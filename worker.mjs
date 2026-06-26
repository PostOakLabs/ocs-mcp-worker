// OCS MCP server — Cloudflare Workers runtime.
// Exposes two tools: list_ocs_tools and build_ocs_workflow_links.
// Data is served from tools-manifest.json via the ASSETS binding (vendored by generate.mjs).
// Deploy: node generate.mjs && npx wrangler deploy
// Endpoint: https://mcp.omegacentauri.me/mcp

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toReqRes, toFetchResponse } from 'fetch-to-node';
import { z } from 'zod';

const BASE_URL = 'https://omegacentauri.me';
const VERSION  = '0.2.0';

// ---------------------------------------------------------------------------
// Physical constants (SI) — constraint_stacker computation.
// Values match repo/tools/constraint-stacker.html exactly.
// ---------------------------------------------------------------------------
const G_SI    = 6.674e-11;   // m³ kg⁻¹ s⁻²
const C_SI    = 2.998e8;     // m/s
const MSUN_KG = 1.989e30;    // kg

// JWST accretion upper-limit (Chen et al. 2025, arXiv:2511.20945).
// L_predicted = ε · Ṁ_Bondi · c²;  Ṁ_Bondi = 4π G² M² ρ∞ / c_s³
// Solve for M: M = sqrt( L_limit · c_s³ / (ε · 4π G² ρ∞ · c²) )
const JWST_L_LIMIT = 1e28;  // 10^35 erg/s → 10^28 W
const JWST_C_S     = 1.0e4; // m/s (~10 km/s, typical GC-core sound speed)

// Full IMBH constraint set — mirrors window.OCS_MEASUREMENTS.imbh in
// repo/tools/data/measurements.js (all 9 entries, same id/method/limitType/value).
// computeConstraintWindow() ignores 'detection'/'noEvidence' for lo/hi, but the
// full list is needed so n_constraints_active matches the browser tool's count.
// Keep in sync with measurements.js.
const IMBH_CONSTRAINTS = [
  { id: 'noyola2008',         year: 2008, authors: 'Noyola, Gebhardt & Bergmann',          limitType: 'detection',          method: 'kinematics',   value: 4e4 },
  { id: 'vandermarel2010',    year: 2010, authors: 'van der Marel & Anderson',             limitType: 'upper',              method: 'kinematics',   value: 1.2e4 },
  { id: 'baumgardt2017',      year: 2017, authors: 'Baumgardt',                            limitType: 'noEvidence',         method: 'nbody',        value: null },
  { id: 'haberle2024',        year: 2024, authors: 'Häberle et al.',                       limitType: 'lower',              method: 'propermotion', value: 8200 },
  { id: 'banares2025',        year: 2025, authors: 'Bañares-Hernández et al.',             limitType: 'upper',              method: 'timing',       value: 6000 },
  { id: 'omegacat6_2025',     year: 2025, authors: 'Häberle et al. (oMEGACat VI)',         limitType: 'noEvidence',         method: 'kinematics',   value: null },
  { id: 'chen2025jwst',       year: 2025, authors: 'Chen et al.',                          limitType: 'parameterDependent', method: 'accretion',    value: null },
  { id: 'gonzalezprieto2025', year: 2025, authors: 'González Prieto, Rodriguez & Cabrera', limitType: 'detection',          method: 'nbody',        value: 5e4 },
  { id: 'trapum2026',         year: 2026, authors: 'TRAPUM (Colom i Bernadich et al.)',    limitType: 'upper',              method: 'timing',       value: 1e5 },
];

// Constraint computation helpers
function jwstUpperLimitMsun(epsilon, rho_inf) {
  const num = JWST_L_LIMIT * Math.pow(JWST_C_S, 3);
  const den = epsilon * 4 * Math.PI * G_SI * G_SI * rho_inf * C_SI * C_SI;
  return Math.sqrt(num / den) / MSUN_KG;
}

