#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { maskSecrets } from './errors.js';
import { OverleafHttpClient } from './overleaf/http-client.js';
import { OverleafRealtimeClient } from './overleaf/socket09-client.js';
import { OverleafService } from './overleaf/service.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const httpClient = new OverleafHttpClient(config);
  const realtimeClient = new OverleafRealtimeClient(config, httpClient);
  const service = new OverleafService(httpClient, realtimeClient, {
    defaultProject: config.defaultProject,
  });

  const server = createMcpServer(service, [config.password]);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    realtimeClient.close();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await server.connect(transport);
  console.error(`[overleaf-ce-mcp] Running on stdio for ${config.url}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const pw = process.env.OVERLEAF_PASSWORD?.trim();
  console.error('[overleaf-ce-mcp] Fatal error:', maskSecrets(msg, pw ? [pw] : []));
  process.exit(1);
});
