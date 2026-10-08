# Experiment B: multi-source product sourcing (Exp-1 only)

Same Customer Need Engine (Layer 1) and Recommendation Engine (Layer 2, `match()`), unchanged. Only the product
source of the FINAL recommendation changes.

```
Layer 1 session (unchanged) -> final NeedProfile
  -> LLMProductDiscoverySource (ProductSource)
       phase 1, in parallel, each with a hard deadline:
         gemini   llm         Gemini + Google Search grounding, structured JSON
         groq     llm         Groq Compound (open models + built-in web search)
         cohere   llm         Cohere command-a-plus-05-2026, knowledge only (a different model family)
         tavily   web_search  pages about the need (Egypt boost)
         serper   shopping    Google Shopping (gl=eg) + Google results on Egyptian retailers
       normalise -> listings with full config + EGP price become candidates -> conservative consolidation
       phase 2: evidence search per top candidate (serper) -> listings matched to candidates (evidence, offers)
       page checks (one plain GET, never bypassing protection) -> verification status, evidence confidence
       -> in-memory CatalogSnapshot (tenant expb-ephemeral, never stored)
  -> match(profile, snapshot, now, 'rank')  (unchanged) -> Top 3
```

Kept apart: customer fit and price fit (the engine), provider consensus (who FOUND it), evidence (which pages and
listings SUPPORT it), verification status. Consensus is metadata only.

Verification statuses: verified (page names it, specs agree) > listed (Egyptian EGP listing matches model + specs or
MPN) > partial > unavailable > web_evidence > mismatch; blocked / unreachable / no_url / not_checked when nothing
could be checked.

Infrastructure (separate Cloudflare project, see wrangler.jsonc): production Worker/D1 `wisedo-engine-exp-1`,
staging Worker/D1 `wisedo-engine-exp-1-staging`. `scripts/check-isolation.mjs` refuses the original
`wisedo-engine-demo` Worker, its D1 and every `wisedo-catalog` resource; it runs in CI, in the tests and before every
deploy step. Deploy: workflow "Deploy Exp-1 to Cloudflare" (target staging, then production).
