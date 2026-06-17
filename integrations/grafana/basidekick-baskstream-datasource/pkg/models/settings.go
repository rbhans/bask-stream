package models

import (
	"encoding/json"
	"fmt"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const (
	defaultTimeoutSec        = 30
	defaultMaxHistoryRecords = 5000
	maxHistoryRecordsCeiling = 5000
	defaultMaxPointsPerQuery = 1000
	maxPointsPerQueryCeiling = 1000
	defaultMaxLiveLeaseSec   = 300
	maxLiveLeaseSecCeiling   = 86400
)

type PluginSettings struct {
	StationURL        string                `json:"stationUrl"`
	Username          string                `json:"username"`
	TLSMode           string                `json:"tlsMode"`
	AllowPlainHTTP    bool                  `json:"allowPlainHttp"`
	TimeoutSec        int                   `json:"timeoutSec"`
	MaxHistoryRecords int                   `json:"maxHistoryRecords"`
	MaxPointsPerQuery int                   `json:"maxPointsPerQuery"`
	MaxLiveLeaseSec   int                   `json:"maxLiveLeaseSec"`
	Secrets           *SecretPluginSettings `json:"-"`
}

type SecretPluginSettings struct {
	Password string `json:"password"`
}

func (s *PluginSettings) VerifyTLS() bool {
	return s.TLSMode != "insecureSkipVerify"
}

func (s *PluginSettings) EffectiveTimeoutSec() int {
	if s.TimeoutSec <= 0 {
		return defaultTimeoutSec
	}
	return s.TimeoutSec
}

func (s *PluginSettings) EffectiveMaxHistoryRecords() int {
	if s.MaxHistoryRecords <= 0 {
		return defaultMaxHistoryRecords
	}
	if s.MaxHistoryRecords > maxHistoryRecordsCeiling {
		return maxHistoryRecordsCeiling
	}
	return s.MaxHistoryRecords
}

func (s *PluginSettings) EffectiveMaxPointsPerQuery() int {
	if s.MaxPointsPerQuery <= 0 {
		return defaultMaxPointsPerQuery
	}
	if s.MaxPointsPerQuery > maxPointsPerQueryCeiling {
		return maxPointsPerQueryCeiling
	}
	return s.MaxPointsPerQuery
}

func (s *PluginSettings) EffectiveMaxLiveLeaseSec() int {
	if s.MaxLiveLeaseSec <= 0 {
		return defaultMaxLiveLeaseSec
	}
	if s.MaxLiveLeaseSec > maxLiveLeaseSecCeiling {
		return maxLiveLeaseSecCeiling
	}
	return s.MaxLiveLeaseSec
}

func LoadPluginSettings(source backend.DataSourceInstanceSettings) (*PluginSettings, error) {
	settings := PluginSettings{}
	err := json.Unmarshal(source.JSONData, &settings)
	if err != nil {
		return nil, fmt.Errorf("could not unmarshal PluginSettings json: %w", err)
	}

	settings.Secrets = loadSecretPluginSettings(source.DecryptedSecureJSONData)

	return &settings, nil
}

func loadSecretPluginSettings(source map[string]string) *SecretPluginSettings {
	return &SecretPluginSettings{
		Password: source["password"],
	}
}
