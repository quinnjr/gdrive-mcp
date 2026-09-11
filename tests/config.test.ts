import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config.js';

const base = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', GOOGLE_REFRESH_TOKEN: 'rtok' };

describe('getConfig', () => {
  it('reads required vars and applies defaults', () => {
    const c = getConfig({ ...base });
    expect(c.port).toBe(3000);
    expect(c.inlineLimitBytes).toBe(10 * 1024 * 1024);
    expect(c.apiKey).toBeNull();
  });
  it('throws naming the missing var', () => {
    expect(() => getConfig({ GOOGLE_CLIENT_ID: 'x' })).toThrow(/GOOGLE_CLIENT_SECRET/);
  });
  it('parses CORS_ORIGINS as a list', () => {
    expect(getConfig({ ...base, CORS_ORIGINS: 'https://a.example, https://b.example' }).corsOrigins)
      .toEqual(['https://a.example', 'https://b.example']);
  });
  it('rejects tiny inline limit that rounds to zero', () => {
    expect(() => getConfig({ ...base, DRIVE_INLINE_LIMIT_MB: '1e-7' })).toThrow(/out of range/);
  });
  it('rejects huge inline limit that overflows', () => {
    expect(() => getConfig({ ...base, DRIVE_INLINE_LIMIT_MB: '1e308' })).toThrow(/out of range/);
  });
  it('defaults maxDownloadBytes to 100MiB', () => {
    expect(getConfig({ ...base }).maxDownloadBytes).toBe(100 * 1024 * 1024);
  });
  it('parses custom DRIVE_MAX_DOWNLOAD_MB', () => {
    expect(getConfig({ ...base, DRIVE_MAX_DOWNLOAD_MB: '50' }).maxDownloadBytes).toBe(50 * 1024 * 1024);
  });
  it.each(['0', '-1', 'abc'])('rejects invalid DRIVE_MAX_DOWNLOAD_MB=%s', (v) => {
    expect(() => getConfig({ ...base, DRIVE_MAX_DOWNLOAD_MB: v })).toThrow(/DRIVE_MAX_DOWNLOAD_MB/);
  });
});
