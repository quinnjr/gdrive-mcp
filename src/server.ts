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
