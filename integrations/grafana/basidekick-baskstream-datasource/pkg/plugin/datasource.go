package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/basidekick/bask-stream/pkg/baskstream"
	"github.com/basidekick/bask-stream/pkg/models"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

const defaultMaxLivePointsPerStream = 500

var (
	_ backend.QueryDataHandler      = (*Datasource)(nil)
	_ backend.CheckHealthHandler    = (*Datasource)(nil)
	_ backend.CallResourceHandler   = (*Datasource)(nil)
	_ backend.StreamHandler         = (*Datasource)(nil)
	_ instancemgmt.InstanceDisposer = (*Datasource)(nil)
)

// NewDatasource creates a new datasource instance.
func NewDatasource(_ context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	parsed, err := models.LoadPluginSettings(settings)
	if err != nil {
		return nil, err
	}
	return &Datasource{settings: parsed}, nil
}

type Datasource struct {
	settings *models.PluginSettings
}

func (d *Datasource) Dispose() {
	// Clean up datasource instance resources.
}

func (d *Datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	response := backend.NewQueryDataResponse()

	for _, q := range req.Queries {
		res := d.query(ctx, req.PluginContext, q)
		response.Responses[q.RefID] = res
	}

	return response, nil
}

type queryModel struct {
	RefID    string   `json:"refId"`
	Mode     string   `json:"mode"`
	Ord      string   `json:"ord"`
	Ords     []string `json:"ords"`
	Alias    string   `json:"alias"`
	Limit    int      `json:"limit"`
	Fields   []string `json:"fields"`
	LeaseSec int      `json:"leaseSec"`
}

func (d *Datasource) query(ctx context.Context, pCtx backend.PluginContext, query backend.DataQuery) backend.DataResponse {
	var qm queryModel
	err := json.Unmarshal(query.JSON, &qm)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, fmt.Sprintf("json unmarshal: %v", err.Error()))
	}
	if qm.Mode == "" {
		qm.Mode = "history"
	}

	switch qm.Mode {
	case "history":
		return d.queryHistory(ctx, pCtx, query, qm)
	case "snapshot":
		return d.querySnapshot(ctx, pCtx, qm)
	case "live":
		return backend.ErrDataResponse(backend.StatusBadRequest, "live mode is served through Grafana Live streaming")
	default:
		return backend.ErrDataResponse(backend.StatusBadRequest, "mode must be one of history, snapshot, or live")
	}
}

func (d *Datasource) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	res := &backend.CheckHealthResult{}
	config, err := d.settingsFor(req.PluginContext)

	if err != nil {
		res.Status = backend.HealthStatusError
		res.Message = "Unable to load settings"
		return res, nil
	}

	client, err := newClient(config)
	if err != nil {
		res.Status = backend.HealthStatusError
		res.Message = err.Error()
		return res, nil
	}
	defer client.Close()

	health, err := client.Login(ctx)
	if err != nil {
		res.Status = backend.HealthStatusError
		res.Message = err.Error()
		return res, nil
	}
	if err = client.Connect(ctx); err != nil {
		res.Status = backend.HealthStatusError
		res.Message = err.Error()
		return res, nil
	}
	capabilities, err := client.Call(ctx, "capabilities", nil)
	if err != nil {
		res.Status = backend.HealthStatusError
		res.Message = err.Error()
		return res, nil
	}
	user, _ := health["authenticatedUser"].(string)
	apiVersion := nestedString(capabilities, "capabilities", "apiVersion")
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: fmt.Sprintf("Connected to baskStream apiVersion=%s user=%s", apiVersion, user),
	}, nil
}

