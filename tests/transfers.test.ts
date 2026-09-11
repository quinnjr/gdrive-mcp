import { describe, expect, it } from 'vitest';
import { decodeToolContent, selectUploadMode, toInlinePayload } from '../src/services/transfers.js';

describe('transfers', () => {
  it('selects resumable above 5MB', () => {
    expect(selectUploadMode(5 * 1024 * 1024)).toBe('single');
    expect(selectUploadMode(5 * 1024 * 1024 + 1)).toBe('resumable');
  });
  it('rejects both/neither content forms', () => {
    expect(() => decodeToolContent({})).toThrow(/contentText or contentBase64/);
    expect(() => decodeToolContent({ contentText: 'a', contentBase64: 'Yg==' })).toThrow(/only one/);
    expect(() => decodeToolContent({ contentBase64: '!!!' })).toThrow(/malformed/);
  });
  it('inlines text and truncates with continuation', () => {
    const bytes = Buffer.from('0123456789abcdef');
    const p = toInlinePayload(bytes, 'text/plain', 0, 10);
    expect(p).toMatchObject({ text: '0123456789', isBase64: false, truncated: true, nextOffset: 10, totalSize: 16 });
    const tail = toInlinePayload(bytes, 'text/plain', 10, 10);
    expect(tail).toMatchObject({ text: 'abcdef', truncated: false });
    expect(tail.nextOffset).toBeUndefined();
  });
  it('base64-encodes binary', () => {
    const p = toInlinePayload(Buffer.from([0xff, 0xd8]), 'image/png', 0, 1024);
    expect(p).toMatchObject({ isBase64: true, truncated: false });
    expect(typeof p.dataBase64).toBe('string');
  });
  it('inlines application/*+json suffix types as text', () => {
    const p = toInlinePayload(Buffer.from('{"a":1}'), 'application/ld+json', 0, 1024);
    expect(p).toMatchObject({ isBase64: false, truncated: false, text: '{"a":1}' });
  });
});
