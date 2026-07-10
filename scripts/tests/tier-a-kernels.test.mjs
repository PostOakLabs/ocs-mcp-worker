// tier-a-kernels.test.mjs — OCS-TEST-COVERAGE-SPEC.md v1 §3 Tier A.
//
// The 7 §18-proven kernels already have committed fixtures (the same ones
// `check-compute-proofs.mjs` re-verifies against their groth16 receipts).
// This wraps a node:test file around them: import each `.kernel.mjs`,
// run compute() against every case in the matching `.fixtures.json`,
// assert output_payload equality (numeric fields within float tolerance,
// everything else exact).
//
// Run: node --test scripts/tests/tier-a-kernels.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const KERNELS_DIR = resolve(ROOT, 'kernels');
const FIXTURES_DIR = resolve(KERNELS_DIR, 'fixtures');

const kernelIds = readdirSync(KERNELS_DIR)
  .filter((f) => f.endsWith('.kernel.mjs'))
  .map((f) => f.replace(/\.kernel\.mjs$/, ''))
  .sort();

function deepAssertClose(actual, expected, path, t) {
  if (typeof expected === 'number') {
    assert.ok(typeof actual === 'number' && Number.isFinite(actual), `${path}: expected number, got ${JSON.stringify(actual)}`);
    const tol = Math.max(1e-6, Math.abs(expected) * 1e-6);
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: expected ~${expected}, got ${actual}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected array`);
    assert.equal(actual.length, expected.length, `${path}: array length mismatch`);
    expected.forEach((v, i) => deepAssertClose(actual[i], v, `${path}[${i}]`, t));
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${path}: expected object`);
    for (const key of Object.keys(expected)) deepAssertClose(actual[key], expected[key], `${path}.${key}`, t);
  } else {
    assert.equal(actual, expected, `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

test('tier-a kernel fixtures — all §18-proven kernels', async (t) => {
  assert.ok(kernelIds.length >= 7, `expected at least 7 kernels, found ${kernelIds.length}`);

  for (const kernelId of kernelIds) {
    const fixturePath = resolve(FIXTURES_DIR, `${kernelId}.fixtures.json`);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    assert.equal(fixture.tool_id, kernelId, `${kernelId}: fixture tool_id mismatch`);

    const mod = await import(pathToFileURL(resolve(KERNELS_DIR, `${kernelId}.kernel.mjs`)).href);
    assert.equal(typeof mod.compute, 'function', `${kernelId}: kernel must export compute()`);

    for (const vector of fixture.vectors) {
      await t.test(`${kernelId} / ${vector.name}`, () => {
        const result = mod.compute(vector.policy_parameters);
        assert.ok(result && typeof result === 'object' && result.output_payload, `${kernelId}/${vector.name}: compute() must return { output_payload }`);
        deepAssertClose(result.output_payload, vector.output_payload, `${kernelId}/${vector.name}.output_payload`, t);
      });
    }
  }
});
