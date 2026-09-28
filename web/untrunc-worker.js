// Web Worker that runs untrunc (WebAssembly) on files chosen by the user.
// Part of the FootageRescue engine (GPL-2.0-or-later, see LICENSE).
//
// The files are read in place with WORKERFS (FileReaderSync on File.slice), so nothing
// is copied into memory or sent over the network. untrunc runs with '-plan': it writes
// only the new headers (ftyp + moov + mdat header) and a list of byte ranges of the
// damaged file; the page then writes the headers and copies those ranges itself.
//
// Messages in:
//   { type: "start", broken: File, reference: File, method, maxDuration?, dropCut? }
//      method: "rsv-ben" | "standard" | "s"
//      dropCut: with "rsv-ben", leave out a final GOP the recording stopped inside
//   { type: "fingerprint", file: File }
// Messages out:
//   { type: "log", line }
//   { type: "progress", percent }                       analysis progress, 0-100
//   { type: "done", headers: ArrayBuffer, plan, diagnostics, exitCode }
//   { type: "fingerprint", sha256, size }               SHA-256 of the first 16 MiB, and the size
//   { type: "error", message, log: [lines] }

import createUntrunc from "./untrunc.mjs";

const METHOD_ARGS = {
	"rsv-ben": ["-rsv-ben"],
	"standard": [],
	"s": ["-s"],
};

const FINGERPRINT_BYTES = 16 << 20;

// Identifies a file without reading all of it: SHA-256 of the first 16 MiB plus the size.
async function fingerprint(file) {
	const head = await file.slice(0, Math.min(file.size, FINGERPRINT_BYTES)).arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", head);
	const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return { sha256, size: file.size };
}

const LOG_KEEP = 300;

function extension(name) {
	const m = /\.[A-Za-z0-9]{1,5}$/.exec(name || "");
	return m ? m[0] : "";
}

self.onmessage = async (event) => {
	const msg = event.data;
	if (msg && msg.type === "fingerprint") {
		try {
			self.postMessage({ type: "fingerprint", ...(await fingerprint(msg.file)) });
		} catch (e) {
			self.postMessage({ type: "error", message: String(e && e.message || e), log: [] });
		}
		return;
	}
	if (!msg || msg.type !== "start") return;

	const log = [];
	const addLog = (line) => {
		log.push(line);
		if (log.length > LOG_KEEP) log.shift();
		self.postMessage({ type: "log", line });
	};

	try {
		const methodArgs = METHOD_ARGS[msg.method];
		if (!methodArgs) throw new Error(`unknown method: ${msg.method}`);
		if (!msg.broken.size) throw new Error("the damaged file is empty (0 bytes)");
		if (!msg.reference.size) throw new Error("the reference clip is empty (0 bytes)");

		const mod = await createUntrunc({
			print: addLog,
			printErr: addLog,
			onUntruncProgress: (percent) => self.postMessage({ type: "progress", percent }),
		});
		const { FS } = mod;

		// Fixed names, so two files with the same name from different folders can't collide.
		const brokenName = "broken" + extension(msg.broken.name);
		const referenceName = "reference" + extension(msg.reference.name);
		FS.mkdir("/in");
		FS.mount(FS.filesystems.WORKERFS, {
			blobs: [
				{ name: brokenName, data: msg.broken },
				{ name: referenceName, data: msg.reference },
			],
		}, "/in");
		FS.mkdir("/out");

		const args = [
			"-n",
			...methodArgs,
			"-dst", "/out/headers.bin",
			"-plan", "/out/plan.json",
			"-diag", "/out/diagnostics.json",
		];
		if (msg.maxDuration) args.push("-maxdur", String(msg.maxDuration));
		if (msg.dropCut && msg.method === "rsv-ben") args.push("-dropcut");
		args.push(`/in/${referenceName}`, `/in/${brokenName}`);

		let exitCode;
		try {
			exitCode = mod.callMain(args);
		} catch (e) {
			if (e && e.name === "ExitStatus") exitCode = e.status;
			else throw e;
		}

		const exists = (p) => FS.analyzePath(p).exists;
		if (!exists("/out/headers.bin") || !exists("/out/plan.json")) {
			const lastError = [...log].reverse().find((l) => /^Error:|^\s*\S.*(not compatible|could not|Could not)/.test(l));
			throw new Error(lastError ? lastError.replace(/^Error:\s*/, "").trim()
				: `untrunc did not produce an output (exit code ${exitCode})`);
		}
		const headers = FS.readFile("/out/headers.bin").buffer;
		const plan = JSON.parse(FS.readFile("/out/plan.json", { encoding: "utf8" }));
		const diagnostics = exists("/out/diagnostics.json")
			? JSON.parse(FS.readFile("/out/diagnostics.json", { encoding: "utf8" }))
			: null;

		self.postMessage({ type: "done", headers, plan, diagnostics, exitCode }, [headers]);
	} catch (e) {
		// A C++ exception untrunc doesn't catch arrives as a WebAssembly.Exception without a message.
		const message = (typeof WebAssembly.Exception === "function" && e instanceof WebAssembly.Exception)
			? (log.filter((l) => /error|Error/.test(l)).pop() || "the repair engine stopped unexpectedly")
			: String(e && e.message || e);
		self.postMessage({ type: "error", message, log });
	}
};
