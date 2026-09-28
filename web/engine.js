// FootageRescue repair engine: browser API.
// Part of the FootageRescue engine (GPL-2.0-or-later, see LICENSE).
//
// untrunc runs in a Web Worker and only produces the new headers plus a copy plan
// (which byte ranges of the damaged file form the media data). This module then
// either writes the repaired file (headers + ranges) to a FileSystemFileHandle, or
// assembles a short preview as a Blob. The damaged file is never uploaded and never
// held in memory as a whole.
//
//   isSupported()                                   Worker + showSaveFilePicker available
//   fingerprint(file)                               { sha256, size }: SHA-256 of the first 16 MiB
//   inspectRsv(file), inspectReference(file)        format facts, for explaining errors
//   analyze({ broken, reference, method, maxDuration?, dropCut?, ... })  → { headers, plan, diagnostics }
//   quality(diagnostics)                            { good, notMatchedPct, avDiffMs, videoMs, audioMs, frames }
//   cascade({ broken, reference, ... })             tries "rsv-ben", "standard", "s"; keeps the best
//   preview({ broken, reference, method, seconds }) → { blob, diagnostics }
//   writePlan({ broken, headers, plan, destination, ... })
//   repair({ broken, reference, method, destination, analysis?, ... })

const COPY_BLOCK = 32 << 20;  // 32 MiB per read/write
export const METHODS = ["rsv-ben", "standard", "s"];
export const LIMITS = { maxNotMatchedPct: 2, maxAvDiffMs: 1000, minVideoMs: 1000 };
const VIDEO_CODECS = ["avc1", "hvc1", "hev1"];
const AUDIO_CODECS = ["twos", "sowt", "ipcm", "lpcm", "in24", "in32", "fl32", "mp4a"];

export function isSupported() {
	return typeof Worker !== "undefined"
		&& typeof self.showSaveFilePicker === "function"
		&& typeof FileSystemFileHandle !== "undefined";
}

export class RepairError extends Error {
	constructor(message, log = [], code = "engine") {
		super(message);
		this.name = "RepairError";
		this.log = log;
		this.code = code;
	}
}

function aborted() {
	return new DOMException("The repair was cancelled.", "AbortError");
}

function runWorker(message, { onProgress, onLog, signal } = {}) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(aborted());
		const worker = new Worker(new URL("./untrunc-worker.js", import.meta.url), { type: "module" });
		const finish = (fn, value) => {
			worker.terminate();
			signal?.removeEventListener("abort", onAbort);
			fn(value);
		};
		const onAbort = () => finish(reject, aborted());
		signal?.addEventListener("abort", onAbort);
		worker.onmessage = ({ data }) => {
			if (data.type === "log") onLog?.(data.line);
			else if (data.type === "progress") onProgress?.({ phase: "analysis", percent: data.percent });
			else if (data.type === "done" || data.type === "fingerprint") finish(resolve, data);
			else if (data.type === "error") finish(reject, new RepairError(data.message, data.log));
		};
		worker.onerror = (e) => finish(reject, new RepairError(e.message || "worker error"));
		worker.postMessage(message);
	});
}

export async function fingerprint(file) {
	const { sha256, size } = await runWorker({ type: "fingerprint", file });
	return { sha256, size };
}

export function analyze({ broken, reference, method = "rsv-ben", maxDuration, dropCut = true, onProgress, onLog, signal }) {
	return runWorker({ type: "start", broken, reference, method, maxDuration, dropCut }, { onProgress, onLog, signal });
}

// How good a repair is, from untrunc's diagnostics.
export function quality(d) {
	const video = d?.tracks?.find((t) => VIDEO_CODECS.includes(t.codec));
	const audio = d?.tracks?.find((t) => AUDIO_CODECS.includes(t.codec));
	const frames = video?.samples || 0;
	const videoMs = video?.duration_ms || 0;
	const audioMs = audio ? audio.duration_ms : null;
	const avDiffMs = audio ? audioMs - videoMs : 0;
	// A premature end leaves the rest of the file unread: that part counts as not matched.
	const unread = d?.premature_end ? Math.max(0, 100 - (d.premature_percentage || 0)) : 0;
	const notMatchedPct = Math.min(100, (d?.bytes_not_matched_pct || 0) + unread);
	const good = frames > 0 && videoMs >= LIMITS.minVideoMs
		&& notMatchedPct <= LIMITS.maxNotMatchedPct && Math.abs(avDiffMs) <= LIMITS.maxAvDiffMs;
	// lower is better; used to pick among results that are all not good
	const score = frames > 0 ? notMatchedPct + Math.abs(avDiffMs) / 1000 : Infinity;
	return { good, frames, videoMs, audioMs, avDiffMs, notMatchedPct, score, videoCodec: video?.codec, audioCodec: audio?.codec };
}

