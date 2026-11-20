import { OverleafMcpError } from '../errors.js';
import {
  extractSectionContent,
  parseSections,
  replaceSectionContent,
  type LatexSection,
} from '../latex/sections.js';
import type { OverleafHttpClient, ProjectSummary } from './http-client.js';
import { computeOtOps } from './ot-diff.js';
import type { OverleafRealtimeClient } from './socket09-client.js';
import {
  flattenProjectTree,
  normalizeProjectPath,
  resolveEntityPath,
  type FlattenedTree,
  type ProjectEntity,
} from './tree.js';

export interface OverleafServiceOptions {
  defaultProject?: string;
}

function extractLatexErrors(logText: string | undefined): {
  errors: string[];
  logExcerpt: string;
} {
  if (!logText) {
    return { errors: [], logExcerpt: '' };
  }
  const lines = logText.split(/\r?\n/);
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('!')) {
      errors.push(lines.slice(i, Math.min(lines.length, i + 4)).join('\n'));
    }
  }
  const maxExcerptChars = 4000;
  const logExcerpt =
    logText.length > maxExcerptChars
      ? logText.slice(logText.length - maxExcerptChars)
      : logText;
  return { errors, logExcerpt };
}

/**
 * High-level service coordinating Overleaf HTTP and real-time document operations.
 */
export class OverleafService {
  private readonly httpClient: OverleafHttpClient;
  private readonly realtimeClient: OverleafRealtimeClient;
  private readonly defaultProject?: string;
  private readonly lastReadVersion = new Map<string, number>();
  private readonly docQueues = new Map<string, Promise<unknown>>();

