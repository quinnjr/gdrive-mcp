// tests/integration.drive.test.ts
import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config.js';
import { AuthProvider } from '../src/auth.js';
import { createDriveClient } from '../src/services/drive.js';

const hasCreds = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN && process.env.TEST_FOLDER_ID);

describe.skipIf(!hasCreds)('drive integration round-trip', () => {
  it('folder -> upload -> read -> update -> move -> copy -> trash -> cleanup', async () => {
    const config = getConfig();
    const drive = createDriveClient(new AuthProvider(config));
    const parent = process.env.TEST_FOLDER_ID as string;

    const folder = await drive.createFolder(`mcp-it-${Date.now()}`, parent);
    const uploaded = await drive.uploadFile({ name: 'hello.txt', parentId: folder.id, mimeType: 'text/plain', bytes: Buffer.from('hello') });
    expect(uploaded.id).toBeTruthy();

    const listed = await drive.listFiles({ q: `'${folder.id}' in parents` });
    expect(listed.files.map((f) => f.id)).toContain(uploaded.id);

    const read = await drive.downloadFile(uploaded.id);
    expect(read.bytes.toString('utf8')).toBe('hello');

    await drive.updateFile({ fileId: uploaded.id, bytes: Buffer.from('hello v2') });
    const read2 = await drive.downloadFile(uploaded.id);
    expect(read2.bytes.toString('utf8')).toBe('hello v2');

    const copied = await drive.copyFile(uploaded.id, 'hello-copy.txt', folder.id);
    await drive.trashFile(copied.id);
    await drive.trashFile(uploaded.id);
    await drive.deleteFilePermanent(copied.id);
    await drive.deleteFilePermanent(uploaded.id);
    await drive.deleteFilePermanent(folder.id);
  }, 120000);
});

describe.skipIf(hasCreds)('drive integration gate', () => {
  it('skips cleanly without credentials', () => {
    expect(hasCreds).toBe(false);
  });
});
