// chains.test.mjs — OCS-TEST-COVERAGE-SPEC.md v1 §3 "Chains" section.
//
// preflight.yml's manifest validator already checks chain-step integrity
// statically (slugs exist / are noted as non-MCP). What's missing per the
// spec is a DYNAMIC walk: does calling build_ocs_workflow_links for every
// one of the 41 committed chains actually produce a well-formed step
// sequence from the live worker code path, not just valid-looking JSON in
// the manifest.
//
// Full numeric chain execution (step N's real output feeding step N+1's
// input) only applies to the 3 run_chain-executable chains (already
// covered in tier-b-contracts.test.mjs) — the 41 deep-link chains are
// mostly site-only calculator steps with no callable endpoint, so there is
// nothing to execute. This file is schema-level, as the spec allows for
// v1: every chain resolves through the live tool, and where two adjacent
// steps are BOTH MCP-manifest tools with documented hash params, warn
// (not fail — the manifest has no per-tool output schema, only inputs)
// if they share a param name with conflicting log10 units, the exact bug
// class CLAUDE.md's "Hash units for demo deeplinks" gotcha exists for.
//
// Requires a running worker at MCP_ENDPOINT (see tier-b-contracts.test.mjs).
//
// Run: node --test scripts/tests/chains.test.mjs

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

// Soft check: two adjacent manifest-documented tools sharing a hash param
// name with conflicting log10 units — a class of bug CLAUDE.md flags by
// hand ("always Grep each tool's loadHash() ... before wiring"). Warn
// only; the manifest's per-param log10 flag is sparse/incomplete, so a
// missing flag is not evidence of a mismatch (spec §5: warn-not-fail for
// this until fixture coverage is judged complete).
function warnUnitMismatch(chainId, fromToolId, toToolId) {
  const fromInputs = manifest.tools[fromToolId]?.inputs || {};
  const toInputs = manifest.tools[toToolId]?.inputs || {};
  for (const key of Object.keys(fromInputs)) {
    if (!(key in toInputs)) continue;
    const a = !!fromInputs[key].log10;
    const b = !!toInputs[key].log10;
    if (a !== b) {
      console.warn(`::warning::chain '${chainId}': step '${fromToolId}' -> '${toToolId}' both use hash param '${key}' but log10 flags disagree (${a} vs ${b}) — verify units before wiring`);
    }
  }
}

test('chains — dynamic build_ocs_workflow_links walk for every committed chain', async (t) => {
  const chainIds = Object.keys(manifest.chains);
  assert.ok(chainIds.length >= 39, `expected at least 39 chains (preflight.yml MIN_CHAINS floor), found ${chainIds.length}`);

  for (const chainId of chainIds) {
    await t.test(chainId, async () => {
      const declared = manifest.chains[chainId];
      const result = await mcpCall('build_ocs_workflow_links', { chain: chainId });
      assert.ok(!result.isError, `${chainId}: build_ocs_workflow_links returned an error: ${JSON.stringify(result.content)}`);
      const sc = result.structuredContent;
      assert.equal(sc.steps.length, declared.steps.length,
        `${chainId}: got ${sc.steps.length} live steps, manifest declares ${declared.steps.length}`);

      for (let i = 0; i < sc.steps.length; i++) {
        const step = sc.steps[i];
        assert.equal(step.tool, declared.steps[i].tool, `${chainId}: step ${i} tool mismatch`);
        assert.ok(typeof step.url === 'string' && step.url.startsWith('https://omegacentauri.me/'),
          `${chainId}: step ${i} url malformed: ${step.url}`);
        assert.ok(typeof step.handoff_note === 'string' && step.handoff_note.length > 0,
          `${chainId}: step ${i} missing a handoff_note`);
      }

      for (let i = 0; i < declared.steps.length - 1; i++) {
        warnUnitMismatch(chainId, declared.steps[i].tool, declared.steps[i + 1].tool);
      }
    });
  }
});
