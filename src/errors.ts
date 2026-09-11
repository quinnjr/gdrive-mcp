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

const SCRUB_LABELS =
  'client[_-]?secret|clientSecret|refresh[_-]?token|refreshToken|access[_-]?token|accessToken|id[_-]?token|idToken|api[_-]?key|apiKey|private[_-]?key|privateKey|authorization|bearer[_-]?token';

const SCRUB_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]{6,}/gi,
  /\bBearer[\s:]+[A-Za-z0-9._~+/-]{4,}=*/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]+?-----END[^-]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bGOCSPX-[A-Za-z0-9_-]+/g,
  /\bGOCSF-[A-Za-z0-9_-]+/g,
  ...SECRET_PATTERNS,
  /=((?:[A-Za-z0-9_.\-/+]){12,})/g,
];

export function scrub(message: string): string {
  let out = message.replace(/&#x3[dD];|%3[Dd]/g, '=');
  out = SCRUB_PATTERNS.reduce<string>(
    (acc, re) =>
      acc.replace(re, (m) =>
        m.toLowerCase().startsWith('bearer') ? 'Bearer [REDACTED]' : m.startsWith('=') ? '=[REDACTED]' : '[REDACTED]',
      ),
    out,
  );
  // The two $1-preserving patterns stay as special cases: they keep the
  // label name ($1) and only redact the value, so they cannot use the
  // uniform replacement in the table above.
  out = out.replace(new RegExp(`(${SCRUB_LABELS})\\s*[:=]\\s*["']?[^"'\\s,}]+`, 'gi'), '$1=[REDACTED]');
  out = out.replace(new RegExp(`["'](${SCRUB_LABELS})["']\\s*:\\s*["'][^"']*["']`, 'gi'), '"$1":"[REDACTED]"');
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
