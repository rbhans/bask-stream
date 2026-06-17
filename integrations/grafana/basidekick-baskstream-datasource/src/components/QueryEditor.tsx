import React, { ChangeEvent, useState } from 'react';
import { Button, Combobox, ComboboxOption, InlineField, Input, Stack } from '@grafana/ui';
import { QueryEditorProps } from '@grafana/data';
import { DataSource } from '../datasource';
import { BaskStreamDataSourceOptions, BaskStreamNode, BaskStreamQuery, BaskStreamQueryMode } from '../types';

type Props = QueryEditorProps<DataSource, BaskStreamQuery, BaskStreamDataSourceOptions>;

const modeOptions: Array<ComboboxOption<BaskStreamQueryMode>> = [
  { label: 'History', value: 'history' },
  { label: 'Snapshot', value: 'snapshot' },
  { label: 'Live', value: 'live' },
];

function parseOrds(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function nodeOrd(node: BaskStreamNode): string {
  return node.slotPath || node.ord || '';
}

function nodeLabel(node: BaskStreamNode): string {
  return node.display || node.name || nodeOrd(node);
}

function nodeCanUse(node: BaskStreamNode, mode: BaskStreamQueryMode): boolean {
  const operations = node.operations || [];
  return mode === 'history' ? operations.includes('read_history') : operations.includes('read');
}

export function QueryEditor({ datasource, query, onChange, onRunQuery }: Props) {
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<BaskStreamNode[]>([]);
  const [searchError, setSearchError] = useState('');
  const [browseBase, setBrowseBase] = useState('slot:/Drivers');
  const [browseNode, setBrowseNode] = useState<BaskStreamNode | undefined>();
  const [browseError, setBrowseError] = useState('');

  const onModeChange = (option: ComboboxOption<BaskStreamQueryMode>) => {
    onChange({ ...query, mode: option.value });
    onRunQuery();
  };

  const onOrdChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, ord: event.target.value });
  };

  const onOrdsChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, ords: parseOrds(event.target.value) });
  };

  const onAliasChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, alias: event.target.value });
  };

  const onLimitChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, limit: Number(event.target.value) || undefined });
    onRunQuery();
  };

  const onLeaseSecChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, leaseSec: Number(event.target.value) || undefined });
    onRunQuery();
  };

  const onSearchTermChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  };

  const onBrowseBaseChange = (event: ChangeEvent<HTMLInputElement>) => {
    setBrowseBase(event.target.value);
  };

  const runPointSearch = async () => {
    const term = searchTerm.trim();
    if (!term) {
      setSearchResults([]);
      setSearchError('');
      return;
    }
    try {
      const response = await datasource.searchPoints(term);
      setSearchResults(response.result?.nodes || []);
      setSearchError('');
    } catch (error) {
      setSearchResults([]);
      setSearchError(error instanceof Error ? error.message : String(error));
    }
  };

  const runBrowse = async (base = browseBase) => {
    const target = base.trim() || 'slot:/Drivers';
    try {
      const response = await datasource.browse(target, 1);
      setBrowseBase(target);
      setBrowseNode(response.node);
      setBrowseError('');
    } catch (error) {
      setBrowseNode(undefined);
      setBrowseError(error instanceof Error ? error.message : String(error));
    }
  };

  const mode = query.mode || 'history';
  const pointList = (query.ords || []).join('\n');

  const selectPoint = (node: BaskStreamNode) => {
    const ord = nodeOrd(node);
    if (!ord) {
      return;
    }
    if (mode === 'history') {
      onChange({ ...query, ord, alias: query.alias || nodeLabel(node) });
    } else {
      const ords = Array.from(new Set([...(query.ords || []), ord]));
      onChange({ ...query, ords, alias: query.alias || nodeLabel(node) });
    }
    onRunQuery();
  };

  return (
    <Stack gap={0}>
      <InlineField label="Mode" labelWidth={14} tooltip="history, snapshot, or live">
        <Combobox<BaskStreamQueryMode>
          id="query-editor-mode"
          onChange={onModeChange}
          value={mode}
          options={modeOptions}
          width={16}
        />
      </InlineField>
      {mode === 'history' && (
        <InlineField label="ORD" labelWidth={14}>
          <Input
            id="query-editor-ord"
            onChange={onOrdChange}
            value={query.ord || ''}
            required
            placeholder="slot:/Drivers/.../points/SpaceTemp"
            width={56}
          />
        </InlineField>
      )}
      {mode !== 'history' && (
        <InlineField label="Point ORDs" labelWidth={14}>
          <Input
            id="query-editor-ords"
            onChange={onOrdsChange}
            value={pointList}
            required
            placeholder="slot:/Drivers/.../points/SpaceTemp"
            width={56}
          />
        </InlineField>
      )}
      <InlineField label="Alias" labelWidth={14}>
        <Input
          id="query-editor-alias"
          onChange={onAliasChange}
          value={query.alias || ''}
          placeholder="Optional display name"
          width={32}
        />
      </InlineField>
      <InlineField label="Find points" labelWidth={14}>
        <Stack gap={0.5}>
          <Input
            id="query-editor-search"
            onChange={onSearchTermChange}
            value={searchTerm}
            placeholder="Search point display or name"
            width={32}
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => void runPointSearch()}>
            Search
          </Button>
        </Stack>
      </InlineField>
      {searchError && (
        <InlineField label="Search error" labelWidth={14}>
          <Input id="query-editor-search-error" value={searchError} readOnly width={56} />
        </InlineField>
      )}
      {searchResults.length > 0 && (
        <InlineField label="Results" labelWidth={14}>
          <div>
            {searchResults.slice(0, 10).map((node) => {
              const ord = nodeOrd(node);
              if (!nodeCanUse(node, mode)) {
                return null;
              }
              return (
                <Button key={ord} type="button" size="sm" variant="secondary" onClick={() => selectPoint(node)}>
                  {nodeLabel(node)}
                </Button>
              );
            })}
          </div>
        </InlineField>
      )}
      <InlineField label="Browse base" labelWidth={14}>
        <Stack gap={0.5}>
          <Input
            id="query-editor-browse-base"
            onChange={onBrowseBaseChange}
            value={browseBase}
            placeholder="slot:/Drivers"
            width={32}
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => void runBrowse()}>
            Browse
          </Button>
        </Stack>
      </InlineField>
      {browseError && (
        <InlineField label="Browse error" labelWidth={14}>
          <Input id="query-editor-browse-error" value={browseError} readOnly width={56} />
        </InlineField>
      )}
      {browseNode?.children && browseNode.children.length > 0 && (
        <InlineField label={nodeLabel(browseNode)} labelWidth={14}>
          <div>
            {browseNode.children.slice(0, 20).map((node) => {
              const ord = nodeOrd(node);
              return (
                <span key={ord || nodeLabel(node)}>
                  {node.hasChildren && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => void runBrowse(ord)}>
                      Open {nodeLabel(node)}
                    </Button>
                  )}
                  {nodeCanUse(node, mode) && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => selectPoint(node)}>
                      Use {nodeLabel(node)}
                    </Button>
                  )}
                </span>
              );
            })}
          </div>
        </InlineField>
      )}
      {mode === 'history' && (
        <InlineField label="Limit" labelWidth={14}>
          <Input
            id="query-editor-limit"
            onChange={onLimitChange}
            value={query.limit || 5000}
            type="number"
            min={1}
            width={12}
          />
        </InlineField>
      )}
      {mode === 'live' && (
        <InlineField label="Lease seconds" labelWidth={14}>
          <Input
            id="query-editor-lease-sec"
            onChange={onLeaseSecChange}
            value={query.leaseSec || 300}
            type="number"
            min={1}
            width={12}
          />
        </InlineField>
      )}
    </Stack>
  );
}
