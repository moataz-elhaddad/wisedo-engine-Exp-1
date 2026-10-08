#!/usr/bin/env python3
"""Experiment B live smoke test against a deployed Exp-1 Worker.

Runs the full pipeline the way the UI does:
  free text -> existing Layer 1 session (/api/session) -> "show results now" -> final NeedProfile
  -> /api/expb/run (multi-source discovery -> consolidation -> evidence -> verification -> ephemeral snapshot
     -> existing Recommendation Engine) -> Top 3
Prints a readable summary and writes expb-status.json, expb-profile.json, expb-run.json.

usage: EXPB_URL=https://... WISEDO_ADMIN_TOKEN=... python3 scripts/expb_smoke.py ["need text"] [--require-providers N]
  EXPB_TEXT  the need text (default: the Arabic gaming-laptop test case)
  EXPB_EDITS JSON object of Layer 1 chip edits applied after the text, e.g. {"brand":["asus"],"acceptImports":"no"}
Exit 1 when the run fails, fewer than N providers succeed, or a Top result is not a verified Egyptian product page.
"""
import json, os, sys, time, urllib.request, urllib.error

URL = os.environ["EXPB_URL"].rstrip("/")
TOKEN = os.environ.get("WISEDO_ADMIN_TOKEN", "").strip()
argv = sys.argv[1:]
args = [a for i, a in enumerate(argv) if not a.startswith("--") and not (i > 0 and argv[i - 1] == "--require-providers")]
TEXT = args[0] if args else (os.environ.get("EXPB_TEXT") or "عاوز لابتوب في حدود ٤٠ الف جنيه يكون gaming لاخويا الصغير")
EDITS = json.loads(os.environ.get("EXPB_EDITS") or '{"use":["gaming"],"brand":["asus"],"budget":40000,"acceptImports":"no","who":"kid"}')
need = 1
if "--require-providers" in sys.argv:
    need = int(sys.argv[sys.argv.index("--require-providers") + 1])


