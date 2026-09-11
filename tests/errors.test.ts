import { describe, expect, it } from 'vitest';
import { DriveError, isRetryableStatus, mapDriveError } from '../src/errors.js';

describe('mapDriveError', () => {
  it('maps 404 with fileId', () => {
    const e = mapDriveError({ response: { status: 404 } }, 'fid123');
    expect(e).toBeInstanceOf(DriveError);
    expect(e.code).toBe('FILE_NOT_FOUND');
    expect(e.message).toContain('fid123');
  });
  it('maps 403 with sharing hint', () => {
    expect(mapDriveError({ response: { status: 403 } }).message).toContain('Shared Drive');
  });
  it('maps 429 with retry-after header', () => {
    const e = mapDriveError({ response: { status: 429, headers: { 'retry-after': '7' } } });
    expect(e.code).toBe('RETRYABLE');
    expect(e.retryAfterMs).toBe(7000);
  });
  it('never leaks credential values', () => {
    const e = mapDriveError(new Error('boom GOOGLE_REFRESH_TOKEN=secret-value-xyz'));
    expect(e.message).not.toContain('secret-value-xyz');
  });
});

describe('isRetryableStatus', () => {
  it('flags 429 and 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
  });
});
