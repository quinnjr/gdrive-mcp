import { describe, expect, it, vi } from 'vitest';

vi.mock('googleapis', () => {
  const calls: unknown[] = [];
  const files = {
    list: vi.fn(async (p: unknown) => { calls.push(['list', p]); return { data: { files: [{ id: 'f1' }], nextPageToken: 'npt' } }; }),
    get: vi.fn(async (p: unknown) => { calls.push(['get', p]); if ((p as { alt?: string })?.alt === 'media') return { data: 'bytes' }; return { data: { id: 'f1', name: 'a.txt', mimeType: 'text/plain' } }; }),
    create: vi.fn(async (p: unknown) => { calls.push(['create', p]); return { data: { id: 'f1', name: 'a.txt' } }; }),
    update: vi.fn(async (p: unknown) => { calls.push(['update', p]); return { data: { id: 'f1', name: 'a.txt' } }; }),
    delete: vi.fn(async (p: unknown) => { calls.push(['delete', p]); return { data: {} }; }),
    copy: vi.fn(async (p: unknown) => { calls.push(['copy', p]); return { data: { id: 'f1', name: 'a.txt' } }; }),
    export: vi.fn(async (p: unknown) => { calls.push(['export', p]); return { data: 'exported' }; }),
  };
  const permissions = {
    list: vi.fn(async (p: unknown) => { calls.push(['permissions.list', p]); return { data: { permissions: [{ id: 'p1' }] } }; }),
    create: vi.fn(async (p: unknown) => { calls.push(['permissions.create', p]); return { data: { id: 'p1' } }; }),
    delete: vi.fn(async (p: unknown) => { calls.push(['permissions.delete', p]); return {}; }),
  };
  const drives = {
    list: vi.fn(async (p: unknown) => { calls.push(['drives.list', p]); return { data: { drives: [{ id: 'd1' }] } }; }),
  };
  return { google: { drive: vi.fn(() => ({ files, permissions, drives })) }, __calls: calls };
});

import { google } from 'googleapis';
import { createDriveClient, escapeQueryLiteral, withRetry, withTrashFilter } from '../src/services/drive.js';
import type { AuthProvider } from '../src/auth.js';

const auth = { getDrive: async () => (google.drive as () => unknown)() } as unknown as AuthProvider;

