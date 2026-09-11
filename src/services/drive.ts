import { Readable } from 'node:stream';
import type { drive_v3 } from 'googleapis';
import type { AuthProvider } from '../auth.js';
import { isRetryableStatus, mapDriveError } from '../errors.js';

export const DEFAULT_FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,parents,trashed,owners,webViewLink';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile { id: string; name?: string; mimeType?: string; [k: string]: unknown }
export interface DriveClient {
  listFiles(p: { q?: string; pageSize?: number; pageToken?: string; orderBy?: string; driveId?: string }): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  getFile(fileId: string, fields?: string): Promise<DriveFile>;
  downloadFile(fileId: string): Promise<{ bytes: Buffer; mimeType: string; name?: string }>;
  exportFile(fileId: string, mimeType: string): Promise<{ bytes: Buffer }>;
  createFolder(name: string, parentId?: string): Promise<DriveFile>;
  uploadFile(p: { name: string; parentId?: string; mimeType?: string; bytes: Buffer }): Promise<DriveFile>;
  updateFile(p: { fileId: string; name?: string; mimeType?: string; bytes?: Buffer }): Promise<DriveFile>;
  trashFile(fileId: string): Promise<void>;
  deleteFilePermanent(fileId: string): Promise<void>;
  moveFile(fileId: string, addParents: string, removeParents?: string): Promise<DriveFile>;
  copyFile(fileId: string, name?: string, parentId?: string): Promise<DriveFile>;
  listPermissions(fileId: string): Promise<unknown[]>;
  createPermission(fileId: string, p: { role: string; type: string; emailAddress?: string }): Promise<unknown>;
  deletePermission(fileId: string, permissionId: string): Promise<void>;
  listDrives(pageSize?: number, pageToken?: string): Promise<{ drives: unknown[]; nextPageToken?: string }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransient(err: unknown): boolean {
  const e = (err ?? {}) as { response?: { status?: unknown }; code?: unknown };
  const status = typeof e.response?.status === 'number'
    ? e.response.status
    : typeof e.code === 'number' ? e.code : undefined;
  if (isRetryableStatus(status)) return true;
  return e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
}

export async function withRetry<T>(fn: () => Promise<T>, opts: { maxAttempts?: number; baseMs?: number } = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let last: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt === maxAttempts - 1 || !isTransient(err)) throw err;
      await sleep(baseMs * 2 ** attempt);
    }
  }
  throw last;
}

export function withTrashFilter(q: string): string {
  const t = q.trim();
  if (!t) return 'trashed=false';
  if (/(^|[\s(])trashed\s*=/.test(t)) return t;
  return `(${t}) and trashed=false`;
}

export function escapeQueryLiteral(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function toBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data as Uint8Array);
}

export function createDriveClient(auth: AuthProvider): DriveClient {
  const drive = (): Promise<drive_v3.Drive> => auth.getDrive();
  const run = <T>(fileId: string | undefined, fn: (d: drive_v3.Drive) => Promise<T>): Promise<T> =>
    withRetry(() => drive().then(fn)).catch((err) => { throw mapDriveError(err, fileId); });
  const SD = { supportsAllDrives: true } as const;

  return {
    async listFiles(p) {
      return run(undefined, async (d) => {
        const res = await d.files.list({
          ...SD,
          includeItemsFromAllDrives: true,
          q: withTrashFilter(p.q ?? ''),
          pageSize: p.pageSize ?? 20,
          pageToken: p.pageToken,
          orderBy: p.orderBy,
          driveId: p.driveId,
          corpora: p.driveId ? 'drive' : 'allDrives',
          fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,trashed)',
        });
        return { files: (res.data.files ?? []) as DriveFile[], nextPageToken: res.data.nextPageToken ?? undefined };
      });
    },
    async getFile(fileId, fields = DEFAULT_FILE_FIELDS) {
      return run(fileId, async (d) => (await d.files.get({ ...SD, fileId, fields })).data as DriveFile);
    },
    async downloadFile(fileId) {
      return run(fileId, async (d) => {
        const meta = (await d.files.get({ ...SD, fileId, fields: 'id,name,mimeType,size' })).data;
        const res = await d.files.get({ ...SD, fileId, alt: 'media' }, { responseType: 'arraybuffer' });
        return { bytes: toBuffer(res.data), mimeType: meta.mimeType ?? 'application/octet-stream', name: meta.name ?? undefined };
      });
    },
    async exportFile(fileId, mimeType) {
      return run(fileId, async (d) => ({ bytes: toBuffer((await d.files.export({ ...SD, fileId, mimeType })).data) }));
    },
    async createFolder(name, parentId) {
      return run(undefined, async (d) => (await d.files.create({ ...SD, requestBody: { name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined }, fields: DEFAULT_FILE_FIELDS })).data as DriveFile);
    },
    async uploadFile(p) {
      return run(undefined, async (d) => (await d.files.create({
        ...SD,
        requestBody: { name: p.name, parents: p.parentId ? [p.parentId] : undefined, mimeType: p.mimeType },
        media: { mimeType: p.mimeType ?? 'application/octet-stream', body: Readable.from([p.bytes]) },
        fields: DEFAULT_FILE_FIELDS,
      })).data as DriveFile);
    },
    async updateFile(p) {
      return run(p.fileId, async (d) => (await d.files.update({
        ...SD,
        fileId: p.fileId,
        requestBody: { name: p.name, mimeType: p.mimeType },
        media: p.bytes ? { mimeType: p.mimeType ?? 'application/octet-stream', body: Readable.from([p.bytes]) } : undefined,
        fields: DEFAULT_FILE_FIELDS,
      })).data as DriveFile);
    },
    async trashFile(fileId) {
      await run(fileId, async (d) => { await d.files.update({ ...SD, fileId, requestBody: { trashed: true } }); });
    },
    async deleteFilePermanent(fileId) {
      await run(fileId, async (d) => { await d.files.delete({ ...SD, fileId }); });
    },
    async moveFile(fileId, addParents, removeParents) {
      return run(fileId, async (d) => (await d.files.update({ ...SD, fileId, addParents, removeParents, fields: DEFAULT_FILE_FIELDS })).data as DriveFile);
    },
    async copyFile(fileId, name, parentId) {
      return run(fileId, async (d) => (await d.files.copy({ ...SD, fileId, requestBody: { name, parents: parentId ? [parentId] : undefined }, fields: DEFAULT_FILE_FIELDS })).data as DriveFile);
    },
    async listPermissions(fileId) {
      return run(fileId, async (d) => (await d.permissions.list({ ...SD, fileId, fields: 'permissions(id,type,role,emailAddress)' })).data.permissions ?? []);
    },
    async createPermission(fileId, p) {
      return run(fileId, async (d) => (await d.permissions.create({ ...SD, fileId, requestBody: { role: p.role, type: p.type, emailAddress: p.emailAddress }, fields: 'id,type,role,emailAddress' })).data);
    },
    async deletePermission(fileId, permissionId) {
      await run(fileId, async (d) => { await d.permissions.delete({ ...SD, fileId, permissionId }); });
    },
    // drives.list takes no supportsAllDrives param (amended plan rule: files.* + permissions.* only).
    async listDrives(pageSize = 20, pageToken) {
      return run(undefined, async (d) => {
        const res = await d.drives.list({ pageSize, pageToken, fields: 'nextPageToken,drives(id,name)' });
        return { drives: res.data.drives ?? [], nextPageToken: res.data.nextPageToken ?? undefined };
      });
    },
  };
}
