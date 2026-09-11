import { describe, expect, it } from 'vitest';
import { clientForToolTests, spyOnStdout, toolTextContent } from './helpers.js';

describe('write tools', () => {
  it('drive_upload decodes base64 and returns the new file', async () => {
    const { client } = await clientForToolTests();
    const res = await client.callTool({ name: 'drive_upload', arguments: { name: 'n.txt', contentBase64: Buffer.from('hi').toString('base64') } });
    expect(JSON.parse(toolTextContent(res)).name).toBe('n.txt');
  });
  it('drive_delete refuses permanent without confirmPermanent', async () => {
    const { client } = await clientForToolTests();
    const res = await client.callTool({ name: 'drive_delete', arguments: { fileId: 'f1', permanent: true } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(toolTextContent(res)).toContain('confirmPermanent');
  });
  it('drive_delete trashes by default and routes permanent correctly', async () => {
    const { client, drive } = await clientForToolTests();
    await client.callTool({ name: 'drive_delete', arguments: { fileId: 'f1' } });
    await client.callTool({ name: 'drive_delete', arguments: { fileId: 'f2', permanent: true, confirmPermanent: true } });
    expect(drive.calls).toContain('trashFile');
    expect(drive.calls).toContain('deleteFilePermanent');
  });
  it('drive_update allows metadata-only update', async () => {
    const { client } = await clientForToolTests();
    const res = await client.callTool({ name: 'drive_update', arguments: { fileId: 'f1', name: 'renamed' } });
    expect(JSON.parse(toolTextContent(res)).id).toBe('f1');
  });
  it('drive_move forwards addParents/removeParents and emits an audit line', async () => {
    const spy = spyOnStdout();
    try {
      let seen: { fileId: string; addParents: string; removeParents?: string } | undefined;
      const { client } = await clientForToolTests({
        moveFile: async (fileId: string, addParents: string, removeParents?: string) => {
          seen = { fileId, addParents, removeParents };
          return { id: fileId, name: 'a.txt', mimeType: 'text/plain' };
        },
      });
      const res = await client.callTool({ name: 'drive_move', arguments: { fileId: 'f1', addParents: 'newParent', removeParents: 'oldParent' } });
      expect(seen).toEqual({ fileId: 'f1', addParents: 'newParent', removeParents: 'oldParent' });
      expect(JSON.parse(toolTextContent(res)).id).toBe('f1');
      expect(spy.mock.calls.some((c) => String(c[0]).includes('"tool":"drive_move"'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  it('drive_copy forwards name/parentId and emits audit with newFileId', async () => {
    const spy = spyOnStdout();
    try {
      let seen: { fileId: string; name?: string; parentId?: string } | undefined;
      const { client } = await clientForToolTests({
        copyFile: async (fileId: string, name?: string, parentId?: string) => {
          seen = { fileId, name, parentId };
          return { id: 'copy', name: name ?? 'a.txt', mimeType: 'text/plain' };
        },
      });
      const res = await client.callTool({ name: 'drive_copy', arguments: { fileId: 'f1', name: 'renamed.txt', parentId: 'newParent' } });
      expect(seen).toEqual({ fileId: 'f1', name: 'renamed.txt', parentId: 'newParent' });
      expect(JSON.parse(toolTextContent(res)).id).toBe('copy');
      const auditLine = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('"tool":"drive_copy"'));
      expect(auditLine).toBeDefined();
      expect(auditLine).toContain('"newFileId":"copy"');
    } finally {
      spy.mockRestore();
    }
  });
  it('emits an audit line on mutation', async () => {
    const spy = spyOnStdout();
    try {
      const { client } = await clientForToolTests();
      await client.callTool({ name: 'drive_create_folder', arguments: { name: 'docs' } });
      expect(spy.mock.calls.some((c) => String(c[0]).includes('"tool":"drive_create_folder"'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
