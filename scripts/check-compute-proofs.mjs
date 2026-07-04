// OCG Standard §18 / §18.6 compute-proof coverage + verify gate (CI-standalone).
// For every kernels/*.kernel.mjs, require a verifying groth16 receipt in
// kernels/receipts/<id>.computeproof.json UNLESS the kernel id is listed in
// kernels/compute-proof-deferred.json (with a reason) — the §18.6 deferral baseline,
// which ratchets DOWN only (a kernel already proven may not be re-added to deferred).
//
// Per receipt, PASS requires (mirrors the WSL run_verify, but reads committed files —
// no GPU, no ../repo, no live fetch):
//   • verifySeal(receipt) === true            (shipped BN254 pairing verifier)
//   • receipt.imageId === GUEST_IMAGE_ID      (the pinned zkVM guest a1a0bc89)
//   • JCS(journal.output) === JCS(compute(fixture.vectors[0].policy_parameters).output_payload)
//   • journal.kernel_digest === sourceDigest(kernel source, LF-normalized)
//   • journal.chaingraph_version === "0.4.0"
// Exit 1 on any missing-and-not-deferred kernel or any verify failure.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifySeal } from '../lib/_computeproof.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KDIR = resolve(ROOT, 'kernels');
const RDIR = resolve(KDIR, 'receipts');
const GUEST_IMAGE_ID = 'sha256:a1a0bc89b5b1febaeda3519f6dbade0fa5ac16beeb143c4e1b01689573567bc6';

function sourceDigest(t) {
  return 'sha256:' + createHash('sha256').update(Buffer.from(String(t).replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')).digest('hex');
}
function jcs(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map((x) => JSON.stringify(x) + ':' + jcs(v[x])).join(',') + '}';
}

const deferredPath = resolve(KDIR, 'compute-proof-deferred.json');
const deferred = existsSync(deferredPath) ? JSON.parse(readFileSync(deferredPath, 'utf8')) : { deferred: [] };
const deferredIds = new Set((deferred.deferred || []).map((d) => d.id));

const kernels = readdirSync(KDIR).filter((f) => f.endsWith('.kernel.mjs')).map((f) => f.replace('.kernel.mjs', ''));
if (kernels.length === 0) { console.error('::error::no kernels found'); process.exitCode = 1; }

let proven = 0, deferredCount = 0, failed = 0;
for (const id of kernels.sort()) {
  const receiptPath = resolve(RDIR, `${id}.computeproof.json`);
  if (!existsSync(receiptPath)) {
    if (deferredIds.has(id)) {
      const reason = (deferred.deferred.find((d) => d.id === id) || {}).reason || '(no reason)';
      console.log(`DEFER ${id} — ${reason}`);
      deferredCount++;
      continue;
    }
    console.error(`::error::§18.6 coverage: kernel '${id}' has no receipt and is not in the deferral baseline (no vacuous skip).`);
    failed++;
    continue;
  }
  if (deferredIds.has(id)) {
    console.error(`::error::§18.6 ratchet: kernel '${id}' has a receipt but is still listed as deferred — remove it from compute-proof-deferred.json.`);
    failed++;
  }
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const ksrc = readFileSync(resolve(KDIR, `${id}.kernel.mjs`), 'utf8');
    const fx = JSON.parse(readFileSync(resolve(KDIR, 'fixtures', `${id}.fixtures.json`), 'utf8'));
    const pp = fx.vectors[0].policy_parameters;
    const mod = await import(pathToFileURL(resolve(KDIR, `${id}.kernel.mjs`)).href);
    const r = mod.compute(pp);
    const out = (r && typeof r === 'object' && 'output_payload' in r) ? r.output_payload : r;

    const problems = [];
    if (receipt.imageId !== GUEST_IMAGE_ID) problems.push(`imageId ${receipt.imageId} != guest`);
    if (receipt.journal?.chaingraph_version !== '0.4.0') problems.push(`cgv ${receipt.journal?.chaingraph_version}`);
    if (receipt.journal?.kernel_digest !== sourceDigest(ksrc)) problems.push('kernel_digest mismatch (source drifted since prove)');
    if (jcs(receipt.journal?.output) !== jcs(out)) problems.push('journal.output != V8 compute(pp).output_payload');
    if (verifySeal(receipt) !== true) problems.push('BN254 verifySeal false');

    if (problems.length) { console.error(`::error::VERIFY_FAIL ${id}: ${problems.join('; ')}`); failed++; }
    else { console.log(`OK    ${id} — groth16 receipt verified (imageId, seal, journal==V8, kernel_digest, cgv)`); proven++; }
  } catch (e) {
    console.error(`::error::VERIFY_ERROR ${id}: ${e.message}`); failed++;
  }
}

console.log(`\n§18 summary: ${proven} proven, ${deferredCount} deferred, ${failed} failed (of ${kernels.length} kernels).`);
process.exitCode = failed ? 1 : 0;