def call(method, path, body=None, auth=False, timeout=60):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("content-type", "application/json")
    # Cloudflare rejects Python's default "Python-urllib" User-Agent (error 1010); identify the smoke test explicitly.
    req.add_header("user-agent", "wisedo-exp1-smoke/1.0 (+github-actions)")
    req.add_header("accept", "application/json")
    if auth and TOKEN:
        req.add_header("authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    try:
        return code, json.loads(raw or b"null")
    except Exception:
        print(f"non-JSON answer from {path}: HTTP {code}: {raw[:300]!r}")
        return code, None


code, status = call("GET", "/api/expb/status")
if not status:
    sys.exit(f"FAILED: /api/expb/status answered HTTP {code} without JSON")
json.dump(status, open("expb-status.json", "w"), indent=1)
print("providers configured:", [(p["name"], p["role"], p["model"]) for p in status["providers"]])
print("providers missing:", [(p["name"], p["secret"]) for p in status["missing"]])
print("experiment:", status.get("experiment"))

dcode, diag = call("GET", "/api/expb/diagnose", auth=True, timeout=120)
print("diagnose:", dcode, json.dumps(diag)[:4000] if diag else None)

code, s1 = call("POST", "/api/session", {"event": {"type": "start", "text": TEXT}})
assert code == 200, (code, s1)
state, ui = s1["state"], s1["ui"]
if ui["screen"] in ("tiles", "unsupported", "not_configured"):
    # Category not read from the text: pick the laptop tile, then give the same text to the session.
    code, s1 = call("POST", "/api/session", {"event": {"type": "start", "tile": "laptop"}})
    code, s1 = call("POST", "/api/session", {"state": s1["state"], "event": {"type": "addText", "text": TEXT}})
    assert code == 200, (code, s1)
    state, ui = s1["state"], s1["ui"]
print("need text:", TEXT)
print("layer 1 first screen:", ui["screen"], "| filled:", {k: v["value"] for k, v in state.get("values", {}).items()})
for slot, value in EDITS.items():
    code, se = call("POST", "/api/session", {"state": state, "event": {"type": "edit", "slot": slot, "value": value}})
    assert code == 200 and se.get("state"), (code, se)
    state, ui = se["state"], se["ui"]
    print(f"edit {slot} = {value} -> {ui['screen']} {ui.get('error') or ''}")
if ui["screen"] != "result":
    code, s2 = call("POST", "/api/session", {"state": state, "event": {"type": "showNow"}})
    assert code == 200 and s2["ui"]["screen"] == "result", (code, s2 and s2.get("ui", {}).get("screen"))
    ui = s2["ui"]
profile = ui["profile"]
json.dump(profile, open("expb-profile.json", "w"), indent=1)
print("NeedProfile:", json.dumps({"money": profile["money"], "must": [f.get("attr") for f in profile["must"]], "prefer": [f.get("attr") for f in profile["prefer"]],
                                  "needs": {n["slot"]: n["value"] for n in profile["needs"] if n["source"] != "default"}}))

t0 = time.time()
code, run = call("POST", "/api/expb/run", {"profile": profile, "compact": True}, auth=True, timeout=300)
wall = time.time() - t0
json.dump(run, open("expb-run.json", "w"), indent=1)
print(f"\nexpb run: HTTP {code} in {wall:.1f}s, status {run and run.get('status')}, error {run and run.get('error')}")
if not run or "providers" not in run:
    print(json.dumps(run)[:2000])
    sys.exit(1)
print("metrics:", json.dumps(run["metrics"]))
print("queries:", json.dumps(run.get("queries")))
for p in run["providers"]:
    print(f"  provider {p['provider']:<8} {p['role']:<10} {'OK  ' if p['ok'] else 'FAIL'} {p['latency_ms']/1000:6.1f}s "
          f"cands {p['candidate_count']:>2} listings {p.get('listing_count', 0):>2} usage {p.get('usage')} cost ${p.get('cost_usd')} "
          f"{p.get('variant') or ''} {p.get('error') or ''}")
for p in run["providers"]:
    if p.get("model_attempts"):
        print(f"  {p['provider']} model attempts: {p['model_attempts']}")
    if p.get("attempts"):
        print(f"  {p['provider']} format attempts: {p['attempts']}")
for r in run.get("raw", []):
    for l in r.get("listings", [])[:12]:
        print(f"  listing {r['provider']:<7} {l.get('kind'):<8} {str(l.get('price_text') or '')[:18]:<18} {str(l.get('title'))[:110]} | {str(l.get('url'))[:80]}")
for e in run.get("evidence_runs", []):
    print(f"  evidence {e['provider']:<8} {'OK' if e['ok'] else 'FAIL'} {e['latency_ms']/1000:.1f}s listings {e['listing_count']} {e.get('error') or ''}")
def cand_line(c):
    sp = c.get("specs") or {}
    return (f"{c['brand']} {c['model']} {c.get('mpn') or ''} | {sp.get('cpu')} {sp.get('ram_gb')}GB {sp.get('storage_gb')}GB {sp.get('gpu')} | "
            f"found by {c['discovered_by']} ({c['provider_consensus_score']}) | LLM claim {c.get('llm_claimed_price')} @ {c.get('llm_claimed_retailer')} | "
            f"verified {c.get('verified_price')} @ {c.get('verified_retailer')} {c.get('verified_product_url') or ''} | "
            f"{c['verification_status']} {c.get('variant_match_strength')} | excl {c.get('exclusion_reason')}")
print(f"\nverified candidates ({len(run['verified_candidates'])}):")
for c in run["verified_candidates"]:
    print("  " + cand_line(c))
print(f"\npromising but unverified ({len(run['unverified_candidates'])}):")
for c in run["unverified_candidates"]:
    print("  " + cand_line(c))
    for r in (c.get("rejections") or [])[:4]:
        print(f"      rejected {r['reason']}: {str(r.get('url'))[:100]} {r.get('detail') or ''}")
print("\nexcluded by reason:", json.dumps(run["metrics"].get("excluded_by_reason")))
print("\nTOP results (existing Recommendation Engine, verified only):")
if not run["top3"]:
    print("  " + str(run.get("no_verified_message")))
bad = []
for p in run["top3"]:
    d = p.get("discovery") or {}
    print(f"  #{p['rank']} {p['role']}: {p['product']['brand']} {p['product']['name']} | MPN {p.get('mpn')} | {p.get('verified_price')} EGP at {p.get('verified_retailer')} | "
          f"{p.get('verified_product_url')} | match {p.get('variant_match_strength')} | score {p['score']} (fit {p['fit']}) | "
          f"found by {d.get('providers')} consensus {d.get('provider_consensus_score')} | {d.get('verification_status')} | evidence {d.get('evidence_providers')}")
    if not p.get("verified") or not p.get("verified_product_url") or not p.get("verified_price"):
        bad.append(p["rank"])
print("\ncatalog Top 3 (same profile):")
for p in run["catalog"]["top3"]:
    print(f"  #{p['rank']} {p['product']['name']} | {p.get('price')} EGP | score {p['score']}")
ok_n = sum(1 for p in run["providers"] if p["ok"])
if code != 200 or ok_n < need or bad:
    print(f"FAILED: HTTP {code}, {ok_n} providers succeeded (need {need}), unverified Top results {bad}")
    sys.exit(1)
