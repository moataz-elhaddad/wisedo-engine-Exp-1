#!/usr/bin/env python3
"""Experiment B live smoke test against a deployed Exp-1 Worker.

Runs the full pipeline the way the UI does:
  free text -> existing Layer 1 session (/api/session) -> "show results now" -> final NeedProfile
  -> /api/expb/run (multi-source discovery -> consolidation -> evidence -> verification -> ephemeral snapshot
     -> existing Recommendation Engine) -> Top 3
Prints a readable summary and writes expb-status.json, expb-profile.json, expb-run.json.

usage: EXPB_URL=https://... WISEDO_ADMIN_TOKEN=... python3 scripts/expb_smoke.py ["need text"] [--require-providers N]
Exit 1 when the run fails or fewer than N providers succeed.
"""
import json, os, sys, time, urllib.request, urllib.error

URL = os.environ["EXPB_URL"].rstrip("/")
TOKEN = os.environ.get("WISEDO_ADMIN_TOKEN", "").strip()
args = [a for a in sys.argv[1:] if not a.startswith("--")]
TEXT = args[0] if args else ("I need a laptop for programming and daily work, around EGP 40,000, good battery life, "
                             "16GB RAM or more, available in Egypt.")
need = 1
if "--require-providers" in sys.argv:
    need = int(sys.argv[sys.argv.index("--require-providers") + 1])


def call(method, path, body=None, auth=False, timeout=60):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("content-type", "application/json")
    if auth and TOKEN:
        req.add_header("authorization", "Bearer " + TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None


status = call("GET", "/api/expb/status")[1]
json.dump(status, open("expb-status.json", "w"), indent=1)
print("providers configured:", [(p["name"], p["role"], p["model"]) for p in status["providers"]])
print("providers missing:", [(p["name"], p["secret"]) for p in status["missing"]])
print("experiment:", status.get("experiment"))

code, s1 = call("POST", "/api/session", {"event": {"type": "start", "text": TEXT}})
assert code == 200, (code, s1)
state, ui = s1["state"], s1["ui"]
print("need text:", TEXT)
print("layer 1 first screen:", ui["screen"], "| filled:", {k: v["value"] for k, v in state.get("values", {}).items()})
if ui["screen"] != "result":
    code, s2 = call("POST", "/api/session", {"state": state, "event": {"type": "showNow"}})
    assert code == 200 and s2["ui"]["screen"] == "result", (code, s2 and s2.get("ui", {}).get("screen"))
    ui = s2["ui"]
profile = ui["profile"]
json.dump(profile, open("expb-profile.json", "w"), indent=1)
print("NeedProfile:", json.dumps({"money": profile["money"], "must": [f.get("attr") for f in profile["must"]], "prefer": [f.get("attr") for f in profile["prefer"]],
                                  "needs": {n["slot"]: n["value"] for n in profile["needs"] if n["source"] != "default"}}))

t0 = time.time()
code, run = call("POST", "/api/expb/run", {"profile": profile}, auth=True, timeout=300)
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
for e in run.get("evidence_runs", []):
    print(f"  evidence {e['provider']:<8} {'OK' if e['ok'] else 'FAIL'} {e['latency_ms']/1000:.1f}s listings {e['listing_count']} {e.get('error') or ''}")
print("\nconsolidated:")
for c in run["consolidated"]:
    print(f"  {c['key']:>3} {c['brand']} {c['model']} | {c.get('cpu')} {c.get('ram_gb')}GB {c.get('storage_gb')}GB {c.get('gpu')} | "
          f"{c.get('price_egp')} EGP | found by {c['providers']} ({c['provider_consensus_score']}) | evidence from {c.get('evidence_providers')} | "
          f"{c['verification_status']} {c['evidence_confidence']} | ranked {'yes' if c.get('product_id') else 'no'}")
print("\nTOP 3 (existing Recommendation Engine):")
for p in run["top3"]:
    d = p.get("discovery") or {}
    print(f"  #{p['rank']} {p['role']}: {p['product']['brand']} {p['product']['name']} | {p.get('price')} EGP at {p.get('retailer')} | "
          f"score {p['score']} (fit {p['fit']}) | found by {d.get('providers')} consensus {d.get('provider_consensus_score')} | "
          f"{d.get('verification_status')} evidence {d.get('evidence_confidence')} | {p.get('url')}")
print("\ncatalog Top 3 (same profile):")
for p in run["catalog"]["top3"]:
    print(f"  #{p['rank']} {p['product']['name']} | {p.get('price')} EGP | score {p['score']}")
ok_n = sum(1 for p in run["providers"] if p["ok"])
if code != 200 or ok_n < need:
    print(f"FAILED: HTTP {code}, {ok_n} providers succeeded (need {need})")
    sys.exit(1)
