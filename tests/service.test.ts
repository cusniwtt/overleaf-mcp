import { describe, it, expect, vi } from 'vitest';
import { flattenProjectTree, normalizeProjectPath } from '../src/overleaf/tree.js';
import { OverleafService } from '../src/overleaf/service.js';
import type { OverleafHttpClient, ProjectSummary } from '../src/overleaf/http-client.js';
import type {
  OverleafProjectPayload,
  OverleafRealtimeClient,
} from '../src/overleaf/socket09-client.js';
import { OverleafMcpError } from '../src/errors.js';

function makeFixture() {
  const projects: ProjectSummary[] = [
    { id: 'p1', name: 'Paper One', accessLevel: 'owner' },
    { id: 'p2', name: 'Paper Two', accessLevel: 'readAndWrite' },
  ];

  const tree: OverleafProjectPayload = {
    _id: 'p1',
    name: 'Paper One',
    rootDoc_id: 'd-main',
    rootFolder: [
      {
        _id: 'root-1',
        name: 'rootFolder',
        docs: [{ _id: 'd-main', name: 'main.tex' }],
        fileRefs: [{ _id: 'f-img', name: 'fig.png' }],
        folders: [
          {
            _id: 'fld-sec',
            name: 'sections',
            docs: [{ _id: 'd-intro', name: 'intro.tex' }],
            fileRefs: [],
            folders: [],
          },
        ],
      },
    ],
  };

  let docState = {
    content: '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nHello world.\n\\end{document}',
    version: 5,
    docType: 'standard',
  };

  const createdFolders: Array<{ name: string; parent: string }> = [];
  const createdDocs: Array<{ name: string; parent: string }> = [];
  const appliedUpdates: Array<{ docId: string; v: number; op: unknown[] }> = [];

  const httpClient = {
    listProjects: vi.fn(async () => projects),
    createFolder: vi.fn(async (_pid: string, name: string, parent: string) => {
      createdFolders.push({ name, parent });
      return { _id: `fld-${name}`, name };
    }),
    createDoc: vi.fn(async (_pid: string, name: string, parent: string) => {
      createdDocs.push({ name, parent });
      return { _id: `doc-${name}`, name };
    }),
    compileProject: vi.fn(async () => ({
      status: 'failure',
      outputFiles: [],
      logText: 'line 1\nline 2\n! Undefined control sequence.\nl.12 \\badcmd\nmore log',
    })),
  } as unknown as OverleafHttpClient;

  const realtimeClient = {
    joinProject: vi.fn(async () => tree),
    joinDoc: vi.fn(async () => ({ ...docState })),
    applyOtUpdate: vi.fn(async (_pid: string, docId: string, update: { v: number; op: unknown[] }) => {
      if (update.v !== docState.version) {
        throw new OverleafMcpError('version mismatch', 'OT_ERROR');
      }
      appliedUpdates.push({ docId, v: update.v, op: update.op });
      docState = { ...docState, version: docState.version + 1 };
      return docState.version;
    }),
    registerCreatedFolder: vi.fn(),
    registerCreatedDoc: vi.fn(),
  } as unknown as OverleafRealtimeClient;

  return {
    httpClient,
    realtimeClient,
    createdFolders,
    createdDocs,
    appliedUpdates,
    setDocState: (next: Partial<typeof docState>) => {
      docState = { ...docState, ...next };
    },
  };
}

describe('tree helpers', () => {
  it('rejects path traversal and absolute paths', () => {
    expect(() => normalizeProjectPath('../etc/passwd')).toThrow(OverleafMcpError);
    expect(() => normalizeProjectPath('/abs/path.tex')).toThrow(OverleafMcpError);
    expect(() => normalizeProjectPath('')).toThrow(OverleafMcpError);
    expect(normalizeProjectPath('sections/intro.tex')).toBe('sections/intro.tex');
  });

  it('flattens rootFolder into entities and folder path map', () => {
    const res = flattenProjectTree({
      _id: 'root-1',
      name: 'rootFolder',
      docs: [{ _id: 'd1', name: 'main.tex' }],
      fileRefs: [{ _id: 'f1', name: 'fig.png' }],
      folders: [{ _id: 'fld1', name: 'sections', docs: [{ _id: 'd2', name: 'a.tex' }], folders: [] }],
    });
    expect(res.rootFolderId).toBe('root-1');
    expect(res.foldersByPath.get('sections')).toBe('fld1');
    expect(res.entities.map((e) => `${e.type}:${e.path}`)).toEqual([
      'file:fig.png',
      'doc:main.tex',
      'doc:sections/a.tex',
    ]);
  });
});

