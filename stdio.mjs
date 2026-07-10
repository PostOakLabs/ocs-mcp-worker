// OCS MCP server — stdio entrypoint.
// Used by the Glama containerized build (mcp-proxy spawns this as a stdio MCP server for
// introspection / scoring) and by any stdio MCP host. Reuses the exact same tool
// registration (buildServer) as the streamable-HTTP Cloudflare Worker in worker.mjs, reading
// the manifest straight from disk instead of via the Workers ASSETS binding.
//
//   node stdio.mjs   → speaks MCP over stdin/stdout

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './worker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, 'data', 'tools-manifest.json'), 'utf8'));

const server = buildServer(manifest);
const transport = new StdioServerTransport();
await server.connect(transport);
