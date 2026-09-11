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
