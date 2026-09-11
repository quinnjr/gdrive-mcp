# gdrive-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Google Drive MCP server from the spec as a working, tested TypeScript service.

**Architecture:** Layered service (Approach B): Express routes Streamable HTTP per-session MCP servers; tool modules orchestrate `DriveClient` / export / transfer services over `googleapis` drive v3; single-tenant OAuth via env refresh token.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@^1.30.0`, `googleapis@^180.0.0`, `google-auth-library@^11.0.2`, `zod@^3.25.76` (v3 required — MCP SDK v1 is incompatible with zod v4), `express@^4.22.2`, `vitest@^5.0.0`, `tsx@^4.23.13`, Node >= 22.

**Spec:** `docs/superpowers/specs/2026-09-11-gdrive-mcp-design.md`

## Global Constraints

- Transport is Streamable HTTP only (`POST`/`GET`/`DELETE /mcp`); no stdio, no legacy SSE routes.
- Single-user OAuth: credentials come only from `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` env vars; no auth tools exposed over MCP.
- Full `drive` scope; every list/search/get/create/update call sets `supportsAllDrives: true`; list/search set `includeItemsFromAllDrives: true` and default to excluding trash.
- `drive_upload` / `drive_update` accept `contentText` XOR `contentBase64`, never both, never multipart.
- `drive_delete` trashes by default; permanent delete requires `permanent: true` AND `confirmPermanent: true`.
- `drive_permissions` create blocks `role: "owner"` unless `allowOwnershipTransfer: true`; v1 grantee `type` is `user` or `group` only.
- `drive_read` inlines at most `DRIVE_INLINE_LIMIT_MB` (default 10) MiB, else returns `truncated: true` with `nextOffset`.
- No tool output or error message may contain credential values.
- Every mutating tool emits one JSON audit line to stdout.
- TDD for every task: failing test first, then minimal implementation, then green run, then commit.

## Locked decomposition decisions (refinements of spec §10)

- Spec §12.1 → **Express 4** (`express@^4.22.2`, `@types/express@^4.17.21`).
- Spec §12.2 → **console JSON-line logging**, no pino dependency (YAGNI; stdout is free since transport is HTTP-only).
- Spec §12.3 → permissions stay **user/group-only** at v1.
- Tool modules are grouped by responsibility into `src/tools/read.ts`, `src/tools/write.ts`, `src/tools/sharing.ts` (instead of 13 one-tool files — files that change together live together).
- A fresh `McpServer` is created per Streamable HTTP session via `createMcpServer(deps)` (shared `deps`), because `Server.connect()` to multiple transports is not a supported pattern; session state stays in the `SessionStore` map only.
- `tsc` compiles `src`, `tests`, `scripts` to `dist/` (single tsconfig); runtime entry is `dist/src/main.js`; `scripts/auth-setup.ts` also runs via `tsx` without compiling.

## File inventory (final state)

```
package.json  tsconfig.json  vitest.config.ts  .gitignore  .env.example  Dockerfile  README.md
src/config.ts  src/errors.ts  src/auth.ts  src/transport.ts  src/server.ts  src/main.ts
src/services/drive.ts  src/services/exports.ts  src/services/transfers.ts
src/tools/common.ts  src/tools/read.ts  src/tools/write.ts  src/tools/sharing.ts
scripts/auth-setup.ts
tests/helpers.ts  tests/config.test.ts  tests/errors.test.ts  tests/auth.test.ts
tests/drive.test.ts  tests/exports.test.ts  tests/transfers.test.ts
tests/server.test.ts  tests/tools.read.test.ts  tests/tools.write.test.ts
tests/tools.sharing.test.ts  tests/integration.drive.test.ts
```

---

### Task 1: Scaffold, config, errors

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`, `src/errors.ts`, `tests/config.test.ts`, `tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Config { clientId: string; clientSecret: string; refreshToken: string; port: number; apiKey: string | null; inlineLimitBytes: number; logLevel: string; corsOrigins: string[] }`
  - `getConfig(env?: NodeJS.ProcessEnv): Config` — throws `Error` naming the missing var; `PORT` default `3000`; `DRIVE_INLINE_LIMIT_MB` default `10`.
  - `type DriveErrorCode = 'FILE_NOT_FOUND' | 'PERMISSION_DENIED' | 'RETRYABLE' | 'INVALID_REQUEST' | 'UNKNOWN'`
  - `class DriveError extends Error { code: DriveErrorCode; fileId?: string; retryAfterMs?: number }`
  - `isRetryableStatus(status?: number): boolean` — true for 429 or >= 500.
  - `mapDriveError(err: unknown, fileId?: string): DriveError` — reads Gaxios-style `err.response.status` / numeric `err.code`; 404 → `FILE_NOT_FOUND`, 403 → `PERMISSION_DENIED` (message + `Check sharing / Shared Drive access.` hint), 429/5xx → `RETRYABLE` (parses `err.response.headers['retry-after']` seconds → ms), else `UNKNOWN`.

- [ ] **Step 1: Initial git commit of spec docs, then feature branch**

```bash
git add docs && git commit -m "docs: add gdrive mcp design spec and plan" && git checkout -b feature/gdrive-mcp-server
```
Expected: new branch `feature/gdrive-mcp-server`; all later task commits land here, never on `develop`.

- [ ] **Step 2: Write `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`**

```json
{
  "name": "gdrive-mcp",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "start": "node dist/src/main.js",
    "test": "vitest run",
    "test:integration": "vitest run tests/integration.drive.test.ts",
    "typecheck": "tsc --noEmit",
    "auth:setup": "tsx scripts/auth-setup.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "express": "^4.22.2",
    "google-auth-library": "^11.0.2",
    "googleapis": "^180.0.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.20.2",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30000 } });
```

```
# .gitignore
node_modules/
dist/
.env
```

```
# .env.example
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
PORT=3000
API_KEY=
DRIVE_INLINE_LIMIT_MB=10
LOG_LEVEL=info
CORS_ORIGINS=
```

- [ ] **Step 3: Write failing tests for config and errors**

```ts
// tests/config.test.ts
import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config.js';

const base = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', GOOGLE_REFRESH_TOKEN: 'rtok' };

describe('getConfig', () => {
  it('reads required vars and applies defaults', () => {
    const c = getConfig({ ...base });
    expect(c.port).toBe(3000);
    expect(c.inlineLimitBytes).toBe(10 * 1024 * 1024);
    expect(c.apiKey).toBeNull();
  });
  it('throws naming the missing var', () => {
    expect(() => getConfig({ GOOGLE_CLIENT_ID: 'x' })).toThrow(/GOOGLE_CLIENT_SECRET/);
  });
  it('parses CORS_ORIGINS as a list', () => {
    expect(getConfig({ ...base, CORS_ORIGINS: 'https://a.example, https://b.example' }).corsOrigins)
      .toEqual(['https://a.example', 'https://b.example']);
  });
});
```

