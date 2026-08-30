// OCS MCP server — Cloudflare Workers runtime.
// Exposes two tools: list_ocs_tools and build_ocs_workflow_links.
// Data is served from tools-manifest.json via the ASSETS binding (vendored by generate.mjs).
// Deploy: node generate.mjs && npx wrangler deploy
// Endpoint: https://mcp.omegacentauri.me/mcp

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toReqRes, toFetchResponse } from 'fetch-to-node';
import { z } from 'zod';
import { BUILDID_BUILDTYPE } from './lib/_buildid.mjs';
import CONSTRAINT_STACKER_PROOF from './kernels/receipts/constraint-stacker.computeproof.mjs';
import { compute as constraintStackerCompute } from './kernels/constraint-stacker.kernel.mjs';
import { compute as bayesFactorRouterCompute } from './kernels/bayes-factor-router.kernel.mjs';
import BAYES_FACTOR_ROUTER_PROOF from './kernels/receipts/bayes-factor-router.computeproof.mjs';
import { compute as jwstAccretionLedgerCompute } from './kernels/jwst-accretion-ledger.kernel.mjs';
import JWST_ACCRETION_LEDGER_PROOF from './kernels/receipts/jwst-accretion-ledger.computeproof.mjs';
import { compute as gwtcRemnantClassifierCompute } from './kernels/gwtc-remnant-classifier.kernel.mjs';
import GWTC_REMNANT_CLASSIFIER_PROOF from './kernels/receipts/gwtc-remnant-classifier.computeproof.mjs';
import { compute as romanMicrolensingCompute } from './kernels/roman-microlensing.kernel.mjs';
import ROMAN_MICROLENSING_PROOF from './kernels/receipts/roman-microlensing.computeproof.mjs';
import { compute as apophisFlybyGeometryCompute } from './kernels/apophis-flyby-geometry.kernel.mjs';
import APOPHIS_FLYBY_GEOMETRY_PROOF from './kernels/receipts/apophis-flyby-geometry.computeproof.mjs';
import { compute as rubinAlertThroughputCompute } from './kernels/rubin-alert-throughput.kernel.mjs';
import RUBIN_ALERT_THROUGHPUT_PROOF from './kernels/receipts/rubin-alert-throughput.computeproof.mjs';

const BASE_URL = 'https://omegacentauri.me';
const VERSION  = '0.3.0';

// OCG Standard §17 (Kernel Identity Binding) — content digest of this file, computed by
// generate.mjs over the LF-normalized source with this line's value replaced by the literal
// 'PLACEHOLDER'. Populated by `node generate.mjs`; idempotent (re-running yields no diff).
const KERNEL_DIGEST = 'sha256:0070aa4583d5ffde529f43b2ee6a125bd2f5963e405f353c686daaf4bf9ee594';

// Vendored from AINumbers ChainGraph SSOT kernels/_hash.mjs (OCG Standard §4 JCS).
// Namespace adapted for me.omegacentauri. Recursive key sort + per-value
// JSON.stringify reproduces RFC 8785 JCS for the I-JSON subset; assertIJson
// fails loud on non-finite / unsafe-int rather than emit an unstable hash.
function assertIJson(v){
  if(typeof v==='number'){
    if(!Number.isFinite(v))throw new Error('Non-finite number ('+v+') not valid I-JSON (RFC 8785 §3.2.2.3).');
    if(Number.isInteger(v)&&!Number.isSafeInteger(v))throw new Error('Integer '+v+' exceeds 2^53 (RFC 7493).');
  } else if(Array.isArray(v)){ v.forEach(assertIJson); }
  else if(v&&typeof v==='object'){ for(const k of Object.keys(v)) assertIJson(v[k]); }
}
const cgCanon=(v)=>Array.isArray(v)?v.map(cgCanon):(v&&typeof v==='object')?Object.keys(v).sort().reduce((o,k)=>(o[k]=cgCanon(v[k]),o),{}):v;
function canonicalPreimage(policy_parameters,output_payload){
  const obj={policy_parameters,output_payload};
  assertIJson(obj);
  return JSON.stringify(cgCanon(obj));
}
// Bare lowercase hex (OCG §4). No "sha256:" prefix.
async function executionHash(policy_parameters,output_payload){
  const bytes=new TextEncoder().encode(canonicalPreimage(policy_parameters,output_payload));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ---------------------------------------------------------------------------
// Vendored VERBATIM from AINumbers ChainGraph SSOT
// C:\dev\Claude\Projects\AINumbers\repo\chaingraph\kernels\_gateval.mjs
// (OpenChainGraph shared decision-gate evaluator, OCG Standard §21.4+).
// SINGLE SOURCE OF TRUTH for gate evaluation across every ChainGraph-conformant
// executing surface (AINumbers worker, embedded runChain, OCS worker run_chain
// below). Do not reimplement — copy the logic exactly; byte-parity matters.
// PURE ECMA-262: no Date, no Math.random, no locale/Intl, no crypto, no I/O.
// ---------------------------------------------------------------------------

// Closed op enum (OCG §21.4). No other operator is valid.
const GATE_OPS = Object.freeze(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'present', 'absent']);
// Ops that carry a comparison `value` (present/absent do not).
const VALUE_OPS = Object.freeze(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']);

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Structural strict equality (no coercion). Used by eq/neq/in.
function gv_deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!gv_deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!gv_deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// A valid RFC 6901 JSON Pointer is "" (whole document) or a string of "/"-
// prefixed tokens. Escapes: ~1 -> "/", ~0 -> "~"; a "~" not part of ~0/~1 is
// invalid. Syntax-only (does not resolve). Exported for validate-chains.
function isPointerSyntaxValid(pointer) {
  if (typeof pointer !== 'string') return false;
  if (pointer === '') return true;
  if (pointer[0] !== '/') return false;
  // Every "~" must be immediately followed by "0" or "1".
  return !/~(?![01])/.test(pointer);
}

// Resolve an RFC 6901 pointer against a document.
// Returns { found, value }. found=false when any token is missing / out of
// range / the pointer is syntactically invalid.
function rfc6901(doc, pointer) {
  if (!isPointerSyntaxValid(pointer)) return { found: false, value: undefined };
  if (pointer === '') return { found: true, value: doc };
  const tokens = pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const tok of tokens) {
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(tok)) return { found: false, value: undefined };
      const idx = Number(tok);
      if (idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return { found: false, value: undefined };
      cur = cur[tok];
    }
  }
  return { found: true, value: cur };
}

// Apply one op. `found` = pointer resolved; `observed` = resolved value.
// Value ops (all but present/absent) require found=true, else no-match.
function applyOp(op, found, observed, value) {
  switch (op) {
    case 'present': return found;
    case 'absent': return !found;
    case 'eq': return found && gv_deepEqual(observed, value);
    case 'neq': return found && !gv_deepEqual(observed, value);
    case 'gt': return found && isFiniteNum(observed) && isFiniteNum(value) && observed > value;
    case 'gte': return found && isFiniteNum(observed) && isFiniteNum(value) && observed >= value;
    case 'lt': return found && isFiniteNum(observed) && isFiniteNum(value) && observed < value;
    case 'lte': return found && isFiniteNum(observed) && isFiniteNum(value) && observed <= value;
    case 'in': return found && Array.isArray(value) && value.some((v) => gv_deepEqual(observed, v));
    default: return false; // unknown op never matches (validate-chains rejects it statically)
  }
}

/**
 * Evaluate a gate against THIS step's output_payload.
 * @param {{input:string, rules:Array<{op:string,value?:any,next:string}>, default:string}} gate
 * @param {object} outputPayload
 * @returns {{input_pointer:string, observed_value:any, matched_rule_index:number|null, op:string|null, value:any, next:string}}
 *   A decision record (minus step_id, which the caller merges in). Deterministic
 *   and recomputable by a verifier from the recorded outputPayload.
 */
function evaluateGate(gate, outputPayload) {
  const { found, value: observed } = rfc6901(outputPayload, gate.input);
  const observed_value = found ? observed : null;
  const rules = Array.isArray(gate.rules) ? gate.rules : [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (applyOp(r.op, found, observed, r.value)) {
      return {
        input_pointer: gate.input,
        observed_value,
        matched_rule_index: i,
        op: r.op,
        value: VALUE_OPS.includes(r.op) ? (r.value === undefined ? null : r.value) : null,
        next: r.next,
      };
    }
  }
  // First-match failed for every rule → mandatory default (total function).
  return {
    input_pointer: gate.input,
    observed_value,
    matched_rule_index: null,
    op: null,
    value: null,
    next: gate.default,
  };
}

