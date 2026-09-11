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
});