func (d *Datasource) queryHistory(ctx context.Context, pCtx backend.PluginContext, query backend.DataQuery, qm queryModel) backend.DataResponse {
	if qm.Ord == "" {
		return backend.ErrDataResponse(backend.StatusBadRequest, "history query requires ord")
	}
	config, err := d.settingsFor(pCtx)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, err.Error())
	}
	client, err := newClient(config)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, err.Error())
	}
	defer client.Close()
	if _, err = client.Login(ctx); err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	if err = client.Connect(ctx); err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	limit := qm.Limit
	if limit <= 0 || limit > config.EffectiveMaxHistoryRecords() {
		limit = config.EffectiveMaxHistoryRecords()
	}
	qm.Ord = canonicalPointOrd(qm.Ord)
	response, err := client.Call(ctx, "read_history", map[string]any{
		"ord":   qm.Ord,
		"start": query.TimeRange.From.UnixMilli(),
		"end":   query.TimeRange.To.UnixMilli(),
		"limit": limit,
	})
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	frames, err := framesFromHistory(qm, response)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	return backend.DataResponse{Frames: frames}
}

func (d *Datasource) querySnapshot(ctx context.Context, pCtx backend.PluginContext, qm queryModel) backend.DataResponse {
	if len(qm.Ords) == 0 {
		return backend.ErrDataResponse(backend.StatusBadRequest, "snapshot query requires at least one point ORD")
	}
	config, err := d.settingsFor(pCtx)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, err.Error())
	}
	if err = validatePointCount("snapshot", len(qm.Ords), config.EffectiveMaxPointsPerQuery()); err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, err.Error())
	}
	client, err := newClient(config)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, err.Error())
	}
	defer client.Close()
	if _, err = client.Login(ctx); err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	if err = client.Connect(ctx); err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	qm.Ords = canonicalPointOrds(qm.Ords)
	request := map[string]any{
		"points": qm.Ords,
	}
	if len(qm.Fields) > 0 {
		request["fields"] = qm.Fields
	}
	response, err := client.Call(ctx, "read", request)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	frames, err := framesFromSnapshot(qm, response)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadGateway, err.Error())
	}
	return backend.DataResponse{Frames: frames}
}

func (d *Datasource) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	path := strings.Trim(req.Path, "/")
	if req.Method != "" && req.Method != http.MethodGet && req.Method != http.MethodPost {
		return sendResourceJSON(sender, http.StatusMethodNotAllowed, map[string]any{
			"error": "resource method must be GET or POST",
		})
	}
	if path == "health" {
		return d.callHealthResource(ctx, req, sender)
	}

	op, ok := resourceOperation(path)
	if !ok {
		return sendResourceJSON(sender, http.StatusNotFound, map[string]any{
			"error": "resource path was not found",
		})
	}
	fields, err := resourceFields(req)
	if err != nil {
		return sendResourceJSON(sender, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})
	}
	fields, err = sanitizeResourceFields(op, fields)
	if err != nil {
		return sendResourceJSON(sender, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})
	}
	response, status, err := d.callStation(ctx, req.PluginContext, op, fields)
	if err != nil {
		return sendResourceJSON(sender, status, map[string]any{
			"error": err.Error(),
		})
	}
	return sendResourceJSON(sender, http.StatusOK, response)
}

func (d *Datasource) callHealthResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	config, err := d.settingsFor(req.PluginContext)
	if err != nil {
		return sendResourceJSON(sender, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})
	}
	client, err := newClient(config)
	if err != nil {
		return sendResourceJSON(sender, http.StatusBadRequest, map[string]any{
			"error": err.Error(),
		})
	}
	defer client.Close()
	health, err := client.Login(ctx)
	if err != nil {
		return sendResourceJSON(sender, http.StatusBadGateway, map[string]any{
			"error": err.Error(),
		})
	}
	if err = client.Connect(ctx); err != nil {
		return sendResourceJSON(sender, http.StatusBadGateway, map[string]any{
			"error": err.Error(),
		})
	}
	capabilities, err := client.Call(ctx, "capabilities", nil)
	if err != nil {
		return sendResourceJSON(sender, http.StatusBadGateway, map[string]any{
			"error": err.Error(),
		})
	}
	return sendResourceJSON(sender, http.StatusOK, map[string]any{
		"health":       health,
		"capabilities": capabilities,
	})
}

