import { afterAll, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config.js';
import { AuthProvider } from '../src/auth.js';
import { createDriveClient } from '../src/services/drive.js';
import { createMcpServer } from '../src/server.js';
import { makeFakeDrive, startTestApp } from './helpers.js';
import type { ServerDeps } from '../src/tools/common.js';

const config = getConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
const deps = (overrides = {}): ServerDeps => ({
  config, auth: new AuthProvider(config), drive: makeFakeDrive(overrides),
});

describe('Streamable HTTP contract', () => {
  const app = startTestApp(deps());
  afterAll(() => app.then((a) => a.close()));

  it('serves healthz', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('initialize -> tools/list contains drive_get -> bad call returns JSON-RPC error shape', async () => {
    const { baseUrl } = await app;
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const list = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId as string },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listJson = await list.json();
    expect(JSON.stringify(listJson)).toContain('drive_get');
    const bad = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId as string },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'drive_get', arguments: {} } }),
    });
    const badJson = await bad.json();
    expect(JSON.stringify(badJson)).toMatch(/isError|error/);
  });
});
