# Google Drive MCP Server — Design Spec

**Date:** 2026-09-11
**Status:** Draft, all 4 design sections approved in chat
**Scope:** TypeScript MCP server, Streamable HTTP only, single-user OAuth 2.0, full Drive access incl. Shared Drives, read + write.

## 1. Goal & Non-Goals

**Goal:** An MCP server that lets an MCP client (agent) search, read (with Google Workspace auto-export), create, update, move, copy, delete, and share Google Drive files via Streamable HTTP.

**Non-goals:**
- stdio / legacy SSE transports (explicitly out — streaming HTTP only).
- Multi-user OAuth / per-request Drive isolation (single shared Drive connection).
- Horizontal scale / serverless (single instance, in-memory sessions).
- Full Drive UI semantics (comments, revisions history beyond read, Apps Script).

## 2. Architecture (Approach B: Layered Service)

```
HTTP (POST/GET/DELETE /mcp)
  → StreamableHTTPServerTransport per session
  → SessionManager (Map<sessionId, transport>)
  → MCP Tool Router (Zod-validated)
  → DriveClient / ExportService / TransferHelper
  → googleapis drive v3
        ↑
  AuthProvider (single OAuth2Client, env refresh token)
```

### Components (one purpose each)

| Component | File | Responsibility |
|---|---|---|
| `server` | `src/server.ts` | Node HTTP server, `/mcp` routes, optional API_KEY gate, CORS, logging |
| `transport` | `src/transport.ts` | `SessionManager`: create/evict `StreamableHTTPServerTransport`, handle `Mcp-Session-Id` |
| `auth` | `src/auth.ts` | Load `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`, single `OAuth2Client`, refresh with mutex |
| `drive` | `src/services/drive.ts` | `googleapis` wrapper: `supportsAllDrives:true`, pagination, fields whitelist, retry w/ backoff |
| `exports` | `src/services/exports.ts` | Workspace MIME map + validation for explicit export |
| `transfers` | `src/services/transfers.ts` | Resumable upload (>5MB, 3 retries), chunked download, 10MB inline cap w/ `truncated/nextOffset` |
| `errors` | `src/errors.ts` | Drive → MCP error mapping, no secret leakage |
| `tools/*` | `src/tools/*.ts` | One module per tool, Zod schemas, thin orchestration over services |

### Dependencies

`@modelcontextprotocol/sdk`, `googleapis`, `google-auth-library`, `zod`, `express` (default; bare `node:http` allowed at plan time), `vitest`, `typescript`.

## 3. Tools (13)

All inputs Zod-validated. `supportsAllDrives=true`, `includeItemsFromAllDrives` on list/search.

| Tool | Input | Behavior |
|---|---|---|
| `drive_search` | `q, pageSize?, pageToken?, driveId?, corpora?` | Pass-through Drive query; default `trashed=false`; returns `files[] + nextPageToken` |
| `drive_get` | `fileId, fields?` | `files.get` metadata only |
| `drive_list` | `folderId?, pageSize?, pageToken?, orderBy?` | `q: '<folder> in parents and trashed=false'`; root if no folder |
| `drive_read` | `fileId, offset?, length?` | Metadata + content; Workspace files auto-exported (see §5); binary → base64 + `isBase64:true`; past inline cap → `truncated:true, nextOffset, totalSize` |
| `drive_export` | `fileId, mimeType` | Explicit export; `mimeType` validated against allowed map for source type |
| `drive_create_folder` | `name, parentId?` | `files.create` with folder MIME |
| `drive_upload` | `name, parentId?, mimeType?, contentText?, contentBase64?` | Small = single-shot; >5MB = resumable via `TransferHelper` |
| `drive_update` | `fileId, name?, mimeType?, contentText?, contentBase64?` | Metadata and/or content update |
| `drive_delete` | `fileId, permanent?, confirmPermanent?` | Default = trash; permanent requires `permanent:true + confirmPermanent:true` |
| `drive_move` | `fileId, addParents, removeParents?` | `files.update` parents add/remove |
| `drive_copy` | `fileId, name?, parentId?` | `files.copy`; Workspace files copy without conversion |
| `drive_permissions` | `action: list\|create\|delete, fileId, role?, type?, email?, permissionId?` | Single tool for sharing; blocks `role:owner` unless `allowOwnershipTransfer:true` |
| `drive_list_drives` | `pageSize?, pageToken?` | `drives.list`, for Shared Drive discovery |

`contentText` / `contentBase64` are mutually exclusive; Streamable HTTP stays pure JSON (no multipart).

## 4. Auth, Sessions, Data Flow

### Auth (single-user)

- One-time setup: `npm run auth:setup` (local browser OAuth code exchange) prints `GOOGLE_REFRESH_TOKEN`. Operator copies it into env/secrets.
- Runtime reads only env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. No auth tools exposed over MCP. No per-user tokens.
- `AuthProvider` holds one `OAuth2Client`; on 401 refreshes under a mutex so concurrent requests don't stampede the token endpoint.

