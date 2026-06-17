import { BaskStreamQuery } from './types';
import { livePath } from './datasource';

function liveQuery(overrides: Partial<BaskStreamQuery> = {}): BaskStreamQuery {
  return {
    refId: 'A',
    mode: 'live',
    ords: ['slot:/Drivers/NiagaraNetwork/AHU_01/points/SpaceTemp'],
    ...overrides,
  };
}

describe('livePath', () => {
  it('keeps long point lists out of the Grafana Live path', () => {
    const longOrds = Array.from(
      { length: 30 },
      (_, index) => `slot:/Drivers/NiagaraNetwork/AHU_${index}/points/VeryLongSpaceTemperaturePointName`
    );

    const path = livePath(liveQuery({ ords: longOrds, leaseSec: 300 }), 0);

    expect(path).toMatch(/^live\/A\/[a-z0-9]+\/300$/);
    expect(path.length).toBeLessThan(80);
    expect(path).not.toContain('VeryLongSpaceTemperaturePointName');
  });

  it('is stable for the same query and changes when stream identity changes', () => {
    const query = liveQuery({ leaseSec: 300 });

    expect(livePath(query, 0)).toBe(livePath(query, 0));
    expect(livePath(query, 0)).not.toBe(livePath({ ...query, leaseSec: 301 }, 0));
  });
});
