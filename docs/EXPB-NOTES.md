# Experiment B: multi-LLM product sourcing (Exp-1 only)

Same Customer Need Engine (Layer 1) and Recommendation Engine (Layer 2, `match()`), unchanged. Only the product
source of the FINAL recommendation changes.

```
Layer 1 session (unchanged, still simulates on the D1 catalog while asking) -> final NeedProfile
  -> ProductSource
       ExistingCatalogProductSource  (D1 catalog snapshot, as before)
       LLMProductDiscoverySource     (OpenAI + Anthropic + Gemini in parallel, web search on)
          -> normalise (malformed output dropped) -> conservative consolidation -> URL verification
          -> in-memory CatalogSnapshot (tenant expb-ephemeral, never stored)
  -> match(profile, snapshot, now, 'rank')  (unchanged)  -> Top 3
```

| File | Role |
|---|---|
| `src/sourcing/product-source.js` | `ProductSource` classes, `recommendWith()` |
| `src/sourcing/discovery-prompt.js` | provider request built from the NeedProfile; JSON schema |
| `src/sourcing/providers.js` | OpenAI / Anthropic / Gemini adapters, usage, cost estimate |
| `src/sourcing/normalize.js` | untrusted output -> candidates |
| `src/sourcing/consolidate.js` | entity resolution (brand + MPN + CPU/RAM/storage/GPU signature + model-name similarity) |
| `src/sourcing/verify.js` | one plain GET per URL; blocked pages are never bypassed |
| `src/sourcing/specs.js` | raw specs -> laptop attribute scale (editorial rules; build/keyboard left unknown) |
| `src/sourcing/ephemeral-snapshot.js` | candidates -> CatalogSnapshot, with flagged assumptions |
| `worker/expb.js` | `/api/expb/status`, `/api/expb/run`, `/api/expb/runs` |
| `web/expb.html` | experiment UI |

Kept apart, never mixed: customer fit and price fit (the engine), provider consensus (metadata), evidence
confidence and verification status (metadata). Assumptions on LLM offers: delivery everywhere, fee 0, 3 days;
no installment plans; no reference price (no deal bonus, no resale value); unknown shops trust 6, no COD.
Run logs (metrics + Top 3 only) go to the Exp-1 D1 table `expb_runs`. Laptops only.
