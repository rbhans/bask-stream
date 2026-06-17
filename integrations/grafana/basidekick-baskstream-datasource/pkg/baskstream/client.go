package baskstream

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/crypto/pbkdf2"
	"golang.org/x/text/unicode/norm"
)

type Config struct {
	StationURL string
	Username   string
	Password   string
	VerifyTLS  bool
	Timeout    time.Duration
}

type Client struct {
	base       *url.URL
	username   string
	password   string
	timeout    time.Duration
	verifyTLS  bool
	httpClient *http.Client
	cookies    map[string]string
	ws         *websocket.Conn
}

func NewClient(config Config) (*Client, error) {
	stationURL := strings.TrimRight(config.StationURL, "/")
	if stationURL == "" {
		return nil, errors.New("station URL is required")
	}
	base, err := url.Parse(stationURL)
	if err != nil {
		return nil, fmt.Errorf("parse station URL: %w", err)
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return nil, errors.New("station URL must start with http:// or https://")
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: !config.VerifyTLS} //nolint:gosec
	return &Client{
		base:      base,
		username:  config.Username,
		password:  config.Password,
		timeout:   timeout,
		verifyTLS: config.VerifyTLS,
		httpClient: &http.Client{
			Timeout:   timeout,
			Transport: transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		cookies: make(map[string]string),
	}, nil
}

func (c *Client) Health(ctx context.Context) (map[string]any, int, error) {
	status, body, err := c.request(ctx, http.MethodGet, "/stream/health", "", nil)
	if err != nil {
		return nil, 0, err
	}
	return parseJSONRecord(body), status, nil
}

func (c *Client) Login(ctx context.Context) (map[string]any, error) {
	if strings.TrimSpace(c.username) == "" || c.password == "" {
		return nil, errors.New("Niagara username and password are required")
	}
	health, status, err := c.Health(ctx)
	if err != nil {
		return nil, err
	}
	if status == http.StatusOK {
		return health, nil
	}

	if _, _, err = c.request(ctx, http.MethodGet, "/prelogin", "", nil); err != nil {
		return nil, err
	}
	userBody := "j_username=" + url.QueryEscape(c.username)
	status, body, err := c.request(ctx, http.MethodPost, "/login", userBody, map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
	})
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK || !bytes.Contains(body, []byte("j_security_check")) {
		return nil, fmt.Errorf("Niagara username step failed with HTTP %d", status)
	}

	nonceBytes := make([]byte, 16)
	if _, err = rand.Read(nonceBytes); err != nil {
		return nil, fmt.Errorf("generate SCRAM nonce: %w", err)
	}
	nonce := base64.StdEncoding.EncodeToString(nonceBytes)
	clientFirstBare := "n=" + prepUsername(c.username) + ",r=" + nonce
	status, body, err = c.request(ctx, http.MethodPost, "/j_security_check/",
		"action=sendClientFirstMessage&clientFirstMessage=n,,"+clientFirstBare,
		map[string]string{"Content-Type": "application/x-niagara-login-support"})
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("SCRAM first message failed with HTTP %d", status)
	}
	serverFirst := strings.TrimSpace(string(body))
	parsed := parseScram(serverFirst)
	if !strings.HasPrefix(parsed["r"], nonce) || parsed["s"] == "" || parsed["i"] == "" {
		return nil, errors.New("invalid SCRAM server first message")
	}
	iterations, err := strconv.Atoi(parsed["i"])
	if err != nil {
		return nil, fmt.Errorf("invalid SCRAM iteration count: %w", err)
	}
	salt, err := base64.StdEncoding.DecodeString(parsed["s"])
	if err != nil {
		return nil, fmt.Errorf("invalid SCRAM salt: %w", err)
	}
	salted := pbkdf2.Key([]byte(norm.NFKC.String(c.password)), salt, iterations, 32, sha256.New)
	clientFinalNoProof := "c=biws,r=" + parsed["r"]
	authMessage := clientFirstBare + "," + serverFirst + "," + clientFinalNoProof
	clientKey := hmacSHA256(salted, "Client Key")
	proof := xor(clientKey, hmacSHA256(sha256Bytes(clientKey), authMessage))
	status, _, err = c.request(ctx, http.MethodPost, "/j_security_check/",
		"action=sendClientFinalMessage&clientFinalMessage="+clientFinalNoProof+",p="+base64.StdEncoding.EncodeToString(proof),
		map[string]string{"Content-Type": "application/x-niagara-login-support"})
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("SCRAM final message failed with HTTP %d", status)
	}
	if _, _, err = c.request(ctx, http.MethodGet, "/j_security_check/", "", nil); err != nil {
		return nil, err
	}
	health, status, err = c.Health(ctx)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("health check failed after login with HTTP %d", status)
	}
	return health, nil
}

func (c *Client) Connect(ctx context.Context) error {
	wsURL := *c.base
	if wsURL.Scheme == "https" {
		wsURL.Scheme = "wss"
	} else {
		wsURL.Scheme = "ws"
	}
	wsURL.Path = "/stream"
	wsURL.RawQuery = ""
	dialer := websocket.Dialer{
		HandshakeTimeout: c.timeout,
		TLSClientConfig:  &tls.Config{InsecureSkipVerify: !c.verifyTLS}, //nolint:gosec
	}
	headers := http.Header{}
	headers.Set("Cookie", c.cookieHeader())
	headers.Set("Origin", c.base.Scheme+"://"+c.base.Host)
	conn, _, err := dialer.DialContext(ctx, wsURL.String(), headers)
	if err != nil {
		return fmt.Errorf("connect baskStream websocket: %w", err)
	}
	c.ws = conn
	return nil
}

