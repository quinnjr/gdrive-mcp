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

describe('sharing tools', () => {
  it('lists all 13 tools', async () => {
    const client = await clientFor();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['drive_search', 'drive_get', 'drive_list', 'drive_read', 'drive_export', 'drive_create_folder', 'drive_upload', 'drive_update', 'drive_delete', 'drive_move', 'drive_copy', 'drive_permissions', 'drive_list_drives']) {
      expect(names).toContain(n);
    }
    expect(tools).toHaveLength(13);
  });
  it('blocks owner transfer by default', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_permissions', arguments: { action: 'create', fileId: 'f1', role: 'owner', type: 'user', emailAddress: 'a@b.c' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res)).toContain('allowOwnershipTransfer');
  });
  it('rejects anyone/domain grantees at v1', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_permissions', arguments: { action: 'create', fileId: 'f1', role: 'reader', type: 'anyone' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
  it('requires permissionId for delete', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_permissions', arguments: { action: 'delete', fileId: 'f1' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
