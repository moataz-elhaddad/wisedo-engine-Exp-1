#!/bin/sh
# Assemble the try-out + admin page into a folder that can be served or published as an Artifact.
# Usage: sh web/build.sh <out-dir>     then e.g.  python3 -m http.server -d <out-dir> 8765
set -e
OUT="${1:?usage: build.sh <out-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
rm -rf "$OUT"
mkdir -p "$OUT/config" "$OUT/data/synthetic"
cp "$HERE/index.html" "$HERE/app.js" "$HERE/admin.js" "$HERE/skus.html" "$HERE/skus.js" "$HERE/expb.html" "$HERE/expb.js" "$OUT/"
cp -r "$ROOT/src" "$OUT/src"
rm -f "$OUT/src/layer1/llm/anthropic.js"   # needs the Node SDK; not used in the browser
cp "$ROOT/config/"*.json "$OUT/config/"
cp -r "$ROOT/data/synthetic/." "$OUT/data/synthetic/"