func (d *Datasource) callStation(ctx context.Context, pCtx backend.PluginContext, op string, fields map[string]any) (map[string]any, int, error) {
	config, err := d.settingsFor(pCtx)
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	client, err := newClient(config)
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	defer client.Close()
	if _, err = client.Login(ctx); err != nil {
		return nil, http.StatusBadGateway, err
	}
	if err = client.Connect(ctx); err != nil {
		return nil, http.StatusBadGateway, err
	}
	response, err := client.Call(ctx, op, fields)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	return response, http.StatusOK, nil
}

func (d *Datasource) SubscribeStream(_ context.Context, req *backend.SubscribeStreamRequest) (*backend.SubscribeStreamResponse, error) {
	var qm queryModel
	if err := json.Unmarshal(req.Data, &qm); err != nil {
		return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusNotFound}, nil
	}
	if err := validateLiveQuery(qm); err != nil {
		return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusNotFound}, nil
	}
	if err := validateLivePath(req.Path, qm); err != nil {
		return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusNotFound}, nil
	}
	return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusOK}, nil
}

func (d *Datasource) PublishStream(_ context.Context, _ *backend.PublishStreamRequest) (*backend.PublishStreamResponse, error) {
	return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
}

func (d *Datasource) RunStream(ctx context.Context, req *backend.RunStreamRequest, sender *backend.StreamSender) error {
	var qm queryModel
	if err := json.Unmarshal(req.Data, &qm); err != nil {
		return fmt.Errorf("json unmarshal stream query: %w", err)
	}
	if err := validateLiveQuery(qm); err != nil {
		return err
	}
	if err := validateLivePath(req.Path, qm); err != nil {
		return err
	}
	qm.Ords = canonicalPointOrds(qm.Ords)

	config, err := d.settingsFor(req.PluginContext)
	if err != nil {
		return err
	}
	if err = validatePointCount("live", len(qm.Ords), config.EffectiveMaxPointsPerQuery()); err != nil {
		return err
	}
	client, err := newClient(config)
	if err != nil {
		return err
	}
	defer client.Close()
	if _, err = client.Login(ctx); err != nil {
		return err
	}
	if err = client.Connect(ctx); err != nil {
		return err
	}
	capabilities, err := client.Call(ctx, "capabilities", nil)
	if err != nil {
		return err
	}
	if err = validatePointCount("live", len(qm.Ords), livePointLimit(capabilities, config)); err != nil {
		return err
	}

	leaseSec := liveLeaseSec(qm.LeaseSec, config)
	group := streamGroup(req, qm, leaseSec)
	defer releaseSubscriptions(config, client, group)

	response, err := client.Call(ctx, "replace_subscriptions", map[string]any{
		"group":    group,
		"points":   qm.Ords,
		"leaseSec": leaseSec,
	})
	if err != nil {
		return err
	}
	if err = sendLiveFrame(sender, qm, response); err != nil {
		return err
	}

	renewTicker := time.NewTicker(renewInterval(leaseSec))
	defer renewTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-renewTicker.C:
			if _, err = client.Send(ctx, "renew_subscriptions", map[string]any{
				"group":    group,
				"leaseSec": leaseSec,
			}); err != nil {
				return err
			}
		default:
		}

		message, ok, err := client.ReadWithin(ctx, renewInterval(leaseSec))
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if !ok || stringValue(message["op"]) != "cov" {
			continue
		}
		if err = sendLiveFrame(sender, qm, message); err != nil {
			return err
		}
	}
}

func (d *Datasource) settingsFor(pCtx backend.PluginContext) (*models.PluginSettings, error) {
	if pCtx.DataSourceInstanceSettings != nil {
		return models.LoadPluginSettings(*pCtx.DataSourceInstanceSettings)
	}
	if d.settings == nil {
		return nil, fmt.Errorf("data source settings are not available")
	}
	return d.settings, nil
}

