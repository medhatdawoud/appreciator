import { describe, expect, it } from 'vitest';

import {
  ItemKeyError,
  MAX_ITEM_KEY_LENGTH,
  normalizeItemKey,
} from '../../src/lib/url-normalize.js';

describe('normalizeItemKey', () => {
  describe('pathname mode', () => {
    it('drops the query string and fragment', () => {
      expect(normalizeItemKey('https://example.com/blog/post?utm_source=x#top', 'pathname')).toBe(
        'https://example.com/blog/post',
      );
    });

    it('keeps the origin so two sites do not share a counter', () => {
      expect(normalizeItemKey('https://a.example.com/post', 'pathname')).not.toBe(
        normalizeItemKey('https://b.example.com/post', 'pathname'),
      );
    });

    it('treats a trailing slash as the same page', () => {
      expect(normalizeItemKey('https://example.com/blog/post/', 'pathname')).toBe(
        normalizeItemKey('https://example.com/blog/post', 'pathname'),
      );
    });

    it('keeps the root path as /', () => {
      expect(normalizeItemKey('https://example.com/', 'pathname')).toBe('https://example.com/');
    });

    it('lowercases the host but not the path', () => {
      expect(normalizeItemKey('https://EXAMPLE.com/Blog/Post', 'pathname')).toBe(
        'https://example.com/Blog/Post',
      );
    });

    it('drops the default port', () => {
      expect(normalizeItemKey('https://example.com:443/post', 'pathname')).toBe(
        'https://example.com/post',
      );
    });

    it('keeps a non-default port', () => {
      expect(normalizeItemKey('http://example.com:8080/post', 'pathname')).toBe(
        'http://example.com:8080/post',
      );
    });

    it('percent-encodes non-ASCII path segments', () => {
      expect(normalizeItemKey('https://example.com/café', 'pathname')).toBe(
        'https://example.com/caf%C3%A9',
      );
    });

    it('distinguishes http from https', () => {
      expect(normalizeItemKey('http://example.com/post', 'pathname')).not.toBe(
        normalizeItemKey('https://example.com/post', 'pathname'),
      );
    });
  });

  describe('full mode', () => {
    it('keeps the query string and fragment', () => {
      expect(normalizeItemKey('https://example.com/search?q=cats#hit-3', 'full')).toBe(
        'https://example.com/search?q=cats#hit-3',
      );
    });

    it('separates pages that differ only by query string', () => {
      expect(normalizeItemKey('https://example.com/p?page=1', 'full')).not.toBe(
        normalizeItemKey('https://example.com/p?page=2', 'full'),
      );
    });

    it('still normalizes the origin', () => {
      expect(normalizeItemKey('https://EXAMPLE.com:443/p?a=1', 'full')).toBe(
        'https://example.com/p?a=1',
      );
    });
  });

  describe('opaque item ids', () => {
    it('passes a non-URL identifier through unchanged', () => {
      expect(normalizeItemKey('article-42', 'pathname')).toBe('article-42');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeItemKey('  article-42  ', 'pathname')).toBe('article-42');
    });

    it('does not treat a non-http scheme as a URL', () => {
      expect(normalizeItemKey('javascript:alert(1)', 'pathname')).toBe('javascript:alert(1)');
      expect(normalizeItemKey('file:///etc/passwd', 'pathname')).toBe('file:///etc/passwd');
    });
  });

  describe('rejections', () => {
    it('rejects an empty item', () => {
      expect(() => normalizeItemKey('', 'pathname')).toThrow(ItemKeyError);
      expect(() => normalizeItemKey('   ', 'pathname')).toThrow(ItemKeyError);
    });

    it('rejects a key longer than the column allows', () => {
      const long = `https://example.com/${'a'.repeat(MAX_ITEM_KEY_LENGTH)}`;
      expect(() => normalizeItemKey(long, 'pathname')).toThrow(ItemKeyError);
    });

    it('rejects a key that only exceeds the limit after percent-encoding', () => {
      // 200 non-ASCII characters fit in 200 chars raw, but expand past the
      // limit once encoded - which is why the check lives after normalization.
      const raw = `https://example.com/${'é'.repeat(200)}`;
      expect(raw.length).toBeLessThan(MAX_ITEM_KEY_LENGTH);
      expect(() => normalizeItemKey(raw, 'pathname')).toThrow(ItemKeyError);
    });

    it('accepts a key exactly at the limit', () => {
      const path = 'a'.repeat(MAX_ITEM_KEY_LENGTH - 'https://example.com/'.length);
      const key = normalizeItemKey(`https://example.com/${path}`, 'pathname');
      expect(key).toHaveLength(MAX_ITEM_KEY_LENGTH);
    });
  });
});
