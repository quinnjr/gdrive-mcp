import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { vi } from 'vitest';
import { AuthProvider } from '../src/auth.js';
import { getConfig, type Config } from '../src/config.js';
import { DriveError } from '../src/errors.js';
import type { DriveClient, DriveFile } from '../src/services/drive.js';
import { createHttpApp, createMcpServer } from '../src/server.js';
import type { ServerDeps } from '../src/tools/common.js';

export const CANNED_FILE: DriveFile = { id: 'f1', name: 'a.txt', mimeType: 'text/plain' };

export function makeFakeDrive(overrides: Partial<DriveClient> = {}): DriveClient & { calls: string[] } {
  const calls: string[] = [];
  const notFound = async (fileId = 'f1'): Promise<never> => { throw new DriveError('FILE_NOT_FOUND', `File not found: ${fileId}`, { fileId }); };
  const base: DriveClient = {
    listFiles: async () => { calls.push('listFiles'); return { files: [CANNED_FILE] }; },
    getFile: async (id) => { calls.push('getFile'); return { ...CANNED_FILE, id }; },
    downloadFile: async (id) => { calls.push('downloadFile'); await notFound(id); throw new Error('unreachable'); },
    exportFile: async () => { calls.push('exportFile'); return { bytes: Buffer.from('x') }; },
    createFolder: async (name) => { calls.push('createFolder'); return { id: 'new', name, mimeType: 'application/vnd.google-apps.folder' }; },
    uploadFile: async (p) => { calls.push('uploadFile'); return { id: 'new', name: p.name, mimeType: p.mimeType }; },
    updateFile: async (p) => { calls.push('updateFile'); return { ...CANNED_FILE, id: p.fileId }; },
    trashFile: async () => { calls.push('trashFile'); },
    deleteFilePermanent: async () => { calls.push('deleteFilePermanent'); },
    moveFile: async (id) => { calls.push('moveFile'); return { ...CANNED_FILE, id }; },
    copyFile: async (id) => { calls.push('copyFile'); return { ...CANNED_FILE, id: 'copy' }; },
    listPermissions: async () => { calls.push('listPermissions'); return []; },
    createPermission: async () => { calls.push('createPermission'); return { id: 'p1' }; },
    deletePermission: async () => { calls.push('deletePermission'); },
    listDrives: async () => { calls.push('listDrives'); return { drives: [] }; },
  };
  return Object.assign({ ...base, ...overrides }, { calls });
}

export async function clientForToolTests(
  overrides: Partial<DriveClient> = {},
  configOverrides: Record<string, string> = {},
): Promise<{ client: Client; drive: DriveClient & { calls: string[] }; config: Config }> {
  const config = getConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', ...configOverrides });
  const drive = makeFakeDrive(overrides);
  const server = createMcpServer({ config, auth: new AuthProvider(config), drive });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, drive, config };
}

export const toolTextContent = (r: unknown): string => (r as { content: [{ text: string }] }).content[0].text;

export function spyOnStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
}

export async function startTestApp(deps: ServerDeps): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app = createHttpApp(() => createMcpServer(deps), deps.config);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))) };
}