func newClient(settings *models.PluginSettings) (*baskstream.Client, error) {
	if settings.StationURL == "" {
		return nil, fmt.Errorf("station URL is required")
	}
	if err := validateStationURL(settings.StationURL, settings.AllowPlainHTTP); err != nil {
		return nil, err
	}
	if settings.Username == "" {
		return nil, fmt.Errorf("username is required")
	}
	if settings.Secrets == nil || settings.Secrets.Password == "" {
		return nil, fmt.Errorf("password is required")
	}
	return baskstream.NewClient(baskstream.Config{
		StationURL: settings.StationURL,
		Username:   settings.Username,
		Password:   settings.Secrets.Password,
		VerifyTLS:  settings.VerifyTLS(),
		Timeout:    time.Duration(settings.EffectiveTimeoutSec()) * time.Second,
	})
}

func framesFromHistory(qm queryModel, response map[string]any) (data.Frames, error) {
	history, ok := response["history"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("history response did not include a history object")
	}
	histories, ok := history["histories"].([]any)
	if !ok {
		return nil, fmt.Errorf("history response did not include histories")
	}
	frames := make(data.Frames, 0, len(histories))
	for _, entry := range histories {
		historyEntry, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		records, _ := historyEntry["records"].([]any)
		times := make([]time.Time, 0, len(records))
		values := make([]float64, 0, len(records))
		statuses := make([]string, 0, len(records))
		trendFlags := make([]string, 0, len(records))
		for _, rawRecord := range records {
			record, ok := rawRecord.(map[string]any)
			if !ok {
				continue
			}
			value, ok := numberValue(record["value"])
			if !ok {
				continue
			}
			timestamp, ok := int64Value(record["timestamp"])
			if !ok {
				continue
			}
			times = append(times, time.UnixMilli(timestamp))
			values = append(values, value)
			statuses = append(statuses, stringValue(record["status"]))
			trendFlags = append(trendFlags, stringValue(record["trendFlags"]))
		}
		name := firstNonEmpty(qm.Alias, stringValue(historyEntry["display"]), stringValue(historyEntry["historyOrd"]), qm.Ord)
		labels := data.Labels{
			"ord":        qm.Ord,
			"historyOrd": stringValue(historyEntry["historyOrd"]),
			"historyId":  stringValue(historyEntry["historyId"]),
			"valueType":  "numeric",
		}
		frame := data.NewFrame(name,
			data.NewField("time", nil, times),
			data.NewField("value", labels, values),
			data.NewField("status", nil, statuses),
			data.NewField("trendFlags", nil, trendFlags),
		)
		frames = append(frames, frame)
	}
	return frames, nil
}

func framesFromSnapshot(qm queryModel, response map[string]any) (data.Frames, error) {
	points, ok := response["points"].([]any)
	if !ok {
		return nil, fmt.Errorf("read response did not include points")
	}
	pointOrds := make([]string, 0, len(points))
	displays := make([]string, 0, len(points))
	values := make([]string, 0, len(points))
	displayValues := make([]string, 0, len(points))
	statuses := make([]string, 0, len(points))
	oks := make([]bool, 0, len(points))
	timestamps := make([]time.Time, 0, len(points))
	valueTypes := make([]string, 0, len(points))
	codes := make([]string, 0, len(points))
	messages := make([]string, 0, len(points))

	for _, entry := range points {
		point, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		pointOrds = append(pointOrds, stringValue(point["point"]))
		displays = append(displays, stringValue(point["display"]))
		values = append(values, stringValue(point["value"]))
		displayValues = append(displayValues, stringValue(point["displayValue"]))
		statuses = append(statuses, stringValue(point["status"]))
		oks = append(oks, boolValue(point["ok"]))
		timestamp, hasTimestamp := int64Value(point["timestamp"])
		if hasTimestamp {
			timestamps = append(timestamps, time.UnixMilli(timestamp))
		} else {
			timestamps = append(timestamps, time.Time{})
		}
		valueTypes = append(valueTypes, stringValue(point["valueType"]))
		codes = append(codes, stringValue(point["code"]))
		messages = append(messages, stringValue(point["message"]))
	}

	name := firstNonEmpty(qm.Alias, "baskStream snapshot")
	return data.Frames{
		data.NewFrame(name,
			data.NewField("point", nil, pointOrds),
			data.NewField("display", nil, displays),
			data.NewField("value", nil, values),
			data.NewField("displayValue", nil, displayValues),
			data.NewField("status", nil, statuses),
			data.NewField("ok", nil, oks),
			data.NewField("timestamp", nil, timestamps),
			data.NewField("valueType", nil, valueTypes),
			data.NewField("code", nil, codes),
			data.NewField("message", nil, messages),
		),
	}, nil
}

