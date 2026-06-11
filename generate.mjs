// Vendors the OCS tools manifest from the site repo into ./data/ for the Cloudflare Workers
// ASSETS binding.  Re-run after any change to repo/tools/data/tools-manifest.json.
// Usage:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, '..', 'repo');
const DATA = resolve(ROOT, 'data');

mkdirSync(DATA, { recursive: true });

writeFileSync(
  resolve(DATA, 'tools-manifest.json'),
  readFileSync(resolve(REPO, 'tools', 'data', 'tools-manifest.json'))
);

console.log('Vendored tools-manifest.json into ./data/');
