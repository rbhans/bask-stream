package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/basidekick/bask-stream/pkg/models"
	"github.com/gorilla/websocket"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/vmihailenco/msgpack/v5"
)

func TestCheckHealthAgainstFakeStation(t *testing.T) {
	stationURL := startFakeStation(t)
	ds := datasourceForStation(stationURL)

	result, err := ds.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != backend.HealthStatusOk {
		t.Fatalf("expected health ok, got %s: %s", result.Status, result.Message)
	}
	if !strings.Contains(result.Message, "apiVersion=1") {
		t.Fatalf("expected apiVersion in health message, got %q", result.Message)
	}
}

func TestQueryHistoryAgainstFakeStation(t *testing.T) {
	stationURL := startFakeStation(t)
	ds := datasourceForStation(stationURL)
	queryJSON, err := json.Marshal(queryModel{Mode: "history", Ord: "slot:/Drivers/AHU/points/SpaceTemp"})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := ds.QueryData(context.Background(), &backend.QueryDataRequest{
		Queries: []backend.DataQuery{
			{
				RefID: "A",
				JSON:  queryJSON,
				TimeRange: backend.TimeRange{
					From: time.UnixMilli(1779648000000),
					To:   time.UnixMilli(1779648300000),
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	queryResp := resp.Responses["A"]
	if queryResp.Error != nil {
		t.Fatal(queryResp.Error)
	}
	if len(queryResp.Frames) != 1 {
		t.Fatalf("expected one history frame, got %d", len(queryResp.Frames))
	}
	frame := queryResp.Frames[0]
	if frame.Name != "Space Temp History" {
		t.Fatalf("unexpected frame name %q", frame.Name)
	}
	if frame.Fields[1].Name != "value" || frame.Fields[1].Len() != 2 {
		t.Fatalf("expected value field with two records, got %s len=%d", frame.Fields[1].Name, frame.Fields[1].Len())
	}
	if got := frame.Fields[1].At(0); got != 72.1 {
		t.Fatalf("unexpected first history value %v", got)
	}
}

func TestQuerySnapshotAgainstFakeStation(t *testing.T) {
	stationURL := startFakeStation(t)
	ds := datasourceForStation(stationURL)
	queryJSON, err := json.Marshal(queryModel{
		Mode: "snapshot",
		Ords: []string{
			"slot:/Drivers/AHU/points/SpaceTemp",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := ds.QueryData(context.Background(), &backend.QueryDataRequest{
		Queries: []backend.DataQuery{
			{
				RefID: "A",
				JSON:  queryJSON,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	queryResp := resp.Responses["A"]
	if queryResp.Error != nil {
		t.Fatal(queryResp.Error)
	}
	if len(queryResp.Frames) != 1 {
		t.Fatalf("expected one snapshot frame, got %d", len(queryResp.Frames))
	}
	frame := queryResp.Frames[0]
	if frame.Fields[0].Len() != 1 {
		t.Fatalf("expected one snapshot row, got %d", frame.Fields[0].Len())
	}
	if got := frame.Fields[0].At(0); got != "slot:/Drivers/AHU/points/SpaceTemp" {
		t.Fatalf("unexpected point ord %v", got)
	}
	if got := frame.Fields[3].At(0); got != "72.4 degF" {
		t.Fatalf("unexpected display value %v", got)
	}
}

func TestRunStreamAgainstFakeStation(t *testing.T) {
	stationURL := startFakeStation(t)
	ds := datasourceForStation(stationURL)
	queryJSON, err := json.Marshal(queryModel{
		RefID:    "A",
		Mode:     "live",
		Ords:     []string{"slot:/Drivers/AHU/points/SpaceTemp"},
		LeaseSec: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	packetSender := &capturingStreamSender{cancel: cancel}

	err = ds.RunStream(ctx, &backend.RunStreamRequest{
		Path:          canonicalLivePath(queryModel{RefID: "A", Mode: "live", Ords: []string{"slot:/Drivers/AHU/points/SpaceTemp"}, LeaseSec: 300}),
		Data:          queryJSON,
		PluginContext: pluginContextForStation(t, stationURL, "baskstream"),
	}, backend.NewStreamSender(packetSender))
	if err != nil {
		t.Fatal(err)
	}
	if len(packetSender.packets) != 1 {
		t.Fatalf("expected one initial live frame, got %d", len(packetSender.packets))
	}
	packet := string(packetSender.packets[0].Data)
	if !strings.Contains(packet, "baskStream live") || !strings.Contains(packet, "Space Temp") {
		t.Fatalf("live frame did not include expected series metadata: %s", packet)
	}
}

func TestCallResourceSearchAgainstFakeStation(t *testing.T) {
	stationURL := startFakeStation(t)
	ds := datasourceForStation(stationURL)

	resp := callResourceForTest(t, ds, &backend.CallResourceRequest{
		Path:          "search",
		Method:        http.MethodGet,
		URL:           "http://grafana.local/api/datasources/uid/test/resources/search?query=temp&op=write&id=caller-id",
		PluginContext: pluginContextForStation(t, stationURL, "baskstream"),
	})
	if resp.Status != http.StatusOK {
		t.Fatalf("expected ok, got %d: %s", resp.Status, string(resp.Body))
	}
	body := decodeResourceBody(t, resp)
	if body["op"] != "search" {
		t.Fatalf("expected fixed search operation, got %v", body["op"])
	}
	echo := body["echo"].(map[string]any)
	if echo["base"] != "slot:/Drivers" {
		t.Fatalf("expected default search base, got %v", echo["base"])
	}
	limit, ok := numberValue(echo["limit"])
	if !ok || limit != 100 {
		t.Fatalf("expected default search limit, got %v", echo["limit"])
	}
	if echo["id"] == "caller-id" {
		t.Fatal("caller-supplied id must not be forwarded to station operation")
	}
}

func TestCallResourceDescribeHistoryAgainstFakeStation(t *testing.T) {
	stationURL := startFakeStation(t)
	ds := datasourceForStation(stationURL)

	resp := callResourceForTest(t, ds, &backend.CallResourceRequest{
		Path:          "describe-history",
		Method:        http.MethodPost,
		Body:          []byte(`{"ord":"slot:/Drivers/AHU/points/SpaceTemp","op":"write","id":"caller-id"}`),
		PluginContext: pluginContextForStation(t, stationURL, "baskstream"),
	})
	if resp.Status != http.StatusOK {
		t.Fatalf("expected ok, got %d: %s", resp.Status, string(resp.Body))
	}
	body := decodeResourceBody(t, resp)
	if body["op"] != "describe_history" {
		t.Fatalf("expected fixed describe_history operation, got %v", body["op"])
	}
	echo := body["echo"].(map[string]any)
	if echo["ord"] != "slot:/Drivers/AHU/points/SpaceTemp" {
		t.Fatalf("expected ord to be forwarded, got %v", echo["ord"])
	}
	if echo["id"] == "caller-id" {
		t.Fatal("caller-supplied id must not be forwarded to station operation")
	}
}

type capturingStreamSender struct {
	cancel  context.CancelFunc
	packets []*backend.StreamPacket
}

func (s *capturingStreamSender) Send(packet *backend.StreamPacket) error {
	s.packets = append(s.packets, packet)
	if s.cancel != nil {
		s.cancel()
	}
	return nil
}

func datasourceForStation(stationURL string) *Datasource {
	return &Datasource{settings: &models.PluginSettings{
		StationURL:     stationURL,
		Username:       "grafana",
		AllowPlainHTTP: true,
		TimeoutSec:     5,
		Secrets: &models.SecretPluginSettings{
			Password: "password",
		},
	}}
}

func pluginContextForStation(t *testing.T, stationURL string, uid string) backend.PluginContext {
	t.Helper()
	jsonData, err := json.Marshal(models.PluginSettings{
		StationURL:     stationURL,
		Username:       "grafana",
		AllowPlainHTTP: true,
		TimeoutSec:     5,
	})
	if err != nil {
		t.Fatal(err)
	}
	return backend.PluginContext{
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			UID:      uid,
			JSONData: jsonData,
			DecryptedSecureJSONData: map[string]string{
				"password": "password",
			},
		},
	}
}

func startFakeStation(t *testing.T) string {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/stream/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"authenticatedUser":"grafana"}`))
	})
	mux.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade websocket: %v", err)
			return
		}
		defer conn.Close()
		for {
			messageType, body, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if messageType != websocket.BinaryMessage {
				continue
			}
			var request map[string]any
			if err = msgpack.Unmarshal(body, &request); err != nil {
				t.Errorf("decode request: %v", err)
				return
			}
			response := fakeStationResponse(request)
			payload, err := msgpack.Marshal(response)
			if err != nil {
				t.Errorf("encode response: %v", err)
				return
			}
			if err = conn.WriteMessage(websocket.BinaryMessage, payload); err != nil {
				return
			}
		}
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL
}

func fakeStationResponse(request map[string]any) map[string]any {
	id, _ := request["id"].(string)
	switch request["op"] {
	case "capabilities":
		return map[string]any{
			"id": id,
			"op": "capabilities",
			"capabilities": map[string]any{
				"apiVersion": "1",
				"limits": map[string]any{
					"maxLivePointsPerStream":    int64(500),
					"maxSubscriptionsPerClient": int64(500),
				},
			},
		}
	case "read_history":
		return map[string]any{
			"id": id,
			"op": "history",
			"history": map[string]any{
				"histories": []any{
					map[string]any{
						"display":    "Space Temp History",
						"historyOrd": "history:/Station/AHU/SpaceTemp",
						"historyId":  "AHU_SpaceTemp",
						"records": []any{
							map[string]any{
								"timestamp":  int64(1779648000000),
								"value":      72.1,
								"status":     "{ok}",
								"trendFlags": "",
							},
							map[string]any{
								"timestamp":  int64(1779648300000),
								"value":      72.4,
								"status":     "{ok}",
								"trendFlags": "",
							},
						},
					},
				},
			},
		}
	case "read":
		return map[string]any{
			"id": id,
			"op": "read",
			"points": []any{
				map[string]any{
					"point":        "slot:/Drivers/AHU/points/SpaceTemp",
					"display":      "Space Temp",
					"value":        72.4,
					"displayValue": "72.4 degF",
					"status":       "{ok}",
					"ok":           true,
					"timestamp":    int64(1779648232328),
					"valueType":    "baja:Double",
				},
			},
		}
	case "replace_subscriptions":
		return map[string]any{
			"id":       id,
			"op":       "subscriptions_replaced",
			"group":    request["group"],
			"added":    int64(1),
			"removed":  int64(0),
			"leaseSec": request["leaseSec"],
			"points": []any{
				map[string]any{
					"point":     "slot:/Drivers/AHU/points/SpaceTemp",
					"display":   "Space Temp",
					"value":     72.4,
					"status":    "{ok}",
					"valueType": "baja:Double",
				},
			},
		}
	case "release_subscriptions":
		return map[string]any{
			"id":      id,
			"op":      "subscriptions_released",
			"group":   request["group"],
			"removed": int64(1),
		}
	case "search":
		return map[string]any{
			"id":   id,
			"op":   "search",
			"echo": request,
			"result": map[string]any{
				"count": int64(1),
				"nodes": []any{
					map[string]any{
						"ord":        "slot:/Drivers/AHU/points/SpaceTemp",
						"display":    "Space Temp",
						"features":   []string{"point", "history"},
						"operations": []string{"read", "read_history"},
					},
				},
			},
		}
	case "browse":
		return map[string]any{
			"id":   id,
			"op":   "browse",
			"echo": request,
			"node": map[string]any{
				"ord":         request["base"],
				"display":     "Drivers",
				"hasChildren": true,
			},
		}
	case "describe":
		return map[string]any{
			"id":   id,
			"op":   "describe",
			"echo": request,
			"node": map[string]any{
				"ord":        request["ord"],
				"display":    "Space Temp",
				"features":   []string{"point", "history"},
				"operations": []string{"read", "read_history"},
			},
		}
	case "describe_history":
		return map[string]any{
			"id":   id,
			"op":   "describe_history",
			"echo": request,
			"history": map[string]any{
				"ord":          request["ord"],
				"historyCount": int64(1),
			},
		}
	default:
		return map[string]any{
			"id":      id,
			"op":      "error",
			"code":    "unsupported_op",
			"message": "unsupported fake station operation",
		}
	}
}

func TestQueryDataRejectsMissingSettings(t *testing.T) {
	ds := Datasource{}
	queryJSON, err := json.Marshal(queryModel{Mode: "history", Ord: "slot:/Drivers/AHU/points/SpaceTemp"})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := ds.QueryData(
		context.Background(),
		&backend.QueryDataRequest{
			Queries: []backend.DataQuery{
				{
					RefID: "A",
					JSON:  queryJSON,
					TimeRange: backend.TimeRange{
						From: time.Unix(0, 0),
						To:   time.Unix(60, 0),
					},
				},
			},
		},
	)
	if err != nil {
		t.Error(err)
	}

	if len(resp.Responses) != 1 {
		t.Fatal("QueryData must return a response")
	}
	if resp.Responses["A"].Error == nil {
		t.Fatal("QueryData should return a query error when settings are missing")
	}
}

func TestFramesFromSnapshot(t *testing.T) {
	frames, err := framesFromSnapshot(queryModel{Alias: "AHU snapshot"}, map[string]any{
		"points": []any{
			map[string]any{
				"point":        "slot:/Drivers/AHU/points/SpaceTemp",
				"display":      "Space Temp",
				"value":        72.4,
				"displayValue": "72.4 degF",
				"status":       "{ok}",
				"ok":           true,
				"timestamp":    int64(1779648232328),
				"valueType":    "baja:Double",
			},
			map[string]any{
				"point":   "slot:/Drivers/AHU/points/Missing",
				"ok":      false,
				"code":    "invalid_point",
				"message": "Resolved point target was null.",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 1 {
		t.Fatalf("expected one frame, got %d", len(frames))
	}
	if frames[0].Name != "AHU snapshot" {
		t.Fatalf("unexpected frame name %q", frames[0].Name)
	}
	if len(frames[0].Fields) != 10 {
		t.Fatalf("expected 10 fields, got %d", len(frames[0].Fields))
	}
	if frames[0].Fields[0].Len() != 2 {
		t.Fatalf("expected two snapshot rows, got %d", frames[0].Fields[0].Len())
	}
}

func TestQuerySnapshotRejectsTooManyPointsBeforeConnecting(t *testing.T) {
	ds := Datasource{settings: &models.PluginSettings{MaxPointsPerQuery: 1}}
	resp := ds.querySnapshot(context.Background(), backend.PluginContext{}, queryModel{
		Mode: "snapshot",
		Ords: []string{
			"slot:/Drivers/AHU/points/SpaceTemp",
			"slot:/Drivers/AHU/points/SupplyTemp",
		},
	})
	if resp.Error == nil {
		t.Fatal("expected over-limit snapshot query to fail")
	}
}

func TestFrameFromLivePoints(t *testing.T) {
	frame, err := frameFromLivePoints(queryModel{Alias: "AHU live"}, map[string]any{
		"op":        "cov",
		"sequence":  int64(42),
		"timestamp": int64(1779648232328),
		"points": []any{
			map[string]any{
				"point":     "slot:/Drivers/AHU/points/SpaceTemp",
				"display":   "Space Temp",
				"value":     72.5,
				"status":    "{ok}",
				"valueType": "baja:Double",
			},
			map[string]any{
				"point": "slot:/Drivers/AHU/points/FanStatus",
				"value": "On",
			},
		},
	}, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if frame == nil {
		t.Fatal("expected live frame")
	}
	if frame.Name != "AHU live" {
		t.Fatalf("unexpected frame name %q", frame.Name)
	}
	if len(frame.Fields) != 2 {
		t.Fatalf("expected time plus one numeric field, got %d fields", len(frame.Fields))
	}
	if frame.Fields[1].Name != "Space Temp" {
		t.Fatalf("unexpected value field %q", frame.Fields[1].Name)
	}
	if frame.Fields[1].Labels["ord"] != "slot:/Drivers/AHU/points/SpaceTemp" {
		t.Fatalf("unexpected ord label %q", frame.Fields[1].Labels["ord"])
	}
}

func TestLiveLeaseSecIsCappedBySettings(t *testing.T) {
	config := &models.PluginSettings{MaxLiveLeaseSec: 120}
	if got := liveLeaseSec(300, config); got != 120 {
		t.Fatalf("expected capped lease 120, got %d", got)
	}
	if got := liveLeaseSec(0, config); got != 120 {
		t.Fatalf("expected default lease capped to 120, got %d", got)
	}
	if got := liveLeaseSec(60, config); got != 60 {
		t.Fatalf("expected requested lease 60, got %d", got)
	}
}

func TestLivePointLimitUsesStationAdvertisedLimit(t *testing.T) {
	config := &models.PluginSettings{MaxPointsPerQuery: 1000}
	capabilities := map[string]any{
		"capabilities": map[string]any{
			"limits": map[string]any{
				"maxLivePointsPerStream": int64(500),
			},
		},
	}
	if got := livePointLimit(capabilities, config); got != 500 {
		t.Fatalf("expected live point limit 500, got %d", got)
	}
}

func TestLivePointLimitKeepsLowerPluginLimit(t *testing.T) {
	config := &models.PluginSettings{MaxPointsPerQuery: 250}
	capabilities := map[string]any{
		"capabilities": map[string]any{
			"limits": map[string]any{
				"maxLivePointsPerStream": int64(500),
			},
		},
	}
	if got := livePointLimit(capabilities, config); got != 250 {
		t.Fatalf("expected live point limit 250, got %d", got)
	}
}

func TestLivePointLimitFallsBackToStationDefault(t *testing.T) {
	config := &models.PluginSettings{MaxPointsPerQuery: 1000}
	if got := livePointLimit(map[string]any{}, config); got != 500 {
		t.Fatalf("expected fallback live point limit 500, got %d", got)
	}
}

func TestValidatePointCount(t *testing.T) {
	if err := validatePointCount("snapshot", 1000, 1000); err != nil {
		t.Fatalf("expected 1000 point request to pass: %v", err)
	}
	if err := validatePointCount("snapshot", 1001, 1000); err == nil {
		t.Fatal("expected over-limit point request to fail")
	}
}

func TestStreamGroupIsStableAndBounded(t *testing.T) {
	longPath := "live/A/" + strings.Repeat("slot%3A%2FDrivers%2FAHU%2Fpoints%2FSpaceTemp%7C", 30) + "/300"
	qm := queryModel{
		RefID:    "A",
		Mode:     "live",
		Ords:     []string{strings.Repeat("slot:/Drivers/AHU/points/SpaceTemp", 30)},
		LeaseSec: 300,
	}
	req := &backend.RunStreamRequest{
		Path: longPath,
		PluginContext: backend.PluginContext{
			DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
				UID: "baskstream-grafana-datasource-with-a-long-but-valid-uid",
			},
		},
	}

	group := streamGroup(req, qm, 300)
	if len(group) > 128 {
		t.Fatalf("expected bounded group name, got length %d", len(group))
	}
	if group != streamGroup(req, qm, 300) {
		t.Fatal("expected group name to be stable")
	}
	if strings.Contains(group, "SpaceTemp") {
		t.Fatalf("expected group name not to include raw ORD content: %s", group)
	}
}

func TestCallResourceRejectsUnknownPath(t *testing.T) {
	ds := Datasource{}
	resp := callResourceForTest(t, &ds, &backend.CallResourceRequest{
		Path:   "write",
		Method: http.MethodGet,
	})
	if resp.Status != http.StatusNotFound {
		t.Fatalf("expected not found, got %d", resp.Status)
	}
}

func TestCallResourceRejectsMissingSettings(t *testing.T) {
	ds := Datasource{}
	resp := callResourceForTest(t, &ds, &backend.CallResourceRequest{
		Path:   "search",
		Method: http.MethodGet,
		URL:    "http://grafana.local/api/datasources/uid/test/resources/search?query=temp",
	})
	if resp.Status != http.StatusBadRequest {
		t.Fatalf("expected bad request, got %d", resp.Status)
	}
}

func TestResourceFieldsParseQueryAndStripOperation(t *testing.T) {
	fields, err := resourceFields(&backend.CallResourceRequest{
		URL: "http://grafana.local/api/datasources/uid/test/resources/search?query=temp&features=point,history&operations=read&limit=25&writable=true&op=write&id=1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["op"]; ok {
		t.Fatal("resource fields must not preserve caller supplied op")
	}
	if _, ok := fields["id"]; ok {
		t.Fatal("resource fields must not preserve caller supplied id")
	}
	if fields["query"] != "temp" {
		t.Fatalf("unexpected query %v", fields["query"])
	}
	if fields["limit"] != 25 {
		t.Fatalf("unexpected limit %v", fields["limit"])
	}
	if fields["writable"] != true {
		t.Fatalf("unexpected writable %v", fields["writable"])
	}
	features, ok := fields["features"].([]string)
	if !ok || len(features) != 2 || features[0] != "point" || features[1] != "history" {
		t.Fatalf("unexpected features %#v", fields["features"])
	}
}

func TestSanitizeResourceFieldsForSearch(t *testing.T) {
	fields := map[string]any{
		"query":      "temp",
		"limit":      1000,
		"depth":      99,
		"operations": []string{"read_history"},
	}
	sanitized, err := sanitizeResourceFields("search", fields)
	if err != nil {
		t.Fatal(err)
	}
	if sanitized["base"] != "slot:/Drivers" {
		t.Fatalf("unexpected base %v", sanitized["base"])
	}
	if sanitized["depth"] != 32 {
		t.Fatalf("unexpected depth %v", sanitized["depth"])
	}
	if sanitized["limit"] != 100 {
		t.Fatalf("unexpected limit %v", sanitized["limit"])
	}
	operations, ok := sanitized["operations"].([]string)
	if !ok || len(operations) != 1 || operations[0] != "read_history" {
		t.Fatalf("unexpected operations %#v", sanitized["operations"])
	}
}

func TestSanitizeResourceFieldsRejectsWriteOperation(t *testing.T) {
	_, err := sanitizeResourceFields("search", map[string]any{
		"query":      "temp",
		"operations": []string{"write"},
	})
	if err == nil {
		t.Fatal("expected write-oriented operation filter to be rejected")
	}
}

func TestSanitizeResourceFieldsRejectsUnknownField(t *testing.T) {
	_, err := sanitizeResourceFields("browse", map[string]any{
		"base":          "slot:/Drivers",
		"timeoutMillis": 30000,
	})
	if err == nil {
		t.Fatal("expected unknown browse field to be rejected")
	}
}

func TestValidateStationURLRequiresHTTPSUnlessOptedIn(t *testing.T) {
	if err := validateStationURL("https://station.example.com", false); err != nil {
		t.Fatalf("expected https URL to pass: %v", err)
	}
	if err := validateStationURL("http://station.example.com", false); err == nil {
		t.Fatal("expected http URL to fail without explicit opt-in")
	}
	if err := validateStationURL("http://station.example.com", true); err != nil {
		t.Fatalf("expected http URL to pass with explicit opt-in: %v", err)
	}
}

func TestCanonicalPointOrdPrefersSlotPath(t *testing.T) {
	got := canonicalPointOrd("local:|station:|slot:/Drivers/AHU/points/SpaceTemp")
	if got != "slot:/Drivers/AHU/points/SpaceTemp" {
		t.Fatalf("unexpected canonical ORD %q", got)
	}
}

func TestValidateLivePathRejectsMismatch(t *testing.T) {
	qm := queryModel{
		RefID:    "A",
		Mode:     "live",
		Ords:     []string{"slot:/Drivers/AHU/points/SpaceTemp"},
		LeaseSec: 300,
	}
	if err := validateLivePath(canonicalLivePath(qm), qm); err != nil {
		t.Fatalf("expected canonical live path to pass: %v", err)
	}
	if err := validateLivePath("live/A/wrong/300", qm); err == nil {
		t.Fatal("expected mismatched live path to fail")
	}
}

func callResourceForTest(t *testing.T, ds *Datasource, req *backend.CallResourceRequest) *backend.CallResourceResponse {
	t.Helper()
	var resp *backend.CallResourceResponse
	err := ds.CallResource(context.Background(), req, backend.CallResourceResponseSenderFunc(func(candidate *backend.CallResourceResponse) error {
		resp = candidate
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if resp == nil {
		t.Fatal("expected resource response")
	}
	return resp
}

func decodeResourceBody(t *testing.T, resp *backend.CallResourceResponse) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatal(err)
	}
	return body
}