function computeConstraintWindow(epsilon, rho_inf, show) {
  let lo = -Infinity, hi = Infinity;
  let lowSrc = null, hiSrc = null;
  for (const m of IMBH_CONSTRAINTS) {
    if (!show[m.method]) continue;
    if (m.limitType === 'lower' && m.value !== null) {
      if (m.value > lo) { lo = m.value; lowSrc = m; }
    } else if (m.limitType === 'upper' && m.value !== null) {
      if (m.value < hi) { hi = m.value; hiSrc = m; }
    } else if (m.limitType === 'parameterDependent' && m.method === 'accretion') {
      const v = jwstUpperLimitMsun(epsilon, rho_inf);
      if (v < hi) { hi = v; hiSrc = { ...m, value: v }; }
    }
  }
  if (lo === -Infinity) lo = null;
  if (hi === Infinity)  hi = null;
  const tension = (lo !== null && hi !== null && lo > hi);
  return { lo, hi, tension, lowSrc, hiSrc };
}

// Number + verdict formatting — ported verbatim from repo/tools/constraint-stacker.html
// so the worker artifact is byte-identical to the browser export for the same inputs.
// en-US locale is pinned so the hashed verdict is deterministic across runtimes
// (ChainGraph Standard §6 — no run-to-run variation in the hash preimage).
function fmtMass(M) {
  if (M === null || M === undefined || isNaN(M)) return '—';
  if (M >= 1e6) return (M / 1e6).toFixed(2) + '×10⁶';
  if (M >= 1e4) return (M / 1e3).toFixed(1) + '×10³';
  if (M >= 1000) return Math.round(M).toLocaleString('en-US');
  return Math.round(M).toString();
}
function buildVerdictString(win) {
  if (win.tension) {
    const lo = win.lowSrc ? win.lowSrc.authors + ' ' + win.lowSrc.year : 'lower bound';
    const hi = win.hiSrc  ? win.hiSrc.authors  + ' ' + win.hiSrc.year  : 'upper limit';
    return `tension — ${lo} (${fmtMass(win.lo)} M☉) exceeds ${hi} (${fmtMass(win.hi)} M☉)`;
  }
  if (win.lo !== null && win.hi !== null) return `allowed window: ${fmtMass(win.lo)}–${fmtMass(win.hi)} M☉`;
  if (win.lo !== null) return `lower bound only: > ${fmtMass(win.lo)} M☉`;
  if (win.hi !== null) return `upper limit only: < ${fmtMass(win.hi)} M☉`;
  return 'no constraints active';
}

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