func sendLiveFrame(sender *backend.StreamSender, qm queryModel, message map[string]any) error {
	frame, err := frameFromLivePoints(qm, message, time.Now())
	if err != nil || frame == nil {
		return err
	}
	return sender.SendFrame(frame, data.IncludeAll)
}

func frameFromLivePoints(qm queryModel, message map[string]any, fallbackTime time.Time) (*data.Frame, error) {
	points, ok := message["points"].([]any)
	if !ok {
		return nil, fmt.Errorf("live message did not include points")
	}
	timestamp := liveTimestamp(message, fallbackTime)
	fields := []*data.Field{data.NewField("time", nil, []time.Time{timestamp})}
	for _, entry := range points {
		point, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		value, ok := numberValue(point["value"])
		if !ok {
			continue
		}
		ord := stringValue(point["point"])
		labels := data.Labels{
			"ord":        ord,
			"status":     stringValue(point["status"]),
			"valueType":  stringValue(point["valueType"]),
			"sourceOp":   stringValue(message["op"]),
			"sourceSeq":  stringValue(message["sequence"]),
			"sourceTime": stringValue(message["timestamp"]),
		}
		fieldName := firstNonEmpty(stringValue(point["display"]), ord, "value")
		fields = append(fields, data.NewField(fieldName, labels, []float64{value}))
	}
	if len(fields) == 1 {
		return nil, nil
	}
	return data.NewFrame(firstNonEmpty(qm.Alias, "baskStream live"), fields...), nil
}

func liveTimestamp(message map[string]any, fallback time.Time) time.Time {
	if timestamp, ok := int64Value(message["timestamp"]); ok {
		return time.UnixMilli(timestamp)
	}
	return fallback
}

func validateStationURL(stationURL string, allowPlainHTTP bool) error {
	parsed, err := url.Parse(strings.TrimSpace(stationURL))
	if err != nil {
		return fmt.Errorf("parse station URL: %w", err)
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if allowPlainHTTP {
			return nil
		}
		return fmt.Errorf("station URL must use https:// unless Allow plain HTTP is enabled")
	default:
		return fmt.Errorf("station URL must start with https://")
	}
}

func canonicalPointOrd(ord string) string {
	ord = strings.TrimSpace(ord)
	if index := strings.LastIndex(ord, "slot:/"); index >= 0 {
		return ord[index:]
	}
	return ord
}

func canonicalPointOrds(ords []string) []string {
	out := make([]string, 0, len(ords))
	for _, ord := range ords {
		out = append(out, canonicalPointOrd(ord))
	}
	return out
}

func validateLiveQuery(qm queryModel) error {
	if qm.Mode != "live" {
		return fmt.Errorf("stream query mode must be live")
	}
	if qm.RefID == "" {
		return fmt.Errorf("live query requires refId")
	}
	if len(qm.Ords) == 0 {
		return fmt.Errorf("live query requires at least one point ORD")
	}
	return nil
}