  constructor(
    httpClient: OverleafHttpClient,
    realtimeClient: OverleafRealtimeClient,
    options: OverleafServiceOptions = {}
  ) {
    this.httpClient = httpClient;
    this.realtimeClient = realtimeClient;
    this.defaultProject = options.defaultProject;
  }

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.docQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const cleanup = next.then(
      () => {
        if (this.docQueues.get(key) === cleanup) {
          this.docQueues.delete(key);
        }
      },
      () => {
        if (this.docQueues.get(key) === cleanup) {
          this.docQueues.delete(key);
        }
      }
    );
    this.docQueues.set(key, cleanup);
    return next;
  }

  private async resolveProject(projectRef?: string): Promise<ProjectSummary> {
    const projects = await this.httpClient.listProjects();
    const target = (projectRef ?? this.defaultProject)?.trim();

    if (!target) {
      const list = projects.map((p) => `${p.name} (${p.id})`).join(', ');
      throw new OverleafMcpError(
        `No project specified and OVERLEAF_DEFAULT_PROJECT is not set. Available projects: ${list || '(none)'}`,
        'PROJECT_REQUIRED'
      );
    }

    const byId = projects.find((p) => p.id === target);
    if (byId) return byId;

    const lower = target.toLowerCase();
    const byName = projects.filter((p) => p.name.toLowerCase() === lower);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      const ids = byName.map((p) => p.id).join(', ');
      throw new OverleafMcpError(
        `Multiple projects match name "${target}" (${ids}). Specify the project ID instead.`,
        'AMBIGUOUS_PROJECT'
      );
    }

    const available = projects.map((p) => `${p.name} (${p.id})`).join(', ');
    throw new OverleafMcpError(
      `Project "${target}" not found. Available projects: ${available || '(none)'}`,
      'PROJECT_NOT_FOUND'
    );
  }

  private async getProjectTree(
    projectRef?: string
  ): Promise<{ project: ProjectSummary; rootDocId?: string; tree: FlattenedTree }> {
    const project = await this.resolveProject(projectRef);
    const payload = await this.realtimeClient.joinProject(project.id);
    const tree = flattenProjectTree(payload.rootFolder);
    return {
      project,
      rootDocId: payload.rootDoc_id,
      tree,
    };
  }

  private async resolveDocEntity(
    filePath: string,
    projectRef?: string
  ): Promise<{ project: ProjectSummary; entity: ProjectEntity }> {
    const { project, tree } = await this.getProjectTree(projectRef);
    const entity = resolveEntityPath(tree.entities, filePath);
    if (entity.type !== 'doc') {
      throw new OverleafMcpError(
        `File "${entity.path}" is a binary file entity and cannot be read or edited as UTF-8 text.`,
        'BINARY_FILE'
      );
    }
    return { project, entity };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.httpClient.listProjects();
  }

  async listFiles(input: { project?: string; extension?: string } = {}): Promise<{
    projectId: string;
    projectName: string;
    rootDocPath?: string;
    files: ProjectEntity[];
  }> {
    const { project, rootDocId, tree } = await this.getProjectTree(input.project);
    const ext = input.extension?.trim();
    const files = ext
      ? tree.entities.filter((e) => e.path.endsWith(ext))
      : tree.entities;
    const rootDocPath = rootDocId
      ? tree.entities.find((e) => e.id === rootDocId)?.path
      : undefined;

    return {
      projectId: project.id,
      projectName: project.name,
      rootDocPath,
      files,
    };
  }

  async statusSummary(input: { project?: string } = {}): Promise<{
    projectId: string;
    projectName: string;
    totalFiles: number;
    mainFile?: string;
    sections: LatexSection[];
  }> {
    const { project, rootDocId, tree } = await this.getProjectTree(input.project);
    const mainEntity =
      (rootDocId ? tree.entities.find((e) => e.id === rootDocId && e.type === 'doc') : undefined) ??
      tree.entities.find((e) => e.type === 'doc' && e.path === 'main.tex') ??
      tree.entities.find((e) => e.type === 'doc' && e.path.endsWith('.tex'));

    let sections: LatexSection[] = [];
    if (mainEntity) {
      const doc = await this.realtimeClient.joinDoc(project.id, mainEntity.id);
      this.lastReadVersion.set(`${project.id}:${mainEntity.id}`, doc.version);
      sections = parseSections(doc.content);
    }

    return {
      projectId: project.id,
      projectName: project.name,
      totalFiles: tree.entities.length,
      mainFile: mainEntity?.path,
      sections,
    };
  }

  async readFile(input: { filePath: string; project?: string }): Promise<{
    filePath: string;
    content: string;
    version: number;
  }> {
    const { project, entity } = await this.resolveDocEntity(input.filePath, input.project);
    const key = `${project.id}:${entity.id}`;
    return this.enqueue(key, async () => {
      const doc = await this.realtimeClient.joinDoc(project.id, entity.id);
      this.lastReadVersion.set(key, doc.version);
      return {
        filePath: entity.path,
        content: doc.content,
        version: doc.version,
      };
    });
  }

  async getSections(input: { filePath: string; project?: string }): Promise<LatexSection[]> {
    const { content } = await this.readFile(input);
    return parseSections(content);
  }

  async getSectionContent(input: {
    filePath: string;
    sectionTitle: string;
    sectionIndex?: number;
    project?: string;
  }): Promise<{ filePath: string; content: string; version: number }> {
    const doc = await this.readFile({ filePath: input.filePath, project: input.project });
    return {
      filePath: doc.filePath,
      content: extractSectionContent(doc.content, input.sectionTitle, input.sectionIndex),
      version: doc.version,
    };
  }

  private async writeDocWithTransform(
    input: {
      filePath: string;
      project?: string;
      expectedVersion?: number;
      force?: boolean;
    },
    transform: (currentContent: string) => string
  ): Promise<{ filePath: string; fromVersion: number; toVersion: number }> {
    const { project, entity } = await this.resolveDocEntity(input.filePath, input.project);
    const key = `${project.id}:${entity.id}`;

    return this.enqueue(key, async () => {
      const live = await this.realtimeClient.joinDoc(project.id, entity.id);
      const baselineVersion = input.expectedVersion ?? this.lastReadVersion.get(key);

      if (!input.force && baselineVersion !== undefined && live.version !== baselineVersion) {
        throw new OverleafMcpError(
          `Document "${entity.path}" changed in Overleaf since last read (v${baselineVersion} -> v${live.version}). Re-read the file before writing, or pass force: true to overwrite.`,
          'CONFLICT_ERROR'
        );
      }

      const nextContent = transform(live.content);
      const ops = computeOtOps(live.content, nextContent);
      if (ops.length === 0) {
        this.lastReadVersion.set(key, live.version);
        return {
          filePath: entity.path,
          fromVersion: live.version,
          toVersion: live.version,
        };
      }

      const toVersion = await this.realtimeClient.applyOtUpdate(project.id, entity.id, {
        v: live.version,
        op: ops,
      });
      this.lastReadVersion.set(key, toVersion);
      return {
        filePath: entity.path,
        fromVersion: live.version,
        toVersion,
      };
    });
  }

  async writeFile(input: {
    filePath: string;
    content: string;
    project?: string;
    expectedVersion?: number;
    force?: boolean;
  }): Promise<{ filePath: string; fromVersion: number; toVersion: number }> {
    return this.writeDocWithTransform(input, () => input.content);
  }

  async writeSection(input: {
    filePath: string;
    sectionTitle: string;
    newContent: string;
    sectionIndex?: number;
    project?: string;
    expectedVersion?: number;
    force?: boolean;
  }): Promise<{ filePath: string; fromVersion: number; toVersion: number }> {
    return this.writeDocWithTransform(input, (current) =>
      replaceSectionContent(current, input.sectionTitle, input.newContent, input.sectionIndex)
    );
  }

  async createFile(input: {
    filePath: string;
    content?: string;
    project?: string;
  }): Promise<{ filePath: string; docId: string; createdFolders: string[] }> {
    const normalized = normalizeProjectPath(input.filePath);
    const project = await this.resolveProject(input.project);

    return this.enqueue(`project:${project.id}`, async () => {
      const payload = await this.realtimeClient.joinProject(project.id);
      const tree = flattenProjectTree(payload.rootFolder);

      if (tree.entities.some((e) => e.path === normalized)) {
        throw new OverleafMcpError(
          `File "${normalized}" already exists in project.`,
          'FILE_EXISTS'
        );
      }

      const parts = normalized.split('/');
      const fileName = parts.pop()!;
      let parentFolderId = tree.rootFolderId;
      const createdFolders: string[] = [];
      let currentPath = '';

      for (const segment of parts) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const existingId = tree.foldersByPath.get(currentPath);
        if (existingId) {
          parentFolderId = existingId;
        } else {
          const created = await this.httpClient.createFolder(project.id, segment, parentFolderId);
          tree.foldersByPath.set(currentPath, created._id);
          this.realtimeClient.registerCreatedFolder(project.id, parentFolderId, created);
          parentFolderId = created._id;
          createdFolders.push(currentPath);
        }
      }

      const createdDoc = await this.httpClient.createDoc(project.id, fileName, parentFolderId);
      this.realtimeClient.registerCreatedDoc(project.id, parentFolderId, createdDoc);
      const key = `${project.id}:${createdDoc._id}`;

      if (input.content && input.content.length > 0) {
        await this.enqueue(key, async () => {
          const live = await this.realtimeClient.joinDoc(project.id, createdDoc._id);
          const ops = computeOtOps(live.content, input.content!);
          if (ops.length > 0) {
            const nextVersion = await this.realtimeClient.applyOtUpdate(project.id, createdDoc._id, {
              v: live.version,
              op: ops,
            });
            this.lastReadVersion.set(key, nextVersion);
          } else {
            this.lastReadVersion.set(key, live.version);
          }
        });
      } else {
        this.lastReadVersion.set(key, 0);
      }

      return {
        filePath: normalized,
        docId: createdDoc._id,
        createdFolders,
      };
    });
  }

  async compileProject(input: {
    project?: string;
    rootDocPath?: string;
  } = {}): Promise<{ status: string; errors: string[]; logExcerpt: string }> {
    const project = await this.resolveProject(input.project);
    let rootDocId: string | undefined;
    let rootResourcePath: string | undefined;

    if (input.rootDocPath) {
      const payload = await this.realtimeClient.joinProject(project.id);
      const tree = flattenProjectTree(payload.rootFolder);
      const entity = resolveEntityPath(tree.entities, input.rootDocPath);
      if (entity.type !== 'doc') {
        throw new OverleafMcpError(
          `rootDocPath "${entity.path}" is not a text document.`,
          'INVALID_ROOT_DOC'
        );
      }
      rootDocId = entity.id;
      rootResourcePath = entity.path;
    }

    const compiled = await this.httpClient.compileProject(project.id, {
      rootDocId,
      rootResourcePath,
    });
    const { errors, logExcerpt } = extractLatexErrors(compiled.logText);
    return {
      status: compiled.status,
      errors,
      logExcerpt,
    };
  }
}
