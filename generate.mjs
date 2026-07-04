// Vendors the OCS tools manifest from the site repo into ./data/ for the Cloudflare Workers
// ASSETS binding.  Re-run after any change to repo/tools/data/tools-manifest.json.
// Also stamps the OCG Standard §17 kernel_digest into worker.mjs (KERNEL_DIGEST const) —
// a content digest of worker.mjs itself, computed with the KERNEL_DIGEST line's own value
// blanked to a literal 'PLACEHOLDER' so the digest is stable/self-referential. Idempotent:
// running this twice yields the same digest and no further diff.
// Usage:  node generate.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDigest } from './lib/_buildid.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, '..', 'repo');
const DATA = resolve(ROOT, 'data');

mkdirSync(DATA, { recursive: true });

writeFileSync(
  resolve(DATA, 'tools-manifest.json'),
  readFileSync(resolve(REPO, 'tools', 'data', 'tools-manifest.json'))
);

console.log('Vendored tools-manifest.json into ./data/');

// ---------------------------------------------------------------------------
// OCG Standard §17 — stamp KERNEL_DIGEST into worker.mjs.
// ---------------------------------------------------------------------------
const WORKER_PATH = resolve(ROOT, 'worker.mjs');
const KERNEL_DIGEST_RE = /^const KERNEL_DIGEST = 'sha256:(?:[0-9a-f]{64}|PLACEHOLDER)';$/m;

const workerSrc = readFileSync(WORKER_PATH, 'utf8');
if (!KERNEL_DIGEST_RE.test(workerSrc)) {
  throw new Error('generate.mjs: KERNEL_DIGEST line not found in worker.mjs (§17 stamp aborted).');
}

// Blank the KERNEL_DIGEST line's value to the literal 'PLACEHOLDER' so the digest is
// self-referential/stable, LF-normalize (sourceDigest does this too, but be explicit),
// then compute the digest over that neutralized text.
const neutralized = workerSrc.replace(KERNEL_DIGEST_RE, "const KERNEL_DIGEST = 'sha256:PLACEHOLDER';");
const digest = await sourceDigest(neutralized);

const stamped = workerSrc.replace(KERNEL_DIGEST_RE, `const KERNEL_DIGEST = '${digest}';`);
writeFileSync(WORKER_PATH, stamped);

console.log(`Stamped §17 KERNEL_DIGEST into worker.mjs: ${digest}`);
