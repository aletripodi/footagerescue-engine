// Browser tests for the engine: runs the real Worker + WORKERFS + copy path in Chrome
// and compares every output with the native untrunc result, byte for byte (SHA-256).
//
// Prerequisites:
//   engine/scripts/build-web.sh engine/build/web       (the packaged engine)
//   engine/build/fixtures/ with the files listed in CASES and the native outputs
//   npm install (in engine/tests)
//
// Usage: node browser/run.mjs [--big]     (--big adds the >4 GB file test)
// Env:   CHROME=/path/to/chrome           (default: Google Chrome on macOS)

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ENGINE, sha256File, startHarness } from "./lib.mjs";

const FX = join(ENGINE, "build", "fixtures");
const BIG = process.argv.includes("--big");

const fx = (name) => join(FX, name);
const readRange = (path, start, length) => {
	const fd = openSync(path, "r"); const buf = Buffer.alloc(length);
	readSync(fd, buf, 0, length, start); closeSync(fd); return buf;
};

const h = await startHarness();
const page = h.page;
const setFiles = (broken, reference) => h.setFiles(fx(broken), fx(reference));

const results = [];
function report(name, pass, detail) {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// --- full repairs compared with the native output
const CASES = [
	{ name: "rsv-ben, synthetic RSV 135 MB", broken: "small.RSV", ref: "ref.mov", method: "rsv-ben", expected: "out/upstream.mov" },
	{ name: "rsv-ben -maxdur 2 (preview)", broken: "small.RSV", ref: "ref.mov", method: "rsv-ben", maxDuration: 2, expected: "out/preview.mov" },
	{ name: "standard, interrupted MOV", broken: "cut.mov", ref: "ref.mov", method: "standard", expected: "out/cut-standard-upstream.mov" },
	{ name: "-s, interrupted MOV", broken: "cut.mov", ref: "ref.mov", method: "s", expected: "out/cut-s-upstream.mov" },
];
for (const c of CASES) {
	await setFiles(c.broken, c.ref);
	const r = await page.evaluate((a) => window.runRepair(a), { method: c.method, maxDuration: c.maxDuration, name: "out.bin", fullHash: true });
	if (!r.ok) { report(c.name, false, `${r.name}: ${r.message}`); continue; }
	const expected = await sha256File(fx(c.expected));
	report(c.name, r.sha256 === expected,
		`${r.size} bytes, ${r.ranges.length} range(s), analysis ${secs(r.timings.analysisMs)}, write ${secs(r.timings.writeMs)}, ${r.progressEvents} progress events`);
}

// --- methods outside the cascade are refused
{
	await setFiles("small.RSV", "ref.mov");
	const r = await page.evaluate(() => window.runRepair({ method: "s-rsv-ben", name: "out.bin" }));
	report("unknown method is refused", !r.ok && /unknown method/.test(r.message), r.ok ? "unexpectedly succeeded" : r.message);
}

// --- dropCut: same as native untrunc with -dropcut
{
	await setFiles("small.RSV", "ref.mov");
	const r = await page.evaluate(() => window.runRepair({ method: "rsv-ben", dropCut: true, name: "out.bin", fullHash: true }));
	const expected = await sha256File(fx("out/dropcut.mov"));
	report("rsv-ben with dropCut = native -dropcut", r.ok && r.sha256 === expected, r.ok ? `${r.size} bytes` : r.message);
}

// --- cascade stops at the first good method; inspection and fingerprint
{
	await setFiles("small.RSV", "ref.mov");
	const c = await page.evaluate(() => window.runCascade());
	report("cascade picks rsv-ben on an RSV", c.best?.method === "rsv-ben" && c.attempts.length === 1 && c.best.quality.good,
		JSON.stringify(c.best?.quality));
	const i = await page.evaluate(() => window.runInspect());
	const fp = createHash("sha256").update(readRange(fx("small.RSV"), 0, 16 << 20)).digest("hex");
	report("inspection and fingerprint", i.rsv.isRsv && i.rsv.codec === "h264" && i.rsv.framesPerGop === 12
		&& i.reference.video?.codec === "avc1" && i.reference.video?.fps === 25 && i.fingerprint.sha256 === fp,
		`${JSON.stringify(i.rsv)} ${JSON.stringify(i.reference.video)}`);
	const p = await page.evaluate(() => window.runPreview({ seconds: 2 }));
	const pExpected = await sha256File(fx("out/preview-dropcut.mov"));
	report("preview blob = native -maxdur 2 -dropcut", p.sha256 === pExpected, `${p.size} bytes, ${p.type}`);
}

// --- cancelling during the write
{
	await setFiles("small.RSV", "ref.mov");
	const r = await page.evaluate(() => window.runCancel({ method: "rsv-ben", name: "cancel.bin" }));
	report("cancel during write rejects with AbortError", r.ok, r.message);
}

// --- a file larger than 4 GB: 64-bit offsets through WORKERFS and the copy
if (BIG) {
	const big = "big.RSV";
	if (!existsSync(fx(big))) {
		report(">4 GB test", false, "engine/build/fixtures/big.RSV missing");
	} else {
		await setFiles(big, "ref.mov");
		const a = await page.evaluate(() => window.runAnalyze({ method: "rsv-ben" }));
		const expectedHeaders = await sha256File(fx("out/big-wasm-headers.bin"));
		report(">4 GB: headers match the Node/native run", a.ok && a.headersSha256 === expectedHeaders,
			a.ok ? `${a.diagnostics.rsv.gops} GOPs, ${a.diagnostics.rsv.video_frames} frames, 64-bit ${a.diagnostics.offsets_64bit}, ${secs(a.ms)}` : a.message);

		const r = await page.evaluate(() => window.runRepair({ method: "rsv-ben", name: "big.bin", fullHash: false }));
		if (!r.ok) report(">4 GB: full write", false, r.message);
		else {
			// output = headers + the whole source: check size, the start, and the last 32 MB
			const size = statSync(fx(big)).size;
			const head = createHash("sha256");
			head.update(readFileSync(fx("out/big-wasm-headers.bin")));
			head.update(readRange(fx(big), 0, (1 << 20) - r.headerSize));
			const tailLen = 32 << 20;
			const tail = await sha256File(fx(big), size - tailLen, size);
			const pass = r.size === r.headerSize + size && r.headSha256 === head.digest("hex") && r.tailSha256 === tail;
			report(">4 GB: full write (size, first 1 MB, last 32 MB)", pass,
				`${r.size} bytes, analysis ${secs(r.timings.analysisMs)}, write ${secs(r.timings.writeMs)} (${(r.size / r.timings.writeMs / 1e3).toFixed(0)} MB/s)`);
		}
	}
}

// --- nothing but the engine's own files may be requested, and nothing may be sent
const net = h.networkCheck();
report("no network request carries file data", net.ok, `${net.requests} requests, all GET of ${net.paths.join(", ")}`);

await h.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
