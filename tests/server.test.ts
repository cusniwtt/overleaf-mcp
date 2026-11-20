import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
import type { OverleafService } from '../src/overleaf/service.js';

function makeMockService(): OverleafService {
  return {
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'Paper One', accessLevel: 'owner' }]),
    listFiles: vi.fn(async () => ({
      projectId: 'p1',
      projectName: 'Paper One',
      rootDocPath: 'main.tex',
      files: [{ id: 'd1', path: 'main.tex', type: 'doc', name: 'main.tex', parentFolderId: 'r1' }],
    })),
    statusSummary: vi.fn(async () => ({
      projectId: 'p1',
      projectName: 'Paper One',
      totalFiles: 1,
      mainFile: 'main.tex',
      sections: [{ type: 'section', title: 'Intro', index: 0 }],
    })),
    readFile: vi.fn(async () => ({
      filePath: 'main.tex',
      content: '\\section{Intro}\nHello',
      version: 3,
    })),
    getSections: vi.fn(async () => [{ type: 'section', title: 'Intro', index: 0 }]),
    getSectionContent: vi.fn(async () => ({
      filePath: 'main.tex',
      content: '\\section{Intro}\nHello',
      version: 3,
    })),
    writeFile: vi.fn(async () => ({ filePath: 'main.tex', fromVersion: 3, toVersion: 4 })),
    writeSection: vi.fn(async () => ({ filePath: 'main.tex', fromVersion: 4, toVersion: 5 })),
    createFile: vi.fn(async () => ({
      filePath: 'sections/new.tex',
      docId: 'd2',
      createdFolders: ['sections'],
    })),
    compileProject: vi.fn(async () => ({
      status: 'success',
      errors: [],
      logExcerpt: 'Output written on output.pdf',
    })),
  } as unknown as OverleafService;
}

describe('MCP server', () => {
  it('lists all 10 tools and delegates validated tool calls', async () => {
    const service = makeMockService();
    const server = createMcpServer(service, ['my-secret-pw']);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual([
      'list_projects',
      'list_files',
      'status_summary',
      'read_file',
      'get_sections',
      'get_section_content',
      'write_file',
      'write_section',
      'create_file',
      'compile_project',
    ]);

    const readRes = await client.callTool({
      name: 'read_file',
      arguments: { filePath: 'main.tex' },
    });
    expect(readRes.isError).not.toBe(true);
    expect((readRes.content as Array<{ text: string }>)[0].text).toContain('version');
    expect(service.readFile).toHaveBeenCalledWith({ filePath: 'main.tex', project: undefined });

    const writeSecRes = await client.callTool({
      name: 'write_section',
      arguments: {
        filePath: 'main.tex',
        sectionTitle: 'Intro',
        newContent: '\\section{Intro}\nUpdated',
        sectionIndex: 0,
      },
    });
    expect(writeSecRes.isError).not.toBe(true);
    expect(service.writeSection).toHaveBeenCalledWith({
      filePath: 'main.tex',
      sectionTitle: 'Intro',
      newContent: '\\section{Intro}\nUpdated',
      sectionIndex: 0,
      project: undefined,
      expectedVersion: undefined,
      force: undefined,
    });

    const createRes = await client.callTool({
      name: 'create_file',
      arguments: { filePath: 'sections/new.tex', content: 'hi' },
    });
    expect(createRes.isError).not.toBe(true);
    expect(service.createFile).toHaveBeenCalledWith({
      filePath: 'sections/new.tex',
      content: 'hi',
      project: undefined,
    });

    const compileRes = await client.callTool({
      name: 'compile_project',
      arguments: { rootDocPath: 'main.tex' },
    });
    expect(compileRes.isError).not.toBe(true);
    expect(service.compileProject).toHaveBeenCalledWith({
      project: undefined,
      rootDocPath: 'main.tex',
    });

    await client.close();
    await server.close();
  });

  it('masks secrets in returned tool errors', async () => {
    const service = makeMockService();
    (service.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Failed with my-secret-pw and overleaf.sid=abc123')
    );

    const server = createMcpServer(service, ['my-secret-pw']);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: 'read_file',
      arguments: { filePath: 'main.tex' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain('my-secret-pw');
    expect(text).not.toContain('abc123');
    expect(text).toContain('***');

    await client.close();
    await server.close();
  });
});
