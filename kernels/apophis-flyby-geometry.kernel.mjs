// OCS ChainGraph kernel — Apophis 99942 close-approach geometry (2029-04-13).
// Computes the close-approach geometry for the 2029-04-13 flyby of asteroid
// 99942 Apophis, which passes inside geostationary orbit.
//
// Physics (all guest-legal — sqrt + arithmetic only, NO Math.pow/log/exp/trig):
//   perigee_altitude_km = perigee_km - R_EARTH_KM
//   inside_GEO          = perigee_km < GEO_KM (42,164 km from Earth centre)
//   tidal_dg_m_s2       = 2 * GM_EARTH * diameter_m / perigee_m^3
//   v_perigee_km_s      = sqrt(v_inf_m_s^2 + 2*GM_EARTH/perigee_m) / 1000
//   speed_boost_km_s    = v_perigee_km_s - rel_velocity_km_s
//
// GUEST-LEGAL: only Math.sqrt + Math.abs + Math.min/max + arithmetic.
// No Math.pow, Math.log, Math.exp, Math.sin/cos/tan, Date, Math.random.
//
// REGISTER = peer-reviewed (Apophis orbit: Farnocchia et al. 2021, Icarus 369 114594;
//   Brozovic et al. 2018, Icarus 300 115; diameter: JPL/CNEOS nominal ~340 m).
// Facts frozen to the published JPL solution; inputs are sliders around the nominal.

// ── Constants ────────────────────────────────────────────────────────────────
// GM_EARTH: IAU 2009 standard gravitational parameter (TDB scale, WGS-84 consistent)
const GM_EARTH_M3_S2 = 3.986004418e14; // m^3 s^-2
const R_EARTH_KM     = 6371.0;          // km, mean radius (IAU 2015 B3)
const GEO_KM         = 42164.0;         // km, geostationary orbit radius from Earth centre

// Apophis 99942 nominal flyby (JPL solution #197 / CNEOS 2024)
const APOPHIS_DATE              = '2029-04-13';
const APOPHIS_PERIGEE_NOM_KM   = 38017.0; // km from Earth centre (JPL Horizons)
const APOPHIS_DIAMETER_NOM_M   = 340.0;   // m, radar shape model (uncertainty ~30 m)
const APOPHIS_V_INF_NOM_KM_S   = 7.43;   // km/s, hyperbolic excess velocity

// Companion missions
const MISSIONS = [
  'NASA OSIRIS-APEX (formerly OSIRIS-REx) — currently en route, arrival 2029-04-13',
  'ESA Ramses — committed Nov 2025, launch target Apr 2028, arrival Apr 2029',
];

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function compute(policy_parameters) {
  const pp = policy_parameters ?? {};
  const ip = pp.input_parameters ?? {};

  const perigee_km      = finiteOr(ip.perigee_km,        APOPHIS_PERIGEE_NOM_KM);
  const diameter_m      = finiteOr(ip.diameter_m,         APOPHIS_DIAMETER_NOM_M);
  const rel_velocity_km = finiteOr(ip.rel_velocity_km_s,  APOPHIS_V_INF_NOM_KM_S);

  // ── Geometry ──────────────────────────────────────────────────────────────
  const perigee_m       = perigee_km * 1000.0;
  const perigee_alt_km  = perigee_km - R_EARTH_KM;
  const inside_GEO      = perigee_km < GEO_KM;
  // Positive = inside GEO (margin to GEO ring), negative = outside
  const GEO_margin_km   = GEO_KM - perigee_km;

  // ── Tidal acceleration across asteroid (dg = 2GM*d / r^3) ─────────────────
  // Units: GM [m^3/s^2] * d [m] / r [m]^3 → m/s^2
  const r3 = perigee_m * perigee_m * perigee_m; // r^3 (pure multiplication, guest-legal)
  const tidal_dg_m_s2 = (r3 > 0 && diameter_m > 0)
    ? 2.0 * GM_EARTH_M3_S2 * diameter_m / r3
    : 0;

  // ── Vis-viva speed at perigee (hyperbolic orbit) ──────────────────────────
  // v_peri^2 = v_inf^2 + 2*GM/r  (hyperbolic excess velocity assumed as input)
  const v_inf_m_s = rel_velocity_km * 1000.0;
  const v_peri_sq = (v_inf_m_s > 0 && perigee_m > 0)
    ? v_inf_m_s * v_inf_m_s + 2.0 * GM_EARTH_M3_S2 / perigee_m
    : 0;
  const v_perigee_km_s   = v_peri_sq > 0 ? Math.sqrt(v_peri_sq) / 1000.0 : 0;
  const speed_boost_km_s = v_perigee_km_s - rel_velocity_km;

  // ── Rounding ──────────────────────────────────────────────────────────────
  // Manual literal factors only — no Math.pow (guest-illegal).
  const perigee_km_r     = Math.round(perigee_km * 10) / 10;
  const perigee_alt_r    = Math.round(perigee_alt_km * 10) / 10;
  const GEO_margin_r     = Math.round(GEO_margin_km * 10) / 10;
  const tidal_r          = Math.round(tidal_dg_m_s2 * 1e10) / 1e10;
  const v_peri_r         = Math.round(v_perigee_km_s * 10000) / 10000;
  const speed_boost_r    = Math.round(speed_boost_km_s * 10000) / 10000;

  const output_payload = {
    flyby_date:            APOPHIS_DATE,
    perigee_km:            perigee_km_r,
    perigee_altitude_km:   perigee_alt_r,
    R_earth_km:            R_EARTH_KM,
    inside_GEO:            inside_GEO,
    GEO_km:                GEO_KM,
    GEO_margin_km:         GEO_margin_r,
    diameter_m:            diameter_m,
    tidal_dg_m_s2:         tidal_r,
    tidal_note:            'Tidal acceleration differential across asteroid body: dg = 2*GM_earth*d/r^3 (classical tidal formula). Units: m/s^2.',
    rel_velocity_km_s:     rel_velocity_km,
    v_perigee_km_s:        v_peri_r,
    speed_boost_km_s:      speed_boost_r,
    vis_viva_note:         'v_perigee computed from vis-viva: v_peri^2 = v_inf^2 + 2*GM/r. rel_velocity_km_s treated as hyperbolic excess velocity (v_inf). speed_boost = v_perigee - v_inf.',
    missions:              MISSIONS,
    register:              'peer-reviewed',
    citations: [
      'Farnocchia et al. 2021, Icarus 369, 114594 (DOI 10.1016/j.icarus.2021.114594) — definitive Apophis orbit solution',
      'Brozovic et al. 2018, Icarus 300, 115 (DOI 10.1016/j.icarus.2017.09.010) — Apophis radar observations',
      'JPL/CNEOS Apophis close-approach solution #197: 2029-Apr-13 perigee ~38,017 km',
      'ESA Ramses mission: committed Nov 2025, launch target Apr 2028',
      'NASA OSIRIS-APEX: en route to Apophis, arrival 2029-04-13',
    ],
  };

  return { output_payload };
}
