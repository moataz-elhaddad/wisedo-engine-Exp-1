# Wisedo engine, Experiment 1 (five categories: mobile, laptop, TV, AC, fridge)

> **This repository is Exp-1**: an isolated copy used for Experiment B (multi-source product sourcing: LLM + web
> search + shopping search feeding the unchanged engines). It deploys only to its own Cloudflare Worker/D1
> (`wisedo-engine-exp-1`, staging `wisedo-engine-exp-1-staging`); `scripts/check-isolation.mjs` blocks the original
> infrastructure. See `docs/EXPB-NOTES.md`. Experiment page: `/expb.html`.

Deterministic buying-decision engine in two layers, plain JavaScript (ES modules), Node 22, no npm dependencies.
All data is synthetic sample data (every record has `source: "synthetic"`); prices are not real.

## Run
- Tests: `node --test test/` (236 tests, Layer 2 + Layer 1 + parameters + eval-phrase checks)
- Eval phrase coverage: `node eval/coverage.js`
- Regenerate the synthetic dataset: `node data/generate.js`

## Layout
- Specs (BRD, Tech Spec, Technical Design v4) live as Claude Docs and are kept out of this repository while it is public.
- `config/<category>.json` one config per category (mobile, laptop, tv, ac, fridge); data per extra category in `data/synthetic/<category>/` (generators `data/generate-<category>.js`), notes in `docs/<category>-NOTES.md`, phrases in `eval/phrases-<category>.jsonl`. Retailers and installment plans are shared across categories.
- `config/mobile.json` the mobile category config (24 slots, 15 attributes, 40 buying factors tagged)
- `src/layer2/` matching (M1-M9, rank and simulate), entry: `match(needProfile, snapshot, now, mode, options)`
- `src/layer1/` need understanding (U1-U9) and `session.js`, a serialisable state machine
- `src/layer1/llm/mock.js` recorded-response adapter used by tests; `anthropic.js` live adapter, written but NOT yet run against the API
- `data/` synthetic dataset generator and output
- `eval/` 300 synthetic phrases tagged by factor, with a coverage checker
- `docs/` CONTRACTS.md, BUILD-NOTES.md (Layer 2 decisions), LAYER1-NOTES.md (Layer 1 decisions, how to run a live parser check)

- `web/` try-out page and admin panel (`sh web/build.sh <dir>` assembles it); `src/params.js` the tunable parameters; `src/store.js` published/draft/history of a configuration

## Demo deployment (Cloudflare Worker + D1)
One tenant (`demo-b2b`) with its own SKU catalog, B2B style: the engine recommends only from the SKUs in D1.
- `worker/` the Worker: JSON API, static pages from `dist/` (built by `sh web/build.sh dist`)
- `migrations/` D1 schema; each row keeps the full contract record (docs/CONTRACTS.md) as JSON
- `web/skus.html` SKU page: list, edit, add, delete products and offers; CSV export and import (the first form of the B2B upload)
- `web/index.html` try-out page; when served by the Worker it reads the catalog from `api/snapshot`
- Deploy: GitHub Actions, workflow "Deploy Exp-1 to Cloudflare" (manual; target staging, then production). Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WISEDO_ADMIN_TOKEN` (24+ characters). The first deploy loads the sample data.
- Clock: the demo runs on the sample data's frozen clock (`CLOCK=demo`) so the synthetic prices stay fresh; set `CLOCK=real` for real data.
- Free text reading, all free: Google Gemini (optional `GEMINI_API_KEY` secret, free from Google AI Studio), then Cloudflare Workers AI (the `AI` binding, no key), then keyword rules (`src/layer1/u2-rules.js`) when both fail or none is set. Order in `LLM_ORDER`; `/api/health` lists the active providers. The two LLM adapters (`worker/llm.js`) are unverified until the first deploy.

| Method | Path | Token |
|---|---|---|
| GET | `/api/health`, `/api/categories`, `/api/snapshot`, `/api/retailers`, `/api/plans` | no |
| GET | `/api/skus?category=laptop`, `/api/skus/:id` (product with offers) | no |
| GET | `/api/export.csv?category=laptop` | no |
| POST | `/api/session` body `{state, event}` (Layer 1 events, see src/layer1/session.js) | no |
| POST | `/api/parse` body `{kind: "extract"\|"category", category, text}` (the try-out page's parser; prompt built on the server; 20 calls a minute per IP) | no |
| POST, PUT, DELETE | `/api/skus[/:id]`, `/api/offers[/:id]` | yes |
| POST | `/api/import?category=laptop[&dry_run=1]` (CSV body; all or nothing) | yes |
| POST | `/api/admin/reset` (replace the catalog with the sample data) | yes |

The token goes in `Authorization: Bearer <token>`.

## Not built yet
Live check of the LLM parsers against an eval set, ingestion from the catalog engine, mapping of arbitrary B2B Excel layouts.
