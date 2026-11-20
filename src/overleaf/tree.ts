import { OverleafMcpError } from '../errors.js';
import type { OverleafFolderNode } from './socket09-client.js';

export interface ProjectEntity {
  id: string;
  path: string;
  type: 'doc' | 'file';
  name: string;
  parentFolderId: string;
}

export interface FlattenedTree {
  entities: ProjectEntity[];
  foldersByPath: Map<string, string>;
  rootFolderId: string;
}

/**
 * Normalizes and validates a POSIX-style project-relative path, rejecting traversal.
 */
export function normalizeProjectPath(filePath: string): string {
  const trimmed = filePath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('/')) {
    throw new OverleafMcpError(
      `Invalid project file path "${filePath}": must be a non-empty relative path.`,
      'INVALID_PATH'
    );
  }

  const parts = trimmed.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new OverleafMcpError(
        `Invalid project file path "${filePath}": path traversal or empty segments are not allowed.`,
        'INVALID_PATH'
      );
    }
  }
  return parts.join('/');
}

/**
 * Flattens an Overleaf `rootFolder` tree into sorted entities and folder path lookup.
 */
export function flattenProjectTree(
  rootInput: OverleafFolderNode | OverleafFolderNode[]
): FlattenedTree {
  const root = Array.isArray(rootInput) ? rootInput[0] : rootInput;
  if (!root) {
    throw new OverleafMcpError('Project has no rootFolder.', 'TREE_ERROR');
  }

  const entities: ProjectEntity[] = [];
  const foldersByPath = new Map<string, string>();

  function walk(folder: OverleafFolderNode, prefix: string): void {
    for (const doc of folder.docs ?? []) {
      const docPath = prefix ? `${prefix}/${doc.name}` : doc.name;
      entities.push({
        id: doc._id,
        path: docPath,
        type: 'doc',
        name: doc.name,
        parentFolderId: folder._id,
      });
    }

    for (const file of folder.fileRefs ?? []) {
      const filePath = prefix ? `${prefix}/${file.name}` : file.name;
      entities.push({
        id: file._id,
        path: filePath,
        type: 'file',
        name: file.name,
        parentFolderId: folder._id,
      });
    }

    for (const child of folder.folders ?? []) {
      const folderPath = prefix ? `${prefix}/${child.name}` : child.name;
      foldersByPath.set(folderPath, child._id);
      walk(child, folderPath);
    }
  }

  walk(root, '');
  entities.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    entities,
    foldersByPath,
    rootFolderId: root._id,
  };
}

export function resolveEntityPath(
  entities: ProjectEntity[],
  filePath: string
): ProjectEntity {
  const normalized = normalizeProjectPath(filePath);
  const found = entities.find((e) => e.path === normalized);
  if (!found) {
    throw new OverleafMcpError(
      `File "${normalized}" not found in project.`,
      'FILE_NOT_FOUND'
    );
  }
  return found;
}
