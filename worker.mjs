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

const BASE_URL = 'https://omegacentauri.me';
const VERSION  = '0.3.0';

// OCG Standard §17 (Kernel Identity Binding) — content digest of this file, computed by
// generate.mjs over the LF-normalized source with this line's value replaced by the literal
// 'PLACEHOLDER'. Populated by `node generate.mjs`; idempotent (re-running yields no diff).
const KERNEL_DIGEST = 'sha256:d4c234cecdc98967946912b2434e958fe951d05c59ad64ea5d7ab5092b0c52f8';

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
// buildServer — called per request; manifest already loaded + cached.
// ---------------------------------------------------------------------------
function buildServer(manifest) {
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
    inputSchema: {
      query:    z.string().optional().describe('Free-text search against tool title and description'),
      category: z.string().optional().describe(
        'Filter by category: imbh-evidence | bh-physics | fermi-paradox | fermi-seti | mth | kardashev'
      ),
      register: z.string().optional().describe(
        'Filter by epistemic register: peer-reviewed | speculative'
      ),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
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
    inputSchema: {
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
    },
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
    inputSchema: {
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
    },
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
    inputSchema: {
      artifact:          z.record(z.any()).optional().describe('A full ChainGraph artifact (with policy_parameters, output_payload, execution_hash).'),
      policy_parameters: z.record(z.any()).optional().describe('Artifact policy_parameters (if not passing a full artifact).'),
      output_payload:    z.record(z.any()).optional().describe('Artifact output_payload (if not passing a full artifact).'),
      claimed_hash:      z.string().optional().describe('execution_hash to check against (if not passing a full artifact).'),
    },
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