async function sha256hex(obj) {
  const canonical = JSON.stringify(sortKeysDeep(obj));
  const buf  = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
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
// Telemetry — Cloudflare Analytics Engine writeDataPoint (non-blocking, fire-and-forget).
// PRIVACY: record ONLY the tool name + enumerable, non-identifying dimensions (category,
// chain). NEVER the raw user query, client IP, or any identity. Optional-chained so local
// dev (no AE binding) silently no-ops, and a telemetry error never breaks a tool call.
// Schema: blobs[0]=tool, blobs[1]=dim1, blobs[2]=dim2, doubles[0]=1; indexes[0]=tool.
// ---------------------------------------------------------------------------
function track(env, tool, dim1 = '', dim2 = '') {
  try {
    env?.AE?.writeDataPoint({
      blobs: [tool, String(dim1), String(dim2)],
      doubles: [1],
      indexes: [tool],
    });
  } catch (_) { /* telemetry must never surface to callers */ }
}

// ---------------------------------------------------------------------------
// buildServer — called per request; manifest already loaded + cached.
// ---------------------------------------------------------------------------
function buildServer(manifest, env) {
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
    // Privacy: record the enumerable filters only — NOT the raw query text.
    track(env, 'list_ocs_tools', category ?? '', register ?? '');
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
    track(env, 'constraint_stacker');
    const eps = epsilon ?? 1e-3;
    const rho = rho_inf ?? 1e-21;
    const show = {
      kinematics:   show_kinematics   ?? true,
      propermotion: show_propermotion ?? true,
      timing:       show_timing       ?? true,
      accretion:    show_accretion    ?? true,
      nbody:        show_nbody        ?? true,
    };

    const win = computeConstraintWindow(eps, rho, show);

    // Physics lanes (msigma is a browser overlay only, not a window-bounding method).
    const LANES       = ['kinematics', 'propermotion', 'timing', 'accretion', 'nbody'];
    const activeLanes = LANES.filter(m => show[m]);
    // Count every measurement whose method is shown (incl. detection/noEvidence),
    // matching constraint-stacker.html's activeConstraints.
    const nActive     = IMBH_CONSTRAINTS.filter(m => show[m.method]).length;

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

    const outputPayload = {
      allowed_window_M_solar: {
        lower: win.lo !== null ? Math.round(win.lo) : null,
        upper: win.hi !== null ? Math.round(win.hi) : null,
      },
      tension_detected:        !!win.tension,
      tension_direction:       win.tension ? 'lower_bound_exceeds_upper_limit' : null,
      n_constraints_active:    nActive,
      constraint_lanes_active: activeLanes,
      lower_bound_source:      win.lowSrc ? win.lowSrc.authors + ' ' + win.lowSrc.year : null,
      upper_limit_source:      win.hiSrc  ? win.hiSrc.authors  + ' ' + win.hiSrc.year  : null,
      epsilon_adaf:            eps,
      rho_inf_kg_m3:           rho,
      verdict:                 buildVerdictString(win),
    };

    // ChainGraph Standard v0.1 §6: hash the artifact's actual snake_case field
    // names {policy_parameters, output_payload} so any vendor's verify_execution_hash
    // reproduces it — and so the worker matches repo/tools/constraint-stacker.html.
    const execHash = 'sha256:' + await sha256hex({ policy_parameters: policyParameters, output_payload: outputPayload });

    const artifact = {
      chaingraph_version: '0.1.0',
      ocs_version:    '1.0.0',
      mandate_type:   'me.omegacentauri/imbh_constraint',
      tool_id:        'constraint-stacker',
      tool_version:   '1.1.0',
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
        win.tension ? 'tension:lower_bound_exceeds_upper_limit' : 'window:consistent',
      ],
      audit_signature: {
        client_side_executed: true,
        zero_pii_verified:    true,
        deterministic_run:    true,
        data_sources: [
          'Häberle et al. 2024, Nature 631:285',
          'Bañares-Hernández et al. 2025, A&A 693:A104',
          'Chen et al. 2025, arXiv:2511.20945',
          'Malave et al. 2025/2026, arXiv:2512.09649',
          'Colom i Bernadich et al. 2026, arXiv:2603.21845',
        ],
        schema_version: 'ocs-chaingraph-0.1.0',
      },
    };

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
    track(env, 'build_ocs_workflow_links', chain ?? '_adhoc');
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
  // verify_execution_hash — ChainGraph Standard v0.1 §6
  // Recompute an artifact's execution hash so any agent can independently
  // verify an OCS (or any ChainGraph) artifact rather than trust it. Reuses
  // sortKeysDeep + the same snake_case preimage the artifacts are hashed over.
  // -------------------------------------------------------------------------
  server.registerTool('verify_execution_hash', {
    title: 'Verify a ChainGraph execution hash',
    description:
      'Independently verify a ChainGraph artifact (ChainGraph Standard v0.1 §6). ' +
      'Recomputes SHA-256 over the canonical (sorted-key, whitespace-stripped) JSON of ' +
      '{policy_parameters, output_payload} and compares it to the claimed execution_hash. ' +
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
    track(env, 'verify_execution_hash');
    const pp = policy_parameters ?? artifact?.policy_parameters;
    const op = output_payload ?? artifact?.output_payload;
    const claimed = claimed_hash ?? artifact?.execution_hash ?? null;
    if (pp === undefined || op === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'Provide a full artifact, or policy_parameters + output_payload (+ claimed_hash).' }] };
    }
    const computed = 'sha256:' + await sha256hex({ policy_parameters: pp, output_payload: op });
    const valid = claimed != null && computed === claimed;
    const out = {
      valid,
      computed_hash: computed,
      claimed_hash:  claimed,
      tool_id:            artifact?.tool_id ?? null,
      chaingraph_version: artifact?.chaingraph_version ?? artifact?.ocs_version ?? null,
      note: claimed == null
        ? 'No claimed hash supplied — returning the computed hash only.'
        : (valid ? 'Verified: recomputed hash matches the artifact.' : 'MISMATCH: treat the artifact as unverified.'),
      spec: 'ChainGraph Standard v0.1 §6',
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
      const manifest  = await loadData(env);
      const server    = buildServer(manifest, env);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const { req, res } = toReqRes(request);
      await server.connect(transport);
      const handled = transport.handleRequest(req, res, await request.json().catch(() => undefined));
      ctx.waitUntil(handled);
      const response = await toFetchResponse(res);
      for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
      return response;
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
