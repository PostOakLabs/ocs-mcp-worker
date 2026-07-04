// OCS ChainGraph kernel — Roman Space Telescope microlensing geometry (§4a companion).
// Computes the Einstein radius and crossing timescale for a gravitational microlensing
// event observed by the Nancy Grace Roman Space Telescope (launch target 2026-08-30).
// Physics: Gould 2000 (ApJ 542, 785) microlensing formalism:
//   pi_rel_mas  = 1/D_L_kpc - 1/D_S_kpc   (relative parallax, mas)
//   theta_E_mas = sqrt(kappa * M * pi_rel)   (Einstein radius, mas)
//   t_E_days    = theta_E_mas / mu_mas_yr * 365.25  (Einstein crossing time)
// with kappa = 8.144 mas/Msun (Gould 2000 Eq. 1).
// Also reports a yield-scaled event-count estimate from Penny et al. 2019
// (arXiv:1808.02490) scaled by an optional survey_fraction input.
// GUEST-LEGAL: only Math.sqrt + Math.PI + Math.abs + Math.min/max + arithmetic.
// No Math.pow, Math.log, Math.exp, Math.sin/cos/tan, Date, Math.random.
//
// REGISTER = peer-reviewed (Gould microlensing formalism, Penny 2019 yield).
// Gate / label: `regime` = "forecast" unless released=true (Roman has not launched
// as of 2026-07-04; launch target 2026-08-30). Never imply live Roman data.
//
// Does NOT hash. compute(policy_parameters) -> { output_payload }.

const KAPPA = 8.144;        // mas/Msun, Gould 2000 microlensing parameter kappa = 4G/(c^2 * AU)
const DAYS_PER_YEAR = 365.25;
// Penny et al. 2019 (arXiv:1808.02490) Table 5 fiducial 6-field yield for the
// 2-season Roman Galactic Bulge Time Domain Survey: ~27,000 stellar microlensing events.
// Cite this number; do not invent a total. scale by survey_fraction only.
const PENNY_2019_SURVEY_YIELD = 27000; // stellar microlensing events, 6-field 2-season fiducial

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function compute(policy_parameters) {
  const pp = policy_parameters ?? {};
  const ip = pp.input_parameters ?? {};

  const M    = finiteOr(ip.lens_mass_Msun,  1.0);    // solar masses
  const D_L  = finiteOr(ip.D_L_kpc,         4.0);    // kpc
  const D_S  = finiteOr(ip.D_S_kpc,         8.0);    // kpc
  const mu   = finiteOr(ip.mu_mas_yr,        5.0);    // mas/yr
  const frac = finiteOr(ip.survey_fraction,  1.0);    // 0-1
  const rel  = !!(ip.released);                       // boolean, default false

  // Relative parallax in mas (Gould 2000): pi_L - pi_S = 1/D_L_kpc - 1/D_S_kpc
  const pi_rel = (D_L > 0 && D_S > 0 && D_S > D_L)
    ? (1 / D_L - 1 / D_S)
    : 0;

  // Einstein radius in mas
  const theta_E_sq = KAPPA * (M > 0 ? M : 0) * pi_rel;
  const theta_E    = theta_E_sq > 0 ? Math.sqrt(theta_E_sq) : 0;

  // Einstein crossing time in days
  const t_E = (mu > 0 && theta_E > 0) ? theta_E / mu * DAYS_PER_YEAR : 0;

  // Regime label
  const regime = rel ? 'live' : 'forecast';

  // Yield estimate (stellar events; IMBH events are a small uncertain subset)
  const frac_c = Math.max(0, Math.min(1, frac));
  const yield_scaled = Math.round(frac_c * PENNY_2019_SURVEY_YIELD);

  // Round outputs to safe precision without Math.pow
  const theta_E_r  = Math.round(theta_E  * 10000) / 10000; // 4 dp in mas
  const t_E_r      = Math.round(t_E      * 100)   / 100;   // 2 dp in days
  const pi_rel_r   = Math.round(pi_rel   * 1000000) / 1000000; // 6 dp in mas

  const output_payload = {
    theta_E_mas:                theta_E_r,
    t_E_days:                   t_E_r,
    pi_rel_mas:                 pi_rel_r,
    kappa_mas_Msun:             KAPPA,
    regime,
    lens_mass_Msun:             M,
    D_L_kpc:                    D_L,
    D_S_kpc:                    D_S,
    mu_mas_yr:                  mu,
    survey_fraction:            frac_c,
    yield_scaled_events:        yield_scaled,
    yield_base_events:          PENNY_2019_SURVEY_YIELD,
    yield_note:                 'Scaled from Penny et al. 2019 (arXiv:1808.02490) 6-field 2-season fiducial yield of ~27,000 stellar events by survey_fraction=' + frac_c + '. Stellar events only; IMBH-induced events would be a small, uncertain subset.',
    survey:                     'Nancy Grace Roman Space Telescope (launch target 2026-08-30)',
    regime_note:                rel
      ? 'Roman data available (released=true).'
      : 'Roman has not yet launched; all outputs are pre-launch forecasts (launch target 2026-08-30).',
    register:                   'peer-reviewed',
    citations: [
      'Gould 2000, ApJ 542, 785 (microlensing Einstein radius formalism)',
      'Penny et al. 2019, ApJS 241, 3 (arXiv:1808.02490) — Roman Galactic Bulge microlensing yield',
      'Johnson et al. 2024, arXiv:2512.05182 — updated Roman microlensing yield estimates',
      'Roman launch target: 2026-08-30 (NASA/GSFC)',
    ],
  };
  return { output_payload };
}
