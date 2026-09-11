import { describe, expect, it, vi } from 'vitest';

vi.mock('googleapis', () => {
  const calls: unknown[] = [];
  const files = {
    list: vi.fn(async (p: unknown) => { calls.push(['list', p]); return { data: { files: [{ id: 'f1' }], nextPageToken: 'npt' } }; }),
    get: vi.fn(async (p: unknown) => { calls.push(['get', p]); return { data: { id: 'f1', name: 'a.txt' } }; }),
  };
  return { google: { drive: vi.fn(() => ({ files })) }, __calls: calls };
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
});
