import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DriveError } from '../errors.js';
import { decodeToolContent, selectUploadMode } from '../services/transfers.js';
import { auditLog, handleTool, type ServerDeps } from './common.js';

const content = { contentText: z.string().optional(), contentBase64: z.string().optional() };

// Note: session id is unavailable at the tool layer, so audit lines log fileId/name only.
export function registerWriteTools(server: McpServer, deps: ServerDeps): void {
  server.tool('drive_create_folder', 'Create a folder', { name: z.string().min(1), parentId: z.string().optional() }, async (args) =>
    handleTool(async () => {
      const folder = await deps.drive.createFolder(args.name, args.parentId);
      auditLog('drive_create_folder', { fileId: folder.id, name: args.name });
      return folder;
    }));

  server.tool('drive_upload', 'Upload a new file (contentText XOR contentBase64)', { name: z.string().min(1), parentId: z.string().optional(), mimeType: z.string().optional(), ...content }, async (args) =>
    handleTool(async () => {
      const { bytes } = decodeToolContent({ contentText: args.contentText, contentBase64: args.contentBase64 });
      const file = await deps.drive.uploadFile({ name: args.name, parentId: args.parentId, mimeType: args.mimeType, bytes });
      auditLog('drive_upload', { fileId: file.id, name: args.name, uploadMode: selectUploadMode(bytes.length) });
      return file;
    }));

  server.tool('drive_update', 'Update file metadata and/or content', { fileId: z.string(), name: z.string().optional(), mimeType: z.string().optional(), ...content }, async (args) =>
    handleTool(async () => {
      const hasContent = args.contentText !== undefined || args.contentBase64 !== undefined;
      const { bytes } = hasContent ? decodeToolContent({ contentText: args.contentText, contentBase64: args.contentBase64 }) : { bytes: undefined as unknown as Buffer };
      const file = await deps.drive.updateFile({ fileId: args.fileId, name: args.name, mimeType: args.mimeType, bytes });
      auditLog('drive_update', { fileId: args.fileId, name: args.name ?? null });
      return file;
    }));

  server.tool('drive_delete', 'Trash a file by default; permanent delete needs double opt-in', { fileId: z.string(), permanent: z.boolean().default(false), confirmPermanent: z.boolean().default(false) }, async (args) =>
    handleTool(async () => {
      if (args.permanent && !args.confirmPermanent) {
        throw new DriveError('INVALID_REQUEST', `Refusing to permanently delete ${args.fileId}. Set confirmPermanent:true to permanently delete.`);
      }
      if (args.permanent) {
        await deps.drive.deleteFilePermanent(args.fileId);
        auditLog('drive_delete', { fileId: args.fileId, permanent: true });
        return { fileId: args.fileId, deleted: true };
      }
      await deps.drive.trashFile(args.fileId);
      auditLog('drive_delete', { fileId: args.fileId, trashed: true });
      return { fileId: args.fileId, trashed: true };
    }));

  server.tool('drive_move', 'Move a file by adding/removing parents', { fileId: z.string(), addParents: z.string(), removeParents: z.string().optional() }, async (args) =>
    handleTool(async () => {
      const file = await deps.drive.moveFile(args.fileId, args.addParents, args.removeParents);
      auditLog('drive_move', { fileId: args.fileId });
      return file;
    }));

  server.tool('drive_copy', 'Copy a file, optionally renamed into another folder', { fileId: z.string(), name: z.string().optional(), parentId: z.string().optional() }, async (args) =>
    handleTool(async () => {
      const file = await deps.drive.copyFile(args.fileId, args.name, args.parentId);
      auditLog('drive_copy', { fileId: args.fileId, newFileId: file.id });
      return file;
    }));
}
