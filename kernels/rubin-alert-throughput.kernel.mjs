// OCS ChainGraph kernel — Rubin/LSST transient-alert throughput calculator.
// Estimates nightly alert count and data-rate budget for the Vera C. Rubin
// Observatory Legacy Survey of Space and Time (LSST), based on the published
// Rubin science design parameters (Ivezic et al. 2019, ApJ 873, 111).
//
// Physics / arithmetic (all guest-legal — pure multiplication + arithmetic):
//   alerts_per_night  = visits_per_night * alerts_per_visit
//   alerts_per_year   = alerts_per_night * nights_per_year
//   nightly_data_rate_GB = alerts_per_night * avg_alert_bytes / 1e9
//
// REGISTER = speculative (Rubin LSST is in commissioning as of 2026; design
//   parameters are pre-survey estimates, not measured science-quality values).
// PRIMARY CITATION: Ivezic et al. 2019, ApJ 873, 111 (arXiv:0805.2366).
// ALERT SYSTEM: Bellm et al. 2019, PASP 131, 995004 (arXiv:1902.02134).
//
// GUEST-LEGAL: only arithmetic + Math.round + Math.abs + Math.min/max.
// No Math.pow, Math.log, Math.exp, Math.sin/cos/tan, Date, Math.random.

// ── Design constants (Ivezic et al. 2019 / Rubin Science Book 2009) ──────────
const RUBIN_VISITS_NOM        = 1000;    // visits/night (design estimate, ~1000 15-s exposures)
const RUBIN_ALERTS_PER_VISIT  = 10000;   // alerts per visit (Rubin alert design: ~10^4)
const RUBIN_NIGHTS_NOM        = 182;     // clear nights per year at Cerro Pachon (Ivezic 2019)
const RUBIN_BYTES_PER_ALERT   = 82000;   // bytes per alert packet (Bellm et al. 2019: ~82 KB)
const RUBIN_STATUS            = 'commissioning-2026';

function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function compute(policy_parameters) {
  const pp = policy_parameters ?? {};
  const ip = pp.input_parameters ?? {};

  const visits_per_night  = finiteOr(ip.visits_per_night,   RUBIN_VISITS_NOM);
  const alerts_per_visit  = finiteOr(ip.alerts_per_visit,   RUBIN_ALERTS_PER_VISIT);
  const nights_per_year   = finiteOr(ip.nights_per_year,    RUBIN_NIGHTS_NOM);
  const avg_alert_bytes   = finiteOr(ip.avg_alert_bytes,    RUBIN_BYTES_PER_ALERT);

  // ── Core calculations (all pure arithmetic) ───────────────────────────────
  const alerts_per_night  = visits_per_night * alerts_per_visit;
  const alerts_per_year   = alerts_per_night * nights_per_year;
  // Data rate: bytes → GB (1e9 bytes per GB, using literal 1000000000)
  const nightly_data_rate_GB = alerts_per_night * avg_alert_bytes / 1000000000;
  const yearly_data_rate_TB  = nightly_data_rate_GB * nights_per_year / 1000;

  // ── Rounding (manual literal factors — no Math.pow) ───────────────────────
  const alerts_per_night_r    = Math.round(alerts_per_night);
  const alerts_per_year_r     = Math.round(alerts_per_year);
  const nightly_rate_r        = Math.round(nightly_data_rate_GB * 10) / 10;
  const yearly_rate_r         = Math.round(yearly_data_rate_TB * 100) / 100;

  const output_payload = {
    survey:                 'Vera C. Rubin Observatory — LSST (Legacy Survey of Space and Time)',
    status:                 RUBIN_STATUS,
    visits_per_night:       visits_per_night,
    alerts_per_visit:       alerts_per_visit,
    nights_per_year:        nights_per_year,
    avg_alert_bytes:        avg_alert_bytes,
    alerts_per_night:       alerts_per_night_r,
    alerts_per_year:        alerts_per_year_r,
    nightly_data_rate_GB:   nightly_rate_r,
    yearly_data_rate_TB:    yearly_rate_r,
    throughput_note:        'alerts_per_night = visits_per_night * alerts_per_visit. nightly_data_rate_GB = alerts_per_night * avg_alert_bytes / 1e9. Design parameters from Rubin LSST system design; measured values will differ once full science operations begin.',
    register:               'speculative',
    register_note:          'Rubin LSST is in commissioning as of 2026-07-04. Alert throughput figures are design estimates, not measured science-quality statistics. Treat as order-of-magnitude forecast.',
    citations: [
      'Ivezic et al. 2019, ApJ 873, 111 (arXiv:0805.2366) — LSST science design overview',
      'Bellm et al. 2019, PASP 131, 995004 (arXiv:1902.02134) — LSST alert system design (~10^4 alerts/visit, ~82 KB/alert)',
      'LSST Science Book 2009 (arXiv:0912.0201) — survey design parameters',
    ],
  };

  return { output_payload };
}
