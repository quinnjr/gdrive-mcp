// tests/auth.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { google } from 'googleapis';
import { AuthProvider, DRIVE_SCOPES } from '../src/auth.js';
import { getConfig } from '../src/config.js';
import { buildAuthUrl } from '../scripts/auth-setup.js';

const mocks = vi.hoisted(() => ({ failNextOAuth2Client: 0 }));

vi.mock('google-auth-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('google-auth-library')>();
  return {
    ...actual,
    OAuth2Client: class extends actual.OAuth2Client {
      constructor(...args: ConstructorParameters<typeof actual.OAuth2Client>) {
        if (mocks.failNextOAuth2Client > 0) {
          mocks.failNextOAuth2Client -= 1;
          throw new Error('mock OAuth2Client construction failure');
        }
        super(...args);
      }
    },
  };
});

afterEach(() => {
  mocks.failNextOAuth2Client = 0;
});

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
  it('shares one client across concurrent getDrive callers', async () => {
    const auth = new AuthProvider(config);
    const driveSpy = vi.spyOn(google, 'drive');
    try {
      const [d1, d2] = await Promise.all([auth.getDrive(), auth.getDrive()]);
      expect(typeof d1.files.list).toBe('function');
      expect(typeof d2.files.list).toBe('function');
      expect(driveSpy).toHaveBeenCalledTimes(2);
      const client = await auth.getClient();
      const authArg1 = (driveSpy.mock.calls[0]?.[0] as { auth?: unknown } | undefined)?.auth;
      const authArg2 = (driveSpy.mock.calls[1]?.[0] as { auth?: unknown } | undefined)?.auth;
      expect(authArg1).toBe(client);
      expect(authArg2).toBe(client);
    } finally {
      driveSpy.mockRestore();
    }
  });
  it('recovers after a client construction failure instead of caching the rejection', async () => {
    mocks.failNextOAuth2Client = 1;
    const auth = new AuthProvider(config);
    await expect(auth.getClient()).rejects.toThrow('mock OAuth2Client construction failure');
    const client = await auth.getClient();
    expect(client.credentials.refresh_token).toBe('rtok');
    await expect(auth.getClient()).resolves.toBe(client);
  });
  it('rejects all concurrent callers on construction failure and recovers on retry', async () => {
    mocks.failNextOAuth2Client = 2;
    const auth = new AuthProvider(config);
    const results = await Promise.allSettled([auth.getClient(), auth.getClient()]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    mocks.failNextOAuth2Client = 0;
    const client = await auth.getClient();
    expect(client.credentials.refresh_token).toBe('rtok');
    await expect(auth.getClient()).resolves.toBe(client);
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
