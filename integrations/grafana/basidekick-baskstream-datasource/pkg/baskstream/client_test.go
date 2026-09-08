package baskstream

import (
	"context"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"
)

func TestPrepareRequestAddsOperationAndPreservesID(t *testing.T) {
	fields := map[string]any{
		"id":       "renew-1",
		"group":    "grafana:ds:panel",
		"leaseSec": 300,
	}

	id, payload, err := prepareRequest("renew_subscriptions", fields)
	if err != nil {
		t.Fatal(err)
	}
	if id != "renew-1" {
		t.Fatalf("unexpected id %q", id)
	}

	var decoded map[string]any
	if err = msgpack.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["op"] != "renew_subscriptions" {
		t.Fatalf("unexpected op %v", decoded["op"])
	}
	if decoded["id"] != "renew-1" {
		t.Fatalf("unexpected decoded id %v", decoded["id"])
	}
	if decoded["group"] != "grafana:ds:panel" {
		t.Fatalf("unexpected group %v", decoded["group"])
	}
	if _, ok := fields["op"]; ok {
		t.Fatal("prepareRequest must not mutate caller fields with op")
	}
}

func TestPrepareRequestDoesNotMutateCallerFieldsWhenIDIsGenerated(t *testing.T) {
	fields := map[string]any{
		"group": "grafana:ds:panel",
	}

	id, payload, err := prepareRequest("release_subscriptions", fields)
	if err != nil {
		t.Fatal(err)
	}
	if id == "" {
		t.Fatal("expected generated id")
	}

	var decoded map[string]any
	if err = msgpack.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["id"] != id {
		t.Fatalf("unexpected decoded id %v", decoded["id"])
	}
	if _, ok := fields["id"]; ok {
		t.Fatal("prepareRequest must not mutate caller fields with id")
	}
	if _, ok := fields["op"]; ok {
		t.Fatal("prepareRequest must not mutate caller fields with op")
	}
}

func TestReadTimeoutIsFatal(t *testing.T) {
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		<-done
	}))
	defer server.Close()
	defer close(done)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{ws: conn}
	defer client.Close()
	_, ok, err := client.ReadWithin(context.Background(), 20*time.Millisecond)
	if err == nil || ok {
		t.Fatalf("read timeout must be fatal: ok=%v err=%v", ok, err)
	}
}
