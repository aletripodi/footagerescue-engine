# FootageRescue repair engine

Repairs interrupted camera recordings (Sony `.RSV`, and MP4/MOV with a healthy
reference clip) **inside the browser**. The damaged file is read in place and never
leaves the user's computer. It is [untrunc](https://github.com/anthwlock/untrunc)
compiled to WebAssembly, plus a small JavaScript layer.

This folder is self-contained and is published on its own as the engine's source code
(GPL obligation): https://github.com/aletripodi/footagerescue-engine, updated with
`scripts/publish-source.sh`. The website, payments and unlocking are not part of it
and talk to the engine only through the API in `web/engine.js` and the Worker's
messages.

- License: GPL-2.0-or-later (`LICENSE`), as untrunc.
- Upstream and changes: `UPSTREAM.md` (untrunc commit `9d86ec9`), `CHANGES.md`.

## How it works

```
page ──(File, File, method)──► Web Worker: untrunc.wasm
                                 reads both files in place (WORKERFS: FileReaderSync on File.slice)
                                 writes only ftyp + moov + mdat header (~100 KB)
                                 and a copy plan: [(offset, length), ...] of the damaged file
page ◄──(headers, plan, diagnostics)──
page: destination.createWritable() ← headers, then the planned ranges of the damaged file
      copied in 32 MiB blocks (Blob.slice → arrayBuffer → write)
```

- **No double copy.** WebAssembly never touches the media data. The output needs the
  destination's space once; the damaged file is only read.
- **64-bit offsets** everywhere (files over 4 GB), while WebAssembly memory stays small:
  about 270 MB peak for `-rsv-ben` (two 128 MB search buffers).
- **Progress and cancel.** The Worker reports analysis progress; `engine.js` reports
  write progress. Cancelling terminates the Worker or aborts the write, and the
  destination is discarded.
- **Diagnostics** as JSON (see `-diag` in `CHANGES.md`): per-track samples and
  durations, unknown sequences and "bytes not matched", and the detected RSV
  parameters. Phase 2 will use them to decide whether to try the next method.
- **Preview-ready.** `maxDuration` (untrunc `-maxdur`) recovers only the first N
  seconds with `-rsv-ben`: the new `mdat` then covers only the data up to that GOP.

### Files

| Path | What |
|---|---|
| `untrunc/` | untrunc sources (upstream + the changes in `CHANGES.md`) |
| `wasm/glue.cpp` | connects untrunc's progress hook to the Worker |
| `web/untrunc-worker.js` | the Web Worker |
| `web/engine.js` | browser API: `repair()`, `analyze()`, `writePlan()`, `isSupported()` |
| `scripts/` | build scripts (native, FFmpeg for WASM, WASM, web package) and `publish-source.sh` |
| `Dockerfile` | pinned, reproducible build of the web package |
| `tests/` | fixture generator, plan assembler, browser tests |

### Worker messages

In: `{ type: "start", broken: File, reference: File, method, maxDuration? }`,
where `method` is `"rsv-ben"` (default), `"s-rsv-ben"`, `"standard"` or `"s"`.

Out: `{ type: "log", line }`, `{ type: "progress", percent }`,
`{ type: "done", headers: ArrayBuffer, plan, diagnostics, exitCode }`,
`{ type: "error", message, log }`.

Plan: `{ version: 1, header_size, total_size, source_size, ranges: [[offset, length], ...] }`.
The repaired file is the headers followed by the ranges, in order.

## Building

### With Docker (reproducible, used by CI)

```
docker build --build-arg ENGINE_COMMIT=$(git rev-parse HEAD) --output type=local,dest=out engine
```

Output in `out/`: `engine.js`, `untrunc-worker.js`, `untrunc.mjs`, `untrunc.wasm`
(2.5 MB, 0.78 MB gzipped), `LICENSE.txt`, `SOURCE.txt`. The GitHub workflow
`.github/workflows/engine-preview.yml` runs this on every push to `engine` and
publishes the site as a Cloudflare Pages preview.

### Locally (macOS)

Emscripten 6.0.9 in the user folder (no admin rights, no Docker):

