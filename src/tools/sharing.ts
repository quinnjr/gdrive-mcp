import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DriveError } from '../errors.js';
import { auditLog, handleTool, type ServerDeps } from './common.js';

const role = z.enum(['reader', 'writer', 'commenter', 'owner']);
const grantee = z.enum(['user', 'group']);

export function registerSharingTools(server: McpServer, deps: ServerDeps): void {
  server.tool('drive_permissions', 'List, create, or delete sharing permissions (user/group only at v1)',
    {
      action: z.enum(['list', 'create', 'delete']),
      fileId: z.string(),
      role: role.optional(),
      type: grantee.optional(),
      emailAddress: z.string().optional(),
      permissionId: z.string().optional(),
      allowOwnershipTransfer: z.boolean().default(false),
    }, async (args) =>
    handleTool(async () => {
      if (args.action === 'list') return deps.drive.listPermissions(args.fileId);
      if (args.action === 'delete') {
        if (!args.permissionId) throw new DriveError('INVALID_REQUEST', 'drive_permissions delete requires permissionId.');
        await deps.drive.deletePermission(args.fileId, args.permissionId);
        auditLog('drive_permissions', { fileId: args.fileId, action: 'delete' });
        return { fileId: args.fileId, permissionId: args.permissionId, deleted: true };
      }
      if (!args.role || !args.type) throw new DriveError('INVALID_REQUEST', 'drive_permissions create requires role and type (user|group).');
      if (!args.emailAddress) throw new DriveError('INVALID_REQUEST', 'drive_permissions create requires emailAddress for user/group grantees.');
      if (args.role === 'owner' && !args.allowOwnershipTransfer) {
        throw new DriveError('INVALID_REQUEST', 'Ownership transfer blocked. Set allowOwnershipTransfer:true to transfer ownership.');
      }
      const perm = await deps.drive.createPermission(args.fileId, { role: args.role, type: args.type, emailAddress: args.emailAddress });
      auditLog('drive_permissions', { fileId: args.fileId, action: 'create', role: args.role });
      return perm;
    }));

  server.tool('drive_list_drives', 'List Shared Drives', { pageSize: z.number().int().min(1).max(100).default(20), pageToken: z.string().optional() }, async (args) =>
    handleTool(() => deps.drive.listDrives(args.pageSize, args.pageToken)));
}