```ts
// tests/errors.test.ts
import { describe, expect, it } from 'vitest';
import { DriveError, isRetryableStatus, mapDriveError } from '../src/errors.js';

describe('mapDriveError', () => {
  it('maps 404 with fileId', () => {
    const e = mapDriveError({ response: { status: 404 } }, 'fid123');
    expect(e).toBeInstanceOf(DriveError);
    expect(e.code).toBe('FILE_NOT_FOUND');
    expect(e.message).toContain('fid123');
  });
  it('maps 403 with sharing hint', () => {
    expect(mapDriveError({ response: { status: 403 } }).message).toContain('Shared Drive');
  });
  it('maps 429 with retry-after header', () => {
    const e = mapDriveError({ response: { status: 429, headers: { 'retry-after': '7' } } });
    expect(e.code).toBe('RETRYABLE');
    expect(e.retryAfterMs).toBe(7000);
  });
  it('never leaks credential values', () => {
    const e = mapDriveError(new Error('boom GOOGLE_REFRESH_TOKEN=secret-value-xyz'));
    expect(e.message).not.toContain('secret-value-xyz');
  });
});

describe('isRetryableStatus', () => {
  it('flags 429 and 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm install && npx vitest run tests/config.test.ts tests/errors.test.ts`
Expected: FAIL with "Failed to resolve import" / "Cannot find module" for `../src/config.js` and `../src/errors.js`.

- [ ] **Step 5: Write minimal implementation**

```ts
// src/config.ts
export interface Config {
  clientId: string; clientSecret: string; refreshToken: string; port: number;
  apiKey: string | null; inlineLimitBytes: number; logLevel: string; corsOrigins: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid PORT: must be a positive integer');
  const mb = env.DRIVE_INLINE_LIMIT_MB === undefined || env.DRIVE_INLINE_LIMIT_MB === '' ? 10 : Number(env.DRIVE_INLINE_LIMIT_MB);
  if (!Number.isFinite(mb) || mb <= 0) throw new Error('Invalid DRIVE_INLINE_LIMIT_MB: must be a positive number');
  return {
    clientId: required(env, 'GOOGLE_CLIENT_ID'),
    clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
    refreshToken: required(env, 'GOOGLE_REFRESH_TOKEN'),
    port,
    apiKey: env.API_KEY ? env.API_KEY : null,
    inlineLimitBytes: Math.round(mb * 1024 * 1024),
    logLevel: env.LOG_LEVEL || 'info',
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
```

```ts
// src/errors.ts
export type DriveErrorCode = 'FILE_NOT_FOUND' | 'PERMISSION_DENIED' | 'RETRYABLE' | 'INVALID_REQUEST' | 'UNKNOWN';

export class DriveError extends Error {
  code: DriveErrorCode;
  fileId?: string;
  retryAfterMs?: number;
  constructor(code: DriveErrorCode, message: string, opts: { fileId?: string; retryAfterMs?: number } = {}) {
    super(scrub(message));
    this.name = 'DriveError';
    this.code = code;
    this.fileId = opts.fileId;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const SECRET_PATTERNS = [/AIza[0-9A-Za-z_-]{10,}/g, /ya29\.[0-9A-Za-z_-]+/g, /1\/\/[0-9A-Za-z_-]+/g];

export function scrub(message: string): string {
  let out = message;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function isRetryableStatus(status?: number): boolean {
  return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
}

interface GaxiosLike { response?: { status?: number; headers?: Record<string, string> }; code?: number | string; message?: string }

export function mapDriveError(err: unknown, fileId?: string): DriveError {
  if (err instanceof DriveError) return err;
  const e = (err || {}) as GaxiosLike;
  const status = e.response?.status ?? (typeof e.code === 'number' ? e.code : undefined);
  const raw = typeof (err as Error)?.message === 'string' ? (err as Error).message : String(err);
  if (status === 404) return new DriveError('FILE_NOT_FOUND', `File not found: ${fileId ?? '(unknown id)'}`, { fileId });
  if (status === 403) return new DriveError('PERMISSION_DENIED', `Permission denied${fileId ? ` for file ${fileId}` : ''}. Check sharing / Shared Drive access.`, { fileId });
  if (isRetryableStatus(status)) {
    const ra = e.response?.headers?.['retry-after'];
    const retryAfterMs = ra !== undefined && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : undefined;
    return new DriveError('RETRYABLE', `Drive API temporarily unavailable (status ${status}). Retry${retryAfterMs ? ` after ${retryAfterMs}ms` : ''}.`, { fileId, retryAfterMs });
  }
  return new DriveError('UNKNOWN', raw, { fileId });
}
```

Note: the 403 hint text must contain the literal `Shared Drive` (test asserts it); the leak test passes because `secret-value-xyz` matches no secret pattern — fix: `scrub` must also redact long opaque tokens. The test message `boom GOOGLE_REFRESH_TOKEN=secret-value-xyz` contains `secret-value-xyz` (16 chars). Add generic pattern: any `KEY=token` value after `=` with 12+ non-space chars → redact value. Implement in final code as:

```ts
out = out.replace(/=((?:[A-Za-z0-9_.\-/+]){12,})/g, '=[REDACTED]');
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/errors.test.ts && npx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts src/errors.ts tests/config.test.ts tests/errors.test.ts && git commit -m "feat: scaffold project with config and error mapping"
```

---

### Task 2: Auth provider and auth-setup script

**Files:**
- Create: `src/auth.ts`, `scripts/auth-setup.ts`, `tests/auth.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1.
- Produces:
  - `DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive']`
  - `class AuthProvider { constructor(config: Config); getClient(): Promise<OAuth2Client>; getDrive(): Promise<drive_v3.Drive> }` — single cached client; concurrent `getClient()` calls share one init promise (mutex); no network on construction.
  - `buildAuthUrl(clientId: string, redirectUri: string): string` (exported from `scripts/auth-setup.ts` for testability).

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth.test.ts
import { describe, expect, it } from 'vitest';
import { AuthProvider, DRIVE_SCOPES } from '../src/auth.js';
import { getConfig } from '../src/config.js';
import { buildAuthUrl } from '../scripts/auth-setup.js';

