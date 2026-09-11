import { describe, expect, it } from 'vitest';
import type { DriveClient } from '../src/services/drive.js';
import { clientForToolTests, toolTextContent } from './helpers.js';

type ListDrivesArgs = Parameters<DriveClient['listDrives']>;

describe('sharing tools', () => {
  it('lists all 13 tools', async () => {
    const { client } = await clientForToolTests();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['drive_search', 'drive_get', 'drive_list', 'drive_read', 'drive_export', 'drive_create_folder', 'drive_upload', 'drive_update', 'drive_delete', 'drive_move', 'drive_copy', 'drive_permissions', 'drive_list_drives']) {
      expect(names).toContain(n);
    }
    expect(tools).toHaveLength(13);
  });
  it('blocks owner transfer by default', async () => {
    const { client } = await clientForToolTests();
    const res = await client.callTool({ name: 'drive_permissions', arguments: { action: 'create', fileId: 'f1', role: 'owner', type: 'user', emailAddress: 'a@b.c' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(toolTextContent(res)).toContain('allowOwnershipTransfer');
  });
  it('rejects anyone/domain grantees at v1', async () => {
    const { client } = await clientForToolTests();
    const res = await client.callTool({ name: 'drive_permissions', arguments: { action: 'create', fileId: 'f1', role: 'reader', type: 'anyone' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
  it('requires permissionId for delete', async () => {
    const { client } = await clientForToolTests();
    const res = await client.callTool({ name: 'drive_permissions', arguments: { action: 'delete', fileId: 'f1' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
  it('drive_list_drives forwards pagination and returns drives payload', async () => {
    const seen: { pageSize?: number; pageToken?: string } = {};
    const { client } = await clientForToolTests({
      listDrives: async (...args: ListDrivesArgs) => {
        const [pageSize, pageToken] = args;
        seen.pageSize = pageSize;
        seen.pageToken = pageToken;
        return { drives: [{ id: 'sd1', name: 'Team Drive' }], nextPageToken: 'next123' };
      },
    });
    const res = await client.callTool({ name: 'drive_list_drives', arguments: { pageSize: 5, pageToken: 'tok123' } });
    expect(seen).toEqual({ pageSize: 5, pageToken: 'tok123' });
    expect(JSON.parse(toolTextContent(res))).toEqual({ drives: [{ id: 'sd1', name: 'Team Drive' }], nextPageToken: 'next123' });
  });
});
