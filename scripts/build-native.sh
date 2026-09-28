#!/usr/bin/env bash
# Builds the native (command line) untrunc from engine/untrunc with FFmpeg 3.3.9,
# the same combination used for the manual repair. It is the reference the
# browser engine is compared against.
#
# Usage: build-native.sh [source dir] [output name]
#   defaults: engine/untrunc, "native"  ->  engine/build/native/untrunc
# Pass a checkout of upstream untrunc to build an unmodified binary for comparisons.
set -euo pipefail

sha256_check() {  # <sha256> <file>: shasum on macOS, sha256sum on Linux
	if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c -; else echo "$1  $2" | shasum -a 256 -c -; fi
}

ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ENGINE/build"
SRC="${1:-$ENGINE/untrunc}"
OUT="$BUILD/${2:-native}"
FF_VER=3.3.9
FF_TAR="$BUILD/ffmpeg-$FF_VER.tar.xz"
FF_SHA256=ae34f14fffa65a1a59b256737ca9af7bf4e296b7c4320d42512350126ce06c84

mkdir -p "$BUILD"
if [ ! -f "$FF_TAR" ]; then
	curl -fsSL -o "$FF_TAR" "https://www.ffmpeg.org/releases/ffmpeg-$FF_VER.tar.xz"
fi
sha256_check "$FF_SHA256" "$FF_TAR"

# Build out of tree so engine/untrunc stays a clean copy of the sources.
mkdir -p "$OUT"
rsync -a --delete --exclude .git --exclude "ffmpeg-$FF_VER" --exclude ".build_*" "$SRC/" "$OUT/"
if [ ! -f "$OUT/ffmpeg-$FF_VER/configure" ]; then
	tar -xf "$FF_TAR" -C "$OUT"
fi

make -C "$OUT" FF_VER="$FF_VER" IS_RELEASE=1
"$OUT/untrunc" 2>&1 | head -1 || true
echo "built: $OUT/untrunc"
