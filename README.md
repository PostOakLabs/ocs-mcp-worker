# OCS MCP Worker

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Remote MCP server for the [Omega Centauri Society](https://omegacentauri.me) — a science portal on NGC 5139 (Omega Centauri): candidate intermediate-mass black hole (IMBH) evidence, the Fermi Paradox, and the Macro Transcension Hypothesis. Exposes deterministic, hash-anchored physics kernels and deep-link catalogs of the site's client-side astrophysics calculators to any MCP host, including Claude.

No auth, no API key, no account, zero PII.

## Quick start

```bash
# Claude: Settings -> Connectors -> Add custom connector
https://mcp.omegacentauri.me/mcp

# Inspector
npx @modelcontextprotocol/inspector   # then Streamable HTTP -> the URL above
```

**Live endpoint:** `https://mcp.omegacentauri.me/mcp` (streamable HTTP) · **Site:** [omegacentauri.me](https://omegacentauri.me) · **Registry:** [`me.omegacentauri/tools`](https://registry.modelcontextprotocol.io) on the Official MCP Registry

## Tools

Callable MCP tools (`tools/list`) are backed by a catalog of flagship, prefill-enabled browser calculators and a set of named scenario/workflow chains. **Counts drift as tools ship — never trust a hardcoded number.** Verify with `node -e "const m=require('./data/tools-manifest.json'); console.log(Object.keys(m.tools).length, Object.keys(m.chains).length)"` here, or the site repo's `python3 scripts/verify-counts.py` (SSOT).

- `list_ocs_tools` — search the catalog by category, register, or free text
- `constraint_stacker`, `bayes_factor_router`, `jwst_accretion_ledger`, `gwtc_remnant_classifier`, `roman_microlensing`, `apophis_flyby_geometry`, `rubin_alert_throughput` — server-side physics kernels; each returns a hash-anchored ChainGraph artifact (OCG Standard v0.8, JCS/RFC 8785 `execution_hash`)
- `build_ocs_workflow_links` — construct deep-links into the named scenario/workflow chains, with `#in=` prefill for flagship tools
- `run_chain` — server-side kernel execution of a named chain (`imbh-evidence-window`, `evidence-threshold-routing`, `accretion-eligibility-fastfail`), including §21.4 decision-gate routing
- `verify_execution_hash` — independently recompute and check a ChainGraph artifact's `execution_hash` (vendor-agnostic — works on OCS, AINumbers, or ApexLogics artifacts)

Every tool declares `readOnlyHint: true`. No account, no auth, zero PII, nothing mutates state.

**Proof scope (honest, not aspirational):** `constraint_stacker`, `bayes_factor_router`, `jwst_accretion_ledger`, `gwtc_remnant_classifier`, `roman_microlensing`, `apophis_flyby_geometry`, and `rubin_alert_throughput` — 7 kernels, 0 deferred — carry real RISC0 groth16-bn254 zk compute proofs (§18). Browser-side calculators are client-side and are not zk-proven; the catalog and copy never imply otherwise. Receipts anchor via the shared `https://anchor.ainumbers.co/mcp` service (no own TSA infra).

**IMBH mass tension:** Häberle 2024 sets a ≥8,200 M☉ kinematic lower bound; Bañares 2025 sets a ≤6,000 M☉ pulsar-timing upper bound. These are irreconcilable under current systematics — tools that surface this never collapse it to one number. Speculative-engineering content (MTH/computronium) is always labeled as such, never presented as peer-reviewed physics.

## Architecture

Cloudflare Worker, streamable HTTP (`worker.mjs`), assets served from `data/` (the vendored `tools-manifest.json`, synced from the site repo on every site deploy). `stdio.mjs` re-exports the same `buildServer()` over stdio for local MCP hosts and containerized introspection builds (e.g. Glama).

```bash
npm install
npm run deploy   # regenerates + wrangler deploy
```

## License

MIT — see [LICENSE](LICENSE).
