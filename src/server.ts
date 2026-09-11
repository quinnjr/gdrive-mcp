import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { getConfig } from './config.js';
import { AuthProvider } from './auth.js';
import { createDriveClient } from './services/drive.js';
import { createSessionStore, newSessionTransport, type SessionStore } from './transport.js';
import { handleTool, type ServerDeps } from './tools/common.js';
import { scrub } from './errors.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerSharingTools } from './tools/sharing.js';

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: 'gdrive-mcp', version: '0.1.0' });
  server.tool('drive_get', 'Get file metadata by ID', { fileId: z.string(), fields: z.string().optional() }, async (args) =>
    handleTool(() => deps.drive.getFile(args.fileId, args.fields)));
  registerReadTools(server, deps);
  registerWriteTools(server, deps);
  registerSharingTools(server, deps);
  return server;
}

function sendInternalError(res: express.Response, err: unknown): void {
  let message = 'internal error';
  try { message = scrub(String((err as Error)?.message ?? err)); } catch { /* keep fallback */ }
  if (!res.headersSent && !res.writableEnded) res.status(500).json({ error: message });
  else { try { res.end(); } catch { /* socket already gone */ } }
}

export function createHttpApp(makeServer: () => McpServer, config: Config, store: SessionStore = createSessionStore()): express.Express {
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

  const sessionIdOf = (req: express.Request): string | undefined => {
    const h = req.headers['mcp-session-id'];
    return Array.isArray(h) ? h[0] : h;
  };

  const sessionTransport = (req: express.Request, store: SessionStore) => {
    const id = sessionIdOf(req);
    return { id, transport: id ? store.transports.get(id) : undefined };
  };

  const sendKnownSessionError = (res: express.Response, status: 400 | 404): void => {
    res.status(status).json({ error: 'unknown session' });
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/mcp', async (req, res) => {
    try {
      let transport = sessionTransport(req, store).transport;
      if (!transport) {
        transport = newSessionTransport(store);
        await makeServer().connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.get('/mcp', async (req, res) => {
    try {
      const { transport } = sessionTransport(req, store);
      if (!transport) { sendKnownSessionError(res, 400); return; }
      await transport.handleRequest(req, res);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.delete('/mcp', async (req, res) => {
    try {
      const { id, transport } = sessionTransport(req, store);
      if (!transport || !id) { sendKnownSessionError(res, 404); return; }
      try {
        await transport.handleRequest(req, res);
      } finally {
        store.transports.delete(id);
      }
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  return app;
}

export async function start(): Promise<void> {
  const config = getConfig();
  const auth = new AuthProvider(config);
  const drive = createDriveClient(auth, { maxDownloadBytes: config.maxDownloadBytes });
  const app = createHttpApp(() => createMcpServer({ config, auth, drive }), config);
  await new Promise<void>((resolve) => app.listen(config.port, () => resolve()));
  console.log(`gdrive-mcp listening on :${config.port}`);
}
