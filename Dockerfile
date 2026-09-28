# Reproducible build of the FootageRescue browser engine.
#
#   docker build --build-arg ENGINE_COMMIT=$(git rev-parse HEAD) --output type=local,dest=out engine
#
# writes engine.js, untrunc-worker.js, untrunc.mjs, untrunc.wasm, LICENSE.txt and
# SOURCE.txt to ./out. The toolchain is pinned: Emscripten 6.0.9 (image digest below)
# and FFmpeg 3.3.9 (tarball SHA-256 in scripts/build-ffmpeg-wasm.sh).
FROM emscripten/emsdk:6.0.9@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc AS build
ARG ENGINE_COMMIT=unknown
ENV ENGINE_COMMIT=${ENGINE_COMMIT}
WORKDIR /engine
COPY LICENSE CHANGES.md UPSTREAM.md ./
COPY untrunc ./untrunc
COPY wasm ./wasm
COPY web ./web
COPY scripts ./scripts
RUN ./scripts/build-ffmpeg-wasm.sh && ./scripts/build-wasm.sh && ./scripts/build-web.sh /dist

FROM scratch
COPY --from=build /dist/ /
