package models

import "testing"

func TestEffectiveLimitsUseConservativeDefaults(t *testing.T) {
	settings := PluginSettings{}

	if got := settings.EffectiveMaxHistoryRecords(); got != 5000 {
		t.Fatalf("expected default history limit 5000, got %d", got)
	}
	if got := settings.EffectiveMaxPointsPerQuery(); got != 1000 {
		t.Fatalf("expected default point limit 1000, got %d", got)
	}
	if got := settings.EffectiveMaxLiveLeaseSec(); got != 300 {
		t.Fatalf("expected default live lease 300, got %d", got)
	}
}

func TestEffectiveLimitsAreCappedAtModuleCeilings(t *testing.T) {
	settings := PluginSettings{
		MaxHistoryRecords: 6000,
		MaxPointsPerQuery: 1200,
		MaxLiveLeaseSec:   90000,
	}

	if got := settings.EffectiveMaxHistoryRecords(); got != 5000 {
		t.Fatalf("expected capped history limit 5000, got %d", got)
	}
	if got := settings.EffectiveMaxPointsPerQuery(); got != 1000 {
		t.Fatalf("expected capped point limit 1000, got %d", got)
	}
	if got := settings.EffectiveMaxLiveLeaseSec(); got != 86400 {
		t.Fatalf("expected capped live lease 86400, got %d", got)
	}
}
