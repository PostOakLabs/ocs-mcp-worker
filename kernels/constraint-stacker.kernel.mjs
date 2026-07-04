// OCS ChainGraph kernel — constraint_stacker compute.
// Self-contained, GUEST-LEGAL (no imports, no banned APIs). Extracted from worker.mjs
// so the browser-embedded guest runtime and the Cloudflare Worker share a single
// source of truth for the IMBH constraint-window computation.
//
// GUEST-LEGAL RULES (see OCG Standard §-guest-runtime):
//   BANNED: Math.pow, Math.log, Math.exp, Math.sin, Math.cos, Date, Math.random,
//           toLocaleString, Intl, .normalize(), TextEncoder/TextDecoder, crypto.
//   ALLOWED: Math.sqrt, Math.PI (deterministic, no transcendental drift).
//   The only transcendental in the original worker compute was Math.pow(JWST_C_S, 3)
//   inside jwstUpperLimitMsun — replaced below with explicit multiplication
//   (integer exponent; numerically identical for JWST_C_S = 1e4).
//
// Does NOT hash. The guest (or the worker) supplies/consumes the journal and
// computes execution_hash itself from {policy_parameters, output_payload}.

// ---------------------------------------------------------------------------
// Physical constants (SI) — must match repo/tools/constraint-stacker.html exactly.
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
// Keep in sync with measurements.js and worker.mjs.
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
  const c_s3 = JWST_C_S * JWST_C_S * JWST_C_S; // guest-legal: no Math.pow (integer exponent)
  const num = JWST_L_LIMIT * c_s3;
  const den = epsilon * 4 * Math.PI * G_SI * G_SI * rho_inf * C_SI * C_SI;
  if (!Number.isFinite(den) || den === 0) return null;
  const ratio = num / den;
  if (!Number.isFinite(ratio) || ratio < 0) return null;
  const v = Math.sqrt(ratio) / MSUN_KG;
  return Number.isFinite(v) ? v : null;
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
      if (v !== null && v < hi) { hi = v; hiSrc = { ...m, value: v }; }
    }
  }
  if (lo === -Infinity) lo = null;
  if (hi === Infinity)  hi = null;
  const tension = (lo !== null && hi !== null && lo > hi);
  return { lo, hi, tension, lowSrc, hiSrc };
}

// Number + verdict formatting — ported verbatim from repo/tools/constraint-stacker.html
// so the artifact is byte-identical to the browser export for the same inputs.
// Deterministic en-US thousands grouping (no Intl/toLocaleString; guest-legal).
function fmtEnUS(n){
  n=Number(n);
  if(Number.isNaN(n))return 'NaN';
  if(!Number.isFinite(n))return n>0?'∞':'-∞';
  const sign=(n<0)?'-':'';
  let s=Math.abs(n).toString();
  if(s.includes('e')||s.includes('E'))return sign+s;
  let [i,f='']=s.split('.');
  if(f.length>3){const keep=f.slice(0,3);const nd=f.charCodeAt(3)-48;const d=(i+keep).split('').map(c=>c.charCodeAt(0)-48);if(nd>=5){let j=d.length-1;for(;j>=0;j--){if(d[j]===9){d[j]=0;}else{d[j]++;break;}}if(j<0)d.unshift(1);}const a=d.join('');i=a.slice(0,a.length-keep.length)||'0';f=a.slice(a.length-keep.length);}
  f=f.replace(/0+$/,'');i=i.replace(/^0+(?=\d)/,'');
  return sign+i.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(f?'.'+f:'');
}
function fmtMass(M) {
  if (M === null || M === undefined || isNaN(M)) return '—';
  if (M >= 1e6) return (M / 1e6).toFixed(2) + '×10⁶';
  if (M >= 1e4) return (M / 1e3).toFixed(1) + '×10³';
  if (M >= 1000) return fmtEnUS(Math.round(M));
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

const LANES = ['kinematics', 'propermotion', 'timing', 'accretion', 'nbody'];

// Coerce a numeric input to a finite number, falling back to `fallback` if not finite.
function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// compute — single entry point. Mirrors worker.mjs's constraint_stacker handler
// exactly for the shared window/output-payload computation.
//
// policy_parameters = { execution_backend, input_parameters: { epsilon, rho, show } }
// where `show` is a comma-joined string of active lane METHOD keys.
// ---------------------------------------------------------------------------
export function compute(policy_parameters) {
  const pp = policy_parameters ?? {};
  const ip = pp.input_parameters ?? {};

  const eps = finiteOr(ip.epsilon, 1e-3);
  const rho = finiteOr(ip.rho, 1e-21);

  const showObj = {};
  for (const m of String(ip.show ?? '').split(',')) if (m) showObj[m] = true;

  const win = computeConstraintWindow(eps, rho, showObj);

  const activeLanes = LANES.filter(m => showObj[m]);
  const n_constraints_active = IMBH_CONSTRAINTS.filter(m => showObj[m.method]).length;

  const output_payload = {
    allowed_window_M_solar: {
      lower: win.lo !== null ? Math.round(win.lo) : null,
      upper: win.hi !== null ? Math.round(win.hi) : null,
    },
    tension_detected:        !!win.tension,
    tension_direction:       win.tension ? 'lower_bound_exceeds_upper_limit' : null,
    n_constraints_active,
    constraint_lanes_active: activeLanes,
    lower_bound_source:      win.lowSrc ? win.lowSrc.authors + ' ' + win.lowSrc.year : null,
    upper_limit_source:      win.hiSrc  ? win.hiSrc.authors  + ' ' + win.hiSrc.year  : null,
    epsilon_adaf:            eps,
    rho_inf_kg_m3:           rho,
    verdict:                 buildVerdictString(win),
  };

  return { output_payload };
}
