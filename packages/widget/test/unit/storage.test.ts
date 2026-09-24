import type { ClickCounts } from '@appreciator/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cacheKey,
  configCacheKey,
  readCachedConfig,
  readCachedCounts,
  writeCachedConfig,
  writeCachedCounts,
} from '../../src/storage.js';
import { sampleConfig, sampleSvgSources } from './fake-server.js';

const COUNTS: ClickCounts = {
  totalCount: 4,
  maxClicks: 10,
  visitorCount: 1,
  visitorRemaining: 9,
  maxed: false,
};

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException('denied', 'SecurityError');
  };
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

describe('counts cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips counts per button and item', () => {
    writeCachedCounts('pk_1', 'a', COUNTS);
    writeCachedCounts('pk_1', 'b', { ...COUNTS, totalCount: 9 });

    expect(readCachedCounts('pk_1', 'a')).toEqual(COUNTS);
    expect(readCachedCounts('pk_1', 'b')?.totalCount).toBe(9);
    expect(readCachedCounts('pk_2', 'a')).toBeNull();
  });

  it('ignores corrupt or foreign values', () => {
    localStorage.setItem(cacheKey('pk_1', 'a'), '{not json');
    localStorage.setItem(cacheKey('pk_1', 'b'), JSON.stringify({ totalCount: 'many' }));

    expect(readCachedCounts('pk_1', 'a')).toBeNull();
    expect(readCachedCounts('pk_1', 'b')).toBeNull();
  });

  it('degrades to no cache when storage throws', () => {
    expect(() => writeCachedCounts('pk_1', 'a', COUNTS, throwingStorage())).not.toThrow();
    expect(readCachedCounts('pk_1', 'a', throwingStorage())).toBeNull();
    expect(readCachedCounts('pk_1', 'a', null)).toBeNull();
  });
});

describe('config cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a config per button, with or without per-state icons', () => {
    writeCachedConfig('pk_1', sampleConfig());
    writeCachedConfig('pk_2', sampleConfig({ svgSources: sampleSvgSources() }));

    expect(readCachedConfig('pk_1')).toEqual(sampleConfig());
    expect(readCachedConfig('pk_2')?.svgSources).toEqual(sampleSvgSources());
    expect(readCachedConfig('pk_3')).toBeNull();
  });

  it('ignores corrupt or foreign values', () => {
    localStorage.setItem(configCacheKey('pk_1'), '{nope');
    localStorage.setItem(configCacheKey('pk_2'), JSON.stringify({ ...sampleConfig(), colors: {} }));

    expect(readCachedConfig('pk_1')).toBeNull();
    expect(readCachedConfig('pk_2')).toBeNull();
  });

  it('degrades to no cache when storage throws', () => {
    expect(() => writeCachedConfig('pk_1', sampleConfig(), throwingStorage())).not.toThrow();
    expect(readCachedConfig('pk_1', throwingStorage())).toBeNull();
  });
});
