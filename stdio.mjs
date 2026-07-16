// OCS MCP server — stdio entrypoint.
// Vendored pattern from the AINumbers ChainGraph SSOT stdio.mjs (single lineage — do not fork).
// Used by the Glama containerized build (mcp-proxy spawns this as a stdio MCP server for
// introspection / scoring) and by any stdio MCP host. Reuses the exact same tool + chain
// registration as the streamable-HTTP Cloudflare Worker — single source of truth.
//
//   node stdio.mjs   → speaks MCP over stdin/stdout (manifest read from ./data/)
//   wrangler deploy  → streamable HTTP at https://mcp.omegacentauri.me/mcp (production)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './worker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(HERE, 'data', 'tools-manifest.json'), 'utf8')
);

const server = buildServer(manifest);
const transport = new StdioServerTransport();
await server.connect(transport);
