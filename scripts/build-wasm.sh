#!/usr/bin/env bash
# Builds untrunc as a WebAssembly module for the browser Worker.
#
# Requires emcc on PATH (source emsdk_env.sh first, or run inside the Docker image)
# and the FFmpeg libraries from build-ffmpeg-wasm.sh (built automatically if missing).
# Output: engine/build/wasm/dist/untrunc.mjs + untrunc.wasm
set -euo pipefail

ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ENGINE/build/wasm"
FF_DIR="$OUT/ffmpeg-3.3.9"
DIST="$OUT/dist"
OBJ="$OUT/obj"

command -v em++ >/dev/null || { echo "em++ not found: source emsdk_env.sh first" >&2; exit 1; }
[ -f "$FF_DIR/libavcodec/libavcodec.a" ] || "$ENGINE/scripts/build-ffmpeg-wasm.sh"

SRC=( "$ENGINE"/untrunc/src/*.cpp "$ENGINE"/untrunc/src/avc1/*.cpp "$ENGINE"/untrunc/src/hvc1/*.cpp "$ENGINE"/wasm/glue.cpp )
COMMIT="${ENGINE_COMMIT:-$(cd "$ENGINE" && git rev-parse HEAD 2>/dev/null || echo dev)}"
VERSION="footagerescue-${COMMIT:0:7}"
CXXFLAGS=( -std=c++17 -O3 -D_FILE_OFFSET_BITS=64 -DUNTR_VERSION="\"$VERSION\""
	-isystem "$FF_DIR" -fwasm-exceptions -Wno-deprecated-declarations )

# FFmpeg's VERSION file shadows the C++ <version> header on case-insensitive file systems
[ -f "$FF_DIR/VERSION" ] && mv "$FF_DIR/VERSION" "$FF_DIR/VERSION.bak"

mkdir -p "$DIST" "$OBJ" "$OUT/node"
# Objects are reused only if no header changed since the last build (headers define
# class layouts shared by every object; a partial rebuild would mix old and new ones).
STAMP="$OBJ/.headers-stamp"
if [ ! -f "$STAMP" ] || [ -n "$(find "$ENGINE/untrunc/src" "$ENGINE/wasm" -name '*.h' -newer "$STAMP" -print -quit)" ]; then
	rm -f "$OBJ"/*.o
fi
objs=()
pids=()
for s in "${SRC[@]}"; do
	o="$OBJ/$(echo "${s#$ENGINE/}" | tr '/' '_').o"
	objs+=("$o")
	if [ ! -f "$o" ] || [ "$s" -nt "$o" ]; then
		em++ "${CXXFLAGS[@]}" -c "$s" -o "$o" &
		pids+=($!)
	fi
done
for pid in ${pids[@]+"${pids[@]}"}; do wait "$pid"; done
touch "$STAMP"

em++ "${objs[@]}" \
	"$FF_DIR/libavformat/libavformat.a" "$FF_DIR/libavcodec/libavcodec.a" "$FF_DIR/libavutil/libavutil.a" \
	-O3 -fwasm-exceptions \
	-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createUntrunc \
	-sENVIRONMENT=worker -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=4MB \
	-sFORCE_FILESYSTEM=1 -lworkerfs.js \
	-sEXPORTED_RUNTIME_METHODS=callMain,FS \
	-o "$DIST/untrunc.mjs"

# Test-only build for Node.js with direct file access (tests/run-wasm-node.sh).
# Same objects and flags; only the environment and file system differ.
if [ "${WITH_NODE_TEST_BUILD:-0}" = 1 ]; then
	em++ "${objs[@]}" \
		"$FF_DIR/libavformat/libavformat.a" "$FF_DIR/libavcodec/libavcodec.a" "$FF_DIR/libavutil/libavutil.a" \
		-O3 -fwasm-exceptions \
		-sENVIRONMENT=node -sNODERAWFS=1 -sEXIT_RUNTIME=1 \
		-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=4MB \
		-o "$OUT/node/untrunc.cjs"
fi

ls -la "$DIST"