// Tries the methods in order and stops at the first good result; otherwise keeps the best.
export async function cascade({ broken, reference, methods = METHODS, onAttempt, onProgress, onLog, signal }) {
	const attempts = [];
	let best = null;
	for (const method of methods) {
		onAttempt?.(method);
		let attempt;
		try {
			const r = await analyze({ broken, reference, method, onProgress, onLog, signal });
			attempt = { method, ...r, quality: quality(r.diagnostics) };
		} catch (e) {
			if (e.name === "AbortError") throw e;
			attempt = { method, error: e, quality: quality(null) };
		}
		attempts.push(attempt);
		if (!attempt.error && (!best || attempt.quality.score < best.quality.score)) best = attempt;
		if (attempt.quality.good) break;
	}
	return { best, attempts };
}

// A short repaired preview, assembled in memory without copying the media data.
export async function preview({ broken, reference, method = "rsv-ben", seconds = 20, onProgress, onLog, signal }) {
	const r = await analyze({ broken, reference, method, maxDuration: seconds, onProgress, onLog, signal });
	const parts = [r.headers, ...r.plan.ranges.map(([off, len]) => broken.slice(off, off + len))];
	const type = /\.mov$/i.test(reference.name) ? "video/quicktime" : "video/mp4";
	return { blob: new Blob(parts, { type }), diagnostics: r.diagnostics, quality: quality(r.diagnostics) };
}

export async function writePlan({ broken, headers, plan, destination, onProgress, signal }) {
	if (plan.version !== 1) throw new RepairError(`unsupported plan version ${plan.version}`);
	if (plan.source_size !== broken.size) throw new RepairError("the damaged file changed during the repair", [], "changed");
	if (headers.byteLength !== plan.header_size) throw new RepairError("header size does not match the plan");

	const total = plan.total_size;
	let writable;
	try {
		writable = await destination.createWritable({ keepExistingData: false });
	} catch (e) {
		throw new RepairError(`could not open the destination file: ${e.message}`, [], "destination");
	}
	let written = 0;
	const report = () => onProgress?.({
		phase: "write", percent: Math.floor(100 * written / total), bytesWritten: written, bytesTotal: total,
	});

	try {
		await writable.write(headers);
		written += headers.byteLength;
		report();

		// Read the next block while the current one is being written.
		const blocks = [];
		for (const [offset, length] of plan.ranges) {
			for (let pos = offset; pos < offset + length; pos += COPY_BLOCK) {
				blocks.push([pos, Math.min(pos + COPY_BLOCK, offset + length)]);
			}
		}
		let next = blocks.length ? broken.slice(blocks[0][0], blocks[0][1]).arrayBuffer() : null;
		for (let i = 0; i < blocks.length; i++) {
			if (signal?.aborted) throw aborted();
			const data = await next;
			next = i + 1 < blocks.length ? broken.slice(blocks[i + 1][0], blocks[i + 1][1]).arrayBuffer() : null;
			if (data.byteLength !== blocks[i][1] - blocks[i][0]) throw new RepairError("could not read the damaged file", [], "read");
			try {
				await writable.write(data);
			} catch (e) {
				// Chrome reports a full disk as QuotaExceededError (sometimes as a generic write error)
				throw new RepairError(`could not write the repaired file: ${e.message}`, [], "write");
			}
			written += data.byteLength;
			report();
		}
		if (written !== total) throw new RepairError(`wrote ${written} bytes, expected ${total}`);
		await writable.close();
	} catch (e) {
		await writable.abort().catch(() => {});
		throw e;
	}
	return written;
}

// Full repair. Pass `analysis` (a result of analyze() or cascade().best, without
// maxDuration) to skip the analysis step.
export async function repair({ broken, reference, method = "rsv-ben", dropCut = true, analysis, destination, onProgress, onLog, signal }) {
	const t0 = performance.now();
	const r = analysis || await analyze({ broken, reference, method, dropCut, onProgress, onLog, signal });
	const t1 = performance.now();
	const bytesWritten = await writePlan({ broken, headers: r.headers, plan: r.plan, destination, onProgress, signal });
	const t2 = performance.now();
	return { diagnostics: r.diagnostics, plan: r.plan, bytesWritten, timings: { analysisMs: t1 - t0, writeMs: t2 - t1 } };
}

// ---- format inspection (for explaining errors; the repair doesn't depend on it)

const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const fourcc = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const isRtmd = (b, i) => b[i] === 0x00 && b[i + 1] === 0x1c && b[i + 2] === 0x01 && b[i + 3] === 0x00
	&& b[i + 8] === 0xf0 && b[i + 9] === 0x01 && b[i + 10] === 0x00 && b[i + 11] === 0x10;

function findRtmd(b, from) {
	for (let i = from; i + 12 <= b.length; i++) if (b[i] === 0 && b[i + 1] === 0x1c && isRtmd(b, i)) return i;
	return -1;
}