func validateLivePath(path string, qm queryModel) error {
	expected := canonicalLivePath(qm)
	if expected == "" || path == expected {
		return nil
	}
	return fmt.Errorf("live stream path does not match query identity")
}

func canonicalLivePath(qm queryModel) string {
	if qm.RefID == "" {
		return ""
	}
	leaseSec := qm.LeaseSec
	if leaseSec <= 0 {
		leaseSec = 300
	}
	hash := livePathHash(fmt.Sprintf("%s\n%s\n%d", qm.RefID, strings.Join(qm.Ords, "|"), leaseSec))
	return fmt.Sprintf("live/%s/%s/%d", url.PathEscape(qm.RefID), hash, leaseSec)
}

func livePathHash(value string) string {
	first := uint32(2166136261)
	second := uint32(2166136261) ^ uint32(len(value))
	for _, code := range []byte(value) {
		first = uint32(uint64(first^uint32(code)) * 16777619)
		second = uint32(uint64(second^uint32(code))*16777619) ^ (first >> 13)
	}
	return strconv.FormatUint(uint64(first), 36) + strconv.FormatUint(uint64(second), 36)
}

func streamGroup(req *backend.RunStreamRequest, qm queryModel, leaseSec int) string {
	uid := "datasource"
	if req.PluginContext.DataSourceInstanceSettings != nil && req.PluginContext.DataSourceInstanceSettings.UID != "" {
		uid = req.PluginContext.DataSourceInstanceSettings.UID
	}
	return "grafana:" + hashGroup(uid, qm.RefID, strings.Join(qm.Ords, "\x00"), strconv.Itoa(leaseSec))
}

func hashGroup(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:16])
}

func renewInterval(leaseSec int) time.Duration {
	seconds := leaseSec / 2
	if seconds < 1 {
		seconds = 1
	}
	return time.Duration(seconds) * time.Second
}

func liveLeaseSec(requested int, config *models.PluginSettings) int {
	leaseSec := requested
	if leaseSec <= 0 {
		leaseSec = 300
	}
	maxLeaseSec := config.EffectiveMaxLiveLeaseSec()
	if leaseSec > maxLeaseSec {
		return maxLeaseSec
	}
	return leaseSec
}

func livePointLimit(capabilities map[string]any, config *models.PluginSettings) int {
	limit := config.EffectiveMaxPointsPerQuery()
	stationLimit := stationLivePointLimit(capabilities)
	if stationLimit <= 0 {
		stationLimit = defaultMaxLivePointsPerStream
	}
	if stationLimit < limit {
		return stationLimit
	}
	return limit
}

func stationLivePointLimit(response map[string]any) int {
	capabilities, ok := response["capabilities"].(map[string]any)
	if !ok {
		return 0
	}
	limits, ok := capabilities["limits"].(map[string]any)
	if !ok {
		return 0
	}
	if value, ok := int64Value(limits["maxLivePointsPerStream"]); ok && value > 0 {
		return int(value)
	}
	if value, ok := int64Value(limits["maxSubscriptionsPerClient"]); ok && value > 0 {
		return int(value)
	}
	return 0
}

func validatePointCount(mode string, count int, max int) error {
	if count > max {
		return fmt.Errorf("%s query requests %d point ORDs; max point ORDs is %d", mode, count, max)
	}
	return nil
}

func releaseSubscriptions(config *models.PluginSettings, client *baskstream.Client, group string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(config.EffectiveTimeoutSec())*time.Second)
	defer cancel()
	_, _ = client.Send(ctx, "release_subscriptions", map[string]any{
		"group": group,
	})
}

func resourceOperation(path string) (string, bool) {
	switch path {
	case "search":
		return "search", true
	case "browse":
		return "browse", true
	case "describe":
		return "describe", true
	case "describe-history", "describe_history":
		return "describe_history", true
	default:
		return "", false
	}
}

