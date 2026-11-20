import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { maskSecrets } from './errors.js';
import type { OverleafService } from './overleaf/service.js';

const projectArg = z.string().min(1).optional();
const expectedVersionArg = z.number().int().nonnegative().optional();
const forceArg = z.boolean().optional();

const listFilesSchema = z.object({
  project: projectArg,
  extension: z.string().optional(),
});

const statusSummarySchema = z.object({
  project: projectArg,
});

const readFileSchema = z.object({
  filePath: z.string().min(1),
  project: projectArg,
});

const getSectionsSchema = z.object({
  filePath: z.string().min(1),
  project: projectArg,
});

const getSectionContentSchema = z.object({
  filePath: z.string().min(1),
  sectionTitle: z.string().min(1),
  sectionIndex: z.number().int().nonnegative().optional(),
  project: projectArg,
});

const writeFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
  project: projectArg,
  expectedVersion: expectedVersionArg,
  force: forceArg,
});

const writeSectionSchema = z.object({
  filePath: z.string().min(1),
  sectionTitle: z.string().min(1),
  newContent: z.string(),
  sectionIndex: z.number().int().nonnegative().optional(),
  project: projectArg,
  expectedVersion: expectedVersionArg,
  force: forceArg,
});

const createFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string().optional(),
  project: projectArg,
});

const compileProjectSchema = z.object({
  project: projectArg,
  rootDocPath: z.string().min(1).optional(),
});

const TOOL_DEFINITIONS = [
  {
    name: 'list_projects',
    description: 'List accessible Overleaf Community Edition projects.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_files',
    description: 'List files and documents in an Overleaf project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
        extension: {
          type: 'string',
          description: 'Optional filename suffix filter (e.g., ".tex" or ".bib").',
        },
      },
    },
  },
  {
    name: 'status_summary',
    description: 'Get a project overview including file count, root/main LaTeX file, and section outline.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text document from an Overleaf project (rejects binary files) and record its live version.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Project-relative POSIX path (e.g., "main.tex" or "sections/intro.tex").',
        },
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'get_sections',
    description: 'Parse LaTeX sectioning commands (part, chapter, section, subsection, subsubsection) from a document.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Project-relative path to the LaTeX document.',
        },
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'get_section_content',
    description:
      'Extract a named LaTeX section including its heading line through just before the next equal/higher-level heading.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Project-relative path to the LaTeX document.',
        },
        sectionTitle: {
          type: 'string',
          description: 'Exact LaTeX title inside the heading braces.',
        },
        sectionIndex: {
          type: 'number',
          description: 'Optional UTF-16 character index from get_sections to disambiguate duplicate titles.',
        },
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
      },
      required: ['filePath', 'sectionTitle'],
    },
  },
  {
    name: 'write_file',
    description:
      'Replace an entire text document in Overleaf via OT update. Rejects if Overleaf changed since last read unless force: true.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Project-relative path to the text document.',
        },
        content: {
          type: 'string',
          description: 'Complete new UTF-8 file content.',
        },
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
        expectedVersion: {
          type: 'number',
          description: 'Optional document version to assert against live Overleaf state.',
        },
        force: {
          type: 'boolean',
          description: 'Set true to bypass stale-read version conflict check.',
        },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'write_section',
    description:
      'Replace a targeted LaTeX section via OT update. newContent MUST include the section heading line (e.g., "\\section{Intro}\\n..."). Rejects on stale reads unless force: true.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Project-relative path to the LaTeX document.',
        },
        sectionTitle: {
          type: 'string',
          description: 'Exact LaTeX title of the section to replace.',
        },
        newContent: {
          type: 'string',
          description: 'Replacement content including the section heading line.',
        },
        sectionIndex: {
          type: 'number',
          description: 'Optional UTF-16 character index from get_sections to disambiguate duplicate titles.',
        },
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
        expectedVersion: {
          type: 'number',
          description: 'Optional document version to assert against live Overleaf state.',
        },
        force: {
          type: 'boolean',
          description: 'Set true to bypass stale-read version conflict check.',
        },
      },
      required: ['filePath', 'sectionTitle', 'newContent'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new text document (and any missing parent folders) in an Overleaf project.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Project-relative path for the new document (e.g., "sections/related.tex").',
        },
        content: {
          type: 'string',
          description: 'Optional initial UTF-8 content to populate after creation.',
        },
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'compile_project',
    description: 'Trigger a remote LaTeX compile in Overleaf CE and return compile status plus log diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project ID or exact name (optional if OVERLEAF_DEFAULT_PROJECT is set).',
        },
        rootDocPath: {
          type: 'string',
          description: 'Optional project-relative path to the root .tex document to compile.',
        },
      },
    },
  },
];

function jsonTextResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Creates and wires an MCP Server instance backed by `OverleafService`.
 */
export function createMcpServer(
  service: OverleafService,
  secretsToMask: string[] = []
): Server {
  const server = new Server(
    {
      name: 'overleaf-ce-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: rawArgs } = request.params;
      const args = rawArgs ?? {};

      switch (name) {
        case 'list_projects':
          return jsonTextResult(await service.listProjects());

        case 'list_files':
          return jsonTextResult(await service.listFiles(listFilesSchema.parse(args)));

        case 'status_summary':
          return jsonTextResult(await service.statusSummary(statusSummarySchema.parse(args)));

        case 'read_file':
          return jsonTextResult(await service.readFile(readFileSchema.parse(args)));

        case 'get_sections':
          return jsonTextResult(await service.getSections(getSectionsSchema.parse(args)));

        case 'get_section_content':
          return jsonTextResult(
            await service.getSectionContent(getSectionContentSchema.parse(args))
          );

        case 'write_file':
          return jsonTextResult(await service.writeFile(writeFileSchema.parse(args)));

        case 'write_section':
          return jsonTextResult(await service.writeSection(writeSectionSchema.parse(args)));

        case 'create_file':
          return jsonTextResult(await service.createFile(createFileSchema.parse(args)));

        case 'compile_project':
          return jsonTextResult(await service.compileProject(compileProjectSchema.parse(args)));

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${maskSecrets(rawMessage, secretsToMask)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
