#!/usr/bin/env bash
# Builds a minimal FFmpeg 3.3.9 (libavformat, libavcodec, libavutil) with Emscripten.
# Only what untrunc needs: the MOV/MP4 demuxer to read the reference clip, and the
# parsers/decoders for the codecs Sony and common cameras write.
#
# Requires emcc on PATH (source emsdk_env.sh first, or run inside the Docker image).
# Output: engine/build/wasm/ffmpeg-3.3.9/{libavformat,libavcodec,libavutil}/*.a
set -euo pipefail

sha256_check() {  # <sha256> <file>: shasum on macOS, sha256sum on Linux
	if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c -; else echo "$1  $2" | shasum -a 256 -c -; fi
}

ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ENGINE/build"
OUT="$BUILD/wasm"
FF_VER=3.3.9
FF_TAR="$BUILD/ffmpeg-$FF_VER.tar.xz"
FF_SHA256=ae34f14fffa65a1a59b256737ca9af7bf4e296b7c4320d42512350126ce06c84
FF_DIR="$OUT/ffmpeg-$FF_VER"

command -v emcc >/dev/null || { echo "emcc not found: source emsdk_env.sh first" >&2; exit 1; }

mkdir -p "$OUT"
if [ ! -f "$FF_TAR" ]; then
	curl -fsSL -o "$FF_TAR" "https://www.ffmpeg.org/releases/ffmpeg-$FF_VER.tar.xz"
fi
sha256_check "$FF_SHA256" "$FF_TAR"
if [ ! -f "$FF_DIR/configure" ]; then
	tar -xf "$FF_TAR" -C "$OUT"
fi

DECODERS=h264,hevc,aac,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_f32be,pcm_f32le
PARSERS=h264,hevc,aac

cd "$FF_DIR"
if [ ! -f config.h ]; then
	emconfigure ./configure \
		--cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
		--enable-cross-compile --target-os=none --arch=x86_32 --cpu=generic \
		--disable-asm --disable-inline-asm --disable-yasm \
		--disable-runtime-cpudetect --disable-pthreads --disable-w32threads --disable-os2threads \
		--disable-programs --disable-doc --disable-debug --disable-stripping \
		--disable-network \
		--disable-zlib --disable-bzlib --disable-lzma --disable-iconv --disable-sdl2 \
		--disable-securetransport --disable-schannel --disable-xlib \
		--disable-vaapi --disable-vdpau --disable-vda --disable-videotoolbox --disable-audiotoolbox \
		--disable-cuda --disable-cuvid --disable-nvenc \
		--disable-everything \
		--disable-avdevice --disable-swresample --disable-swscale --disable-avfilter --disable-postproc \
		--enable-protocol=file --enable-demuxer=mov \
		--enable-decoder="$DECODERS" --enable-parser="$PARSERS" \
		--extra-cflags="-O3 -Wno-error=incompatible-function-pointer-types -Wno-error=implicit-function-declaration -Wno-error=int-conversion" \
		> "$OUT/ffmpeg-configure.log"
fi
emmake make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" > "$OUT/ffmpeg-make.log" 2>&1
# FFmpeg's VERSION file shadows the C++ <version> header on case-insensitive
# file systems (macOS), because untrunc adds this directory to the include path.
[ -f VERSION ] && mv VERSION VERSION.bak
ls -la libavformat/libavformat.a libavcodec/libavcodec.a libavutil/libavutil.a
