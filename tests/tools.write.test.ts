import { describe, expect, it, vi } from 'vitest';
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

describe('write tools', () => {
  it('drive_upload decodes base64 and returns the new file', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_upload', arguments: { name: 'n.txt', contentBase64: Buffer.from('hi').toString('base64') } });
    expect(JSON.parse(text(res)).name).toBe('n.txt');
  });
  it('drive_delete refuses permanent without confirmPermanent', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_delete', arguments: { fileId: 'f1', permanent: true } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res)).toContain('confirmPermanent');
  });
  it('drive_delete trashes by default and routes permanent correctly', async () => {
    const drive = makeFakeDrive();
    const config = getConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
    const { createMcpServer: mk } = await import('../src/server.js');
    const server = mk({ config, auth: new AuthProvider(config), drive });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({ name: 'drive_delete', arguments: { fileId: 'f1' } });
    await client.callTool({ name: 'drive_delete', arguments: { fileId: 'f2', permanent: true, confirmPermanent: true } });
    expect(drive.calls).toContain('trashFile');
    expect(drive.calls).toContain('deleteFilePermanent');
  });
  it('drive_update allows metadata-only update', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_update', arguments: { fileId: 'f1', name: 'renamed' } });
    expect(JSON.parse(text(res)).id).toBe('f1');
  });
  it('emits an audit line on mutation', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    try {
      const client = await clientFor();
      await client.callTool({ name: 'drive_create_folder', arguments: { name: 'docs' } });
      expect(spy.mock.calls.some((c) => String(c[0]).includes('"tool":"drive_create_folder"'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