### Sessions (Streamable HTTP only)

- `POST /mcp`: JSON-RPC request; new `StreamableHTTPServerTransport` when no `Mcp-Session-Id`, session id returned in response header.
- `GET /mcp`: holds SSE notification stream for that session.
- `DELETE /mcp`: evicts `Map<sessionId, transport>` entry.
- Single-instance assumption documented. No Redis. No stdio/SSE-legacy routes.

### Flows

- **Read:** `files.get(fields)` → if `mimeType` is `application/vnd.google-apps.*` → `ExportService` auto-export + `exportedFrom/originalMime` in response; else download bytes → UTF-8 when text-ish, else base64.
- **Search/list:** `q` forwarded; default excludes trash; `corpora:allDrives` when no `driveId`.
- **Write:** upload/update via `TransferHelper`; `delete` trashes by default; `move` = parents add/remove; `permissions.create` validates `role ∈ {reader, writer, commenter}` (+ `owner` only with explicit flag).

## 5. Workspace Export Map

Auto-export on `drive_read`; explicit format choice via `drive_export`.

| Source | Auto-export | Explicit allowed |
|---|---|---|
| Google Doc | `text/markdown` | `text/markdown`, `text/plain`, `application/pdf` |
| Google Sheet | `text/csv` (first sheet) | `text/csv`, `application/pdf`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Google Slides | `text/plain` | `text/plain`, `application/pdf` |
| Google Drawing | `image/png` (base64) | `image/png`, `application/pdf` |

Unknown future Workspace types: return metadata + `exportRequired:true` + supported list instead of guessing.

## 6. Errors

`ErrorMapper`: 404 → `FILE_NOT_FOUND (fileId)`; 403 → `PERMISSION_DENIED + hint`; 429/5xx → `RETRYABLE + Retry-After`; schema failures → MCP invalid-params before any API call. `DriveClient` retries 429/5xx with exponential backoff (3 attempts). Error messages never include tokens/credentials.

## 7. Security

- Full `drive` scope is sensitive — documented as single-tenant: every MCP client of this server shares one Drive identity.
- `drive_delete(permanent)` needs double opt-in; `drive_permissions` blocks ownership transfer by default.
- No tool returns credentials. HTTP layer: optional `API_KEY` bearer check (required for non-localhost), CORS allowlist via env, binds `PORT` (default 3000).
- Mutating tools emit an audit log line: `{ts, tool, fileId, actor: "single-user", sessionId}`.

## 8. Config

| Var | Required | Default | Notes |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | — | OAuth client |
| `GOOGLE_CLIENT_SECRET` | yes | — | OAuth secret |
| `GOOGLE_REFRESH_TOKEN` | yes | — | From `auth:setup` |
| `PORT` | no | `3000` | HTTP listen |
| `API_KEY` | no | — | Bearer gate when set |
| `DRIVE_INLINE_LIMIT_MB` | no | `10` | `drive_read` inline cap |
| `LOG_LEVEL` | no | `info` | pino/console |

`.env.example` + `scripts/auth-setup.ts` + `Dockerfile` (node:22-slim, non-root, `CMD ["node","dist/server.js"]`).

## 9. Testing

- **Unit (vitest, mocked `googleapis`):** Zod schemas (incl. `contentText`/`contentBase64` mutual exclusion), export MIME map, `ErrorMapper`, session eviction.
- **Integration (gated by env):** `TEST_FOLDER_ID` (+ optional `TEST_DRIVE_ID`): create folder → upload → read → update → move → copy → trash → permissions round-trip → cleanup. Skips cleanly without `GOOGLE_*`.
- **Contract:** Streamable HTTP initialize → `tools/list` → `tools/call drive_get` with bad id → assert `Mcp-Session-Id` header + JSON-RPC error shape.

## 10. Layout

```
src/server.ts src/transport.ts src/auth.ts src/errors.ts
src/services/drive.ts src/services/exports.ts src/services/transfers.ts
src/tools/{search,get,list,read,export,createFolder,upload,update,delete,move,copy,permissions,listDrives}.ts
scripts/auth-setup.ts  Dockerfile  .env.example
```

## 11. Success Criteria

- `npm run dev` serves `POST/GET/DELETE /mcp` (Streamable HTTP); MCP Inspector connects and lists 13 tools.
- Against real Drive + one Shared Drive: search → get → read with Doc auto-export → upload → update → move → copy → share → trash round-trips; metadata ops p50 <2s.
- `drive_read` on a >10MB file returns `truncated:true` with working `offset` continuation; no OOM.
- `drive_delete` without `confirmPermanent` never permanently deletes; no secret appears in any tool output or error.

## 12. Open Decisions (for implementation plan)

1. Express vs bare `node:http` for `/mcp` routing.
2. Logger choice (pino vs console) and audit sink.
3. Whether `drive_permissions` should also support `domain`/`anyone` grantee types or stay `user/group`-only at v1 (recommend user/group-only).
