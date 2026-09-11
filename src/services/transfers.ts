import { DriveError } from '../errors.js';

export const UPLOAD_RESUMABLE_BYTES = 5 * 1024 * 1024;

export const TEXTISH_RE = /^(text\/.*|application\/(json|xml|javascript|x-[^+]*\+json)|[^/]*\+(json|xml)|image\/svg\+xml)$/;

export function selectUploadMode(byteLength: number): 'single' | 'resumable' {
  return byteLength > UPLOAD_RESUMABLE_BYTES ? 'resumable' : 'single';
}

export function decodeToolContent(input: { contentText?: string; contentBase64?: string }): { bytes: Buffer; isBase64: boolean } {
  const { contentText, contentBase64 } = input;
  if (contentText !== undefined && contentBase64 !== undefined) {
    throw new DriveError('INVALID_REQUEST', 'Provide only one of contentText or contentBase64, not both.');
  }
  if (contentText !== undefined) return { bytes: Buffer.from(contentText, 'utf8'), isBase64: false };
  if (contentBase64 !== undefined) {
    const clean = contentBase64.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean) || clean.length === 0) {
      throw new DriveError('INVALID_REQUEST', 'contentBase64 is malformed: not valid base64.');
    }
    return { bytes: Buffer.from(clean, 'base64'), isBase64: true };
  }
  throw new DriveError('INVALID_REQUEST', 'Provide contentText or contentBase64.');
}

export interface InlinePayload {
  text?: string; dataBase64?: string; isBase64: boolean;
  truncated: boolean; nextOffset?: number; totalSize: number;
}

export function toInlinePayload(bytes: Buffer, mimeType: string, offset: number, limitBytes: number): InlinePayload {
  if (!Number.isInteger(offset) || offset < 0) throw new DriveError('INVALID_REQUEST', 'offset must be a non-negative integer.');
  const totalSize = bytes.length;
  const slice = bytes.subarray(Math.min(offset, totalSize), Math.min(offset + limitBytes, totalSize));
  const end = Math.min(offset, totalSize) + slice.length;
  const truncated = end < totalSize;
  const isBase64 = !TEXTISH_RE.test(mimeType);
  return {
    ...(isBase64 ? { dataBase64: slice.toString('base64') } : { text: slice.toString('utf8') }),
    isBase64,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
    totalSize,
  };
}
