// OCG Standard §17 kernel_digest freshness check (CI-safe; no ../repo dependency).
// Recomputes the self-referential sha256-source digest over worker.mjs (KERNEL_DIGEST
// line blanked to 'PLACEHOLDER', LF-normalized) and compares it to the committed
// KERNEL_DIGEST constant. Exit 1 on drift. Mirrors the stamp logic in generate.mjs
// but does NOT vendor the manifest (generate.mjs reads ../repo, absent in CI).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDigest } from '../lib/_buildid.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(ROOT, '..', 'worker.mjs');
const NEUTRAL_RE = /^const KERNEL_DIGEST = 'sha256:(?:[0-9a-f]{64}|PLACEHOLDER)';$/m;
const VALUE_RE   = /^const KERNEL_DIGEST = '(sha256:[0-9a-f]{64})';$/m;

const src = readFileSync(WORKER_PATH, 'utf8');
if (!NEUTRAL_RE.test(src)) {
  console.error('::error::§17 check: KERNEL_DIGEST line not found in worker.mjs.');
  process.exitCode = 1;
} else {
  const committed = (src.match(VALUE_RE) || [])[1] || null;
  const neutralized = src.replace(NEUTRAL_RE, "const KERNEL_DIGEST = 'sha256:PLACEHOLDER';");
  const recomputed = await sourceDigest(neutralized);
  if (committed && committed === recomputed) {
    console.log(`OK  §17 KERNEL_DIGEST is fresh: ${recomputed}`);
  } else {
    console.error(`::error::§17 KERNEL_DIGEST is stale. committed=${committed} recomputed=${recomputed}. Run 'node generate.mjs' locally and commit worker.mjs.`);
    process.exitCode = 1;
  }
}
