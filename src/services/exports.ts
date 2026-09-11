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
