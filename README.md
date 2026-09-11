# gdrive-mcp

Single-tenant Google Drive MCP server, Streamable HTTP only. It exposes one shared Google Drive identity over the [Model Context Protocol](https://modelcontextprotocol.io/) so an MCP client (e.g. MCP Inspector, Claude Code) can search, read, write, and share Drive files through tools.

No stdio transport: the server speaks Streamable HTTP exclusively (`POST /mcp` for client messages, `GET /mcp` for the SSE stream, `DELETE /mcp` to terminate a session).

## Prerequisites

- Node.js >= 22 (see `engines` in `package.json`).
- A Google Cloud project with the Google Drive API enabled and an **OAuth client of type "Desktop app"**. Note the client ID and client secret — you need them for setup.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run the interactive OAuth setup (needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the environment). It prints an authorization URL, you grant Drive access in the browser, paste back the code, and it prints a `GOOGLE_REFRESH_TOKEN`:

   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run auth:setup
   ```

3. Copy the printed `GOOGLE_REFRESH_TOKEN` into a `.env` file (see `.env.example` for all variables):

   ```env
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REFRESH_TOKEN=...
   PORT=3000
   API_KEY=
   DRIVE_INLINE_LIMIT_MB=10
   LOG_LEVEL=info
   CORS_ORIGINS=
   ```

## Run

```bash
npm run dev
```

This starts the server on port 3000 (or `$PORT`). Endpoints:

- `POST /mcp` — JSON-RPC client messages (initialize, tools/list, tools/call, …).
- `GET /mcp` — SSE stream for server-to-client notifications.
- `DELETE /mcp` — terminate the session.
- `GET /healthz` — health check, returns `{"ok":true}`.

Uncaught `/mcp` errors before response headers return scrubbed JSON `{error}` with 500 (all methods); after SSE headers start the stream is torn down.

Connect MCP Inspector to `http://localhost:3000/mcp`.

## Docker

```bash
docker build -t gdrive-mcp .
docker run -p 3000:3000 --env-file .env gdrive-mcp
```

The image builds with `npm run build`, installs production dependencies only, and runs as the non-root `app` user (`node dist/src/main.js`).

## Tools

| Tool | Description |
| ---- | ----------- |
| `drive_search` | Pass-through Drive query; default `trashed=false`; returns `files[] + nextPageToken` |
| `drive_get` | `files.get` metadata only |
| `drive_list` | `q: '<folder> in parents and trashed=false'`; root if no folder |
| `drive_read` | Metadata + content; Workspace files auto-exported; binary → base64 + `isBase64:true`; past inline cap → `truncated:true, nextOffset, totalSize`; `length ≤ DRIVE_INLINE_LIMIT_MB (default 10 MiB); larger → invalid-params error`; Workspace auto-exports paginate like regular files (offset/length, truncated/nextOffset) |
| `drive_export` | Explicit export; `mimeType` validated against allowed map for source type; returns the full buffer with no truncation (large PDFs can be big) |
| `drive_create_folder` | `files.create` with folder MIME |
| `drive_upload` | Small = single-shot; >5MB = resumable via `TransferHelper` |
| `drive_update` | Metadata and/or content update |
| `drive_delete` | Default = trash; permanent requires `permanent:true + confirmPermanent:true` |
| `drive_move` | `files.update` parents add/remove |
| `drive_copy` | `files.copy`; Workspace files copy without conversion |
| `drive_permissions` | Single tool for sharing; blocks `role:owner` unless `allowOwnershipTransfer:true` |
| `drive_list_drives` | `drives.list`, for Shared Drive discovery |

## Security notes

- **Single shared Drive identity.** The server acts as one Google account (the OAuth refresh token holder). All MCP clients share that identity — there is no per-user auth.
- **Trash-by-default.** `drive_delete` moves files to trash unless called with both `permanent:true` and `confirmPermanent:true`.
- **Ownership transfer blocked.** `drive_permissions` rejects `role:owner` unless the call explicitly passes `allowOwnershipTransfer:true`.
- **`API_KEY` required when set.** When `API_KEY` is set, all `/mcp` requests require `Authorization: Bearer <key>` (no localhost exemption).
- Secrets (client secret, refresh token, API key) never appear in tool output or error messages.
- Error messages are scrubbed; assert error codes/isError, not exact message text.

## Test

```bash
npm test
```

Integration round-trip (folder → upload → read → update → move → copy → trash → cleanup) against a real Drive account. Set credentials plus a scratch folder, then:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... TEST_FOLDER_ID=... npm run test:integration
```

Without credentials the integration suite skips cleanly (gate test asserts the skip, exit 0).
