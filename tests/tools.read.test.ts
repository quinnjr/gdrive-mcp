// tests/tools.read.test.ts
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getConfig } from '../src/config.js';
import { AuthProvider } from '../src/auth.js';
import { createMcpServer } from '../src/server.js';
import { makeFakeDrive } from './helpers.js';

async function clientFor(overrides = {}) {
  const config = getConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
  const server = createMcpServer({ config, auth: new AuthProvider(config), drive: makeFakeDrive(overrides) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
const text = (r: unknown) => (r as { content: [{ text: string }] }).content[0].text;

describe('read tools', () => {
  it('drive_search forwards query and returns files', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_search', arguments: { q: "name='a'" } });
    expect(text(res)).toContain('f1');
  });
  it('drive_read auto-exports a Google Doc to markdown', async () => {
    const client = await clientFor({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
      exportFile: async () => ({ bytes: Buffer.from('# hi') }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'doc1' } });
    const payload = JSON.parse(text(res));
    expect(payload.exportMime).toBe('text/markdown');
    expect(payload.text).toBe('# hi');
    expect(payload.exportedFrom).toBe('application/vnd.google-apps.document');
  });
  it('drive_read truncates large files with nextOffset', async () => {
    const client = await clientFor({
      getFile: async (id: string) => ({ id, name: 'big.bin', mimeType: 'application/octet-stream', size: '16' }),
      downloadFile: async () => ({ bytes: Buffer.from('0123456789abcdef'), mimeType: 'application/octet-stream' }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'big', offset: 0, length: 10 } });
    expect(JSON.parse(text(res))).toMatchObject({ truncated: true, nextOffset: 10, totalSize: 16, isBase64: true });
  });
  it('drive_read truncates Workspace textish exports with nextOffset', async () => {
    const buf = Buffer.from('abcdefghijklmnopqrstuvwxyz'); // 26 bytes
    const client = await clientFor({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
      exportFile: async () => ({ bytes: buf }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'doc1', length: 10 } });
    expect(JSON.parse(text(res))).toMatchObject({ truncated: true, nextOffset: 10, totalSize: 26, isBase64: false, text: 'abcdefghij' });
  });
  it('drive_export rejects disallowed mime with isError', async () => {
    const client = await clientFor({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
    });
    const res = await client.callTool({ name: 'drive_export', arguments: { fileId: 'doc1', mimeType: 'image/png' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res)).toContain('INVALID_REQUEST');
  });
});
