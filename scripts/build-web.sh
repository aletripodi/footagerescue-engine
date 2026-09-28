#!/usr/bin/env bash
# Packages the browser engine into one folder that a web page can load:
#   engine.js, untrunc-worker.js, untrunc.mjs, untrunc.wasm, LICENSE.txt, SOURCE.txt
#
# Usage: build-web.sh <output dir>
# Builds the WebAssembly module first if it is missing (needs emcc, see build-wasm.sh).
set -euo pipefail

ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: build-web.sh <output dir>}"
DIST="$ENGINE/build/wasm/dist"

[ -f "$DIST/untrunc.wasm" ] || "$ENGINE/scripts/build-wasm.sh"

mkdir -p "$DEST"
cp "$ENGINE/web/engine.js" "$ENGINE/web/untrunc-worker.js" "$DIST/untrunc.mjs" "$DIST/untrunc.wasm" "$DEST/"
cp "$ENGINE/LICENSE" "$DEST/LICENSE.txt"
COMMIT="${ENGINE_COMMIT:-$(cd "$ENGINE" && git rev-parse HEAD 2>/dev/null || echo unknown)}"
cat > "$DEST/SOURCE.txt" <<TXT
FootageRescue repair engine, built from commit $COMMIT.

It contains untrunc (https://github.com/anthwlock/untrunc), GPL-2.0-or-later, with the
changes listed in engine/CHANGES.md, and FFmpeg 3.3.9 (https://ffmpeg.org), built with
LGPL-2.1-or-later components only. See LICENSE.txt. The complete corresponding source
code, with the scripts to rebuild it, is at https://github.com/aletripodi/footagerescue-engine
(each commit there says which commit of the site it was published from). Questions:
hello@footagerescue.com.
TXT
ls -la "$DEST"
