import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface SessionStore { transports: Map<string, StreamableHTTPServerTransport> }

export function createSessionStore(): SessionStore {
  return { transports: new Map() };
}

export function newSessionTransport(store: SessionStore): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // Plain-JSON responses (not SSE) so POST /mcp bodies parse via res.json().
    enableJsonResponse: true,
    onsessioninitialized: (id) => { store.transports.set(id, transport); },
    onsessionclosed: (id) => { store.transports.delete(id); },
  });
  return transport;
}
