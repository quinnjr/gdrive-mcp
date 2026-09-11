import { describe, expect, it } from 'vitest';
import { DriveError, isRetryableStatus, mapDriveError, scrub } from '../src/errors.js';

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

describe('scrub', () => {
  it('redacts JSON-quoted client_secret', () => {
    const out = scrub('"client_secret":"GOCSPX-Abc123Xyz789"');
    expect(out).not.toContain('GOCSPX-Abc123Xyz789');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"client_secret":"[REDACTED]"');
  });
  it('redacts JSON-quoted refresh_token', () => {
    const out = scrub('"refresh_token":"1//abc"');
    expect(out).not.toContain('1//abc');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"refresh_token":"[REDACTED]"');
  });
  it('redacts Authorization Bearer token', () => {
    const out = scrub('Authorization: Bearer mykey123456789');
    expect(out).not.toContain('mykey123456789');
    expect(out).toContain('[REDACTED]');
  });
  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCfakekey123\n-----END PRIVATE KEY-----';
    const out = scrub(pem);
    expect(out).not.toContain('fakekey123');
    expect(out).not.toContain('BEGIN PRIVATE');
    expect(out).toContain('[REDACTED]');
  });
  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM4OTI2IiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    const out = scrub(`token ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('[REDACTED]');
  });
  it('redacts bare GOCSPX secrets', () => {
    const out = scrub('leaked GOCSPX-abc123XYZ here');
    expect(out).not.toContain('GOCSPX-abc123XYZ');
    expect(out).toContain('[REDACTED]');
  });
  it('redacts camelCase clientSecret JSON', () => {
    const out = scrub('{"clientSecret":"GOCSPX-x"}');
    expect(out).not.toContain('GOCSPX-x');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"clientSecret":"[REDACTED]"');
  });
  it('redacts single-quoted client_secret JSON', () => {
    const out = scrub("{'client_secret': 'GOCSPX-y'}");
    expect(out).not.toContain('GOCSPX-y');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"client_secret":"[REDACTED]"');
  });
  it('redacts Bearer colon-separated token', () => {
    const out = scrub('Bearer:tok123456');
    expect(out).not.toContain('tok123456');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('Bearer [REDACTED]');
  });
  it('redacts hyphenated api-key label', () => {
    const out = scrub('api-key: xyz7890abcd');
    expect(out).not.toContain('xyz7890abcd');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('api-key=[REDACTED]');
  });
});
