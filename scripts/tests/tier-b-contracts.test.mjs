// tier-b-contracts.test.mjs — OCS-TEST-COVERAGE-SPEC.md v1 §3 Tier B.
//
// The worker registers 11 MCP tools total: 7 are §18-proven kernels
// (tier-a-kernels.test.mjs), the other 4 are registry/utility tools with
// no per-tool kernel fixture — list_ocs_tools, build_ocs_workflow_links,
// verify_execution_hash, run_chain. The ~24 "remaining catalog tools" in
// the spec are manifest CATALOG entries (site calculator pages), not
// separate callable MCP tools — there is no JSON-RPC endpoint to call for
// them individually; their only worker-side surface is being findable
// through list_ocs_tools and linkable through build_ocs_workflow_links,
// which is what this file actually tests.
//
// These are contract tests, not math regression: given a valid call,
// assert the response shape matches what the committed manifest promises
// (catalog count, chain step count, hash verification, chain execution
// shape) — not a specific numeric physics answer.
//
// Requires a running worker at MCP_ENDPOINT (default local wrangler dev on
// 127.0.0.1:8799) — spun up by preflight.yml before this file runs, per
// spec §5 (never hits live prod from a test run).
//
// Run: node --test scripts/tests/tier-b-contracts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ENDPOINT = process.env.MCP_ENDPOINT || 'http://127.0.0.1:8799/mcp';

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'data/tools-manifest.json'), 'utf8'));

let nextId = 1;
async function mcpCall(name, args) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args ?? {} } }),
  });
  const raw = await res.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  const json = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  if (json.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(json.error)}`);
  return json.result;
}

async function mcpList() {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} }),
  });
  const raw = await res.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : raw).result;
}

test('tier-b contract — list_ocs_tools catalog count matches committed manifest', async () => {
  const result = await mcpCall('list_ocs_tools', { limit: 500 });
  const expectedCount = Object.keys(manifest.tools).length;
  assert.equal(result.structuredContent.count, expectedCount,
    `list_ocs_tools count ${result.structuredContent.count} != committed manifest catalog ${expectedCount}`);
  assert.ok(Array.isArray(result.structuredContent.tools), 'list_ocs_tools must return a tools array');
});

test('tier-b contract — list_ocs_tools category filter returns only that category', async () => {
  const result = await mcpCall('list_ocs_tools', { category: 'imbh-evidence', limit: 500 });
  assert.ok(result.structuredContent.tools.length > 0, 'expected at least one imbh-evidence tool');
  for (const t of result.structuredContent.tools) {
    assert.equal(t.category, 'imbh-evidence', `tool ${t.slug ?? t.id ?? '?'} has category ${t.category}, expected imbh-evidence`);
  }
});

test('tier-b contract — build_ocs_workflow_links deep-link chains', async (t) => {
  const chainNames = Object.keys(manifest.chains);
  assert.ok(chainNames.length > 0, 'manifest must declare at least one chain');

  const listing = await mcpList();
  const desc = listing.tools.find((x) => x.name === 'build_ocs_workflow_links').description;
  const m = desc.match(/Named chains \((\d+) total\)/);
  assert.ok(m, 'build_ocs_workflow_links description must advertise "Named chains (N total)"');
  assert.equal(Number(m[1]), chainNames.length,
    `advertised chain count ${m[1]} != committed manifest chains ${chainNames.length}`);

  // Sample a handful of chains rather than all 41 — this is a contract
  // check (step count / shape), not a per-chain fixture.
  const sample = [chainNames[0], chainNames[Math.floor(chainNames.length / 2)], chainNames[chainNames.length - 1]];
  for (const chainId of sample) {
    await t.test(chainId, async () => {
      const result = await mcpCall('build_ocs_workflow_links', { chain: chainId });
      const expectedSteps = manifest.chains[chainId].steps.length;
      assert.equal(result.structuredContent.steps.length, expectedSteps,
        `${chainId}: got ${result.structuredContent.steps.length} steps, manifest declares ${expectedSteps}`);
      for (const step of result.structuredContent.steps) {
        assert.ok(typeof step.url === 'string' && step.url.startsWith('https://omegacentauri.me/'),
          `${chainId}: step url looks wrong: ${step.url}`);
      }
    });
  }
});

test('tier-b contract — verify_execution_hash accepts a valid artifact and rejects a tampered one', async () => {
  const fixture = JSON.parse(readFileSync(resolve(ROOT, 'kernels/fixtures/apophis-flyby-geometry.fixtures.json'), 'utf8'));
  const vector = fixture.vectors[0];

  const valid = await mcpCall('verify_execution_hash', {
    policy_parameters: vector.policy_parameters,
    output_payload: vector.output_payload,
    claimed_hash: vector.golden_hash,
  });
  assert.equal(valid.structuredContent.valid, true, 'verify_execution_hash should validate the kernel-proven golden hash');

  const tampered = await mcpCall('verify_execution_hash', {
    policy_parameters: vector.policy_parameters,
    output_payload: { ...vector.output_payload, perigee_km: vector.output_payload.perigee_km + 1 },
    claimed_hash: vector.golden_hash,
  });
  assert.equal(tampered.structuredContent.valid, false, 'verify_execution_hash should reject a tampered output_payload');
});

test('tier-b contract — run_chain executes each named server-side chain', async (t) => {
  const listing = await mcpList();
  const runChainTool = listing.tools.find((x) => x.name === 'run_chain');
  const chainKeysMatch = runChainTool.description.match(/Named chains: "([^"]+(?:", "[^"]+)*)"/);
  assert.ok(chainKeysMatch, 'run_chain description must list its named chains');
  const chainKeys = chainKeysMatch[1].split('", "');
  assert.ok(chainKeys.length >= 1, 'expected at least one server-executable chain');

  for (const chainKey of chainKeys) {
    await t.test(chainKey, async () => {
      const result = await mcpCall('run_chain', { chain: chainKey });
      const sc = result.structuredContent;
      assert.ok(Array.isArray(sc.steps) && sc.steps.length > 0, `${chainKey}: expected at least one executed step`);
      // A gated chain's untaken branch is legitimately 'skipped_by_gate' —
      // only the steps on path_taken must have actually run ('ok').
      const ranSteps = sc.steps.filter((s) => sc.path_taken.includes(s.id));
      assert.ok(ranSteps.length > 0, `${chainKey}: expected at least one step on path_taken`);
      assert.ok(ranSteps.every((s) => s.status === 'ok'), `${chainKey}: every step on path_taken should have status 'ok'`);
      assert.equal(typeof sc.composite_execution_hash, 'string', `${chainKey}: expected a composite_execution_hash string`);
      assert.ok(Array.isArray(sc.path_taken) && sc.path_taken.length > 0, `${chainKey}: expected a non-empty path_taken`);
    });
  }
});
