// tests/tools.read.test.ts
import { describe, expect, it } from 'vitest';
import type { DriveClient } from '../src/services/drive.js';
import { clientForToolTests, toolTextContent } from './helpers.js';

type ListFilesParams = Parameters<DriveClient['listFiles']>[0];

describe('read tools', () => {
  it('drive_search forwards query and returns files', async () => {
    const { client } = await clientForToolTests();
    const res = await client.callTool({ name: 'drive_search', arguments: { q: "name='a'" } });
    expect(toolTextContent(res)).toContain('f1');
  });
  it('drive_read auto-exports a Google Doc to markdown', async () => {
    const { client } = await clientForToolTests({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
      exportFile: async () => ({ bytes: Buffer.from('# hi') }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'doc1' } });
    const payload = JSON.parse(toolTextContent(res));
    expect(payload.exportMime).toBe('text/markdown');
    expect(payload.text).toBe('# hi');
    expect(payload.exportedFrom).toBe('application/vnd.google-apps.document');
  });
  it('drive_read truncates large files with nextOffset', async () => {
    const { client } = await clientForToolTests({
      getFile: async (id: string) => ({ id, name: 'big.bin', mimeType: 'application/octet-stream', size: '16' }),
      downloadFile: async () => ({ bytes: Buffer.from('0123456789abcdef'), mimeType: 'application/octet-stream' }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'big', offset: 0, length: 10 } });
    expect(JSON.parse(toolTextContent(res))).toMatchObject({ truncated: true, nextOffset: 10, totalSize: 16, isBase64: true });
  });
  it('drive_read truncates Workspace textish exports with nextOffset', async () => {
    const buf = Buffer.from('abcdefghijklmnopqrstuvwxyz'); // 26 bytes
    const { client } = await clientForToolTests({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
      exportFile: async () => ({ bytes: buf }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'doc1', length: 10 } });
    expect(JSON.parse(toolTextContent(res))).toMatchObject({ truncated: true, nextOffset: 10, totalSize: 26, isBase64: false, text: 'abcdefghij' });
  });
  it('drive_read applies offset to Drawing exports', async () => {
    const full = Buffer.from('0123456789abcdef'); // 16 bytes; Drawing auto-exports to image/png (base64)
    const { client } = await clientForToolTests({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.drawing' }),
      exportFile: async () => ({ bytes: full }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'draw1', offset: 6, length: 4 } });
    const payload = JSON.parse(toolTextContent(res));
    expect(payload).toMatchObject({ isBase64: true, totalSize: 16, nextOffset: 10 });
    expect(payload.dataBase64).toBe(full.subarray(6, 10).toString('base64'));
  });
  it('drive_list defaults to root parents query', async () => {
    let seenQ: string | undefined;
    const { client } = await clientForToolTests({
      listFiles: async (p: ListFilesParams) => { seenQ = p.q; return { files: [{ id: 'f1', name: 'a.txt', mimeType: 'text/plain' }] }; },
    });
    const res = await client.callTool({ name: 'drive_list', arguments: {} });
    expect(toolTextContent(res)).toContain('f1');
    expect(seenQ).toBe("'root' in parents");
  });
  it('drive_list forwards folderId as quoted-parents query with pagination', async () => {
    let seen: ListFilesParams | undefined;
    const { client } = await clientForToolTests({
      listFiles: async (p: ListFilesParams) => { seen = p; return { files: [{ id: 'f1', name: 'a.txt', mimeType: 'text/plain' }] }; },
    });
    const res = await client.callTool({ name: 'drive_list', arguments: { folderId: 'folder123', pageSize: 5, pageToken: 'tok' } });
    expect(toolTextContent(res)).toContain('f1');
    expect(seen?.q).toBe("'folder123' in parents");
    expect(seen?.pageSize).toBe(5);
    expect(seen?.pageToken).toBe('tok');
  });
  it('drive_read enforces a custom inline cap', async () => {
    const cap = 1024 * 1024;
    const { client, config } = await clientForToolTests(
      {
        getFile: async (id: string) => ({ id, name: 'small.txt', mimeType: 'text/plain' }),
        downloadFile: async () => ({ bytes: Buffer.from('hello world'), mimeType: 'text/plain' }),
      },
      { DRIVE_INLINE_LIMIT_MB: '1' },
    );
    expect(config.inlineLimitBytes).toBe(cap);
    const ok = await client.callTool({ name: 'drive_read', arguments: { fileId: 'f1', length: cap - 1 } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.parse(toolTextContent(ok))).toMatchObject({ text: 'hello world', truncated: false });
    const over = await client.callTool({ name: 'drive_read', arguments: { fileId: 'f1', length: 2 * cap } });
    expect((over as { isError?: boolean }).isError).toBe(true);
    expect(toolTextContent(over)).toMatch(/maximum|invalid/i);
  });
  it('drive_export rejects disallowed mime with isError', async () => {
    const { client } = await clientForToolTests({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
    });
    const res = await client.callTool({ name: 'drive_export', arguments: { fileId: 'doc1', mimeType: 'image/png' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(toolTextContent(res)).toContain('INVALID_REQUEST');
  });
  it('drive_export paginates text export with offset/length', async () => {
    const { client } = await clientForToolTests({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
      exportFile: async () => ({ bytes: Buffer.from('abcdefghij') }),
    });
    const res = await client.callTool({ name: 'drive_export', arguments: { fileId: 'doc1', mimeType: 'text/markdown', offset: 2, length: 3 } });
    expect(JSON.parse(toolTextContent(res))).toMatchObject({ exportMime: 'text/markdown', text: 'cde', truncated: true, nextOffset: 5, totalSize: 10, isBase64: false });
  });
});
