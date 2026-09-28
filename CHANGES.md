# Changes to upstream untrunc

Modifications made by UAU Srl (FootageRescue) to the files in `engine/untrunc/`,
as required by section 2(a) of the GPL v2. Newest first. The exact diff against
upstream is `git diff <import commit> -- engine/untrunc` (import commit: "engine:
import upstream untrunc 9d86ec9 unmodified").

## 2026-09-25 (2): cut-GOP drop, frame layout check, preview limit for every method

- **`-dropcut`** (`rsv.cpp`, `main.cpp`, `common.*`): with `-rsv-ben`, when no rtmd
  block follows a GOP (the recording stopped inside it), that GOP is left out
  entirely (rtmd, video and audio) and the new `mdat` ends before it. Upstream treats
  the last bytes of such a file as the GOP's audio, which plays as a short burst of
  noise and leaves one undecodable frame.
- **Frame layout check** (`rsv.cpp`, `mp4.*`): with `-rsv-ben`, every frame is checked
  to consist of length-prefixed NAL units ending exactly at the frame boundary. If the
  last frame of a GOP doesn't end where the audio chunk begins (the audio chunk size
  comes from the reference's frame rate and audio format), the whole GOP counts as
  "bytes not matched". Reported in `-diag` only; the output is unchanged.
- **`-maxdur` for all methods** (`mp4.cpp`, `track.h`): the standard and `-s` repairs
  stop once the first video track holds the requested duration, ending the new `mdat`
  there the way a premature end does. `Track::origTimes()` gives read access to the
  reference sample durations.

## 2026-09-25: copy plan, JSON diagnostics, preview limit, lighter RSV reads

All new behaviour is opt-in through new options; without them untrunc behaves as upstream.

- **`-plan <file>`** (`main.cpp`, `common.*`, `mp4.cpp`, `atom.*`): `saveVideo()` writes
  only `ftyp` + `moov` + the `mdat` header to the destination, and writes to `<file>`
  a JSON list of the `(offset, length)` ranges of the damaged file that form the
  `mdat` content. New `BufferedAtom::writePlan()` follows exactly the same traversal
  as `BufferedAtom::write()` (same header, same excluded sequences) without reading
  the data. Headers followed by the ranges are byte-identical to the normal output.
  Used by the browser, which copies the media data itself.
- **`-diag <file>`** (`mp4.*`): writes the repair summary as JSON: per-track samples,
  chunks, keyframes and duration; unknown sequences and bytes not matched; skipped
  atoms; premature end; and, with `-rsv-ben`, the detected RSV parameters and counts.
- **`-maxdur <seconds>`** (`rsv.cpp`, `main.cpp`): with `-rsv-ben`, stops at the end
  of the GOP that reaches the given duration and limits the new `mdat` to the data
  read so far. For short previews.
- **`-rsv-ben` search window** (`rsv.cpp`): upstream read a fixed 128 MB window from
  each GOP's video start, for every GOP. The window is now loaded in growing steps
  (starting from the previous GOP's size) until the next rtmd header is found or the
  full window is loaded. The rtmd search runs over the same bytes in the same order,
  and the AUD scan covers every position before the audio boundary, so the frames,
  sizes and offsets are unchanged. On a 134 MB synthetic RSV: identical output,
  227 MB read instead of ~2.1 GB.