describe('withRetry', () => {
  it('retries retryable failures then succeeds', async () => {
    let n = 0;
    const r = await withRetry(async () => {
      n += 1;
      if (n < 3) throw { response: { status: 503 } };
      return 'ok';
    }, { baseMs: 1 });
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
  it('does not retry 404', async () => {
    let n = 0;
    await expect(withRetry(async () => { n += 1; throw { response: { status: 404 } }; }, { baseMs: 1 })).rejects.toMatchObject({ response: { status: 404 } });
    expect(n).toBe(1);
  });
});

describe('query helpers', () => {
  it('withTrashFilter defaults and wraps', () => {
    expect(withTrashFilter('')).toBe('trashed=false');
    expect(withTrashFilter("name='a'")).toBe("(name='a') and trashed=false");
    expect(withTrashFilter('trashed=true')).toBe('trashed=true');
  });
  it('escapeQueryLiteral escapes quotes', () => {
    expect(escapeQueryLiteral("a'b")).toBe("a\\'b");
  });
});

describe('createDriveClient', () => {
  it('list passes shared-drive flags and trash filter', async () => {
    const c = createDriveClient(auth);
    const res = await c.listFiles({ q: "name='a'" });
    expect(res.files[0]?.id).toBe('f1');
    expect(res.nextPageToken).toBe('npt');
    const params = (google.drive as ReturnType<typeof vi.fn>).mock.results[0]?.value.files.list.mock.calls[0][0];
    expect(params.supportsAllDrives).toBe(true);
    expect(params.includeItemsFromAllDrives).toBe(true);
    expect(params.q).toContain('trashed=false');
  });
  describe('supportsAllDrives flags', () => {
    type MockMethod = { mock: { calls: unknown[][] } };
    type MockResource = Record<string, MockMethod>;
    type MockDrive = { files: MockResource; permissions: MockResource; drives: MockResource };
    type MockWithOnce = MockMethod & { mockImplementationOnce: (fn: (p: unknown) => Promise<unknown>) => unknown };
    const drv = () => (google.drive as unknown as { mock: { results: Array<{ value: MockDrive }> } }).mock.results.at(-1)?.value as MockDrive;
    // Shared mock fns are closure-singletons; calling google.drive() directly
    // returns them without recording a files.* call, so baselines work even
    // when mock.results is cleared between tests.
    const shared = () => (google.drive as unknown as () => MockDrive)();
    const lastParams = (obj: MockResource, method: string) => obj[method]?.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    it('getFile sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.get.mock.calls.length;
      await c.getFile('f1');
      expect(drv().files.get.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'get').supportsAllDrives).toBe(true);
    });

    it('downloadFile sets supportsAllDrives:true on metadata + media calls', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.get.mock.calls.length;
      const dl = await c.downloadFile('f1');
      expect(dl.bytes).toEqual(Buffer.from('bytes'));
      expect(dl.mimeType).toBe('text/plain');
      const dlCalls = drv().files.get.mock.calls.slice(before).map((a) => a[0] as Record<string, unknown>);
      expect(dlCalls).toHaveLength(2);
      for (const params of dlCalls) {
        expect(params.supportsAllDrives).toBe(true);
      }
      expect(dlCalls[0]).toHaveProperty('fields');
      expect(dlCalls[0]).not.toHaveProperty('alt');
      expect(dlCalls[1]).toMatchObject({ alt: 'media' });
    });

    it('downloadFile rejects over ceiling without media fetch', async () => {
      const c = createDriveClient(auth);
      const getMock = shared().files.get as unknown as MockWithOnce;
      getMock.mockImplementationOnce(async () => ({ data: { id: 'big', name: 'big.bin', mimeType: 'application/octet-stream', size: String(200 * 1024 * 1024) } }));
      const mediaBefore = shared().files.get.mock.calls.filter((a) => (a[0] as Record<string, unknown>)?.alt === 'media').length;
      await expect(c.downloadFile('big')).rejects.toThrow(/exceeds download ceiling/);
      const mediaAfter = drv().files.get.mock.calls.filter((a) => (a[0] as Record<string, unknown>)?.alt === 'media').length;
      expect(mediaAfter).toBe(mediaBefore);
    });

    it('exportFile sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.export.mock.calls.length;
      await c.exportFile('f1', 'text/plain');
      expect(drv().files.export.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'export').supportsAllDrives).toBe(true);
    });

    it('createFolder sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.create.mock.calls.length;
      await c.createFolder('new');
      expect(drv().files.create.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'create').supportsAllDrives).toBe(true);
    });

    it('uploadFile sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.create.mock.calls.length;
      await c.uploadFile({ name: 'a.txt', bytes: Buffer.from('hi') });
      expect(drv().files.create.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'create').supportsAllDrives).toBe(true);
    });

    it('updateFile sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.update.mock.calls.length;
      await c.updateFile({ fileId: 'f1', name: 'n' });
      expect(drv().files.update.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'update').supportsAllDrives).toBe(true);
    });

    it('trashFile sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.update.mock.calls.length;
      await c.trashFile('f1');
      expect(drv().files.update.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'update').supportsAllDrives).toBe(true);
    });

    it('deleteFilePermanent sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.delete.mock.calls.length;
      await c.deleteFilePermanent('f1');
      expect(drv().files.delete.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'delete').supportsAllDrives).toBe(true);
    });

    it('moveFile sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.update.mock.calls.length;
      await c.moveFile('f1', 'p1');
      expect(drv().files.update.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'update').supportsAllDrives).toBe(true);
    });

    it('copyFile sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.copy.mock.calls.length;
      await c.copyFile('f1', 'copy');
      expect(drv().files.copy.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'copy').supportsAllDrives).toBe(true);
    });

    it('listPermissions sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().permissions.list.mock.calls.length;
      await c.listPermissions('f1');
      expect(drv().permissions.list.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().permissions, 'list').supportsAllDrives).toBe(true);
    });

    it('createPermission sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().permissions.create.mock.calls.length;
      await c.createPermission('f1', { role: 'reader', type: 'user' });
      expect(drv().permissions.create.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().permissions, 'create').supportsAllDrives).toBe(true);
    });

    it('deletePermission sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().permissions.delete.mock.calls.length;
      await c.deletePermission('f1', 'p1');
      expect(drv().permissions.delete.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().permissions, 'delete').supportsAllDrives).toBe(true);
    });

    it('listFiles sets supportsAllDrives:true', async () => {
      const c = createDriveClient(auth);
      const before = shared().files.list.mock.calls.length;
      await c.listFiles({});
      expect(drv().files.list.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().files, 'list').supportsAllDrives).toBe(true);
      expect(lastParams(drv().files, 'list').includeItemsFromAllDrives).toBe(true);
    });

    it('listDrives omits supportsAllDrives', async () => {
      const c = createDriveClient(auth);
      const before = shared().drives.list.mock.calls.length;
      await c.listDrives();
      expect(drv().drives.list.mock.calls.length).toBe(before + 1);
      expect(lastParams(drv().drives, 'list')).not.toHaveProperty('supportsAllDrives');
    });
  });
});
