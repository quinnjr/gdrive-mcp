// tests/auth.test.ts
import { describe, expect, it } from 'vitest';
import { AuthProvider, DRIVE_SCOPES } from '../src/auth.js';
import { getConfig } from '../src/config.js';
import { buildAuthUrl } from '../scripts/auth-setup.js';

const config = getConfig({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', GOOGLE_REFRESH_TOKEN: 'rtok' });

describe('AuthProvider', () => {
  it('caches one client across concurrent calls without network', async () => {
    const auth = new AuthProvider(config);
    const [a, b] = await Promise.all([auth.getClient(), auth.getClient()]);
    expect(a).toBe(b);
    expect(a.credentials.refresh_token).toBe('rtok');
  });
  it('hands out a drive client bound to that auth', async () => {
    const auth = new AuthProvider(config);
    const drive = await auth.getDrive();
    expect(typeof drive.files.list).toBe('function');
  });
  it('requests full drive scope', () => {
    expect(DRIVE_SCOPES).toEqual(['https://www.googleapis.com/auth/drive']);
  });
});

describe('buildAuthUrl', () => {
  it('encodes client id, redirect, and drive scope', () => {
    const url = buildAuthUrl('cid123', 'http://127.0.0.1:9999/oauth2callback');
    expect(url).toContain('cid123');
    expect(url).toContain(encodeURIComponent('https://www.googleapis.com/auth/drive'));
  });
});
