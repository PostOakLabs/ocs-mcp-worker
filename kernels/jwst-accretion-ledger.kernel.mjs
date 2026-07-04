// OCS ChainGraph kernel — JWST accretion-limit ledger row (§4a companion).
// Third independent IMBH constraint axis (accretion) beside dynamics + pulsar timing.
// Given an ADAF radiative efficiency epsilon, ambient density rho_inf, and a JWST
// NIRCam/MIRI bolometric luminosity upper limit, returns the IMBH mass above which the
// predicted Bondi/ADAF luminosity would exceed the JWST limit (an exclusion / upper bound).
//   L_predicted = epsilon * Mdot_Bondi * c^2 ,  Mdot_Bondi = 4*pi*G^2*M^2*rho_inf / c_s^3
//   => M_limit = sqrt( L_limit * c_s^3 / (epsilon * 4*pi*G^2*rho_inf*c^2) )
// GUEST-LEGAL: Math.sqrt + Math.PI + multiplication only (no pow/log/exp), finite-guarded.
//
// REGISTER = model-dependent: the exclusion scales with the assumed epsilon (Pesce et al.
// 2021) and is NOT a peer of the kinematic (Haberle 2024) or timing (Banares 2025) bounds.
// Grounding: Chen et al. 2025, arXiv:2511.20945 (accepted ApJ, v2 2026-03-20). The paper
// constrains (mass, accretion) COMBINATIONS; it does not assert a ~20,000 M-sun detection.
//
// Does NOT hash. compute(policy_parameters) -> { output_payload }.

const G_SI    = 6.674e-11;   // m^3 kg^-1 s^-2
const C_SI    = 2.998e8;     // m/s
const MSUN_KG = 1.989e30;    // kg
const JWST_C_S = 1.0e4;      // m/s (~10 km/s GC-core sound speed)
const JWST_L_LIMIT_DEFAULT = 1e28; // W (Chen et al. 2025; ~1e35 erg/s)

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function jwstUpperLimitMsun(epsilon, rho_inf, L_limit) {
  const c_s3 = JWST_C_S * JWST_C_S * JWST_C_S; // integer exponent, no Math.pow
  const num = L_limit * c_s3;
  const den = epsilon * 4 * Math.PI * G_SI * G_SI * rho_inf * C_SI * C_SI;
  if (!Number.isFinite(den) || den === 0) return null;
  const ratio = num / den;
  if (!Number.isFinite(ratio) || ratio < 0) return null;
  const v = Math.sqrt(ratio) / MSUN_KG;
  return Number.isFinite(v) ? v : null;
}

export function compute(policy_parameters) {
  const pp = policy_parameters ?? {};
  const ip = pp.input_parameters ?? {};

  const eps  = finiteOr(ip.epsilon, 1e-3);
  const rho  = finiteOr(ip.rho_inf ?? ip.rho, 1e-21);
  const Llim = finiteOr(ip.l_limit_w, JWST_L_LIMIT_DEFAULT);

  const mUpper = jwstUpperLimitMsun(eps, rho, Llim);
  const mRounded = mUpper !== null ? Math.round(mUpper) : null;

  const output_payload = {
    constraint_axis:        'accretion',
    jwst_upper_limit_Msun:  mRounded,
    excluded_above_Msun:    mRounded,
    epsilon_adaf:           eps,
    rho_inf_kg_m3:          rho,
    l_limit_w:              String(Llim),
    register:               'model-dependent',
    model_dependence:       'scales with ADAF radiative efficiency epsilon (Pesce et al. 2021); not a peer of the kinematic (Haberle 2024) or timing (Banares 2025) bounds',
    reference:              'Chen et al. 2025, arXiv:2511.20945 (accepted ApJ, v2 2026-03-20)',
    verdict:                mRounded !== null
      ? ('JWST accretion excludes IMBH above ~' + mRounded + ' M-sun at epsilon=' + eps + ', rho_inf=' + rho)
      : 'no constraint (degenerate inputs)',
  };
  return { output_payload };
}
