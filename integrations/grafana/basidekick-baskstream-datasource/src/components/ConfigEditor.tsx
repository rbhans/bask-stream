import React, { ChangeEvent } from 'react';
import { Checkbox, Combobox, ComboboxOption, InlineField, Input, SecretInput } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { BaskStreamDataSourceOptions, BaskStreamSecureJsonData } from '../types';

interface Props extends DataSourcePluginOptionsEditorProps<BaskStreamDataSourceOptions, BaskStreamSecureJsonData> {}

type TlsMode = NonNullable<BaskStreamDataSourceOptions['tlsMode']>;

const tlsModeOptions: Array<ComboboxOption<TlsMode>> = [
  { label: 'Verify TLS', value: 'verify' },
  { label: 'Skip TLS verification', value: 'insecureSkipVerify' },
];

export function ConfigEditor(props: Props) {
  const { onOptionsChange, options } = props;
  const { jsonData, secureJsonFields, secureJsonData } = options;

  const onStationUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        stationUrl: event.target.value,
      },
    });
  };

  const onUsernameChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        username: event.target.value,
      },
    });
  };

  const onTlsModeChange = (option: ComboboxOption<TlsMode>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        tlsMode: option.value,
      },
    });
  };

  const onAllowPlainHttpChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        allowPlainHttp: event.currentTarget.checked,
      },
    });
  };

  const onTimeoutSecChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        timeoutSec: Number(event.target.value) || undefined,
      },
    });
  };

  const onMaxHistoryRecordsChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        maxHistoryRecords: Number(event.target.value) || undefined,
      },
    });
  };

  const onMaxPointsPerQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        maxPointsPerQuery: Number(event.target.value) || undefined,
      },
    });
  };

  const onMaxLiveLeaseSecChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        maxLiveLeaseSec: Number(event.target.value) || undefined,
      },
    });
  };

  const onPasswordChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      secureJsonData: {
        ...secureJsonData,
        password: event.target.value,
      },
    });
  };

  const onResetPassword = () => {
    onOptionsChange({
      ...options,
      secureJsonFields: {
        ...secureJsonFields,
        password: false,
      },
      secureJsonData: {
        ...secureJsonData,
        password: '',
      },
    });
  };

  const tlsMode = jsonData.tlsMode || 'verify';

  return (
    <>
      <InlineField label="Station URL" labelWidth={18} interactive>
        <Input
          id="config-editor-station-url"
          onChange={onStationUrlChange}
          value={jsonData.stationUrl || ''}
          placeholder="https://station.example.com"
          width={40}
        />
      </InlineField>
      <InlineField label="Username" labelWidth={18} interactive>
        <Input
          id="config-editor-username"
          onChange={onUsernameChange}
          value={jsonData.username || ''}
          placeholder="Niagara user"
          width={40}
        />
      </InlineField>
      <InlineField label="Password" labelWidth={18} interactive>
        <SecretInput
          required
          id="config-editor-password"
          isConfigured={secureJsonFields.password}
          value={secureJsonData?.password}
          placeholder="Niagara password"
          width={40}
          onReset={onResetPassword}
          onChange={onPasswordChange}
        />
      </InlineField>
      <InlineField
        label="TLS mode"
        labelWidth={18}
        interactive
        tooltip="Use insecureSkipVerify only for trusted lab/self-signed stations."
      >
        <Combobox<TlsMode>
          id="config-editor-tls-mode"
          onChange={onTlsModeChange}
          value={tlsMode}
          options={tlsModeOptions}
          width={24}
        />
      </InlineField>
      <InlineField
        label="Allow plain HTTP"
        labelWidth={18}
        interactive
        tooltip="Only enable for trusted lab stations on isolated networks."
      >
        <Checkbox
          id="config-editor-allow-plain-http"
          value={Boolean(jsonData.allowPlainHttp)}
          onChange={onAllowPlainHttpChange}
        />
      </InlineField>
      <InlineField label="Timeout seconds" labelWidth={18} interactive>
        <Input
          id="config-editor-timeout-sec"
          onChange={onTimeoutSecChange}
          value={jsonData.timeoutSec || 30}
          type="number"
          min={1}
          width={12}
        />
      </InlineField>
      <InlineField label="Max history records" labelWidth={18} interactive>
        <Input
          id="config-editor-max-history-records"
          onChange={onMaxHistoryRecordsChange}
          value={jsonData.maxHistoryRecords || 5000}
          type="number"
          min={1}
          width={12}
        />
      </InlineField>
      <InlineField label="Max point ORDs" labelWidth={18} interactive>
        <Input
          id="config-editor-max-points-per-query"
          onChange={onMaxPointsPerQueryChange}
          value={jsonData.maxPointsPerQuery || 1000}
          type="number"
          min={1}
          width={12}
        />
      </InlineField>
      <InlineField
        label="Max live lease"
        labelWidth={18}
        interactive
        tooltip="Seconds; capped by the station module limit."
      >
        <Input
          id="config-editor-max-live-lease-sec"
          onChange={onMaxLiveLeaseSecChange}
          value={jsonData.maxLiveLeaseSec || 300}
          type="number"
          min={1}
          width={12}
        />
      </InlineField>
    </>
  );
}
