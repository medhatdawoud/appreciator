import type { ClickCounts } from '@appreciator/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheKey, readCachedCounts, writeCachedCounts } from '../../src/storage.js';

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