func resourceFields(req *backend.CallResourceRequest) (map[string]any, error) {
	fields := make(map[string]any)
	if len(req.Body) > 0 {
		if err := json.Unmarshal(req.Body, &fields); err != nil {
			return nil, fmt.Errorf("resource body must be a JSON object: %w", err)
		}
	}
	for key, values := range resourceQuery(req.URL) {
		if len(values) == 0 {
			continue
		}
		fields[key] = resourceValue(key, values)
	}
	delete(fields, "op")
	delete(fields, "id")
	return fields, nil
}

func resourceQuery(rawURL string) url.Values {
	if rawURL == "" {
		return nil
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil
	}
	return parsed.Query()
}

func resourceValue(key string, values []string) any {
	if key == "features" || key == "operations" {
		return splitResourceList(values)
	}
	value := values[len(values)-1]
	switch key {
	case "depth", "maxDepth", "limit", "maxVisited", "timeoutMillis":
		if number, err := strconv.Atoi(value); err == nil {
			return number
		}
	case "writable":
		if boolean, err := strconv.ParseBool(value); err == nil {
			return boolean
		}
	}
	return value
}

func splitResourceList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				out = append(out, part)
			}
		}
	}
	return out
}

const (
	defaultResourceBase = "slot:/Drivers"
	searchDefaultDepth  = 32
	searchMaxDepth      = 32
	searchDefaultLimit  = 100
	searchMaxLimit      = 100
	browseDefaultDepth  = 1
	browseMaxDepth      = 4
)

func sanitizeResourceFields(op string, fields map[string]any) (map[string]any, error) {
	switch op {
	case "search":
		return sanitizeSearchFields(fields)
	case "browse":
		return sanitizeBrowseFields(fields)
	case "describe":
		return sanitizeDescribeFields(fields)
	case "describe_history":
		return sanitizeDescribeHistoryFields(fields)
	default:
		return nil, fmt.Errorf("unsupported resource operation %q", op)
	}
}

func sanitizeSearchFields(fields map[string]any) (map[string]any, error) {
	if err := rejectUnknownResourceFields("search", fields, "query", "base", "depth", "limit", "metadata", "features", "operations"); err != nil {
		return nil, err
	}
	out := make(map[string]any)
	copyOptionalString(out, fields, "query")
	out["base"] = optionalString(fields, "base", defaultResourceBase)
	out["depth"] = optionalInt(fields, "depth", searchDefaultDepth, searchMaxDepth)
	out["limit"] = optionalInt(fields, "limit", searchDefaultLimit, searchMaxLimit)
	metadata, err := optionalEnum(fields, "metadata", "none", "none")
	if err != nil {
		return nil, err
	}
	features, err := optionalStringList(fields, "features", []string{"point"}, "point", "history")
	if err != nil {
		return nil, err
	}
	operations, err := optionalStringList(fields, "operations", []string{"read"}, "read", "read_history")
	if err != nil {
		return nil, err
	}
	out["metadata"] = metadata
	out["features"] = features
	out["operations"] = operations
	return out, nil
}

func sanitizeBrowseFields(fields map[string]any) (map[string]any, error) {
	if err := rejectUnknownResourceFields("browse", fields, "base", "depth", "metadata"); err != nil {
		return nil, err
	}
	metadata, err := optionalEnum(fields, "metadata", "none", "none")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"base":     optionalString(fields, "base", defaultResourceBase),
		"depth":    optionalInt(fields, "depth", browseDefaultDepth, browseMaxDepth),
		"metadata": metadata,
	}, nil
}

func sanitizeDescribeFields(fields map[string]any) (map[string]any, error) {
	if err := rejectUnknownResourceFields("describe", fields, "ord", "metadata"); err != nil {
		return nil, err
	}
	ord := optionalString(fields, "ord", "")
	if ord == "" {
		return nil, fmt.Errorf("describe resource requires ord")
	}
	metadata, err := optionalEnum(fields, "metadata", "full", "none", "full")
	if err != nil {
		return nil, err
	}
	return map[string]any{"ord": ord, "metadata": metadata}, nil
}

