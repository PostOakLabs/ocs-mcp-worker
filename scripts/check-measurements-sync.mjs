// Measurements-sync CI gate — asserts the worker's IMBH_CONSTRAINTS (worker.mjs) stays
// in lockstep with the live canonical source at omegacentauri.me/tools/data/measurements.js.
// FAILS (exit 1) on any divergence: an id present on one side only, or a value/limitType/
// method mismatch for a shared id. PASSES (exit 0) when the sets match exactly.
//
// measurements.js is a browser script (`window.OCS_MEASUREMENTS = {...}`), not JSON — it's
// evaluated in a minimal vm sandbox with a fake `window` so formatting changes (comments,
// trailing commas, extra fields) don't break the parse.
//
// Usage: node scripts/check-measurements-sync.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEASUREMENTS_URL = 'https://omegacentauri.me/tools/data/measurements.js';
const FIELDS = ['id', 'limitType', 'method', 'value'];

function normValue(v) {
  // null / undefined treated the same; numbers compared as numbers.
  if (v === undefined) return null;
  return v;
}

function valuesEqual(a, b) {
  a = normValue(a);
  b = normValue(b);
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    // Tolerate floating-point noise from re-authoring (e.g. 1e5 vs 100000).
    return Math.abs(a - b) <= Math.abs(a) * 1e-9;
  }
  return a === b;
}

async function fetchMeasurementsImbh() {
  let res;
  try {
    res = await fetch(MEASUREMENTS_URL);
  } catch (e) {
    throw new Error(`fetch failed for ${MEASUREMENTS_URL}: ${e.message}`);
  }
  if (!res.ok) {
    throw new Error(`fetch ${MEASUREMENTS_URL} returned HTTP ${res.status}`);
  }
  const text = await res.text();

  const sandbox = { window: {}, console, globalThis: undefined };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(text, sandbox, { filename: 'measurements.js', timeout: 5000 });
  } catch (e) {
    throw new Error(`failed to evaluate measurements.js in vm sandbox: ${e.message}`);
  }

  const data = sandbox.window.OCS_MEASUREMENTS;
  if (!data || !Array.isArray(data.imbh)) {
    throw new Error('measurements.js evaluated but window.OCS_MEASUREMENTS.imbh is missing/not an array');
  }
  return data.imbh.map((m) => ({
    id: m.id,
    limitType: m.limitType,
    method: m.method,
    value: normValue(m.value),
  }));
}

function extractWorkerConstraints() {
  const workerPath = resolve(ROOT, 'worker.mjs');
  const src = readFileSync(workerPath, 'utf8');

  const marker = 'const IMBH_CONSTRAINTS = [';
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error('IMBH_CONSTRAINTS array not found in worker.mjs');
  }
  // Find the matching closing bracket for the array literal that starts right after '['.
  const arrStart = src.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = arrStart; i < src.length; i++) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) {
    throw new Error('could not find closing bracket for IMBH_CONSTRAINTS in worker.mjs');
  }
  const arrLiteral = src.slice(arrStart, end + 1);

  // Evaluate the array literal in a sandboxed vm (it's a plain JS array-of-objects literal,
  // no external references), robust to formatting/comment changes.
  const sandbox = {};
  vm.createContext(sandbox);
  const wrapped = `globalThis.__IMBH_CONSTRAINTS__ = ${arrLiteral};`;
  try {
    vm.runInContext(wrapped, sandbox, { filename: 'worker.mjs-imbh-extract', timeout: 5000 });
  } catch (e) {
    throw new Error(`failed to evaluate IMBH_CONSTRAINTS literal from worker.mjs: ${e.message}`);
  }
  const arr = sandbox.__IMBH_CONSTRAINTS__ ?? sandbox.globalThis?.__IMBH_CONSTRAINTS__;
  if (!Array.isArray(arr)) {
    throw new Error('IMBH_CONSTRAINTS did not evaluate to an array');
  }
  return arr.map((m) => ({
    id: m.id,
    limitType: m.limitType,
    method: m.method,
    value: normValue(m.value),
  }));
}

async function main() {
  let live, worker;
  try {
    live = await fetchMeasurementsImbh();
  } catch (e) {
    console.error(`FAIL: could not fetch/parse live measurements.js — ${e.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    worker = extractWorkerConstraints();
  } catch (e) {
    console.error(`FAIL: could not extract IMBH_CONSTRAINTS from worker.mjs — ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const liveById = new Map(live.map((m) => [m.id, m]));
  const workerById = new Map(worker.map((m) => [m.id, m]));

  const allIds = new Set([...liveById.keys(), ...workerById.keys()]);
  const diffs = [];

  for (const id of [...allIds].sort()) {
    const l = liveById.get(id);
    const w = workerById.get(id);
    if (!l) {
      diffs.push(`  [${id}] present in worker IMBH_CONSTRAINTS but MISSING from live measurements.js`);
      continue;
    }
    if (!w) {
      diffs.push(`  [${id}] present in live measurements.js but MISSING from worker IMBH_CONSTRAINTS`);
      continue;
    }
    for (const field of FIELDS) {
      if (field === 'id') continue;
      if (!valuesEqual(l[field], w[field])) {
        diffs.push(`  [${id}] field '${field}' mismatch: live=${JSON.stringify(l[field])} worker=${JSON.stringify(w[field])}`);
      }
    }
  }

  if (diffs.length) {
    console.error(`FAIL: IMBH_CONSTRAINTS (worker.mjs) diverges from live measurements.js (${diffs.length} diff(s)):`);
    for (const d of diffs) console.error(d);
    process.exitCode = 1;
    return;
  }

  console.log(`PASS: worker IMBH_CONSTRAINTS matches live measurements.js (${live.length} entries, all ids/limitType/method/value equal).`);
  process.exitCode = 0;
}

main();
