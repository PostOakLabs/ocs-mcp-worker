// imbh-constraints parity gate — asserts kernels/constraint-stacker.kernel.mjs and the
// site's imbh-constraints library compute byte-identical output_payloads across the whole
// constraint-stacker fixture corpus. FAILS (exit 1) on any divergence.
//
// WHY A PARITY GATE AND NOT AN IMPORT
// -----------------------------------
// The library (repo/tools/lib/imbh-constraints.core.js, OCS-JOSS-LIB-SPEC.md) is the
// authored home of the IMBH constraint math. The obvious way to make the worker "consume"
// it would be for the kernel to import it. The kernel cannot:
//
//   1. It is GUEST-LEGAL — no imports at all, and no Math.pow/Math.log/Date/crypto — so it
//      can run unchanged inside the zkVM guest (see the kernel's own header).
//   2. It is §18 groth16-proven (kernels/receipts/constraint-stacker.computeproof.json).
//      The proof is bound to this kernel's source; editing it invalidates the receipt and
//      the §17 KERNEL_DIGEST, and re-proving needs the shared GPU rig.
//
// So the two copies stay separate on disk and are held identical by CI instead. That is a
// weaker guarantee than a shared import and it is stated plainly rather than papered over:
// what this gate buys is that a change to one side without the other CANNOT reach a green
// build. It is the same shape as check-measurements-sync.mjs, which holds the kernel's
// IMBH_CONSTRAINTS table against the same live measurements.js.
//
// The library is fetched from the live site for the same reason measurements.js is: the
// worker repo is standalone and CI has no checkout of the site repo. That makes this gate
// a check against what is actually PUBLISHED, which is the stronger claim anyway.
//
// A fixture is only meaningful here if the kernel already agrees with it, so the gate also
// re-asserts kernel-vs-fixture; tier-a-kernels.test.mjs covers that independently.
//
// Usage: node scripts/check-lib-parity.mjs
//        LIB_URL=http://localhost:8080/tools/lib/imbh-constraints.core.js node scripts/check-lib-parity.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { compute as kernelCompute } from '../kernels/constraint-stacker.kernel.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIB_URL = process.env.LIB_URL || 'https://omegacentauri.me/tools/lib/imbh-constraints.core.js';
const MEASUREMENTS_URL = process.env.MEASUREMENTS_URL || 'https://omegacentauri.me/tools/data/measurements.js';

async function fetchText(url) {
  // file:// lets you run the gate against a working copy before it is deployed
  // (Node's fetch does not implement file:). CI always uses the https URLs.
  if (url.startsWith('file://')) {
    try {
      return readFileSync(fileURLToPath(url), 'utf8');
    } catch (e) {
      throw new Error(`read failed for ${url}: ${e.message}`);
    }
  }
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`fetch failed for ${url}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`fetch ${url} returned HTTP ${res.status}`);
  return res.text();
}

// Evaluate the published library + measurements together in one sandbox, exactly as a
// browser page loads them (two classic scripts, measurements first).
async function loadLibrary() {
  const [measurementsSrc, libSrc] = await Promise.all([fetchText(MEASUREMENTS_URL), fetchText(LIB_URL)]);

  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  try {
    vm.runInContext(measurementsSrc, sandbox, { filename: 'measurements.js', timeout: 5000 });
  } catch (e) {
    throw new Error(`failed to evaluate measurements.js: ${e.message}`);
  }
  try {
    vm.runInContext(libSrc, sandbox, { filename: 'imbh-constraints.core.js', timeout: 5000 });
  } catch (e) {
    throw new Error(`failed to evaluate imbh-constraints.core.js: ${e.message}`);
  }

  const lib = sandbox.IMBHConstraints;
  if (!lib || typeof lib.computeStackerPayload !== 'function') {
    throw new Error('imbh-constraints.core.js evaluated but did not register globalThis.IMBHConstraints.computeStackerPayload');
  }
  const constraints = lib.constraintsFromMeasurements(sandbox.window);
  return { lib, constraints };
}

function loadFixtures() {
  const path = resolve(ROOT, 'kernels', 'fixtures', 'constraint-stacker.fixtures.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.vectors) || parsed.vectors.length === 0) {
    throw new Error('constraint-stacker.fixtures.json has no vectors');
  }
  return parsed.vectors;
}

// Stable stringify so the diff message is deterministic and key order noise never reads
// as a value difference.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {});
  }
  return v;
}
const stable = (v) => JSON.stringify(canon(v));

async function main() {
  let lib, constraints, vectors;
  try {
    ({ lib, constraints } = await loadLibrary());
  } catch (e) {
    console.error(`FAIL: could not load the published imbh-constraints library — ${e.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    vectors = loadFixtures();
  } catch (e) {
    console.error(`FAIL: could not load the fixture corpus — ${e.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`imbh-constraints parity: lib v${lib.VERSION} from ${LIB_URL}`);
  console.log(`  ${constraints.length} constraints, ${vectors.length} fixture vector(s)\n`);

  const failures = [];

  for (const vec of vectors) {
    const name = vec.name || '(unnamed)';
    let kernelOut, libOut;

    try {
      kernelOut = kernelCompute(vec.policy_parameters).output_payload;
    } catch (e) {
      failures.push(`  [${name}] kernel threw: ${e.message}`);
      continue;
    }
    try {
      libOut = lib.computeStackerPayload(vec.policy_parameters, constraints).output_payload;
    } catch (e) {
      failures.push(`  [${name}] library threw: ${e.message}`);
      continue;
    }

    // 1. kernel vs library — the parity claim itself.
    if (stable(kernelOut) !== stable(libOut)) {
      failures.push(
        `  [${name}] kernel and library DIVERGE:\n` +
        `      kernel : ${stable(kernelOut)}\n` +
        `      library: ${stable(libOut)}`
      );
      continue;
    }

    // 2. both vs the recorded fixture — catches the case where the two drift together.
    if (vec.output_payload && stable(kernelOut) !== stable(vec.output_payload)) {
      failures.push(
        `  [${name}] kernel+library agree but BOTH diverge from the recorded fixture:\n` +
        `      computed: ${stable(kernelOut)}\n` +
        `      fixture : ${stable(vec.output_payload)}`
      );
      continue;
    }

    console.log(`  OK  ${name}`);
  }

  if (failures.length) {
    console.error(`\nFAIL: imbh-constraints parity broken (${failures.length} of ${vectors.length} vector(s)):`);
    for (const f of failures) console.error(f);
    console.error(
      '\nThe §18-proven kernel and the published library must compute identical payloads.\n' +
      'If you changed one, change the other to match. Note the kernel is groth16-proven:\n' +
      'editing kernels/constraint-stacker.kernel.mjs invalidates its compute proof and the\n' +
      '§17 KERNEL_DIGEST, and requires re-proving. Prefer changing the library unless the\n' +
      'physics itself changed.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nPASS: kernel and published library agree on all ${vectors.length} vector(s).`);
  process.exitCode = 0;
}

main();