```
git clone --depth 1 --branch 6.0.9 https://github.com/emscripten-core/emsdk.git ~/.local/emsdk
# emsdk needs Python ≥ 3.10; the system one is 3.9, so:
uv python install 3.12
export EMSDK_PYTHON=$(uv python find 3.12)
~/.local/emsdk/emsdk install 6.0.9 && ~/.local/emsdk/emsdk activate 6.0.9
source ~/.local/emsdk/emsdk_env.sh

engine/scripts/build-wasm.sh                 # FFmpeg + untrunc → build/wasm/dist
engine/scripts/build-web.sh public/engine      # package for /rsv and the lab page
engine/scripts/build-native.sh               # native untrunc for comparisons
```

### FFmpeg configuration (LGPL only)

Both builds use **FFmpeg 3.3.9** (the version the manual repairs used), SHA-256
`ae34f14fffa65a1a59b256737ca9af7bf4e296b7c4320d42512350126ce06c84`, with **no
`--enable-gpl`, `--enable-nonfree` or `--enable-version3`**. Checked in the generated
`config.h` of every build: `CONFIG_GPL 0`, `CONFIG_NONFREE 0`, `CONFIG_VERSION3 0`,
`FFMPEG_LICENSE "LGPL version 2.1 or later"`.

WebAssembly (`scripts/build-ffmpeg-wasm.sh`): only what untrunc uses.

```
--enable-cross-compile --target-os=none --arch=x86_32 --cpu=generic
--disable-asm --disable-inline-asm --disable-yasm --disable-runtime-cpudetect
--disable-pthreads --disable-programs --disable-doc --disable-debug --disable-network
--disable-zlib --disable-bzlib --disable-lzma --disable-iconv --disable-sdl2 (and other autodetected system libraries)
--disable-everything --disable-avdevice --disable-swresample --disable-swscale --disable-avfilter --disable-postproc
--enable-protocol=file --enable-demuxer=mov
--enable-decoder=h264,hevc,aac,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_f32be,pcm_f32le
--enable-parser=h264,hevc,aac
```

Native (`scripts/build-native.sh`, for comparisons): untrunc's own Makefile
configuration for `FF_VER=3.3.9`: `--disable-everything --enable-decoders
--enable-demuxers --enable-protocol=file`, without avdevice, swresample, swscale,
avfilter, postproc, zlib, bzlib, lzma, audiotoolbox, videotoolbox.

## Tests

`tests/make-fixtures.swift` generates a healthy clip shaped like Sony XAVC S
(H.264 1080p25, GOP 12, 16-bit big-endian PCM `twos`) and a synthetic `.RSV` in the
layout `-rsv-ben` expects (rtmd blocks, frames with AUD, audio per GOP), cut in the
middle of the last GOP. `tests/browser/run.mjs` runs the real engine in Chrome and
compares every output with native **upstream** untrunc by SHA-256.

```
cd engine/tests && npm install && node browser/run.mjs [--big]
```

### Results so far (synthetic files, 2026-09-25, Mac with Apple M4, Chrome)

| Test | Result |
|---|---|
| `-rsv-ben`, 135 MB RSV: our native build vs upstream | identical output; 227 MB read instead of ~2.1 GB, 0.44 s vs 1.01 s |
| `-rsv-ben`, 135 MB RSV, WASM (Node) vs upstream | identical output and diagnostics |
| `-rsv-ben` 5.45 GB RSV, WASM `-plan` vs upstream | headers + plan = upstream output (5.08 GiB); 6 s vs 52 s |
| Browser: `-rsv-ben`, `-maxdur 2`, standard, `-s` | outputs identical to upstream (SHA-256) |
| Browser: 5.45 GB RSV (64-bit offsets) | headers identical; analysis 9.1 s, write 4.9 s (1.1 GB/s) |
| Browser: cancel during write | rejects with `AbortError`, destination discarded |
| Browser: network | only GET requests for the engine's own files |
| Decoding (ffprobe) | 8739/8740 frames; the one error is the frame cut on purpose |

Still to do (phase 1 acceptance): real A7 IV `.RSV` files (3-4 short ones and the
34 GB one), compared with native untrunc; tab memory and time on the Mac mini;
playback in QuickTime and Premiere/Resolve.

## Known limits

- `-s -rsv-ben` is refused by untrunc itself (`'-rsv-ben' is not compatible with '-s'`);
  the lab page offers it and shows that error.
- As upstream, `-rsv-ben` treats the last bytes of a cut file as the final GOP's
  audio, so the very end of a repaired file may contain a short burst of noise.
- Saving needs `showSaveFilePicker()`: Chrome, Edge, Brave and Arc on desktop.
