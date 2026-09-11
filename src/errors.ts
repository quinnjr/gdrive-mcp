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
  out = out.replace(/=((?:[A-Za-z0-9_.\-/+]){12,})/g, '=[REDACTED]');
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