// Sony .RSV: codec, frames per GOP and the audio bytes per GOP, read from the first GOPs.
export async function inspectRsv(file) {
	const info = { size: file.size, isRsv: false };
	if (!file.size) return info;
	const b = new Uint8Array(await file.slice(0, Math.min(file.size, 64 << 20)).arrayBuffer());
	if (b.length < 12 || !isRtmd(b, 0)) return info;
	info.isRsv = true;
	const packet = findRtmd(b, 12);
	if (packet <= 0) return info;
	let n = 0;
	while (n * packet + 12 <= b.length && isRtmd(b, n * packet)) n++;
	const vstart = n * packet;
	const aud = b[vstart + 4] === 0x09 ? [0, 0, 0, 2, 0x09] : b[vstart + 4] === 0x46 ? [0, 0, 0, 3, 0x46] : null;
	if (!aud) return info;
	info.codec = aud[4] === 0x09 ? "h264" : "hevc";
	const next = findRtmd(b, vstart + 500 * 1024);
	if (next < 0) return info;  // the recording stopped inside the first GOP
	const frames = [];
	for (let i = vstart; i + 5 <= next; i++) {
		if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === aud[3] && b[i + 4] === aud[4]) { frames.push(i); i += 4; }
	}
	// the last frame's NAL units end where the GOP's audio begins
	let p = frames[frames.length - 1];
	while (p + 4 <= next) {
		const len = u32(b, p);
		if (!len || p + 4 + len > next) break;
		p += 4 + len;
	}
	info.framesPerGop = frames.length;
	info.audioBytesPerGop = next - p;
	return info;
}

// Healthy MP4/MOV: duration, and the codec, size and frame rate of the video and audio.
export async function inspectReference(file) {
	const info = { size: file.size };
	let pos = 0, moov = null;
	while (pos + 8 <= file.size) {
		const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
		let size = u32(h, 0);
		const type = fourcc(h, 4);
		if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
		else if (size === 0) size = file.size - pos;
		if (size < 8) break;
		if (type === "moov") { moov = new Uint8Array(await file.slice(pos, pos + size).arrayBuffer()); break; }
		pos += size;
	}
	if (!moov) return info;
	const boxes = (b, start, end) => {
		const out = [];
		for (let i = start; i + 8 <= end;) {
			const size = u32(b, i);
			if (size < 8 || i + size > end) break;
			out.push({ type: fourcc(b, i + 4), start: i, end: i + size });
			i += size;
		}
		return out;
	};
	const child = (b, box, type, skip = 8) => boxes(b, box.start + skip, box.end).find((x) => x.type === type);
	const top = { start: 0, end: moov.length };
	const mvhd = child(moov, top, "mvhd");
	if (mvhd) {
		const v1 = moov[mvhd.start + 8] === 1;
		const ts = u32(moov, mvhd.start + (v1 ? 28 : 20));
		const dur = v1 ? u32(moov, mvhd.start + 32) * 2 ** 32 + u32(moov, mvhd.start + 36) : u32(moov, mvhd.start + 24);
		if (ts) info.durationS = dur / ts;
	}
	for (const trak of boxes(moov, 8, moov.length).filter((x) => x.type === "trak")) {
		const mdia = child(moov, trak, "mdia");
		const hdlr = mdia && child(moov, mdia, "hdlr");
		const mdhd = mdia && child(moov, mdia, "mdhd");
		const stbl = mdia && child(moov, child(moov, mdia, "minf") || mdia, "stbl");
		if (!hdlr || !stbl) continue;
		const handler = fourcc(moov, hdlr.start + 16);
		const stsd = child(moov, stbl, "stsd");
		const entry = stsd ? stsd.start + 16 : -1;
		const codec = entry > 0 ? fourcc(moov, entry + 4) : null;
		const timescale = mdhd ? u32(moov, mdhd.start + (moov[mdhd.start + 8] === 1 ? 28 : 20)) : 0;
		if (handler === "vide" && !info.video) {
			const stts = child(moov, stbl, "stts");
			const delta = stts && u32(moov, stts.start + 12) ? u32(moov, stts.start + 20) : 0;
			info.video = {
				codec, width: (moov[entry + 32] << 8) | moov[entry + 33], height: (moov[entry + 34] << 8) | moov[entry + 35],
				fps: delta ? Math.round(100 * timescale / delta) / 100 : null,
			};
		} else if (handler === "soun" && !info.audio) {
			info.audio = { codec, channels: (moov[entry + 24] << 8) | moov[entry + 25], bits: (moov[entry + 26] << 8) | moov[entry + 27],
				rate: timescale };
		}
	}
	return info;
}

// Frame rate the .RSV was recorded at, assuming the reference clip's audio format.
export function rsvFps(rsv, ref) {
	if (!rsv?.framesPerGop || !rsv.audioBytesPerGop || !ref?.audio?.rate) return null;
	const bytesPerSample = (ref.audio.channels || 2) * ((ref.audio.bits || 16) / 8);
	const samples = rsv.audioBytesPerGop / bytesPerSample;
	return Math.round(100 * rsv.framesPerGop * ref.audio.rate / samples) / 100;
}
