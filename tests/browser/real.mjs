// Tests with real camera files: for each (damaged, reference) pair,
//   1. repair with native upstream untrunc and with the browser engine, compare SHA-256;
//   2. decode the repaired file completely with FFmpeg (ffprobe -show_frames) and report
//      decode errors, video and audio duration, and the final A/V difference.
//
// Usage: node browser/real.mjs <pairs.json> <out dir>
// pairs.json: [{ "id": "01", "broken": "/path/x.RSV", "reference": "/path/y.MP4", "method": "rsv-ben" }, ...]
// The inputs are only read. Outputs (native repairs, results.json) go to <out dir>.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ENGINE, sha256File, startHarness } from "./lib.mjs";

const [pairsPath, outDir] = process.argv.slice(2);
if (!pairsPath || !outDir) { console.error("usage: real.mjs <pairs.json> <out dir>"); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const NATIVE = join(ENGINE, "build", "native-upstream", "untrunc");
const FFPROBE = join(ENGINE, "build", "native", "ffmpeg-3.3.9", "ffprobe");
const METHOD_ARGS = { "rsv-ben": ["-rsv-ben"], "standard": [], "s": ["-s"] };
const pairs = JSON.parse(readFileSync(pairsPath, "utf8"));

function native(p, dst) {
	const t0 = Date.now();
	const r = spawnSync(NATIVE, ["-n", ...METHOD_ARGS[p.method], "-dst", dst, p.reference, p.broken], { encoding: "utf8", maxBuffer: 1 << 28 });
	const log = (r.stdout || "") + (r.stderr || "");
	return { exit: r.status, ms: Date.now() - t0, produced: existsSync(dst) && statSync(dst).size > 0,
		lastError: log.split("\n").filter((l) => /Error|error|not compatible/.test(l)).pop() || null };
}

// Full decode with FFmpeg's decoders; durations from the decoded frames.
function decode(file) {
	const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "frame=media_type,pkt_pts_time,pkt_duration_time",
		"-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 30 });
	const end = { video: 0, audio: 0 }, frames = { video: 0, audio: 0 };
	for (const line of r.stdout.split("\n")) {
		const [type, pts, dur] = line.split(",");
		if (!(type in end) || pts === "N/A") continue;
		frames[type]++;
		end[type] = Math.max(end[type], Number(pts) + (Number(dur) || 0));
	}
	const errors = r.stderr.split("\n").filter(Boolean);
	return { videoFrames: frames.video, audioFrames: frames.audio, videoS: end.video, audioS: end.audio,
		avDiffMs: Math.round((end.audio - end.video) * 1000), errorLines: errors.length, firstErrors: errors.slice(0, 2) };
}

const h = await startHarness();
const results = [];
for (const p of pairs) {
	const res = { id: p.id, broken: p.broken, reference: p.reference, method: p.method, brokenBytes: statSync(p.broken).size };
	process.stdout.write(`${p.id}: native… `);
	const dst = join(outDir, `${p.id}-native.mp4`);
	res.native = native(p, dst);
	if (res.native.produced) res.native.sha256 = await sha256File(dst);

	process.stdout.write("browser… ");
	await h.setFiles(p.broken, p.reference);
	const b = await h.page.evaluate((a) => window.runRepair(a), { method: p.method, name: `${p.id}.out`, fullHash: true });
	res.browser = b.ok
		? { ok: true, size: b.size, sha256: b.sha256, analysisMs: Math.round(b.timings.analysisMs), writeMs: Math.round(b.timings.writeMs),
			frames: b.diagnostics?.rsv?.video_frames, tracks: b.diagnostics?.tracks }
		: { ok: false, error: b.message };
	res.identical = !!(res.native.sha256 && res.browser.ok && res.native.sha256 === res.browser.sha256);
	res.bothFailed = !res.native.produced && !res.browser.ok;

	if (res.native.produced) {
		process.stdout.write("decode… ");
		res.decode = decode(dst);
	}
	results.push(res);
	console.log(res.identical ? "identical" : res.bothFailed ? "both failed" : "DIFFERENT");
}
res_net: {
	const net = h.networkCheck();
	results.push({ id: "network", ok: net.ok, requests: net.requests, paths: net.paths });
}
await h.close();
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`results: ${join(outDir, "results.json")}`);
