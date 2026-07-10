# OCS MCP Worker

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Live endpoint](https://img.shields.io/badge/MCP-mcp.omegacentauri.me-2ea44f)](https://mcp.omegacentauri.me/mcp)
[![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)](https://workers.cloudflare.com/)

MCP server exposing [OmegaCentauri.me](https://omegacentauri.me)'s astrophysics evidence-evaluation tools (IMBH evidence, black-hole physics, Fermi paradox, SETI sensitivity, Kardashev metrics) as agent-callable tools. Deployed as a Cloudflare Worker — no separate hosting, no Node/Python server.

Sister workers: [ainumbers-mcp](https://mcp.ainumbers.co) (markets & institutions), [apexlogics-mcp](https://mcp.apexlogics.org) (career/education). Anchoring/timestamping for all three is centralized at `anchor.ainumbers.co`.

---

## Live Endpoint

```
https://mcp.omegacentauri.me/mcp
```

## Agent Quickstart

Add to any MCP-compatible client config:

```json
{
  "mcpServers": {
    "ocs": {
      "url": "https://mcp.omegacentauri.me/mcp"
    }
  }
}
```

`list_ocs_tools` / `find_tool` return the live catalog — start there rather than hardcoding tool names, since counts drift as the suite grows. See [`omegacentauri.me`](https://omegacentauri.me) for the browser catalog and the [OCS repo](https://github.com/PostOakLabs/OCS) for the live tool/chain counts (never hardcoded here).

## What's Exposed

Each OCS evidence tool is wrapped as an MCP tool: deterministic inputs in, a structured evidence assessment plus a ChainGraph v0.8 hash-anchored artifact out, with a reproducible `execution_hash`. Zero PII.

## Verification Scope (read before citing proofs)

- **Hash-verifiable (all tools):** deterministic client-side execution, SHA-256 execution hashes over inputs/outputs. Reproducible, not zero-knowledge proven.
- **§18 zk compute-proven (7 of 7 kernels):** real Groth16-BN254 proofs generated via a RISC Zero zkVM (`RISC0_DEV_MODE=0`), verified before being attached to the audit trail. All seven worker kernels — `apophis-flyby-geometry`, `bayes-factor-router`, `constraint-stacker`, `gwtc-remnant-classifier`, `jwst-accretion-ledger`, `roman-microlensing`, `rubin-alert-throughput` — are currently proven.

## Dataset & measurement integrity

Kernel fixtures and goldens under `data/fixtures/` pin the observational inputs (catalog values, published measurement ranges) each kernel is tested against; `scripts/check-measurements-sync.mjs` verifies kernel logic hasn't drifted from the pinned fixtures. This does not assert the underlying astrophysical measurements themselves are correct — it asserts the kernel reproduces the same result from the same pinned inputs every time. Citable sources for the underlying evidence and the OCS Zenodo dataset release are tracked in the [OCS repo](https://github.com/PostOakLabs/OCS)'s `CITATION.cff` and DOI badge, not duplicated here.

## Structure

```
ocs-mcp-worker/
├── worker.mjs           # MCP server entrypoint (Cloudflare Worker)
├── generate.mjs          # Regenerates tools-manifest.json from the live site's chaingraph.json
├── kernels/              # Deterministic evidence kernels (.kernel.mjs) + chains/ + fixtures/ + receipts/
├── data/                 # tools-manifest.json, compute-proof-deferred.json
├── scripts/               # CI gates (compute-proof check, kernel digest, measurement sync)
└── wrangler.jsonc          # Cloudflare Worker config (custom domain: mcp.omegacentauri.me)
```
