import {
  CoreApp,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  LiveChannelScope,
  ScopedVars,
} from '@grafana/data';
import { DataSourceWithBackend, getGrafanaLiveSrv, getTemplateSrv } from '@grafana/runtime';
import { merge, Observable } from 'rxjs';

import {
  BaskStreamBrowseResponse,
  BaskStreamDataSourceOptions,
  BaskStreamDescribeHistoryResponse,
  BaskStreamDescribeResponse,
  BaskStreamQuery,
  BaskStreamSearchResponse,
  DEFAULT_QUERY,
} from './types';

export class DataSource extends DataSourceWithBackend<BaskStreamQuery, BaskStreamDataSourceOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<BaskStreamDataSourceOptions>) {
    super(instanceSettings);
  }

  getDefaultQuery(_: CoreApp): Partial<BaskStreamQuery> {
    return DEFAULT_QUERY;
  }

  searchPoints(query: string, base = 'slot:/Drivers'): Promise<BaskStreamSearchResponse> {
    const params = new URLSearchParams({
      query,
      base,
      features: 'point',
      operations: 'read',
      metadata: 'none',
    });
    return this.getResource(`/search?${params.toString()}`);
  }

  browse(base = 'slot:/Drivers', depth = 1): Promise<BaskStreamBrowseResponse> {
    const params = new URLSearchParams({
      base,
      depth: String(depth),
      metadata: 'none',
    });
    return this.getResource(`/browse?${params.toString()}`);
  }

  describe(ord: string): Promise<BaskStreamDescribeResponse> {
    return this.getResource(`/describe?ord=${encodeURIComponent(ord)}`);
  }

  describeHistory(ord: string): Promise<BaskStreamDescribeHistoryResponse> {
    return this.getResource(`/describe-history?ord=${encodeURIComponent(ord)}`);
  }

  query(request: DataQueryRequest<BaskStreamQuery>): Observable<DataQueryResponse> {
    const liveTargets = request.targets.filter((target) => target.mode === 'live');
    const backendTargets = request.targets.filter((target) => (target.mode || 'history') !== 'live');
    const streams = liveTargets.map((target, index) =>
      getGrafanaLiveSrv().getDataStream({
        addr: {
          scope: LiveChannelScope.DataSource,
          stream: this.uid,
          path: livePath(target, index),
          data: target,
        },
      })
    );

    if (backendTargets.length > 0) {
      streams.unshift(super.query({ ...request, targets: backendTargets }));
    }

    return merge(...streams);
  }

  applyTemplateVariables(query: BaskStreamQuery, scopedVars: ScopedVars) {
    return {
      ...query,
      ord: getTemplateSrv().replace(query.ord, scopedVars),
      alias: getTemplateSrv().replace(query.alias, scopedVars),
      ords: query.ords?.map((ord) => getTemplateSrv().replace(ord, scopedVars)),
    };
  }

  filterQuery(query: BaskStreamQuery): boolean {
    if ((query.mode || 'history') === 'history') {
      return !!query.ord;
    }
    return Array.isArray(query.ords) && query.ords.length > 0;
  }
}

export function livePath(query: BaskStreamQuery, index: number): string {
  const refId = query.refId || String(index);
  const ords = (query.ords || []).join('|');
  const leaseSec = query.leaseSec || 300;
  const hash = livePathHash(`${refId}\n${ords}\n${leaseSec}`);
  return `live/${encodeURIComponent(refId)}/${hash}/${leaseSec}`;
}

function livePathHash(value: string): string {
  let first = 2166136261;
  let second = 2166136261 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 16777619) ^ (first >>> 13);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}
