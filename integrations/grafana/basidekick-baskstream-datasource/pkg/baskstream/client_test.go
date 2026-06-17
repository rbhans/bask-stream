package baskstream

import (
	"testing"

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