const config = getConfig({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', GOOGLE_REFRESH_TOKEN: 'rtok' });

describe('AuthProvider', () => {
  it('caches one client across concurrent calls without network', async () => {
    const auth = new AuthProvider(config);
    const [a, b] = await Promise.all([auth.getClient(), auth.getClient()]);
    expect(a).toBe(b);
    expect(a.credentials.refresh_token).toBe('rtok');
  });
  it('hands out a drive client bound to that auth', async () => {
    const auth = new AuthProvider(config);
    const drive = await auth.getDrive();
    expect(typeof drive.files.list).toBe('function');
  });
  it('requests full drive scope', () => {
    expect(DRIVE_SCOPES).toEqual(['https://www.googleapis.com/auth/drive']);
  });
});

describe('buildAuthUrl', () => {
  it('encodes client id, redirect, and drive scope', () => {
    const url = buildAuthUrl('cid123', 'http://127.0.0.1:9999/oauth2callback');
    expect(url).toContain('cid123');
    expect(url).toContain(encodeURIComponent('https://www.googleapis.com/auth/drive'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL — cannot find modules `../src/auth.js`, `../scripts/auth-setup.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth.ts
import { OAuth2Client } from 'google-auth-library';
import { drive_v3, google } from 'googleapis';
import type { Config } from './config.js';

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

export class AuthProvider {
  private client: OAuth2Client | null = null;
  private initPromise: Promise<OAuth2Client> | null = null;
  constructor(private readonly config: Config) {}

  getClient(): Promise<OAuth2Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const client = new OAuth2Client(this.config.clientId, this.config.clientSecret);
        client.setCredentials({ refresh_token: this.config.refreshToken });
        this.client = client;
        this.initPromise = null;
        return client;
      })();
    }
    return this.initPromise;
  }

  async getDrive(): Promise<drive_v3.Drive> {
    return google.drive({ version: 'v3', auth: await this.getClient() });
  }
}
```

```ts
// scripts/auth-setup.ts
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { DRIVE_SCOPES } from '../src/auth.js';

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const tmp = new OAuth2Client(clientId, 'unused-secret', redirectUri);
  return tmp.generateAuthUrl({ access_type: 'offline', scope: DRIVE_SCOPES, prompt: 'consent' });
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run auth:setup\n\nRequires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in env.\nPrints GOOGLE_REFRESH_TOKEN to stdout.');
    return;
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in env');
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  const code: string = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', redirectUri);
      const c = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.end(c ? 'OK — you can close this tab.' : 'Missing code param.');
      server.close();
      if (c) resolve(c);
      else reject(new Error(`OAuth failed: ${err ?? 'no code returned'}`));
    });
    console.log(`Open this URL in your browser:\n\n${buildAuthUrl(clientId, redirectUri)}\n`);
  });
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('No refresh_token returned. Remove app access at myaccount.google.com/permissions and retry.');
  console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
}

const isMain = process.argv[1]?.endsWith('auth-setup.ts') ?? false;
if (isMain) {
  main().catch((err) => { console.error(String((err as Error)?.message ?? err)); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth.test.ts && npx tsc --noEmit && npm run auth:setup -- --help`
Expected: PASS; typecheck clean; help text printed (proves the script loads without env).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts scripts/auth-setup.ts tests/auth.test.ts && git commit -m "feat: add single-user OAuth provider and auth setup script"
```

---

### Task 3: Drive service (API wrapper, retry, query helpers)

**Files:**
- Create: `src/services/drive.ts`, `tests/drive.test.ts`

**Interfaces:**
- Consumes: `AuthProvider` (Task 2), `mapDriveError`, `isRetryableStatus` (Task 1).
- Produces:
  - `DEFAULT_FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,parents,trashed,owners,webViewLink'`
  - `withRetry<T>(fn: () => Promise<T>, opts?: { maxAttempts?: number; baseMs?: number }): Promise<T>` — retries only retryable failures (status 429/5xx via `mapDriveError(...).code === 'RETRYABLE'`, or `ECONNRESET`/`ETIMEDOUT` codes); exponential backoff `baseMs * 2^attempt` (default base 500, max 3 attempts); rethrows last error.
  - `withTrashFilter(q: string): string` — `''` → `'trashed=false'`; query already mentioning `trashed` passes through; else `(<q>) and trashed=false`.
  - `escapeQueryLiteral(v: string): string` — escapes backslash and single-quote for Drive `q` literals.
  - `interface DriveClient` with exactly: `listFiles`, `getFile`, `downloadFile`, `exportFile`, `createFolder`, `uploadFile`, `updateFile`, `trashFile`, `deleteFilePermanent`, `moveFile`, `copyFile`, `listPermissions`, `createPermission`, `deletePermission`, `listDrives` (signatures below).
  - `createDriveClient(auth: AuthProvider): DriveClient` — every method wraps its `googleapis` call in `withRetry` and maps failures via `mapDriveError(err, fileId)`; every files/drives call sets `supportsAllDrives: true`; list/search set `includeItemsFromAllDrives: true`.

```ts
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
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/drive.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/drive.test.ts`
Expected: FAIL — cannot find module `../src/services/drive.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/drive.ts
import { Readable } from 'node:stream';
import type { drive_v3 } from 'googleapis';
import type { AuthProvider } from '../auth.js';
import { isRetryableStatus, mapDriveError } from '../errors.js';

export const DEFAULT_FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,parents,trashed,owners,webViewLink';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile { id: string; name?: string; mimeType?: string; [k: string]: unknown }
export interface DriveClient { /* exact interface from this task's Interfaces block — copy verbatim */ }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransient(err: unknown): boolean {
  const code = mapDriveError(err).code;
  if (code === 'RETRYABLE') return true;
  const c = (err as { code?: unknown })?.code;
  return c === 'ECONNRESET' || c === 'ETIMEDOUT';
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
      return run(fileId, async (d) => ({ bytes: toBuffer((await d.files.export({ fileId, mimeType })).data) }));
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
    async listDrives(pageSize = 20, pageToken) {
      return run(undefined, async (d) => {
        const res = await d.drives.list({ pageSize, pageToken, fields: 'nextPageToken,drives(id,name)' });
        return { drives: res.data.drives ?? [], nextPageToken: res.data.nextPageToken ?? undefined };
      });
    },
  };
}
```

(Replace the `interface DriveClient` placeholder comment with the exact interface from the Interfaces block above — no omissions.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/drive.test.ts && npx tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/drive.ts tests/drive.test.ts && git commit -m "feat: add Drive API wrapper with retry and shared-drive flags"
```

---

### Task 4: Export map and transfer helpers (pure logic)

**Files:**
- Create: `src/services/exports.ts`, `src/services/transfers.ts`, `tests/exports.test.ts`, `tests/transfers.test.ts`

**Interfaces:**
- Consumes: `DriveError` (Task 1).
- Produces:
  - `isWorkspaceMime(mime: string): boolean`
  - `autoExportMime(sourceMime: string): string | null` — Doc → `text/markdown`, Sheet → `text/csv`, Slides → `text/plain`, Drawing → `image/png`; anything else → `null`.
  - `allowedExportMimes(sourceMime: string): string[]` — exact table from spec §5 (Doc: markdown/plain/pdf; Sheet: csv/pdf/xlsx; Slides: plain/pdf; Drawing: png/pdf); unknown → `[]`.
  - `TEXTISH_RE: RegExp` — matches `text/*`, `application/json`, `application/xml`, `*+json`, `*+xml`, `image/svg+xml`, `application/javascript`.
  - `UPLOAD_RESUMABLE_BYTES = 5 * 1024 * 1024`; `selectUploadMode(byteLength: number): 'single' | 'resumable'`.
  - `decodeToolContent(input: { contentText?: string; contentBase64?: string }): { bytes: Buffer; isBase64: boolean }` — throws `DriveError(INVALID_REQUEST)` when both or neither are given, or when base64 is malformed.
  - `toInlinePayload(bytes: Buffer, mimeType: string, offset: number, limitBytes: number): { text?: string; dataBase64?: string; isBase64: boolean; truncated: boolean; nextOffset?: number; totalSize: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/exports.test.ts
import { describe, expect, it } from 'vitest';
import { allowedExportMimes, autoExportMime, isWorkspaceMime } from '../src/services/exports.js';

describe('workspace exports', () => {
  it('auto-exports docs, sheets, slides, drawings', () => {
    expect(autoExportMime('application/vnd.google-apps.document')).toBe('text/markdown');
    expect(autoExportMime('application/vnd.google-apps.spreadsheet')).toBe('text/csv');
    expect(autoExportMime('application/vnd.google-apps.presentation')).toBe('text/plain');
    expect(autoExportMime('application/vnd.google-apps.drawing')).toBe('image/png');
    expect(autoExportMime('application/pdf')).toBeNull();
  });
  it('lists explicit options per spec table', () => {
    expect(allowedExportMimes('application/vnd.google-apps.spreadsheet')).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(allowedExportMimes('application/pdf')).toEqual([]);
  });
  it('detects workspace mimes', () => {
    expect(isWorkspaceMime('application/vnd.google-apps.document')).toBe(true);
    expect(isWorkspaceMime('text/plain')).toBe(false);
  });
});
```

```ts
// tests/transfers.test.ts
import { describe, expect, it } from 'vitest';
import { decodeToolContent, selectUploadMode, toInlinePayload } from '../src/services/transfers.js';

describe('transfers', () => {
  it('selects resumable above 5MB', () => {
    expect(selectUploadMode(5 * 1024 * 1024)).toBe('single');
    expect(selectUploadMode(5 * 1024 * 1024 + 1)).toBe('resumable');
  });
  it('rejects both/neither content forms', () => {
    expect(() => decodeToolContent({})).toThrow(/contentText or contentBase64/);
    expect(() => decodeToolContent({ contentText: 'a', contentBase64: 'Yg==' })).toThrow(/only one/);
    expect(() => decodeToolContent({ contentBase64: '!!!' })).toThrow(/malformed/);
  });
  it('inlines text and truncates with continuation', () => {
    const bytes = Buffer.from('0123456789abcdef');
    const p = toInlinePayload(bytes, 'text/plain', 0, 10);
    expect(p).toMatchObject({ text: '0123456789', isBase64: false, truncated: true, nextOffset: 10, totalSize: 16 });
    const tail = toInlinePayload(bytes, 'text/plain', 10, 10);
    expect(tail).toMatchObject({ text: 'abcdef', truncated: false });
    expect(tail.nextOffset).toBeUndefined();
  });
  it('base64-encodes binary', () => {
    const p = toInlinePayload(Buffer.from([0xff, 0xd8]), 'image/png', 0, 1024);
    expect(p).toMatchObject({ isBase64: true, truncated: false });
    expect(typeof p.dataBase64).toBe('string');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/exports.test.ts tests/transfers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/exports.ts
export const WORKSPACE_PREFIX = 'application/vnd.google-apps.';
export const MIME_DOC = `${WORKSPACE_PREFIX}document`;
export const MIME_SHEET = `${WORKSPACE_PREFIX}spreadsheet`;
export const MIME_SLIDES = `${WORKSPACE_PREFIX}presentation`;
export const MIME_DRAWING = `${WORKSPACE_PREFIX}drawing`;

export function isWorkspaceMime(mime: string): boolean {
  return mime.startsWith(WORKSPACE_PREFIX);
}

const AUTO: Record<string, string> = {
  [MIME_DOC]: 'text/markdown',
  [MIME_SHEET]: 'text/csv',
  [MIME_SLIDES]: 'text/plain',
  [MIME_DRAWING]: 'image/png',
};

const ALLOWED: Record<string, string[]> = {
  [MIME_DOC]: ['text/markdown', 'text/plain', 'application/pdf'],
  [MIME_SHEET]: ['text/csv', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [MIME_SLIDES]: ['text/plain', 'application/pdf'],
  [MIME_DRAWING]: ['image/png', 'application/pdf'],
};

export function autoExportMime(sourceMime: string): string | null {
  return AUTO[sourceMime] ?? null;
}

export function allowedExportMimes(sourceMime: string): string[] {
  return ALLOWED[sourceMime] ? [...ALLOWED[sourceMime]] : [];
}
```

```ts
// src/services/transfers.ts
import { DriveError } from '../errors.js';

export const UPLOAD_RESUMABLE_BYTES = 5 * 1024 * 1024;

export const TEXTISH_RE = /^(text\/.*|application\/(json|xml|javascript|x-[^+]*\+json)|[^/]*\+(json|xml)|image\/svg\+xml)$/;

export function selectUploadMode(byteLength: number): 'single' | 'resumable' {
  return byteLength > UPLOAD_RESUMABLE_BYTES ? 'resumable' : 'single';
}

export function decodeToolContent(input: { contentText?: string; contentBase64?: string }): { bytes: Buffer; isBase64: boolean } {
  const { contentText, contentBase64 } = input;
  if (contentText !== undefined && contentBase64 !== undefined) {
    throw new DriveError('INVALID_REQUEST', 'Provide only one of contentText or contentBase64, not both.');
  }
  if (contentText !== undefined) return { bytes: Buffer.from(contentText, 'utf8'), isBase64: false };
  if (contentBase64 !== undefined) {
    const clean = contentBase64.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean) || clean.length === 0) {
      throw new DriveError('INVALID_REQUEST', 'contentBase64 is malformed: not valid base64.');
    }
    return { bytes: Buffer.from(clean, 'base64'), isBase64: true };
  }
  throw new DriveError('INVALID_REQUEST', 'Provide contentText or contentBase64.');
}

export interface InlinePayload {
  text?: string; dataBase64?: string; isBase64: boolean;
  truncated: boolean; nextOffset?: number; totalSize: number;
}

export function toInlinePayload(bytes: Buffer, mimeType: string, offset: number, limitBytes: number): InlinePayload {
  if (!Number.isInteger(offset) || offset < 0) throw new DriveError('INVALID_REQUEST', 'offset must be a non-negative integer.');
  const totalSize = bytes.length;
  const slice = bytes.subarray(Math.min(offset, totalSize), Math.min(offset + limitBytes, totalSize));
  const end = Math.min(offset, totalSize) + slice.length;
  const truncated = end < totalSize;
  const isBase64 = !TEXTISH_RE.test(mimeType);
  return {
    ...(isBase64 ? { dataBase64: slice.toString('base64') } : { text: slice.toString('utf8') }),
    isBase64,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
    totalSize,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/exports.test.ts tests/transfers.test.ts && npx tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/exports.ts src/services/transfers.ts tests/exports.test.ts tests/transfers.test.ts && git commit -m "feat: add workspace export map and transfer helpers"
```

---

### Task 5: HTTP transport, server shell, first tool, contract test

**Files:**
- Create: `src/transport.ts`, `src/server.ts`, `src/main.ts`, `src/tools/common.ts`, `tests/helpers.ts`, `tests/server.test.ts`

**Interfaces:**
- Consumes: `Config`, `AuthProvider`, `DriveClient`, `DriveError`/`mapDriveError`.
- Produces:
  - `interface ServerDeps { config: Config; auth: AuthProvider; drive: DriveClient }`
  - `toolText(payload: unknown): { content: [{ type: 'text', text: string }] }`
  - `toolError(err: unknown): { content: [{ type: 'text', text: string }]; isError: true }` — serializes only `{ error: code, message }`.
  - `handleTool<T>(fn: () => Promise<T>): Promise<...>` — try/catch wrapper returning `toolText` / `toolError`.
  - `auditLog(tool: string, detail?: Record<string, unknown>): void` — one JSON line to stdout: `{ ts, tool, actor: 'single-user', ...detail }`.
  - `createMcpServer(deps: ServerDeps): McpServer` — registers `drive_get` (more tools added by later tasks).
  - `createSessionStore(): { transports: Map<string, StreamableHTTPServerTransport> }`.
  - `createHttpApp(makeServer: () => McpServer, config: Config): express.Express` — `express.json({ limit: '25mb' })`; optional CORS from `config.corsOrigins`; bearer `API_KEY` gate (exact `Authorization: Bearer <key>`, skips when `apiKey` null); `GET /healthz` → `{ ok: true }`; `POST /mcp` creates per-session `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: randomUUID`, stores on `onsessioninitialized`, removes on `onsessionclosed`); `GET /mcp` replays stream for known session else 400; `DELETE /mcp` closes + evicts else 404.
  - `start(): Promise<void>` (in `src/server.ts`, called by `src/main.ts`) — builds real deps from `getConfig()`, listens on `config.port`.
  - Test helpers (`tests/helpers.ts`): `makeFakeDrive(overrides?: Partial<DriveClient>): DriveClient & { calls: string[] }` (records method names; defaults throw `DriveError('FILE_NOT_FOUND', ...)` for reads, return canned file `{ id: 'f1', name: 'a.txt', mimeType: 'text/plain' }` for writes), `startTestApp(deps: ServerDeps): Promise<{ baseUrl: string; close(): Promise<void> }>` (ephemeral port).

- [ ] **Step 1: Write the failing contract test + helpers**

```ts
// tests/server.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config.js';
import { AuthProvider } from '../src/auth.js';
import { createDriveClient } from '../src/services/drive.js';
import { createMcpServer } from '../src/server.js';
import { makeFakeDrive, startTestApp } from './helpers.js';
import type { ServerDeps } from '../src/tools/common.js';

const config = getConfig({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });
const deps = (overrides = {}): ServerDeps => ({
  config, auth: new AuthProvider(config), drive: makeFakeDrive(overrides),
});

describe('Streamable HTTP contract', () => {
  const app = startTestApp(deps());
  afterAll(() => app.then((a) => a.close()));

  it('serves healthz', async () => {
    const { baseUrl } = await app;
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('initialize -> tools/list contains drive_get -> bad call returns JSON-RPC error shape', async () => {
    const { baseUrl } = await app;
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    const list = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId as string },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listJson = await list.json();
    expect(JSON.stringify(listJson)).toContain('drive_get');
    const bad = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId as string },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'drive_get', arguments: {} } }),
    });
    const badJson = await bad.json();
    expect(JSON.stringify(badJson)).toContain('error');
  });
});
```

`tests/helpers.ts` (write it in this same step — it is test infrastructure, verified by the contract test above):

```ts
import type { Server } from 'node:http';
import express from 'express';
import { DriveError } from '../src/errors.js';
import type { DriveClient, DriveFile } from '../src/services/drive.js';
import { createHttpApp } from '../src/server.js';
import { createMcpServer } from '../src/server.js';
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

export async function startTestApp(deps: ServerDeps): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app = createHttpApp(() => createMcpServer(deps), deps.config);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))) };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/common.ts
import { DriveError, mapDriveError } from '../errors.js';
import type { Config } from '../config.js';
import type { AuthProvider } from '../auth.js';
import type { DriveClient } from '../services/drive.js';

export interface ServerDeps { config: Config; auth: AuthProvider; drive: DriveClient }

export function toolText(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

export function toolError(err: unknown) {
  const m = err instanceof DriveError ? err : mapDriveError(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: m.code, message: m.message }) }], isError: true as const };
}

export async function handleTool<T>(fn: () => Promise<T>) {
  try {
    return toolText(await fn());
  } catch (err) {
    return toolError(err);
  }
}

export function auditLog(tool: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), tool, actor: 'single-user', ...detail })}\n`);
}
```

```ts
// src/transport.ts
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface SessionStore { transports: Map<string, StreamableHTTPServerTransport> }

export function createSessionStore(): SessionStore {
  return { transports: new Map() };
}

export function newSessionTransport(store: SessionStore): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { store.transports.set(id, transport); },
    onsessionclosed: (id) => { store.transports.delete(id); },
  });
  return transport;
}
```

```ts
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { getConfig } from './config.js';
import { AuthProvider } from './auth.js';
import { createDriveClient } from './services/drive.js';
import { createSessionStore, newSessionTransport } from './transport.js';
import { handleTool, type ServerDeps } from './tools/common.js';

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'gdrive-mcp', version: '0.1.0' });
  server.tool('drive_get', 'Get file metadata by ID', { fileId: z.string(), fields: z.string().optional() }, async (args) =>
    handleTool(() => deps.drive.getFile(args.fileId, args.fields)));
  return server;
}

export function createHttpApp(makeServer: () => McpServer, config: Config): express.Express {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  if (config.corsOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.corsOrigins.includes(origin)) res.setHeader('access-control-allow-origin', origin);
      next();
    });
  }
  app.use('/mcp', (req, res, next) => {
    if (!config.apiKey) return next();
    if (req.headers.authorization === `Bearer ${config.apiKey}`) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  const store = createSessionStore();
  const sessionIdOf = (req: express.Request): string | undefined => {
    const h = req.headers['mcp-session-id'];
    return Array.isArray(h) ? h[0] : h;
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/mcp', async (req, res) => {
    try {
      let transport = sessionIdOf(req) ? store.transports.get(sessionIdOf(req) as string) : undefined;
      if (!transport) {
        transport = newSessionTransport(store);
        await makeServer().connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      res.status(500).json({ error: String((err as Error)?.message ?? err) });
    }
  });

  app.get('/mcp', async (req, res) => {
    const transport = sessionIdOf(req) ? store.transports.get(sessionIdOf(req) as string) : undefined;
    if (!transport) { res.status(400).json({ error: 'unknown session' }); return; }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const id = sessionIdOf(req);
    const transport = id ? store.transports.get(id) : undefined;
    if (!transport || !id) { res.status(404).json({ error: 'unknown session' }); return; }
    await transport.handleRequest(req, res);
    store.transports.delete(id);
  });

  return app;
}

export async function start(): Promise<void> {
  const config = getConfig();
  const auth = new AuthProvider(config);
  const drive = createDriveClient(auth);
  const app = createHttpApp(() => createMcpServer({ config, auth, drive }), config);
  await new Promise<void>((resolve) => app.listen(config.port, () => resolve()));
  console.log(`gdrive-mcp listening on :${config.port}`);
}
```

```ts
// src/main.ts
import { start } from './server.js';

start().catch((err) => { console.error(String((err as Error)?.message ?? err)); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server.test.ts && npx tsc --noEmit`
Expected: PASS (initialize returns `mcp-session-id`; `tools/list` contains `drive_get`; missing-args call yields JSON-RPC error); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/transport.ts src/server.ts src/main.ts src/tools/common.ts tests/helpers.ts tests/server.test.ts && git commit -m "feat: add Streamable HTTP transport, server shell, and drive_get"
```

---

### Task 6: Read tools (search, list, read, export)

**Files:**
- Create: `src/tools/read.ts`, `tests/tools.read.test.ts`
- Modify: `src/server.ts` (register read tools in `createMcpServer`)

**Interfaces:**
- Consumes: `ServerDeps`, `handleTool` (Task 5); `DriveClient` (Task 3); `autoExportMime`, `allowedExportMimes`, `isWorkspaceMime` (Task 4); `toInlinePayload`, `decodeToolContent` not needed here; `escapeQueryLiteral` (Task 3); `DriveError` (Task 1).
- Produces: `registerReadTools(server: McpServer, deps: ServerDeps): void` — registers `drive_search`, `drive_list`, `drive_read`, `drive_export` with Zod shapes; handler logic exactly as below.

Tool contracts:
- `drive_search { q: string, pageSize?: number (1-100, default 20), pageToken?: string, driveId?: string, orderBy?: string }` → `{ files, nextPageToken? }` via `drive.listFiles({ q, pageSize, pageToken, orderBy, driveId })`.
- `drive_list { folderId?: string, pageSize?: number, pageToken?: string, orderBy?: string }` → builds `q = '<escaped>' in parents` (`'root' in parents` when omitted) via `drive.listFiles`.
- `drive_read { fileId: string, offset?: number (default 0), length?: number (default inlineLimitBytes) }` → `getFile` meta; if workspace mime: `autoExportMime` null → return `{ metadata, exportRequired: true, supportedExports: allowedExportMimes(mime) }`; else `exportFile(auto)` → `{ metadata, exportedFrom, exportMime, text }` (exported bytes assumed UTF-8 text; binary Workspace exports like pdf/png → base64 via `toInlinePayload(bytes, exportMime, 0, limit)`); non-workspace → `downloadFile` → `toInlinePayload(bytes, mimeType, offset, length)` merged with `{ metadata }`.
- `drive_export { fileId: string, mimeType: string }` → `getFile` meta; reject non-workspace with `INVALID_REQUEST`; reject disallowed mime with `INVALID_REQUEST` listing `allowedExportMimes`; else `exportFile` → text if TEXTISH else base64 (no truncation; full buffer).

- [ ] **Step 1: Write the failing test** (via in-memory MCP client)

```ts
// tests/tools.read.test.ts
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

describe('read tools', () => {
  it('drive_search forwards query and returns files', async () => {
    const client = await clientFor();
    const res = await client.callTool({ name: 'drive_search', arguments: { q: "name='a'" } });
    expect(text(res)).toContain('f1');
  });
  it('drive_read auto-exports a Google Doc to markdown', async () => {
    const client = await clientFor({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
      exportFile: async () => ({ bytes: Buffer.from('# hi') }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'doc1' } });
    const payload = JSON.parse(text(res));
    expect(payload.exportMime).toBe('text/markdown');
    expect(payload.text).toBe('# hi');
    expect(payload.exportedFrom).toBe('application/vnd.google-apps.document');
  });
  it('drive_read truncates large files with nextOffset', async () => {
    const client = await clientFor({
      getFile: async (id: string) => ({ id, name: 'big.bin', mimeType: 'application/octet-stream', size: '16' }),
      downloadFile: async () => ({ bytes: Buffer.from('0123456789abcdef'), mimeType: 'application/octet-stream' }),
    });
    const res = await client.callTool({ name: 'drive_read', arguments: { fileId: 'big', offset: 0, length: 10 } });
    expect(JSON.parse(text(res))).toMatchObject({ truncated: true, nextOffset: 10, totalSize: 16, isBase64: true });
  });
  it('drive_export rejects disallowed mime with isError', async () => {
    const client = await clientFor({
      getFile: async (id: string) => ({ id, name: 'd', mimeType: 'application/vnd.google-apps.document' }),
    });
    const res = await client.callTool({ name: 'drive_export', arguments: { fileId: 'doc1', mimeType: 'image/png' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res)).toContain('INVALID_REQUEST');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools.read.test.ts`
Expected: FAIL — tools `drive_search`/`drive_read`/`drive_export` not found (only `drive_get` registered).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/read.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DriveError } from '../errors.js';
import { escapeQueryLiteral } from '../services/drive.js';
import { allowedExportMimes, autoExportMime, isWorkspaceMime } from '../services/exports.js';
import { TEXTISH_RE, toInlinePayload } from '../services/transfers.js';
import { handleTool, type ServerDeps } from './common.js';

const page = { pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional(), orderBy: z.string().optional() };

export function registerReadTools(server: McpServer, deps: ServerDeps): void {
  server.tool('drive_search', 'Search Drive files with a Drive query string', { q: z.string(), driveId: z.string().optional(), ...page }, async (args) =>
    handleTool(() => deps.drive.listFiles({ q: args.q, pageSize: args.pageSize, pageToken: args.pageToken, orderBy: args.orderBy, driveId: args.driveId })));

  server.tool('drive_list', 'List files in a folder (root when omitted)', { folderId: z.string().optional(), ...page }, async (args) =>
    handleTool(() => {
      const parent = args.folderId ? `'${escapeQueryLiteral(args.folderId)}' in parents` : "'root' in parents";
      return deps.drive.listFiles({ q: parent, pageSize: args.pageSize, pageToken: args.pageToken, orderBy: args.orderBy });
    }));

  server.tool('drive_read', 'Read file content; Workspace files auto-export; large content truncates with nextOffset',
    { fileId: z.string(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).optional() }, async (args) =>
    handleTool(async () => {
      const limit = args.length ?? deps.config.inlineLimitBytes;
      const metadata = await deps.drive.getFile(args.fileId);
      const mime = metadata.mimeType ?? 'application/octet-stream';
      if (isWorkspaceMime(mime)) {
        const auto = autoExportMime(mime);
        if (!auto) return { metadata, exportRequired: true, supportedExports: allowedExportMimes(mime) };
        const { bytes } = await deps.drive.exportFile(args.fileId, auto);
        if (TEXTISH_RE.test(auto)) return { metadata, exportedFrom: mime, exportMime: auto, text: bytes.toString('utf8') };
        return { metadata, exportedFrom: mime, exportMime: auto, ...toInlinePayload(bytes, auto, 0, limit) };
      }
      const { bytes, mimeType } = await deps.drive.downloadFile(args.fileId);
      return { metadata, ...toInlinePayload(bytes, mimeType, args.offset, limit) };
    }));

  server.tool('drive_export', 'Export a Workspace file to an explicit MIME type', { fileId: z.string(), mimeType: z.string() }, async (args) =>
    handleTool(async () => {
      const metadata = await deps.drive.getFile(args.fileId);
      const mime = metadata.mimeType ?? '';
      if (!isWorkspaceMime(mime)) throw new DriveError('INVALID_REQUEST', `drive_export requires a Google Workspace file; ${args.fileId} is ${mime || 'unknown type'}.`);
      const allowed = allowedExportMimes(mime);
      if (!allowed.includes(args.mimeType)) throw new DriveError('INVALID_REQUEST', `Unsupported export MIME ${args.mimeType} for ${mime}. Allowed: ${allowed.join(', ')}.`);
      const { bytes } = await deps.drive.exportFile(args.fileId, args.mimeType);
      return TEXTISH_RE.test(args.mimeType)
        ? { metadata, exportedFrom: mime, exportMime: args.mimeType, text: bytes.toString('utf8') }
        : { metadata, exportedFrom: mime, exportMime: args.mimeType, dataBase64: bytes.toString('base64'), isBase64: true, totalSize: bytes.length };
    }));
}
```

Modify `src/server.ts`: import `registerReadTools` and call it in `createMcpServer` after `drive_get` registration:

```ts
import { registerReadTools } from './tools/read.js';
// inside createMcpServer, after drive_get:
registerReadTools(server, deps);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools.read.test.ts tests/server.test.ts && npx tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts tests/tools.read.test.ts src/server.ts && git commit -m "feat: add read tools with Workspace auto-export"
```

---

### Task 7: Write tools (folders, upload, update, delete, move, copy)

**Files:**
- Create: `src/tools/write.ts`, `tests/tools.write.test.ts`
- Modify: `src/server.ts` (register write tools)

**Interfaces:**
- Consumes: `ServerDeps`, `handleTool`, `auditLog` (Task 5); `decodeToolContent`, `selectUploadMode` (Task 4); `DriveError` (Task 1).
- Produces: `registerWriteTools(server: McpServer, deps: ServerDeps): void` — registers `drive_create_folder`, `drive_upload`, `drive_update`, `drive_delete`, `drive_move`, `drive_copy`; every handler calls `auditLog(toolName, { fileId?, sessionId: undefined })` after success (session id is unavailable at tool layer — log `fileId`/`name` only; document this).

Tool contracts:
- `drive_create_folder { name: string(min 1), parentId?: string }` → `drive.createFolder`.
- `drive_upload { name: string(min 1), parentId?: string, mimeType?: string, contentText?: string, contentBase64?: string }` → `decodeToolContent` (requires exactly one) → `auditLog` includes `uploadMode: selectUploadMode(bytes.length)` → `drive.uploadFile`.
- `drive_update { fileId: string, name?: string, mimeType?: string, contentText?: string, contentBase64?: string }` → content optional (metadata-only update allowed); both content forms → `INVALID_REQUEST`.
- `drive_delete { fileId: string, permanent?: boolean (default false), confirmPermanent?: boolean (default false) }` → permanent without confirm → `INVALID_REQUEST('Set confirmPermanent:true to permanently delete ...')`; else `trashFile` / `deleteFilePermanent`; returns `{ fileId, trashed: true }` or `{ fileId, deleted: true }`.
- `drive_move { fileId: string, addParents: string, removeParents?: string }` → `drive.moveFile`.
- `drive_copy { fileId: string, name?: string, parentId?: string }` → `drive.copyFile`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools.write.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools.write.test.ts`
Expected: FAIL — tools not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/write.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DriveError } from '../errors.js';
import { decodeToolContent, selectUploadMode } from '../services/transfers.js';
import { auditLog, handleTool, type ServerDeps } from './common.js';

const content = { contentText: z.string().optional(), contentBase64: z.string().optional() };

export function registerWriteTools(server: McpServer, deps: ServerDeps): void {
  server.tool('drive_create_folder', 'Create a folder', { name: z.string().min(1), parentId: z.string().optional() }, async (args) =>
    handleTool(async () => {
      const folder = await deps.drive.createFolder(args.name, args.parentId);
      auditLog('drive_create_folder', { fileId: folder.id, name: args.name });
      return folder;
    }));

  server.tool('drive_upload', 'Upload a new file (contentText XOR contentBase64)', { name: z.string().min(1), parentId: z.string().optional(), mimeType: z.string().optional(), ...content }, async (args) =>
    handleTool(async () => {
      const { bytes } = decodeToolContent({ contentText: args.contentText, contentBase64: args.contentBase64 });
      const file = await deps.drive.uploadFile({ name: args.name, parentId: args.parentId, mimeType: args.mimeType, bytes });
      auditLog('drive_upload', { fileId: file.id, name: args.name, uploadMode: selectUploadMode(bytes.length) });
      return file;
    }));

  server.tool('drive_update', 'Update file metadata and/or content', { fileId: z.string(), name: z.string().optional(), mimeType: z.string().optional(), ...content }, async (args) =>
    handleTool(async () => {
      const hasContent = args.contentText !== undefined || args.contentBase64 !== undefined;
      const { bytes } = hasContent ? decodeToolContent({ contentText: args.contentText, contentBase64: args.contentBase64 }) : { bytes: undefined as unknown as Buffer };
      const file = await deps.drive.updateFile({ fileId: args.fileId, name: args.name, mimeType: args.mimeType, bytes });
      auditLog('drive_update', { fileId: args.fileId, name: args.name ?? null });
      return file;
    }));

  server.tool('drive_delete', 'Trash a file by default; permanent delete needs double opt-in', { fileId: z.string(), permanent: z.boolean().default(false), confirmPermanent: z.boolean().default(false) }, async (args) =>
    handleTool(async () => {
      if (args.permanent && !args.confirmPermanent) {
        throw new DriveError('INVALID_REQUEST', `Refusing to permanently delete ${args.fileId}. Set confirmPermanent:true to permanently delete.`);
      }
      if (args.permanent) {
        await deps.drive.deleteFilePermanent(args.fileId);
        auditLog('drive_delete', { fileId: args.fileId, permanent: true });
        return { fileId: args.fileId, deleted: true };
      }
      await deps.drive.trashFile(args.fileId);
      auditLog('drive_delete', { fileId: args.fileId, trashed: true });
      return { fileId: args.fileId, trashed: true };
    }));

  server.tool('drive_move', 'Move a file by adding/removing parents', { fileId: z.string(), addParents: z.string(), removeParents: z.string().optional() }, async (args) =>
    handleTool(async () => {
      const file = await deps.drive.moveFile(args.fileId, args.addParents, args.removeParents);
      auditLog('drive_move', { fileId: args.fileId });
      return file;
    }));

  server.tool('drive_copy', 'Copy a file, optionally renamed into another folder', { fileId: z.string(), name: z.string().optional(), parentId: z.string().optional() }, async (args) =>
    handleTool(async () => {
      const file = await deps.drive.copyFile(args.fileId, args.name, args.parentId);
      auditLog('drive_copy', { fileId: args.fileId, newFileId: file.id });
      return file;
    }));
}
```

Modify `src/server.ts`: import + call `registerWriteTools(server, deps)` in `createMcpServer`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools.write.test.ts tests/server.test.ts && npx tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/write.ts tests/tools.write.test.ts src/server.ts && git commit -m "feat: add write tools with trash-by-default delete"
```

---

### Task 8: Sharing tools (permissions, drives)

**Files:**
- Create: `src/tools/sharing.ts`, `tests/tools.sharing.test.ts`
- Modify: `src/server.ts` (register sharing tools)

**Interfaces:**
- Consumes: `ServerDeps`, `handleTool`, `auditLog` (Task 5); `DriveError` (Task 1).
- Produces: `registerSharingTools(server: McpServer, deps: ServerDeps): void` — registers `drive_permissions`, `drive_list_drives`.

Tool contracts:
- `drive_permissions { action: enum('list','create','delete'), fileId: string, role?: enum('reader','writer','commenter','owner'), type?: enum('user','group'), emailAddress?: string, permissionId?: string, allowOwnershipTransfer?: boolean (default false) }`:
  - `list` → `drive.listPermissions(fileId)`.
  - `create` requires `role` + `type` + (`emailAddress` when type is user/group); `type` outside user/group → `INVALID_REQUEST`; `role: 'owner'` without `allowOwnershipTransfer: true` → `INVALID_REQUEST`; then `drive.createPermission`.
  - `delete` requires `permissionId`; then `drive.deletePermission`.
  - All create/delete paths `auditLog('drive_permissions', { fileId, action })`.
- `drive_list_drives { pageSize?: number (1-100, default 20), pageToken?: string }` → `drive.listDrives`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools.sharing.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools.sharing.test.ts`
Expected: FAIL — `drive_permissions` / `drive_list_drives` not found; tool count is 11, not 13.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/sharing.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DriveError } from '../errors.js';
import { auditLog, handleTool, type ServerDeps } from './common.js';

const role = z.enum(['reader', 'writer', 'commenter', 'owner']);
const grantee = z.enum(['user', 'group']);

export function registerSharingTools(server: McpServer, deps: ServerDeps): void {
  server.tool('drive_permissions', 'List, create, or delete sharing permissions (user/group only at v1)',
    {
      action: z.enum(['list', 'create', 'delete']),
      fileId: z.string(),
      role: role.optional(),
      type: grantee.optional(),
      emailAddress: z.string().optional(),
      permissionId: z.string().optional(),
      allowOwnershipTransfer: z.boolean().default(false),
    }, async (args) =>
    handleTool(async () => {
      if (args.action === 'list') return deps.drive.listPermissions(args.fileId);
      if (args.action === 'delete') {
        if (!args.permissionId) throw new DriveError('INVALID_REQUEST', 'drive_permissions delete requires permissionId.');
        await deps.drive.deletePermission(args.fileId, args.permissionId);
        auditLog('drive_permissions', { fileId: args.fileId, action: 'delete' });
        return { fileId: args.fileId, permissionId: args.permissionId, deleted: true };
      }
      if (!args.role || !args.type) throw new DriveError('INVALID_REQUEST', 'drive_permissions create requires role and type (user|group).');
      if (!args.emailAddress) throw new DriveError('INVALID_REQUEST', 'drive_permissions create requires emailAddress for user/group grantees.');
      if (args.role === 'owner' && !args.allowOwnershipTransfer) {
        throw new DriveError('INVALID_REQUEST', 'Ownership transfer blocked. Set allowOwnershipTransfer:true to transfer ownership.');
      }
      const perm = await deps.drive.createPermission(args.fileId, { role: args.role, type: args.type, emailAddress: args.emailAddress });
      auditLog('drive_permissions', { fileId: args.fileId, action: 'create', role: args.role });
      return perm;
    }));

  server.tool('drive_list_drives', 'List Shared Drives', { pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional() }, async (args) =>
    handleTool(() => deps.drive.listDrives(args.pageSize, args.pageToken)));
}
```

Note: Zod rejects `type: 'anyone'` at schema level (invalid enum) before the handler runs — the test only asserts `isError`, which the SDK returns for schema violations. Modify `src/server.ts`: import + call `registerSharingTools(server, deps)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: full suite PASS (all unit + contract tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/sharing.ts tests/tools.sharing.test.ts src/server.ts && git commit -m "feat: add sharing tools with ownership-transfer guard"
```

---

### Task 9: Integration test, Docker, README, final verification

**Files:**
- Create: `tests/integration.drive.test.ts`, `Dockerfile`, `README.md`

**Interfaces:**
- Consumes: everything (Tasks 1–8). No new production code unless the verification exposes a bug (fix inline in the owning file + test).

- [ ] **Step 1: Write the gated integration test**

```ts
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
```

- [ ] **Step 2: Run integration gate to verify it skips**

Run: `npm run test:integration`
Expected: 1 skipped / 1 passed (gate test), no network calls, exit 0.

- [ ] **Step 3: Write Dockerfile and README**

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN useradd -m app && chown -R app:app /app
COPY --from=builder /app/package.json /app/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
USER app
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
```

`README.md` (write in full — no placeholders):
- What it is (single-tenant Google Drive MCP server, Streamable HTTP only).
- Prerequisites: Google Cloud OAuth client (Desktop app), Node >= 22.
- Setup: `npm install`, `npm run auth:setup` (needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`), copy printed `GOOGLE_REFRESH_TOKEN` into `.env` (see `.env.example`).
- Run: `npm run dev` (port 3000, `POST/GET/DELETE /mcp`); connect MCP Inspector to `http://localhost:3000/mcp`.
- Docker: `docker build -t gdrive-mcp .` + `docker run -p 3000:3000 --env-file .env gdrive-mcp`.
- Tool table: all 13 tools with one-line descriptions (copy from spec §3).
- Security notes: single shared Drive identity; trash-by-default; ownership transfer blocked; `API_KEY` for non-localhost.
- Test: `npm test`; integration: set `GOOGLE_*` + `TEST_FOLDER_ID` then `npm run test:integration`.

- [ ] **Step 4: Full verification**

Run: `npm test && npm run typecheck && npm run build && node -e "console.log('dist ok')"`
Expected: all green; `dist/src/main.js` exists. Then smoke: `PORT=3101 node dist/src/main.js &` + `curl localhost:3101/healthz` → `{"ok":true}`, kill server.

- [ ] **Step 5: Commit**

```bash
git add tests/integration.drive.test.ts Dockerfile README.md && git commit -m "feat: add gated integration test, Dockerfile, and README"
```

---

## Self-review

**Spec coverage:** §3 all 13 tools → Tasks 5–8 (drive_get in 5; search/list/read/export in 6; 6 write tools in 7; permissions/list_drives in 8; 13-count asserted in Task 8 test). §4 auth/sessions/flows → Tasks 2/5/6. §5 export map → Task 4 (+6). §6 errors/retry → Tasks 1/3. §7 security (trash default, owner block, API key, audit, no secret leak) → Tasks 5/7/8 + leak test in Task 1. §8 config/Docker → Tasks 1/9. §9 testing pyramid → unit (1–4, 6–8), contract (5), integration gated (9). §11 success criteria → Task 9 verification step.

**Placeholder scan:** no TBD/TODO; every code step ships concrete code; `DriveClient` interface is defined once (Task 3) and consumed by name in Tasks 5–9; `makeFakeDrive`/`startTestApp` defined once (Task 5 helpers) and reused in Tasks 6–8; `toolText`/`toolError`/`handleTool`/`auditLog` defined once (Task 5) and reused.

**Type consistency:** `DriveFile.id: string` flows into `auditLog({ fileId: folder.id })`; `updateFile.bytes?: Buffer` matches Task 7's metadata-only path (`bytes: undefined as unknown as Buffer` — implementation passes `bytes` through, and `createDriveClient.updateFile` treats falsy as metadata-only via `media: p.bytes ? ... : undefined`); `listFiles` returns `{ files, nextPageToken? }` matching all read handlers; `ServerDeps` shape identical in Tasks 5–8.
