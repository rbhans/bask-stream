import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

export type BaskStreamQueryMode = 'history' | 'snapshot' | 'live';

export interface BaskStreamQuery extends DataQuery {
  mode: BaskStreamQueryMode;
  ord?: string;
  ords?: string[];
  alias?: string;
  limit?: number;
  fields?: string[];
  leaseSec?: number;
}

export const DEFAULT_QUERY: Partial<BaskStreamQuery> = {
  mode: 'history',
  limit: 5000,
  leaseSec: 300,
};

export interface BaskStreamDataSourceOptions extends DataSourceJsonData {
  stationUrl?: string;
  username?: string;
  tlsMode?: 'verify' | 'insecureSkipVerify';
  allowPlainHttp?: boolean;
  timeoutSec?: number;
  maxHistoryRecords?: number;
  maxPointsPerQuery?: number;
  maxLiveLeaseSec?: number;
}

export interface BaskStreamSecureJsonData {
  password?: string;
}

export interface BaskStreamNode {
  ord?: string;
  slotPath?: string;
  name?: string;
  display?: string;
  description?: string;
  typeSpec?: string;
  kind?: string;
  hasChildren?: boolean;
  features?: string[];
  operations?: string[];
  children?: BaskStreamNode[];
}

export interface BaskStreamSearchResponse {
  result?: {
    nodes?: BaskStreamNode[];
    count?: number;
    truncated?: boolean;
    truncatedReasons?: string[];
  };
}

export interface BaskStreamBrowseResponse {
  node?: BaskStreamNode;
}

export interface BaskStreamDescribeResponse {
  node?: BaskStreamNode;
}

export interface BaskStreamDescribeHistoryResponse {
  history?: unknown;
}