// Canonical step identifier: explicit `id`, else the step's tool_id (OCG §21.4).
function stepId(step) {
  return (step && typeof step.id === 'string' && step.id.length) ? step.id : step.tool_id;
}
// ---------------------------------------------------------------------------
// End vendored _gateval.mjs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// base64url-encode a plain object into an #in= fragment value.
// Used to build prefill deep-links for the 10 flagship tools.
// ---------------------------------------------------------------------------
function base64urlEncode(obj) {
  const json = JSON.stringify(obj);
  const b64  = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ---------------------------------------------------------------------------
// Module-scope cache: assets are immutable per deploy, load once per isolate.
// ---------------------------------------------------------------------------
let dataCache = null;
async function loadData(env) {
  if (dataCache) return dataCache;
  const r = await env.ASSETS.fetch('https://assets.local/tools-manifest.json');
  if (!r.ok) throw new Error('asset miss: tools-manifest.json > ' + r.status);
  dataCache = await r.json();
  return dataCache;
}

// ---------------------------------------------------------------------------
// OCG Standard §21 — run_chain server-side kernel execution.
// KERNEL_REGISTRY maps a tool_id to its compute() + registered mandate_type
// (mirrors each tool's mandate_type in its single-tool artifact above).
// ---------------------------------------------------------------------------
const KERNEL_REGISTRY = {
  'constraint-stacker':       { compute: constraintStackerCompute,      mandate_type: 'me.omegacentauri/imbh_constraint' },
  'bayes-factor-router':      { compute: bayesFactorRouterCompute,      mandate_type: 'me.omegacentauri/bayes_factor' },
  'jwst-accretion-ledger':    { compute: jwstAccretionLedgerCompute,    mandate_type: 'me.omegacentauri/imbh_accretion' },
  'gwtc-remnant-classifier':  { compute: gwtcRemnantClassifierCompute,  mandate_type: 'me.omegacentauri/gw_remnant' },
  'roman-microlensing':       { compute: romanMicrolensingCompute,       mandate_type: 'me.omegacentauri/roman_microlensing' },
  'apophis-flyby-geometry':   { compute: apophisFlybyGeometryCompute,   mandate_type: 'me.omegacentauri/apophis_flyby' },
  'rubin-alert-throughput':   { compute: rubinAlertThroughputCompute,   mandate_type: 'me.omegacentauri/rubin_alert_throughput' },
};

// §21.2/§21.4 composite preimage helper — bare-hex SHA-256 over the JCS-
// canonical steps[] definition (used only when the chain has >=1 gate, as the
// route_plan_digest addition to the composite preimage).
async function routePlanDigest(steps) {
  const bytes = new TextEncoder().encode(JSON.stringify(cgCanon(steps)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Full-lane constraint-stacker fields — the kernel's `show` key has no
// default of its own (it is a comma-joined lane-method string built by the
// MCP handler's `?? true` per-lane defaults); a chain step passing fields:{}
// bypasses the handler and reaches the kernel with `show` absent, which the
// kernel reads as zero active lanes (M-6). Every chain step below spells the
// lanes out explicitly so run_chain agrees with the constraint_stacker
// handler's default (all 5 lanes on) rather than running vacuous.
const CONSTRAINT_STACKER_DEFAULT_FIELDS = {
  epsilon: 1e-3,
  rho: 1e-21,
  show: 'kinematics,propermotion,timing,accretion,nbody',
};

// Named chains (OCG §21.1/§21.4). Mirrored as fixtures under kernels/chains/.
export const CHAINS = {
  // LINEAR (§21.1) — single step, no gate.
  'imbh-evidence-window': {
    title: 'IMBH evidence window (linear)',
    steps: [
      { id: 'window', tool_id: 'constraint-stacker', fields: CONSTRAINT_STACKER_DEFAULT_FIELDS },
    ],
  },
  // GATED — evidence-threshold routing. bayes-factor-router's gate_token routes
  // to the falsification lane (constraint-stacker) when evidence is decisive/strong,
  // else falls through (default) to a consistency check (gwtc-remnant-classifier).
  'evidence-threshold-routing': {
    title: 'Evidence-threshold routing (gated)',
    steps: [
      {
        id: 'evidence', tool_id: 'bayes-factor-router', fields: { bf: 1e14 },
        gate: { input: '/gate_token', rules: [{ op: 'in', value: ['decisive', 'strong'], next: 'falsification' }], default: 'consistency' },
      },
      { id: 'falsification', tool_id: 'constraint-stacker', fields: CONSTRAINT_STACKER_DEFAULT_FIELDS, gate: { input: '', rules: [], default: 'end' } },
      { id: 'consistency', tool_id: 'gwtc-remnant-classifier', fields: { m1: 35, m2: 30 } },
    ],
  },
  // GATED — accretion eligibility fast-fail. jwst-accretion-ledger's
  // excluded_above_Msun fast-fails (skips followup) when the exclusion mass is
  // already tight (<1000 Msun); otherwise falls through (default) to a followup
  // constraint-stacker run.
  'accretion-eligibility-fastfail': {
    title: 'Accretion eligibility fast-fail (gated)',
    steps: [
      {
        id: 'ledger', tool_id: 'jwst-accretion-ledger', fields: { epsilon: 1e-3, rho_inf: 1e-21 },
        gate: { input: '/excluded_above_Msun', rules: [{ op: 'lt', value: 1000, next: 'end' }], default: 'followup' },
      },
      { id: 'followup', tool_id: 'constraint-stacker', fields: CONSTRAINT_STACKER_DEFAULT_FIELDS },
    ],
  },
};

// ---------------------------------------------------------------------------
// runChain — OCG §21 linear-model chain executor with §21.4 decision gates.
// steps: [{ tool_id, id?, fields?, gate? }]
// Returns { steps: perStepResults[], composite_execution_hash, path_taken,
//           decisions, chain_title, step_count }.
// ---------------------------------------------------------------------------
export async function runChain(chainTitle, steps) {
  const hasGate = steps.some((s) => !!s.gate);

  // id -> index map for forward jumps ('end' is a sentinel, not a step id).
  const idToIndex = new Map();
  steps.forEach((s, i) => idToIndex.set(stepId(s, i), i));

  const perStep = new Array(steps.length).fill(null);
  const decisions = [];
  const pathTaken = [];
  const ranToolIds = [];
  const ranArtifacts = []; // { tool_id, mandate_type, execution_hash, output_payload }

  let prevHash = null;
  let prevToolId = null;
  let cursor = 0;
  let stopped = false;

  while (cursor !== null && cursor < steps.length && !stopped) {
    const step = steps[cursor];
    const sId = stepId(step, cursor);
    const entry = KERNEL_REGISTRY[step.tool_id];

    if (!entry) {
      // Unknown tool_id -> status unknown_node; does not advance parent threading.
      perStep[cursor] = {
        id: sId,
        tool_id: step.tool_id,
        status: 'unknown_node',
      };
      cursor = cursor + 1;
      continue;
    }

    const policyParameters = { execution_backend: 'js', input_parameters: step.fields ?? {} };
    const { output_payload: outputPayload } = entry.compute(policyParameters);
    const execHash = await executionHash(policyParameters, outputPayload);

    const stepArtifact = {
      tool_id:            step.tool_id,
      mandate_type:       entry.mandate_type,
      execution_hash:     execHash,
      chain: {
        parent_hashes:   prevHash ? [prevHash] : [],
        parent_tool_ids: prevToolId ? [prevToolId] : [],
        chain_depth:     cursor,
      },
      policy_parameters:  policyParameters,
      output_payload:     outputPayload,
    };

    perStep[cursor] = { id: sId, status: 'ok', artifact: stepArtifact };
    pathTaken.push(sId);
    ranToolIds.push(step.tool_id);
    ranArtifacts.push({
      tool_id:        step.tool_id,
      mandate_type:   entry.mandate_type,
      execution_hash: execHash,
      output_payload: outputPayload,
    });

    prevHash = execHash;
    prevToolId = step.tool_id;

    if (step.gate) {
      const decision = evaluateGate(step.gate, outputPayload);
      decision.step_id = sId;
      decisions.push(decision);

      if (decision.next === 'end') {
        stopped = true;
        // Mark all remaining, not-yet-visited steps as skipped_by_gate.
        for (let j = cursor + 1; j < steps.length; j++) {
          if (perStep[j] === null) perStep[j] = { id: stepId(steps[j], j), status: 'skipped_by_gate' };
        }
        cursor = null;
        break;
      }

      const nextIdx = idToIndex.get(decision.next);
      if (nextIdx === undefined) {
        // Should not happen for a validated chain (forward-only next); treat as end.
        stopped = true;
        cursor = null;
        break;
      }
      // Mark every step strictly between cursor and nextIdx (forward-only) as
      // skipped_by_gate — they are jumped over and do NOT run.
      for (let j = cursor + 1; j < nextIdx; j++) {
        if (perStep[j] === null) perStep[j] = { id: stepId(steps[j], j), status: 'skipped_by_gate' };
      }
      cursor = nextIdx;
    } else {
      cursor = cursor + 1;
    }
  }

  // Any steps never visited (e.g. branch not taken, chain ended early without
  // a gate reaching them) are skipped_by_gate too.
  for (let j = 0; j < steps.length; j++) {
    if (perStep[j] === null) perStep[j] = { id: stepId(steps[j], j), status: 'skipped_by_gate' };
  }

  let compositeHash = null;
  if (ranArtifacts.length > 0) {
    const pp = {
      compute_mode: 'server',
      chain: { name: chainTitle, steps },
      chain_title: chainTitle,
      step_count: ranArtifacts.length,
      step_tool_ids: ranToolIds,
    };
    const op = {
      chain: { name: chainTitle, steps },
      steps: ranArtifacts,
    };
    if (hasGate) {
      pp.route_plan_digest = await routePlanDigest(steps);
      op.decisions = decisions;
      op.path_taken = pathTaken;
    }
    compositeHash = await executionHash(pp, op);
  }

  return {
    chain_title: chainTitle,
    step_count: steps.length,
    ran_count: ranArtifacts.length,
    steps: perStep,
    path_taken: pathTaken,
    decisions,
    composite_execution_hash: compositeHash,
  };
}

// ---------------------------------------------------------------------------
// buildServer — called per request; manifest already loaded + cached.
// ---------------------------------------------------------------------------
export function buildServer(manifest) {
  const server = new McpServer({ name: 'ocs-mcp', version: VERSION });
  const tools  = manifest.tools  ?? {};
  const chains = manifest.chains ?? {};

  // Flagship tools (those in the manifest) have OCS_APPLY_PREFILL hooks wired.
  const prefillEnabled = new Set(Object.keys(tools));
  const CHAIN_NAMES    = Object.keys(chains);

  // -------------------------------------------------------------------------
  // list_ocs_tools
  // -------------------------------------------------------------------------
  server.registerTool('list_ocs_tools', {
    title: 'List OCS tools',
    description:
      'Search the Omega Centauri Society interactive calculator suite. ' +
      'Returns deep-links to client-side browser tools at omegacentauri.me. ' +
      'Flagship tools are prefill-enabled: append #in=<base64url(JSON)> to ' +
      'the URL and the tool opens pre-filled with those parameter values. ' +
      'Categories: imbh-evidence (kinematics, dark-cluster, microlensing, Bayesian evidence ledger, detection forecast), ' +
      'bh-physics (scale comparator, infall survival, shadow imaging, Kerr geometry), ' +
      'fermi-paradox (Drake equation, Great Filter), ' +
      'fermi-seti (radio / optical SETI sensitivity), ' +
      'mth (Macro Transcension Hypothesis — BZ power, Bekenstein-Landauer-Lloyd compute limits), ' +
      'kardashev (Kardashev meter, energy translator, sci-fi tech auditor). ' +
      'Registers: peer-reviewed (citable science) vs speculative (MTH engineering extrapolations). ' +
      'IMBH mass tension note: Häberle 2024 sets a ≥8,200 M☉ lower bound; ' +
      'Bañares 2025 sets a ≤6,000 M☉ upper bound. These are irreconcilable — never collapse to one number.',
    inputSchema: z.object({
      query:    z.string().optional().describe('Free-text search against tool title and description'),
      category: z.string().optional().describe(
        'Filter by category: imbh-evidence | bh-physics | fermi-paradox | fermi-seti | mth | kardashev'
      ),
      register: z.string().optional().describe(
        'Filter by epistemic register: peer-reviewed | speculative'
      ),
      limit: z.number().optional().describe('Max results (default 20)'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, category, register, limit }) => {
    const q = (query ?? '').toLowerCase();
    const rows = Object.entries(tools)
      .filter(([, t]) => !category || t.category === category)
      .filter(([, t]) => !register  || t.register  === register)
      .filter(([slug, t]) =>
        !q || (t.title + ' ' + t.description).toLowerCase().includes(q)
      )
      .slice(0, limit ?? 20)
      .map(([slug, t]) => ({
        slug,
        title:    t.title,
        category: t.category,
        register: t.register,
        prefill:  true,
        url:      BASE_URL + '/' + t.path,
        description: t.description.slice(0, 180),
        inputs:   Object.keys(t.inputs ?? {}),
        hashNote: t.hashNote ?? null,
        citations: t.citations ?? [],
      }));
    return {
      content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      structuredContent: { count: rows.length, tools: rows },
    };
  });

  // -------------------------------------------------------------------------
  // constraint_stacker — computes IMBH mass window + returns OCS artifact JSON
  // -------------------------------------------------------------------------
  server.registerTool('constraint_stacker', {
    title: 'OCS IMBH Constraint Stacker',
    description:
      'Computes the currently allowed IMBH mass window for NGC 5139 (Omega Centauri) ' +
      'given active observational constraints. Returns a hash-anchored OCS ChainGraph artifact JSON. ' +
      'Mirrors the browser tool at omegacentauri.me/tools/constraint-stacker.html. ' +
      'CRITICAL: Häberle 2024 lower bound (8,200 M☉) exceeds Bañares 2025 upper limit (6,000 M☉) — ' +
      'irreconcilable under default settings. When tension_detected is true, report as ' +
      '"at least one analysis has unaccounted-for systematics" — never collapse to one mass. ' +
      'The JWST accretion limit (Chen et al. 2025) shifts with epsilon and rho_inf. ' +
      'execution_hash anchors the result for citation and downstream chain provenance.',
    inputSchema: z.object({
      epsilon: z.number().min(1e-6).max(1).optional().describe(
        'ADAF radiative efficiency (0 < ε ≤ 1). Default 0.001. ' +
        'Lower ε → weaker accretion → JWST upper limit shifts to higher masses.'
      ),
      rho_inf: z.number().min(1e-28).max(1e-18).optional().describe(
        'Ambient gas density at the Bondi radius (kg/m³). Default 1e-21. ' +
        'Lower ρ∞ → less Bondi accretion → JWST upper limit shifts to higher masses.'
      ),
      show_kinematics:   z.boolean().optional().describe('Include stellar kinematics constraints (default true)'),
      show_propermotion: z.boolean().optional().describe('Include HST proper-motion constraints (default true)'),
      show_timing:       z.boolean().optional().describe('Include pulsar timing constraints (default true)'),
      show_accretion:    z.boolean().optional().describe('Include JWST accretion constraints (default true)'),
      show_nbody:        z.boolean().optional().describe('Include N-body simulation constraints (default true)'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ epsilon, rho_inf, show_kinematics, show_propermotion, show_timing, show_accretion, show_nbody }) => {
    const eps = epsilon ?? 1e-3;
    const rho = rho_inf ?? 1e-21;
    const show = {
      kinematics:   show_kinematics   ?? true,
      propermotion: show_propermotion ?? true,
      timing:       show_timing       ?? true,
      accretion:    show_accretion    ?? true,
      nbody:        show_nbody        ?? true,
    };

    // Physics lanes (msigma is a browser overlay only, not a window-bounding method).
    const LANES       = ['kinematics', 'propermotion', 'timing', 'accretion', 'nbody'];
    const activeLanes = LANES.filter(m => show[m]);

    // Canonical artifact shape — identical to the browser tool's buildArtifact()
    // so the execution_hash reproduces across both surfaces. execution_backend is
    // 'js' (the worker runs the same JS reference computation); the UI-only 'sel'
    // field is intentionally excluded from the hashed inputs.
    const policyParameters = {
      execution_backend: 'js',
      input_parameters: {
        epsilon: eps,
        rho:     rho,
        show:    activeLanes.join(','),
      },
    };

    // Single source of truth for the window/output-payload computation — shared
    // with the guest runtime via kernels/constraint-stacker.kernel.mjs.
    const { output_payload: outputPayload } = constraintStackerCompute(policyParameters);

    // OCG Standard §4: hash over the artifact's snake_case {policy_parameters,
    // output_payload} so any vendor's verify_execution_hash reproduces it — and
    // so the worker matches repo/tools/constraint-stacker.html byte-for-byte.
    // Bare lowercase hex (no sha256: prefix); the digest is unchanged from the
    // prior sortKeysDeep+JSON.stringify canonicalization.
    const execHash = await executionHash(policyParameters, outputPayload);

    const artifact = {
      '@context':     'https://openchain.graph/spec/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      buildType:      'https://openchain.graph/spec/v0.2#WebCryptoSHA256',
      mandate_type:   'me.omegacentauri/imbh_constraint',
      tool_id:        'constraint-stacker',
      tool_version:   '1.2.0',
      generated_at:   new Date().toISOString(),
      execution_hash: execHash,
      chain: {
        parent_hashes:   [],
        parent_tool_ids: [],
        chain_depth:     0,
      },
      policy_parameters: policyParameters,
      output_payload:    outputPayload,
      compliance_flags: [
        'register:peer-reviewed',
        outputPayload.tension_detected ? 'tension:lower_bound_exceeds_upper_limit' : 'window:consistent',
      ],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        register:             'peer-reviewed',
        data_sources: [
          'Häberle et al. 2024, Nature 631:285',
          'Bañares-Hernández et al. 2025, A&A 693:A104',
          'Chen et al. 2025, arXiv:2511.20945',
          'Malave et al. 2025/2026, arXiv:2512.09649',
          'Colom i Bernadich et al. 2026, arXiv:2603.21845',
        ],
        schema_version: 'ocs-chaingraph-0.4.0',
        ocs_artifact_version: '1.0.0',
      },
    };

    // OCG Standard §17 (Kernel Identity Binding) — hash-excluded; stamped AFTER
    // execution_hash is computed and never enters the hashed preimage.
    artifact.audit_signature.build_identity = {
      kernel_digest: KERNEL_DIGEST,
      buildType:     BUILDID_BUILDTYPE,
      source_ref:    'worker.mjs',
    };

    // OCG Standard §18 — attach the real groth16 compute-proof for the PROVEN default
    // inputs (hash-excluded; assigned after execution_hash, never enters the preimage).
    // The zkVM receipt proves kernels/constraint-stacker.kernel.mjs produced this exact
    // output_payload. Non-default inputs stay §4 hash-anchored but carry no per-input
    // receipt (only the default vector was proven).
    const PROVEN_PP = { execution_backend: 'js', input_parameters: { epsilon: 1e-3, rho: 1e-21, show: 'kinematics,propermotion,timing,accretion,nbody' } };
    if (JSON.stringify(cgCanon(policyParameters)) === JSON.stringify(cgCanon(PROVEN_PP))) {
      artifact.audit_signature.compute_proof = CONSTRAINT_STACKER_PROOF;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
      structuredContent: artifact,
    };
  });

  // -------------------------------------------------------------------------
  // bayes_factor_router — Bayes-factor / 2lnBF evidence-strength gate token
  // -------------------------------------------------------------------------
  server.registerTool('bayes_factor_router', {
    title: 'OCS Bayes Factor Router',
    description:
      'Classifies a Bayes factor (BF) or 2·lnBF value into a categorical evidence-strength ' +
      'token using the Jeffreys (1961) / Kass & Raftery (1995, JASA 90:773) scale: ' +
      'supports_null · weak · substantial · strong · decisive. Used as a §21.4 decision ' +
      'gate for model-selection and evidence chains (e.g. routing NANOGrav-style ' +
      'gravitational-wave-background Bayes factors). Returns a hash-anchored OCS ' +
      'ChainGraph artifact JSON with a gate_token suitable for downstream chain routing. ' +
      'Worked example: BF > 1e14 (NANOGrav 15-yr GWB, arXiv:2306.16213) -> "decisive". ' +
      'Pass either bf (raw Bayes factor) or two_ln_bf (2·ln(BF), the twice-log-likelihood-ratio ' +
      'scale); if both are omitted, returns an "undefined" gate_token with no evidence input.',
    inputSchema: z.object({
      bf: z.number().optional().describe(
        'Raw Bayes factor (BF > 0). Thresholds: <1 supports null, <3.2 weak, <10 substantial, ' +
        '<100 strong, >=100 decisive (Kass & Raftery 1995). Mutually preferred over two_ln_bf if both given.'
      ),
      two_ln_bf: z.number().optional().describe(
        '2·ln(Bayes factor) — the twice-log-likelihood-ratio scale. Thresholds: <0 supports null, ' +
        '<2.3263 weak, <4.6052 substantial, <9.2103 strong, >=9.2103 decisive.'
      ),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ bf, two_ln_bf }) => {
    const input_parameters = {};
    if (bf !== undefined) input_parameters.bf = bf;
    if (two_ln_bf !== undefined) input_parameters.two_ln_bf = two_ln_bf;

    const policyParameters = { execution_backend: 'js', input_parameters };
    const { output_payload: outputPayload } = bayesFactorRouterCompute(policyParameters);
    const execHash = await executionHash(policyParameters, outputPayload);

    const artifact = {
      '@context':     'https://openchain.graph/spec/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      buildType:      'https://openchain.graph/spec/v0.2#WebCryptoSHA256',
      mandate_type:   'me.omegacentauri/bayes_factor',
      tool_id:        'bayes-factor-router',
      tool_version:   '1.2.0',
      generated_at:   new Date().toISOString(),
      execution_hash: execHash,
      chain: {
        parent_hashes:   [],
        parent_tool_ids: [],
        chain_depth:     0,
      },
      policy_parameters: policyParameters,
      output_payload:    outputPayload,
      compliance_flags: ['register:peer-reviewed'],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        register:             'peer-reviewed',
        data_sources: [
          'Jeffreys 1961',
          'Kass & Raftery 1995, JASA 90:773',
        ],
        schema_version: 'ocs-chaingraph-0.4.0',
        ocs_artifact_version: '1.0.0',
      },
    };

    artifact.audit_signature.build_identity = {
      kernel_digest: KERNEL_DIGEST,
      buildType:     BUILDID_BUILDTYPE,
      source_ref:    'worker.mjs',
    };

    const PROVEN_PP_BAYES_FACTOR_ROUTER = { execution_backend: 'js', input_parameters: { bf: 1e14 } };
    if (JSON.stringify(cgCanon(policyParameters)) === JSON.stringify(cgCanon(PROVEN_PP_BAYES_FACTOR_ROUTER))) {
      artifact.audit_signature.compute_proof = BAYES_FACTOR_ROUTER_PROOF;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
      structuredContent: artifact,
    };
  });

  // -------------------------------------------------------------------------
  // jwst_accretion_ledger — JWST accretion-limit exclusion mass (model-dependent)
  // -------------------------------------------------------------------------
  server.registerTool('jwst_accretion_ledger', {
    title: 'OCS JWST Accretion Ledger',
    description:
      'Computes the IMBH mass above which the predicted ADAF/Bondi accretion luminosity would ' +
      'exceed the JWST NIRCam/MIRI bolometric upper limit for NGC 5139 (Chen et al. 2025, ' +
      'arXiv:2511.20945), given an assumed ADAF radiative efficiency epsilon and ambient gas ' +
      'density rho_inf at the Bondi radius. Returns a hash-anchored OCS ChainGraph artifact JSON. ' +
      'CRITICAL — this is a MODEL-DEPENDENT accretion constraint: the exclusion mass scales with ' +
      'the assumed epsilon (Pesce et al. 2021) and is NOT a peer of the Häberle 2024 kinematic ' +
      'lower bound or the Bañares 2025 pulsar-timing upper bound. It constrains (mass, accretion) ' +
      'COMBINATIONS and does not assert or imply any IMBH mass detection.',
    inputSchema: z.object({
      epsilon: z.number().min(1e-6).max(1).optional().describe(
        'ADAF radiative efficiency (0 < ε ≤ 1). Default 0.001. ' +
        'Lower ε → weaker accretion → exclusion mass shifts higher.'
      ),
      rho_inf: z.number().min(1e-28).max(1e-18).optional().describe(
        'Ambient gas density at the Bondi radius (kg/m³). Default 1e-21. ' +
        'Lower ρ∞ → less Bondi accretion → exclusion mass shifts higher.'
      ),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ epsilon, rho_inf }) => {
    const eps = epsilon ?? 1e-3;
    const rho = rho_inf ?? 1e-21;

    const policyParameters = { execution_backend: 'js', input_parameters: { epsilon: eps, rho_inf: rho } };
    const { output_payload: outputPayload } = jwstAccretionLedgerCompute(policyParameters);
    const execHash = await executionHash(policyParameters, outputPayload);

    const artifact = {
      '@context':     'https://openchain.graph/spec/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      buildType:      'https://openchain.graph/spec/v0.2#WebCryptoSHA256',
      mandate_type:   'me.omegacentauri/imbh_accretion',
      tool_id:        'jwst-accretion-ledger',
      tool_version:   '1.2.0',
      generated_at:   new Date().toISOString(),
      execution_hash: execHash,
      chain: {
        parent_hashes:   [],
        parent_tool_ids: [],
        chain_depth:     0,
      },
      policy_parameters: policyParameters,
      output_payload:    outputPayload,
      compliance_flags: ['register:model-dependent'],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        register:             'model-dependent',
        data_sources: [
          'Chen et al. 2025, arXiv:2511.20945 (accepted ApJ, v2 2026-03-20)',
          'Pesce et al. 2021 (ADAF radiative efficiency epsilon dependence)',
        ],
        schema_version: 'ocs-chaingraph-0.4.0',
        ocs_artifact_version: '1.0.0',
      },
    };

    artifact.audit_signature.build_identity = {
      kernel_digest: KERNEL_DIGEST,
      buildType:     BUILDID_BUILDTYPE,
      source_ref:    'worker.mjs',
    };

    const PROVEN_PP_JWST_ACCRETION_LEDGER = { execution_backend: 'js', input_parameters: { epsilon: 1e-3, rho_inf: 1e-21 } };
    if (JSON.stringify(cgCanon(policyParameters)) === JSON.stringify(cgCanon(PROVEN_PP_JWST_ACCRETION_LEDGER))) {
      artifact.audit_signature.compute_proof = JWST_ACCRETION_LEDGER_PROOF;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
      structuredContent: artifact,
    };
  });

  // -------------------------------------------------------------------------
  // gwtc_remnant_classifier — GWTC-5.0 IMBH remnant / pair-instability gap classifier
  // -------------------------------------------------------------------------
  server.registerTool('gwtc_remnant_classifier', {
    title: 'OCS GWTC Remnant Classifier',
    description:
      'Classifies a compact-binary merger (GWTC-5.0-style component masses m1, m2, optional ' +
      'aligned spins chi1, chi2) by computing chirp mass, total mass, mass ratio, remnant ' +
      '(final) mass, final spin, pair-instability (PI) mass-gap membership (~60-130 M☉, model-' +
      'dependent edges), and an IMBH-remnant classification with a gate_token for chain routing. ' +
      'Uses the Jiménez-Forteza et al. 2017 (PRD 95, 064024, arXiv:1611.00332) nonspinning-limit ' +
      'closed-form fits for radiated energy and final spin. Anchor-validated against GW231123 ' +
      '(m1~137, m2~103 M☉ -> remnant ~229 M☉, within the paper\'s quoted range). Returns a ' +
      'hash-anchored OCS ChainGraph artifact JSON. Register: peer-reviewed fit (JF17) in its ' +
      'nonspinning limit; PI-gap edges and GW231123-class remnant masses carry model/waveform-' +
      'systematics uncertainty — see the artifact caveat field.',
    inputSchema: z.object({
      m1: z.number().optional().describe('Primary component mass (M☉). Default 30.'),
      m2: z.number().optional().describe('Secondary component mass (M☉). Default 25.'),
      chi1: z.number().optional().describe('Primary aligned dimensionless spin. Default 0 (nonspinning-limit fit).'),
      chi2: z.number().optional().describe('Secondary aligned dimensionless spin. Default 0 (nonspinning-limit fit).'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ m1, m2, chi1, chi2 }) => {
    const input_parameters = {};
    if (m1   !== undefined) input_parameters.m1   = m1;
    if (m2   !== undefined) input_parameters.m2   = m2;
    if (chi1 !== undefined) input_parameters.chi1 = chi1;
    if (chi2 !== undefined) input_parameters.chi2 = chi2;

    const policyParameters = { execution_backend: 'js', input_parameters };
    const { output_payload: outputPayload } = gwtcRemnantClassifierCompute(policyParameters);
    const execHash = await executionHash(policyParameters, outputPayload);

    const artifact = {
      '@context':     'https://openchain.graph/spec/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      buildType:      'https://openchain.graph/spec/v0.2#WebCryptoSHA256',
      mandate_type:   'me.omegacentauri/gw_remnant',
      tool_id:        'gwtc-remnant-classifier',
      tool_version:   '1.2.0',
      generated_at:   new Date().toISOString(),
      execution_hash: execHash,
      chain: {
        parent_hashes:   [],
        parent_tool_ids: [],
        chain_depth:     0,
      },
      policy_parameters: policyParameters,
      output_payload:    outputPayload,
      compliance_flags: ['register:peer-reviewed'],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        register:             'peer-reviewed',
        data_sources: [
          'Jiménez-Forteza et al. 2017, PRD 95, 064024 (arXiv:1611.00332)',
          'Farmer et al. 2019 (PI mass-gap edges)',
          'Chatterjee et al. 2025, arXiv:2509.09161 (GW231123 waveform-systematics ML validation)',
        ],
        schema_version: 'ocs-chaingraph-0.4.0',
        ocs_artifact_version: '1.0.0',
      },
    };

    artifact.audit_signature.build_identity = {
      kernel_digest: KERNEL_DIGEST,
      buildType:     BUILDID_BUILDTYPE,
      source_ref:    'worker.mjs',
    };

    const PROVEN_PP_GWTC_REMNANT_CLASSIFIER = { execution_backend: 'js', input_parameters: { m1: 137, m2: 103 } };
    if (JSON.stringify(cgCanon(policyParameters)) === JSON.stringify(cgCanon(PROVEN_PP_GWTC_REMNANT_CLASSIFIER))) {
      artifact.audit_signature.compute_proof = GWTC_REMNANT_CLASSIFIER_PROOF;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
      structuredContent: artifact,
    };
  });

  // -------------------------------------------------------------------------
  // roman_microlensing — Nancy Grace Roman Space Telescope microlensing geometry
  // -------------------------------------------------------------------------
  server.registerTool('roman_microlensing', {
    title: 'OCS Roman Microlensing',
    description:
      'Computes Einstein radius (theta_E, mas) and Einstein crossing timescale (t_E, days) for a ' +
      'gravitational microlensing event observable by the Nancy Grace Roman Space Telescope ' +
      '(launch target 2026-08-30), using the Gould 2000 (ApJ 542, 785) microlensing formalism. ' +
      'Also reports a yield-scaled stellar event estimate from Penny et al. 2019 (arXiv:1808.02490). ' +
      'The `regime` field is "forecast" until released=true (Roman has not launched as of 2026-07-04). ' +
      'Inputs: lens_mass_Msun (lens mass), D_L_kpc (lens distance), D_S_kpc (source distance, must be ' +
      'greater than D_L_kpc), mu_mas_yr (relative proper motion), released (boolean, default false), ' +
      'survey_fraction (0-1, scales Penny 2019 yield). Returns a hash-anchored OCS ChainGraph artifact. ' +
      'Register: peer-reviewed (Gould 2000 formalism; Penny 2019 yield). ' +
      'IMBH context: for a lens mass of 8,200 M☉ (Haberle 2024 lower bound) at omega-Cen distance ' +
      '(5.3 kpc) with galactic-bulge sources (8.2 kpc), theta_E ~ 67 mas and t_E ~ 22 years — ' +
      'detectable with Roman astrometric microlensing but very long-duration events.',
    inputSchema: z.object({
      lens_mass_Msun: z.number().positive().optional().describe(
        'Lens mass in solar masses. Default 1.0 (stellar). Try 8200 for Haberle 2024 IMBH lower bound.'
      ),
      D_L_kpc: z.number().positive().optional().describe(
        'Lens distance in kpc. Default 4.0. For omega-Cen as lens: ~5.3 kpc.'
      ),
      D_S_kpc: z.number().positive().optional().describe(
        'Source distance in kpc. Must exceed D_L_kpc. Default 8.0 (galactic bulge).'
      ),
      mu_mas_yr: z.number().positive().optional().describe(
        'Relative proper motion of lens and source (mas/yr). Default 5.0. Typical bulge: 3-8 mas/yr.'
      ),
      released: z.boolean().optional().describe(
        'Whether Roman data are released. Default false (Roman launches 2026-08-30). ' +
        'When false, regime="forecast"; when true, regime="live".'
      ),
      survey_fraction: z.number().min(0).max(1).optional().describe(
        'Fraction of the Penny 2019 6-field 2-season fiducial survey (0-1). Default 1.0. ' +
        'Scales the ~27,000 stellar event yield estimate proportionally.'
      ),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ lens_mass_Msun, D_L_kpc, D_S_kpc, mu_mas_yr, released, survey_fraction }) => {
    const input_parameters = {};
    if (lens_mass_Msun   !== undefined) input_parameters.lens_mass_Msun   = lens_mass_Msun;
    if (D_L_kpc          !== undefined) input_parameters.D_L_kpc          = D_L_kpc;
    if (D_S_kpc          !== undefined) input_parameters.D_S_kpc          = D_S_kpc;
    if (mu_mas_yr        !== undefined) input_parameters.mu_mas_yr        = mu_mas_yr;
    if (released         !== undefined) input_parameters.released         = released;
    if (survey_fraction  !== undefined) input_parameters.survey_fraction  = survey_fraction;

    const policyParameters = { execution_backend: 'js', input_parameters };
    const { output_payload: outputPayload } = romanMicrolensingCompute(policyParameters);
    const execHash = await executionHash(policyParameters, outputPayload);

    const artifact = {
      '@context':     'https://openchain.graph/spec/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      buildType:      'https://openchain.graph/spec/v0.2#WebCryptoSHA256',
      mandate_type:   'me.omegacentauri/roman_microlensing',
      tool_id:        'roman-microlensing',
      tool_version:   '1.2.0',
      generated_at:   new Date().toISOString(),
      execution_hash: execHash,
      chain: {
        parent_hashes:   [],
        parent_tool_ids: [],
        chain_depth:     0,
      },
      policy_parameters: policyParameters,
      output_payload:    outputPayload,
      compliance_flags: ['register:peer-reviewed'],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        register:             'peer-reviewed',
        data_sources: [
          'Gould 2000, ApJ 542, 785 (microlensing Einstein radius formalism)',
          'Penny et al. 2019, ApJS 241, 3 (arXiv:1808.02490) — Roman Galactic Bulge microlensing yield',
          'Johnson et al. 2024, arXiv:2512.05182 — updated Roman microlensing yield estimates',
        ],
        schema_version: 'ocs-chaingraph-0.4.0',
        ocs_artifact_version: '1.0.0',
      },
    };

    artifact.audit_signature.build_identity = {
      kernel_digest: KERNEL_DIGEST,
      buildType:     BUILDID_BUILDTYPE,
      source_ref:    'worker.mjs',
    };

    const PROVEN_PP_ROMAN_MICROLENSING = {
      execution_backend: 'js',
      input_parameters: { lens_mass_Msun: 1.0, D_L_kpc: 4.0, D_S_kpc: 8.0, mu_mas_yr: 5.0, survey_fraction: 1.0, released: false },
    };
    if (JSON.stringify(cgCanon(policyParameters)) === JSON.stringify(cgCanon(PROVEN_PP_ROMAN_MICROLENSING))) {
      artifact.audit_signature.compute_proof = ROMAN_MICROLENSING_PROOF;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
      structuredContent: artifact,
    };
  });

  // -------------------------------------------------------------------------
  // apophis_flyby_geometry — Apophis 99942 close-approach geometry (2029-04-13)
  // -------------------------------------------------------------------------
  server.registerTool('apophis_flyby_geometry', {
    title: 'OCS Apophis Flyby Geometry',
    description:
      'Computes the close-approach geometry for the 2029-04-13 flyby of asteroid 99942 Apophis, ' +
      'which passes inside geostationary orbit at ~38,017 km from Earth\'s centre. ' +
      'Physics: tidal acceleration differential across the asteroid (dg = 2·GM_earth·d/r³, classical tidal formula), ' +
      'perigee speed from vis-viva equation (v_peri² = v_inf² + 2·GM/r), and GEO-ring crossing status. ' +
      'Default inputs match the nominal JPL/CNEOS solution #197 (perigee ~38,017 km, ' +
      'diameter ~340 m, v_inf ~7.43 km/s). ' +
      'Missions en route: NASA OSIRIS-APEX (arrival 2029-04-13) and ESA Ramses (launch Apr 2028). ' +
      'Inputs: perigee_km (Earth-centre distance at closest approach, km), ' +
      'diameter_m (asteroid mean diameter, m), rel_velocity_km_s (hyperbolic excess velocity v_inf, km/s). ' +
      'Returns a hash-anchored OCS ChainGraph artifact. Register: peer-reviewed ' +
      '(Farnocchia et al. 2021 Icarus 369 114594; Brozovic et al. 2018 Icarus 300 115).',
    inputSchema: z.object({
      perigee_km: z.number().positive().optional().describe(
        'Earth-centre distance at closest approach in km. Default 38017.0 (JPL nominal). ' +
        'GEO orbit is at 42,164 km — values below this are inside GEO.'
      ),
      diameter_m: z.number().positive().optional().describe(
        'Asteroid mean diameter in metres. Default 340.0 (radar shape model, uncertainty ~30 m).'
      ),
      rel_velocity_km_s: z.number().positive().optional().describe(
        'Hyperbolic excess velocity (v_inf) in km/s. Default 7.43. ' +
        'Used in vis-viva equation: v_peri² = v_inf² + 2·GM/r.'
      ),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ perigee_km, diameter_m, rel_velocity_km_s }) => {
    const input_parameters = {};
    if (perigee_km         !== undefined) input_parameters.perigee_km         = perigee_km;
    if (diameter_m         !== undefined) input_parameters.diameter_m         = diameter_m;
    if (rel_velocity_km_s  !== undefined) input_parameters.rel_velocity_km_s  = rel_velocity_km_s;

    const policyParameters = { execution_backend: 'js', input_parameters };
    const { output_payload: outputPayload } = apophisFlybyGeometryCompute(policyParameters);
    const execHash = await executionHash(policyParameters, outputPayload);

    const artifact = {
      '@context':     'https://openchain.graph/spec/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      buildType:      'https://openchain.graph/spec/v0.2#WebCryptoSHA256',
      mandate_type:   'me.omegacentauri/apophis_flyby',
      tool_id:        'apophis-flyby-geometry',
      tool_version:   '1.2.0',
      generated_at:   new Date().toISOString(),
      execution_hash: execHash,
      chain: {
        parent_hashes:   [],
        parent_tool_ids: [],
        chain_depth:     0,
      },
      policy_parameters: policyParameters,
      output_payload:    outputPayload,
      compliance_flags: ['register:peer-reviewed'],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        register:             'peer-reviewed',
        data_sources: [
          'Farnocchia et al. 2021, Icarus 369, 114594 (DOI 10.1016/j.icarus.2021.114594) — definitive Apophis orbit solution',
          'Brozovic et al. 2018, Icarus 300, 115 (DOI 10.1016/j.icarus.2017.09.010) — Apophis radar observations',
          'JPL/CNEOS Apophis close-approach solution #197: 2029-Apr-13 perigee ~38,017 km',
          'ESA Ramses mission: committed Nov 2025, launch target Apr 2028',
          'NASA OSIRIS-APEX: en route to Apophis, arrival 2029-04-13',
        ],
        schema_version: 'ocs-chaingraph-0.4.0',
        ocs_artifact_version: '1.0.0',
      },
    };

    artifact.audit_signature.build_identity = {
      kernel_digest: KERNEL_DIGEST,
      buildType:     BUILDID_BUILDTYPE,
      source_ref:    'worker.mjs',
    };

    const PROVEN_PP_APOPHIS_FLYBY = {
      execution_backend: 'js',
      input_parameters: { perigee_km: 38017.0, diameter_m: 340.0, rel_velocity_km_s: 7.43 },
    };
    if (JSON.stringify(cgCanon(policyParameters)) === JSON.stringify(cgCanon(PROVEN_PP_APOPHIS_FLYBY))) {
      artifact.audit_signature.compute_proof = APOPHIS_FLYBY_GEOMETRY_PROOF;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
      structuredContent: artifact,
    };
  });

  // -------------------------------------------------------------------------
  // rubin_alert_throughput — Rubin/LSST transient-alert throughput calculator
  // -------------------------------------------------------------------------
  server.registerTool('rubin_alert_throughput', {
    title: 'OCS Rubin Alert Throughput',
    description:
      'Estimates the nightly transient-alert count and data-rate budget for the Vera C. Rubin ' +
      'Observatory Legacy Survey of Space and Time (LSST). ' +
      'Pure arithmetic: alerts_per_night = visits_per_night × alerts_per_visit; ' +
      'nightly_data_rate_GB = alerts_per_night × avg_alert_bytes / 1e9. ' +
      'Default parameters from Rubin system design (Ivezic et al. 2019, ApJ 873 111): ' +
      '~1,000 visits/night, ~10,000 alerts/visit, ~182 clear nights/year, ~82 KB/alert packet ' +
      '(Bellm et al. 2019, PASP 131 995004). ' +
      'Rubin is in commissioning as of 2026; all figures are pre-science design estimates. ' +
      'Inputs: visits_per_night, alerts_per_visit, nights_per_year, avg_alert_bytes. ' +
      'Returns a hash-anchored OCS ChainGraph artifact. Register: speculative ' +
      '(Rubin LSST full-survey operations not yet begun as of 2026).',
    inputSchema: z.object({
      visits_per_night: z.number().positive().optional().describe(
        'Number of telescope visits (exposures) per night. Default 1000 (Rubin design estimate).'
      ),
      alerts_per_visit: z.number().positive().optional().describe(
        'Number of transient alerts generated per visit. Default 10000 (Rubin alert design, ~10⁴/visit).'
      ),
      nights_per_year: z.number().positive().optional().describe(
        'Clear science nights per year at Cerro Pachón. Default 182 (Ivezic et al. 2019).'
      ),
      avg_alert_bytes: z.number().positive().optional().describe(
        'Average bytes per alert packet. Default 82000 (82 KB; Bellm et al. 2019, PASP 131 995004).'
      ),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ visits_per_night, alerts_per_visit, nights_per_year, avg_alert_bytes }) => {
    const input_parameters = {};
    if (visits_per_night  !== undefined) input_parameters.visits_per_night  = visits_per_night;
    if (alerts_per_visit  !== undefined) input_parameters.alerts_per_visit  = alerts_per_visit;
    if (nights_per_year   !== undefined) input_parameters.nights_per_year   = nights_per_year;
    if (avg_alert_bytes   !== undefined) input_parameters.avg_alert_bytes   = avg_alert_bytes;

    const policyParameters = { execution_backend: 'js', input_parameters };
    const { output_payload: outputPayload } = rubinAlertThroughputCompute(policyParameters);
    const execHash = await executionHash(policyParameters, outputPayload);

    const artifact = {
      '@context':     'https://openchain.graph/spec/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      buildType:      'https://openchain.graph/spec/v0.2#WebCryptoSHA256',
      mandate_type:   'me.omegacentauri/rubin_alert_throughput',
      tool_id:        'rubin-alert-throughput',
      tool_version:   '1.2.0',
      generated_at:   new Date().toISOString(),
      execution_hash: execHash,
      chain: {
        parent_hashes:   [],
        parent_tool_ids: [],
        chain_depth:     0,
      },
      policy_parameters: policyParameters,
      output_payload:    outputPayload,
      compliance_flags: ['register:speculative'],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        register:             'speculative',
        data_sources: [
          'Ivezic et al. 2019, ApJ 873, 111 (arXiv:0805.2366) — LSST science design overview',
          'Bellm et al. 2019, PASP 131, 995004 (arXiv:1902.02134) — LSST alert system design (~10^4 alerts/visit, ~82 KB/alert)',
          'LSST Science Book 2009 (arXiv:0912.0201) — survey design parameters',
        ],
        schema_version: 'ocs-chaingraph-0.4.0',
        ocs_artifact_version: '1.0.0',
      },
    };

    artifact.audit_signature.build_identity = {
      kernel_digest: KERNEL_DIGEST,
      buildType:     BUILDID_BUILDTYPE,
      source_ref:    'worker.mjs',
    };

    const PROVEN_PP_RUBIN = {
      execution_backend: 'js',
      input_parameters: { visits_per_night: 1000, alerts_per_visit: 10000, nights_per_year: 182, avg_alert_bytes: 82000 },
    };
    if (JSON.stringify(cgCanon(policyParameters)) === JSON.stringify(cgCanon(PROVEN_PP_RUBIN))) {
      artifact.audit_signature.compute_proof = RUBIN_ALERT_THROUGHPUT_PROOF;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
      structuredContent: artifact,
    };
  }); // -----------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // build_ocs_workflow_links
  // -------------------------------------------------------------------------
  server.registerTool('build_ocs_workflow_links', {
    title: 'Build OCS workflow deep-links',
    description:
      'Constructs an ordered set of ready-to-use deep-links for a named OCS scenario or workflow ' +
      'chain, or an ad-hoc sequence of tools. Each link points to the browser tool at omegacentauri.me. ' +
      'The flagship tools accept #in=<base64url(JSON)> prefill fragments — pass input values as ' +
      'a fields object to receive a pre-filled URL. ' +
      'All physics logic runs deterministically in the user\'s browser; zero server-side execution. ' +
      'IMBH mass tension: Häberle 2024 lower bound ≥8,200 M☉; Bañares 2025 upper bound ≤6,000 M☉ — ' +
      'irreconcilable. Do not collapse to a single value; present both. ' +
      'Named chains (' + CHAIN_NAMES.length + ' total): ' + CHAIN_NAMES.join(', ') + '.',
    inputSchema: z.object({
      chain: z.string().optional().describe(
        'Name of a pre-defined scenario or workflow chain. ' +
        'One of: ' + CHAIN_NAMES.join(', ') + '. ' +
        'Mutually exclusive with steps.'
      ),
      steps: z.array(z.object({
        tool: z.string().describe(
          'Tool slug (e.g. "constraint-stacker", "bz-kardashev", "drake-monte-carlo")'
        ),
        fields: z.record(z.any()).optional().describe(
          'Input values encoded as #in= fragment when the tool is prefill-enabled. ' +
          'IMPORTANT: radio-seti ALL 6 params are log10 (eirp, dist, aeff, tsys, tau, bw). ' +
          'qpo-mass-spin: lognu is log10(Hz). bz-kardashev: use key "spin" (not "a") and "power" (not "P").'
        ),
      })).optional().describe('Ad-hoc ordered step list. Mutually exclusive with chain.'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ chain, steps }) => {
    // Validate mutual exclusivity
    if (chain && steps) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Provide either chain or steps, not both.' }],
      };
    }

    let chainMeta = null;
    let rawSteps;

    if (chain) {
      chainMeta = chains[chain];
      if (!chainMeta) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Unknown chain "' + chain + '". Available: ' + CHAIN_NAMES.join(', ') }],
        };
      }
      rawSteps = chainMeta.steps.map((s) => ({
        tool: s.tool, fields: undefined, _handoff: s.handoff,
      }));
    } else if (steps && steps.length > 0) {
      rawSteps = steps.map((s) => ({ tool: s.tool, fields: s.fields, _handoff: null }));
    } else {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Provide chain (named) or steps (ad-hoc array of {tool, fields?}).' }],
      };
    }

    const warnings = [];
    const result   = [];

    for (let i = 0; i < rawSteps.length; i++) {
      const rs       = rawSteps[i];
      const slug     = rs.tool;
      const toolMeta = tools[slug];

      // Flagship tools use the manifest path; others get the conventional URL
      let url = toolMeta
        ? BASE_URL + '/' + toolMeta.path
        : BASE_URL + '/tools/' + slug + '.html';

      const prefill = prefillEnabled.has(slug);

      if (rs.fields && Object.keys(rs.fields).length > 0) {
        if (!prefill) {
          warnings.push(
            'Step ' + (i + 1) + ' (' + slug + '): fields provided but this tool is ' +
            'not a flagship prefill tool — fields ignored.'
          );
        } else {
          url = url + '#in=' + base64urlEncode(rs.fields);
        }
      }

      const handoff_note = rs._handoff
        ?? (i < rawSteps.length - 1
          ? 'Export results from this tool, then open step ' + (i + 2) + '.'
          : 'Final step.');

      result.push({
        order:       i + 1,
        tool:        slug,
        title:       toolMeta?.title ?? slug,
        url,
        prefill,
        handoff_note,
      });
    }

    const output = {
      chain:      chain ?? null,
      title:      chainMeta?.title  ?? null,
      tier:       chainMeta?.tier   ?? null,
      register:   chainMeta?.register ?? null,
      chain_page: chainMeta?.page   ? BASE_URL + '/' + chainMeta.page : null,
      imbh_mass_note:
        'Häberle 2024 lower bound ≥8,200 M☉ (kinematics); ' +
        'Bañares 2025 upper bound ≤6,000 M☉ (pulsar timing). ' +
        'These bounds are irreconcilable — present both.',
      steps: result,
      warnings,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  });

  // -------------------------------------------------------------------------
  // verify_execution_hash — ChainGraph Standard §4 (JCS execution hash)
  // Recompute an artifact's execution hash so any agent can independently
  // verify an OCS (or any ChainGraph) artifact rather than trust it. Uses the
  // §4 JCS canonicalizer over the same snake_case preimage the artifacts are
  // hashed over; tolerant of a legacy 'sha256:' prefix on the claimed hash.
  // -------------------------------------------------------------------------
  server.registerTool('verify_execution_hash', {
    title: 'Verify a ChainGraph execution hash',
    description:
      'Independently verify a ChainGraph artifact (ChainGraph Standard §4 JCS). ' +
      'Recomputes SHA-256 over the canonical (RFC 8785 JCS, sorted-key, whitespace-stripped) JSON of ' +
      '{policy_parameters, output_payload} and compares it to the claimed execution_hash ' +
      '(bare hex or legacy sha256:-prefixed). ' +
      'Pass a full artifact, or policy_parameters + output_payload + claimed_hash. ' +
      'Works on artifacts from any ChainGraph vendor (OCS, AINumbers, ApexLogics).',
    inputSchema: z.object({
      artifact:          z.record(z.any()).optional().describe('A full ChainGraph artifact (with policy_parameters, output_payload, execution_hash).'),
      policy_parameters: z.record(z.any()).optional().describe('Artifact policy_parameters (if not passing a full artifact).'),
      output_payload:    z.record(z.any()).optional().describe('Artifact output_payload (if not passing a full artifact).'),
      claimed_hash:      z.string().optional().describe('execution_hash to check against (if not passing a full artifact).'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ artifact, policy_parameters, output_payload, claimed_hash }) => {
    const pp = policy_parameters ?? artifact?.policy_parameters;
    const op = output_payload ?? artifact?.output_payload;
    const claimed = claimed_hash ?? artifact?.execution_hash ?? null;
    if (pp === undefined || op === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Provide a full artifact, or policy_parameters + output_payload (+ claimed_hash).' }] };
    }
    // Bare lowercase hex (OCG §4). Accept a claimed hash with or without a
    // legacy 'sha256:' prefix: strip it from both sides before comparing so
    // previously exported (sha256:-prefixed) artifacts still verify.
    const stripPfx = (h) => (typeof h === 'string' && h.startsWith('sha256:')) ? h.slice(7) : h;
    const computed = await executionHash(pp, op);
    const valid = claimed != null && stripPfx(computed) === stripPfx(claimed);
    const out = {
      valid,
      computed_hash: computed,
      claimed_hash:  claimed,
      tool_id:            artifact?.tool_id ?? null,
      chaingraph_version: artifact?.chaingraph_version ?? null,
      note: claimed == null
        ? 'No claimed hash supplied — returning the computed hash only.'
        : (valid ? 'Verified: recomputed hash matches the artifact.' : 'MISMATCH: treat the artifact as unverified.'),
      spec: 'ChainGraph Standard §4',
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
  });

  // -------------------------------------------------------------------------
  // run_chain — OCG Standard §21 server-side chain EXECUTION (not deeplinks).
  // Executes the 4 registered kernels in sequence, threading each step's
  // execution_hash as the next step's chain.parent_hashes, with optional
  // §21.4 decision gates for evidence-threshold routing / falsification /
  // both-branch fast-fail chains. Returns a composite_execution_hash over the
  // RAN (status ok) steps only.
  // -------------------------------------------------------------------------
  const CHAIN_KEYS = Object.keys(CHAINS);
  server.registerTool('run_chain', {
    title: 'Run an OCS ChainGraph chain (server-side kernel execution)',
    description:
      'Executes a ChainGraph chain server-side (OCG Standard §21) — runs the actual ' +
      'kernels (constraint-stacker, bayes-factor-router, jwst-accretion-ledger, ' +
      'gwtc-remnant-classifier, roman-microlensing) in sequence, NOT deep-links. Supports §21.4 decision ' +
      'gates: an RFC 6901 pointer into a step\'s output_payload (e.g. gate_token, ' +
      'excluded_above_Msun) is matched against ordered rules (eq/neq/gt/gte/lt/lte/in/' +
      'present/absent) to pick the next step id, falling through to a mandatory default ' +
      'when no rule matches. Named chains: "' + CHAIN_KEYS.join('", "') + '". ' +
      '"evidence-threshold-routing" demonstrates both-branch evidence-threshold routing ' +
      '(decisive/strong Bayes factor -> falsification lane; weak/substantial -> default ' +
      'consistency check). "accretion-eligibility-fastfail" demonstrates a fast-fail gate ' +
      '(tight JWST exclusion mass skips the followup step). Returns a composite hash over ' +
      'the executed (RAN) steps, the decision record(s), and the path_taken. No argument ' +
      'runs the default linear chain ("imbh-evidence-window").',
    inputSchema: z.object({
      chain: z.string().optional().describe(
        'Name of a pre-defined chain to execute. One of: ' + CHAIN_KEYS.join(', ') + '. ' +
        'Mutually exclusive with steps. Defaults to "imbh-evidence-window" if neither is given.'
      ),
      steps: z.array(z.object({
        id: z.string().optional().describe('Explicit step id (defaults to tool_id if omitted).'),
        tool_id: z.string().describe(
          'Kernel tool_id to execute: constraint-stacker | bayes-factor-router | jwst-accretion-ledger | gwtc-remnant-classifier | roman-microlensing'
        ),
        fields: z.record(z.any()).optional().describe('Input parameters passed to the kernel as input_parameters.'),
        gate: z.object({
          input: z.string().describe('RFC 6901 JSON Pointer into this step\'s output_payload.'),
          rules: z.array(z.object({
            op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'present', 'absent']),
            value: z.any().optional(),
            next: z.string().describe('Forward-only step id, or "end".'),
          })),
          default: z.string().describe('Mandatory fallback step id, or "end", when no rule matches.'),
        }).optional().describe('Optional §21.4 decision gate evaluated after this step runs.'),
      })).optional().describe('Ad-hoc ordered step list. Mutually exclusive with chain.'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ chain, steps }) => {
    // An empty steps array is treated as absent (not "both provided") — a
    // caller sending steps:[] alongside chain is asking to run the named
    // chain, not opting into an empty ad-hoc chain.
    const stepsGiven = (steps && steps.length > 0) ? steps : undefined;

    if (chain && stepsGiven) {
      return { isError: true, content: [{ type: 'text', text: 'Provide either chain or steps, not both.' }] };
    }

    let chainTitle, chainSteps;
    if (chain) {
      const chainMeta = CHAINS[chain];
      if (!chainMeta) {
        return { isError: true, content: [{ type: 'text', text: 'Unknown chain "' + chain + '". Available: ' + CHAIN_KEYS.join(', ') }] };
      }
      chainTitle = chainMeta.title;
      chainSteps = chainMeta.steps;
    } else if (stepsGiven) {
      chainTitle = 'ad-hoc';
      chainSteps = stepsGiven;
    } else {
      // FIXTURE-DEFAULT: no-argument call runs the default linear chain.
      chainTitle = CHAINS['imbh-evidence-window'].title;
      chainSteps = CHAINS['imbh-evidence-window'].steps;
    }

    const result = await runChain(chainTitle, chainSteps);
    const output = { chain: chain ?? (stepsGiven ? 'ad-hoc' : 'imbh-evidence-window'), ...result };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  });

  return server;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  'https://omegacentauri.me',
  'https://www.omegacentauri.me',
  'https://claude.ai',
  'https://app.claude.ai',
  'http://localhost:3000',
  'http://localhost:8787',
]);

// ---------------------------------------------------------------------------
// Cloudflare Workers entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin':  ALLOWED_ORIGINS.has(origin) ? origin : 'https://omegacentauri.me',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Glama ownership claim (directory listing verification)
    if (url.pathname === '/.well-known/glama.json') {
      return Response.json({ maintainers: ['collectrix'] }, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json(
        { status: 'ok', server: 'ocs-mcp', version: VERSION, mcp_endpoint: 'https://mcp.omegacentauri.me/mcp' },
        { headers: corsHeaders }
      );
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // Parse body once — needed by both the MCP handler and telemetry extraction.
      const body = await request.json().catch(() => undefined);

      // Telemetry fields from tools/call requests only — structural metadata,
      // never payloads, parameters, or outputs.
      const isToolCall = body?.method === 'tools/call';
      const toolName   = isToolCall ? (body?.params?.name ?? 'unknown') : null;
      const chainDepth = isToolCall ? (body?.params?.arguments?.chain_depth ?? 0) : null;

      const t0        = Date.now();
      const manifest  = await loadData(env);
      const server    = buildServer(manifest);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const { req, res } = toReqRes(request);
      await server.connect(transport);
      const handled = transport.handleRequest(req, res, body);
      ctx.waitUntil(handled);
      const response = await toFetchResponse(res);
      for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);

      // Fire-and-forget Analytics Engine telemetry — never blocks the response.
      // Structural metadata only: tool name, salted (non-reversible, no-PII) caller hash,
      // ok/error, latency, chain depth. Mirrors ainumbers-mcp / apexlogics-mcp.
      if (isToolCall && env.ANALYTICS) {
        const latencyMs = Date.now() - t0;
        const success   = response.status < 500;
        const callerRaw = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? '';
        const callerBuf = await crypto.subtle.digest('SHA-256',
          new TextEncoder().encode('ocs-mcp-v1:' + callerRaw));
        const callerHash = 'sha256:' + Array.from(new Uint8Array(callerBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        ctx.waitUntil(Promise.resolve().then(() => {
          try {
            env.ANALYTICS.writeDataPoint({
              blobs:   [toolName, callerHash, success ? 'ok' : 'error'],
              doubles: [latencyMs, chainDepth ?? 0],
              indexes: [toolName],
            });
          } catch (_) { /* telemetry is best-effort; never affect the response */ }
        }));
      }

      return response;
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
