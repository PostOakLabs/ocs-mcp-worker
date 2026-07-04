// OCS ChainGraph kernel — Bayes-factor evidence-strength router (§4a gate primitive).
// Maps a Bayes factor (BF) or 2·lnBF to a categorical evidence-strength token, the
// value that constraint-stacker evidence chains route on at a §21.4 decision gate.
//
// Scales (Jeffreys 1961 / Kass & Raftery 1995, JASA 90:773):
//   BF thresholds:      1 · 3.2 · 10 · 100      (weak · substantial · strong · decisive)
//   2·lnBF thresholds:  0 · 2·ln3.2 · 2·ln10 · 2·ln100  (= 0 · 2.3263 · 4.6052 · 9.2103)
// The 2·lnBF boundaries are the BF boundaries mapped through 2·ln(·) and HARDCODED as
// constants so the kernel needs no Math.log — GUEST-LEGAL (pure comparisons, no
// transcendentals, no banned APIs). Worked example: NANOGrav 15-yr GWB BF > 1e14
// (arXiv:2306.16213) -> "decisive".
//
// Does NOT hash. compute(policy_parameters) -> { output_payload }.

const REFERENCE = 'Jeffreys 1961; Kass & Raftery 1995 (JASA 90:773)';
const K_SUBSTANTIAL = 2.3263; // 2*ln(3.2)
const K_STRONG      = 4.6052; // 2*ln(10)
const K_DECISIVE    = 9.2103; // 2*ln(100)

function classifyBF(bf) {
  if (bf < 1)     return { evidence_category: 'supports null hypothesis',      gate_token: 'supports_null' };
  if (bf < 3.2)   return { evidence_category: 'weak (barely worth mentioning)', gate_token: 'weak' };
  if (bf < 10)    return { evidence_category: 'substantial',                    gate_token: 'substantial' };
  if (bf < 100)   return { evidence_category: 'strong',                         gate_token: 'strong' };
  return            { evidence_category: 'decisive',                       gate_token: 'decisive' };
}

function classifyK(k) {
  if (k < 0)            return { evidence_category: 'supports null hypothesis',      gate_token: 'supports_null' };
  if (k < K_SUBSTANTIAL) return { evidence_category: 'weak (barely worth mentioning)', gate_token: 'weak' };
  if (k < K_STRONG)      return { evidence_category: 'substantial',                    gate_token: 'substantial' };
  if (k < K_DECISIVE)    return { evidence_category: 'strong',                         gate_token: 'strong' };
  return                   { evidence_category: 'decisive',                       gate_token: 'decisive' };
}

export function compute(policy_parameters) {
  const pp = policy_parameters ?? {};
  const ip = pp.input_parameters ?? {};

  const bfRaw = Number(ip.bf);
  const kRaw  = Number(ip.two_ln_bf);
  const hasBF = ip.bf !== undefined && ip.bf !== null && Number.isFinite(bfRaw);
  const hasK  = ip.two_ln_bf !== undefined && ip.two_ln_bf !== null && Number.isFinite(kRaw);

  let scale, input_value, cls, thresholds;
  if (hasBF) {
    scale = 'bayes_factor';
    input_value = bfRaw;
    cls = classifyBF(bfRaw);
    thresholds = { substantial: 3.2, strong: 10, decisive: 100 };
  } else if (hasK) {
    scale = 'two_ln_bayes_factor';
    input_value = kRaw;
    cls = classifyK(kRaw);
    thresholds = { substantial: K_SUBSTANTIAL, strong: K_STRONG, decisive: K_DECISIVE };
  } else {
    scale = 'none';
    input_value = null;
    cls = { evidence_category: 'no evidence input provided', gate_token: 'undefined' };
    thresholds = null;
  }

  const output_payload = {
    scale,
    input_value,
    evidence_category: cls.evidence_category,
    gate_token: cls.gate_token,
    thresholds,
    reference: REFERENCE,
  };
  return { output_payload };
}
