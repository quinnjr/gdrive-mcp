// src/tools/read.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DriveError } from '../errors.js';
import { escapeQueryLiteral } from '../services/drive.js';
import { allowedExportMimes, autoExportMime, isWorkspaceMime } from '../services/exports.js';
import { TEXTISH_RE, toInlinePayload } from '../services/transfers.js';
import { handleTool, type ServerDeps } from './common.js';

const page = { pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional(), orderBy: z.string().optional() };

export function registerReadTools(server: McpServer, deps: ServerDeps): void {
  server.tool('drive_search', 'Search Drive files with a Drive query string', { q: z.string(), driveId: z.string().optional(), ...page }, async (args) =>
    handleTool(() => deps.drive.listFiles({ q: args.q, pageSize: args.pageSize, pageToken: args.pageToken, orderBy: args.orderBy, driveId: args.driveId })));

  server.tool('drive_list', 'List files in a folder (root when omitted)', { folderId: z.string().optional(), ...page }, async (args) =>
    handleTool(() => {
      const parent = args.folderId ? `'${escapeQueryLiteral(args.folderId)}' in parents` : "'root' in parents";
      return deps.drive.listFiles({ q: parent, pageSize: args.pageSize, pageToken: args.pageToken, orderBy: args.orderBy });
    }));

  server.tool('drive_read', 'Read file content; Workspace files auto-export; large content truncates with nextOffset',
    { fileId: z.string(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).optional() }, async (args) =>
    handleTool(async () => {
      const limit = args.length ?? deps.config.inlineLimitBytes;
      const metadata = await deps.drive.getFile(args.fileId);
      const mime = metadata.mimeType ?? 'application/octet-stream';
      if (isWorkspaceMime(mime)) {
        const auto = autoExportMime(mime);
        if (!auto) return { metadata, exportRequired: true, supportedExports: allowedExportMimes(mime) };
        const { bytes } = await deps.drive.exportFile(args.fileId, auto);
        if (TEXTISH_RE.test(auto)) return { metadata, exportedFrom: mime, exportMime: auto, text: bytes.toString('utf8') };
        return { metadata, exportedFrom: mime, exportMime: auto, ...toInlinePayload(bytes, auto, 0, limit) };
      }
      const { bytes, mimeType } = await deps.drive.downloadFile(args.fileId);
      return { metadata, ...toInlinePayload(bytes, mimeType, args.offset, limit) };
    }));

  server.tool('drive_export', 'Export a Workspace file to an explicit MIME type', { fileId: z.string(), mimeType: z.string() }, async (args) =>
    handleTool(async () => {
      const metadata = await deps.drive.getFile(args.fileId);
      const mime = metadata.mimeType ?? '';
      if (!isWorkspaceMime(mime)) throw new DriveError('INVALID_REQUEST', `drive_export requires a Google Workspace file; ${args.fileId} is ${mime || 'unknown type'}.`);
      const allowed = allowedExportMimes(mime);
      if (!allowed.includes(args.mimeType)) throw new DriveError('INVALID_REQUEST', `Unsupported export MIME ${args.mimeType} for ${mime}. Allowed: ${allowed.join(', ')}.`);
      const { bytes } = await deps.drive.exportFile(args.fileId, args.mimeType);
      return TEXTISH_RE.test(args.mimeType)
        ? { metadata, exportedFrom: mime, exportMime: args.mimeType, text: bytes.toString('utf8') }
        : { metadata, exportedFrom: mime, exportMime: args.mimeType, dataBase64: bytes.toString('base64'), isBase64: true, totalSize: bytes.length };
    }));
}