describe('OverleafService', () => {
  it('resolves project by id, case-insensitive name, or defaultProject', async () => {
    const { httpClient, realtimeClient } = makeFixture();
    const svcNoDefault = new OverleafService(httpClient, realtimeClient);

    await expect(svcNoDefault.listFiles()).rejects.toThrow(/Paper One/);
    const byName = await svcNoDefault.listFiles({ project: 'paper one' });
    expect(byName.projectId).toBe('p1');
    expect(byName.rootDocPath).toBe('main.tex');

    const svcWithDefault = new OverleafService(httpClient, realtimeClient, {
      defaultProject: 'p1',
    });
    const byDefault = await svcWithDefault.listFiles();
    expect(byDefault.projectId).toBe('p1');
  });

  it('rejects binary file entities on readFile', async () => {
    const { httpClient, realtimeClient } = makeFixture();
    const svc = new OverleafService(httpClient, realtimeClient, { defaultProject: 'p1' });

    await expect(svc.readFile({ filePath: 'fig.png' })).rejects.toThrow(/binary/i);
  });

  it('enforces stale-read conflict guard unless force=true or expectedVersion matches', async () => {
    const { httpClient, realtimeClient, setDocState, appliedUpdates } = makeFixture();
    const svc = new OverleafService(httpClient, realtimeClient, { defaultProject: 'p1' });

    const first = await svc.readFile({ filePath: 'main.tex' });
    expect(first.version).toBe(5);

    // Simulate concurrent browser edit bumping version to 6
    setDocState({ version: 6 });

    await expect(
      svc.writeFile({ filePath: 'main.tex', content: 'new text' })
    ).rejects.toThrow(/changed.*re-read/i);
    expect(appliedUpdates).toHaveLength(0);

    // Passing expectedVersion=6 or force=true allows the write
    const forced = await svc.writeFile({
      filePath: 'main.tex',
      content: 'new text',
      force: true,
    });
    expect(forced).toEqual({ filePath: 'main.tex', fromVersion: 6, toVersion: 7 });
    expect(appliedUpdates).toHaveLength(1);
  });

  it('creates only missing intermediate folders on createFile and updates project tree for follow-up operations', async () => {
    const { httpClient, realtimeClient, createdFolders, createdDocs, appliedUpdates } = makeFixture();
    // Simulate real OverleafRealtimeClient mutations when registerCreatedFolder/Doc are called
    let liveTree: OverleafProjectPayload | undefined;
    (realtimeClient.joinProject as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!liveTree) {
        liveTree = {
          _id: 'p1',
          name: 'Paper One',
          rootDoc_id: 'd-main',
          rootFolder: [
            {
              _id: 'root-1',
              name: 'rootFolder',
              docs: [{ _id: 'd-main', name: 'main.tex' }],
              fileRefs: [{ _id: 'f-img', name: 'fig.png' }],
              folders: [
                {
                  _id: 'fld-sec',
                  name: 'sections',
                  docs: [{ _id: 'd-intro', name: 'intro.tex' }],
                  fileRefs: [],
                  folders: [],
                },
              ],
            },
          ],
        };
      }
      return liveTree;
    });
    (realtimeClient as unknown as { registerCreatedFolder: ReturnType<typeof vi.fn> }).registerCreatedFolder = vi.fn(
      (_pid: string, parentId: string, folder: { _id: string; name: string }) => {
        const sec = liveTree!.rootFolder[0].folders!.find((f) => f._id === parentId);
        sec?.folders?.push({ ...folder, docs: [], fileRefs: [], folders: [] });
      }
    );
    (realtimeClient as unknown as { registerCreatedDoc: ReturnType<typeof vi.fn> }).registerCreatedDoc = vi.fn(
      (_pid: string, parentId: string, doc: { _id: string; name: string }) => {
        const ch1 = liveTree!.rootFolder[0].folders![0].folders!.find((f) => f._id === parentId);
        ch1?.docs?.push(doc);
      }
    );

    const svc = new OverleafService(httpClient, realtimeClient, { defaultProject: 'p1' });

    const res = await svc.createFile({
      filePath: 'sections/ch1/new.tex',
      content: '\\section{Chapter 1}',
    });

    expect(createdFolders).toEqual([{ name: 'ch1', parent: 'fld-sec' }]);
    expect(createdDocs).toEqual([{ name: 'new.tex', parent: 'fld-ch1' }]);
    expect(res).toEqual({
      filePath: 'sections/ch1/new.tex',
      docId: 'doc-new.tex',
      createdFolders: ['sections/ch1'],
    });
    expect(appliedUpdates).toHaveLength(1);

    const files = await svc.listFiles();
    expect(files.files.some((f) => f.path === 'sections/ch1/new.tex')).toBe(true);
    await expect(svc.createFile({ filePath: 'sections/ch1/new.tex' })).rejects.toThrow(/already exists/i);
  });

  it('forwards both rootDocId and rootResourcePath in compileProject and extracts errors', async () => {
    const { httpClient, realtimeClient } = makeFixture();
    const svc = new OverleafService(httpClient, realtimeClient, { defaultProject: 'p1' });

    const res = await svc.compileProject({ rootDocPath: 'sections/intro.tex' });
    expect(httpClient.compileProject).toHaveBeenCalledWith('p1', {
      rootDocId: 'd-intro',
      rootResourcePath: 'sections/intro.tex',
    });
    expect(res.status).toBe('failure');
    expect(res.errors[0]).toContain('! Undefined control sequence.');
    expect(res.logExcerpt).toContain('! Undefined control sequence.');
  });

  it('serializes concurrent writeFile calls on the same document', async () => {
    const { httpClient, realtimeClient, setDocState, appliedUpdates } = makeFixture();
    const order: string[] = [];

    (realtimeClient.joinDoc as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push('join');
      return { content: 'a', version: 5 + appliedUpdates.length, docType: 'standard' };
    });
    (realtimeClient.applyOtUpdate as ReturnType<typeof vi.fn>).mockImplementation(
      async (_pid: string, docId: string, update: { v: number; op: unknown[] }) => {
        order.push(`apply-${update.v}`);
        appliedUpdates.push({ docId, v: update.v, op: update.op });
        const nextV = update.v + 1;
        setDocState({ version: nextV });
        return nextV;
      }
    );

    const svc = new OverleafService(httpClient, realtimeClient, { defaultProject: 'p1' });
    const [r1, r2] = await Promise.all([
      svc.writeFile({ filePath: 'main.tex', content: 'b', force: true }),
      svc.writeFile({ filePath: 'main.tex', content: 'c', force: true }),
    ]);

    expect(r1.toVersion).toBe(6);
    expect(r2.fromVersion).toBe(6);
    expect(r2.toVersion).toBe(7);
    expect(order).toEqual(['join', 'apply-5', 'join', 'apply-6']);
  });
});