func sanitizeDescribeHistoryFields(fields map[string]any) (map[string]any, error) {
	if err := rejectUnknownResourceFields("describe-history", fields, "ord"); err != nil {
		return nil, err
	}
	ord := optionalString(fields, "ord", "")
	if ord == "" {
		return nil, fmt.Errorf("describe-history resource requires ord")
	}
	return map[string]any{"ord": ord}, nil
}

func rejectUnknownResourceFields(op string, fields map[string]any, allowed ...string) error {
	allowedSet := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = true
	}
	for key := range fields {
		if !allowedSet[key] {
			return fmt.Errorf("%s resource does not accept field %q", op, key)
		}
	}
	return nil
}

func copyOptionalString(out map[string]any, fields map[string]any, key string) {
	if value := optionalString(fields, key, ""); value != "" {
		out[key] = value
	}
}

func optionalString(fields map[string]any, key string, fallback string) string {
	value, ok := fields[key]
	if !ok {
		return fallback
	}
	text := strings.TrimSpace(stringValue(value))
	if text == "" {
		return fallback
	}
	return text
}

func optionalInt(fields map[string]any, key string, fallback int, maxValue int) int {
	value, ok := fields[key]
	if !ok {
		return fallback
	}
	number, ok := intValue(value)
	if !ok || number <= 0 {
		return fallback
	}
	if number > maxValue {
		return maxValue
	}
	return number
}

func optionalEnum(fields map[string]any, key string, fallback string, allowed ...string) (string, error) {
	value := optionalString(fields, key, fallback)
	for _, allowedValue := range allowed {
		if value == allowedValue {
			return value, nil
		}
	}
	return "", fmt.Errorf("%s must be one of %s", key, strings.Join(allowed, ", "))
}

func optionalStringList(fields map[string]any, key string, fallback []string, allowed ...string) ([]string, error) {
	value, ok := fields[key]
	if !ok {
		return fallback, nil
	}
	values, ok := stringListValue(value)
	if !ok || len(values) == 0 {
		return fallback, nil
	}
	allowedSet := make(map[string]bool, len(allowed))
	for _, entry := range allowed {
		allowedSet[entry] = true
	}
	for _, entry := range values {
		if !allowedSet[entry] {
			return nil, fmt.Errorf("%s contains unsupported value %q", key, entry)
		}
	}
	return values, nil
}

func stringListValue(value any) ([]string, bool) {
	switch typed := value.(type) {
	case []string:
		return normalizeStringList(typed), true
	case []any:
		values := make([]string, 0, len(typed))
		for _, entry := range typed {
			text, ok := entry.(string)
			if !ok {
				return nil, false
			}
			values = append(values, text)
		}
		return normalizeStringList(values), true
	case string:
		return normalizeStringList([]string{typed}), true
	default:
		return nil, false
	}
}

func normalizeStringList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func intValue(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		converted := int(typed)
		return converted, typed == float64(converted)
	default:
		return 0, false
	}
}

func sendResourceJSON(sender backend.CallResourceResponseSender, status int, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return sender.Send(&backend.CallResourceResponse{
		Status: status,
		Headers: map[string][]string{
			"content-type": {"application/json"},
		},
		Body: body,
	})
}

func nestedString(record map[string]any, first string, second string) string {
	child, ok := record[first].(map[string]any)
	if !ok {
		return ""
	}
	return stringValue(child[second])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return "baskStream history"
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func boolValue(value any) bool {
	if typed, ok := value.(bool); ok {
		return typed
	}
	return false
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case uint32:
		return float64(typed), true
	default:
		return 0, false
	}
}

func int64Value(value any) (int64, bool) {
	switch typed := value.(type) {
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case uint64:
		return int64(typed), true
	case uint32:
		return int64(typed), true
	case float64:
		return int64(typed), true
	default:
		return 0, false
	}
}