func (c *Client) Call(ctx context.Context, op string, fields map[string]any) (map[string]any, error) {
	if c.ws == nil {
		return nil, errors.New("websocket is not connected")
	}
	id, err := c.Send(ctx, op, fields)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(c.timeout)
	for {
		if err = c.ws.SetReadDeadline(deadline); err != nil {
			return nil, err
		}
		messageType, body, err := c.ws.ReadMessage()
		if err != nil {
			return nil, fmt.Errorf("read %s response: %w", op, err)
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		var response map[string]any
		if err = msgpack.Unmarshal(body, &response); err != nil {
			return nil, fmt.Errorf("decode %s response: %w", op, err)
		}
		if response["id"] != id {
			continue
		}
		if response["op"] == "error" {
			return nil, fmt.Errorf("baskStream error: %v", response)
		}
		return response, nil
	}
}

func (c *Client) Send(ctx context.Context, op string, fields map[string]any) (string, error) {
	if c.ws == nil {
		return "", errors.New("websocket is not connected")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	id, payload, err := prepareRequest(op, fields)
	if err != nil {
		return "", err
	}
	if err = c.ws.SetWriteDeadline(time.Now().Add(c.timeout)); err != nil {
		return "", err
	}
	if err = c.ws.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		return "", fmt.Errorf("write %s request: %w", op, err)
	}
	return id, nil
}

func prepareRequest(op string, fields map[string]any) (string, []byte, error) {
	payloadFields := make(map[string]any, len(fields)+2)
	for key, value := range fields {
		payloadFields[key] = value
	}
	id, _ := fields["id"].(string)
	if id == "" {
		id = fmt.Sprintf("%s-%d", op, time.Now().UnixNano())
	}
	payloadFields["op"] = op
	payloadFields["id"] = id
	payload, err := msgpack.Marshal(payloadFields)
	if err != nil {
		return "", nil, fmt.Errorf("encode %s request: %w", op, err)
	}
	return id, payload, nil
}

func (c *Client) Read(ctx context.Context) (map[string]any, bool, error) {
	return c.ReadWithin(ctx, c.timeout)
}

func (c *Client) ReadWithin(ctx context.Context, timeout time.Duration) (map[string]any, bool, error) {
	if c.ws == nil {
		return nil, false, errors.New("websocket is not connected")
	}
	if timeout <= 0 {
		timeout = c.timeout
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		if err := c.ws.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return nil, false, err
		}
		messageType, body, err := c.ws.ReadMessage()
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return nil, false, nil
			}
			return nil, false, fmt.Errorf("read websocket message: %w", err)
		}
		if messageType != websocket.BinaryMessage {
			continue
		}
		var response map[string]any
		if err = msgpack.Unmarshal(body, &response); err != nil {
			return nil, false, fmt.Errorf("decode websocket message: %w", err)
		}
		return response, true, nil
	}
}

func (c *Client) Close() {
	if c.ws != nil {
		_ = c.ws.Close()
		c.ws = nil
	}
}

func (c *Client) request(ctx context.Context, method string, requestPath string, body string, headers map[string]string) (int, []byte, error) {
	target := c.base.ResolveReference(&url.URL{Path: requestPath})
	req, err := http.NewRequestWithContext(ctx, method, target.String(), strings.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	if cookie := c.cookieHeader(); cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if body != "" && req.Header.Get("Content-Length") == "" {
		req.ContentLength = int64(len(body))
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	c.storeCookies(resp.Cookies())
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, responseBody, nil
}

func (c *Client) storeCookies(cookies []*http.Cookie) {
	for _, cookie := range cookies {
		if cookie.Name != "" {
			c.cookies[cookie.Name] = cookie.Value
		}
	}
}

func (c *Client) cookieHeader() string {
	parts := make([]string, 0, len(c.cookies))
	for key, value := range c.cookies {
		parts = append(parts, key+"="+value)
	}
	return strings.Join(parts, "; ")
}

func parseJSONRecord(body []byte) map[string]any {
	var record map[string]any
	if err := json.Unmarshal(body, &record); err == nil && record != nil {
		return record
	}
	return map[string]any{"body": string(body)}
}

func parseScram(value string) map[string]string {
	out := make(map[string]string)
	for _, part := range strings.Split(value, ",") {
		index := strings.Index(part, "=")
		if index > 0 {
			out[part[:index]] = part[index+1:]
		}
	}
	return out
}

func prepUsername(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(norm.NFKC.String(value), "=", "=3D"), ",", "=2C")
}

func hmacSHA256(key []byte, text string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(text))
	return mac.Sum(nil)
}

func sha256Bytes(value []byte) []byte {
	sum := sha256.Sum256(value)
	return sum[:]
}

func xor(a []byte, b []byte) []byte {
	out := make([]byte, len(a))
	for i := range a {
		out[i] = a[i] ^ b[i]
	}
	return out
}
