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
