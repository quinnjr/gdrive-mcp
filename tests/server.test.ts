import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConfig } from '../src/config.js';
import { AuthProvider } from '../src/auth.js';
import { createDriveClient } from '../src/services/drive.js';
import { createHttpApp, createMcpServer } from '../src/server.js';
import { createSessionStore } from '../src/transport.js';
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

  it('GET unknown session -> 400', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown session' });
  });

  it('DELETE unknown session -> 404', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'nope' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown session' });
  });

  it('POST makeServer throw -> 500 with secret redacted', async () => {
    const failing = createHttpApp(() => { throw new Error('boom ya29.test-secret-value'); }, config);
    const server = await new Promise<Server>((resolve) => {
      const s = failing.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('[REDACTED]');
      expect(JSON.stringify(body)).not.toContain('ya29.test-secret-value');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('GET transport throw -> 500 with secret redacted', async () => {
    const store = createSessionStore();
    store.transports.set('sess-1', { handleRequest: async () => { throw new Error('boom ya29.get-delete-secret'); } } as unknown as StreamableHTTPServerTransport);
    const throwing = createHttpApp(() => createMcpServer(deps()), config, store);
    const server: Server = await new Promise((resolve) => {
      const s = throwing.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': 'sess-1' },
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('[REDACTED]');
      expect(JSON.stringify(body)).not.toContain('ya29.get-delete-secret');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('DELETE transport throw -> 500 redacted, then session evicted -> 404', async () => {
    const store = createSessionStore();
    store.transports.set('sess-1', { handleRequest: async () => { throw new Error('boom ya29.get-delete-secret'); } } as unknown as StreamableHTTPServerTransport);
    const throwing = createHttpApp(() => createMcpServer(deps()), config, store);
    const server: Server = await new Promise((resolve) => {
      const s = throwing.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': 'sess-1' },
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('[REDACTED]');
      expect(JSON.stringify(body)).not.toContain('ya29.get-delete-secret');
      const retry = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': 'sess-1' },
      });
      expect(retry.status).toBe(404);
      expect(await retry.json()).toEqual({ error: 'unknown session' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe('API_KEY strict gate', () => {
  const keyedConfig = getConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', API_KEY: 'k' });
  const keyedDeps = (): ServerDeps => ({
    config: keyedConfig, auth: new AuthProvider(keyedConfig), drive: makeFakeDrive(),
  });
  const app = startTestApp(keyedDeps());
  afterAll(() => app.then((a) => a.close()));

  const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });

  it('unauthenticated POST /mcp -> 401', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: initBody,
    });
    expect(res.status).toBe(401);
  });

  it('wrong token POST /mcp -> 401', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer wrong' },
      body: initBody,
    });
    expect(res.status).toBe(401);
  });

  it('correct Bearer POST /mcp -> 200 with mcp-session-id', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer k' },
      body: initBody,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('GET /mcp without token -> 401', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /mcp without token -> 401', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'any' },
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /mcp with wrong token -> 401', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'any', authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /healthz stays open without token -> 200', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
