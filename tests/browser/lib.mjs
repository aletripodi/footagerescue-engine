// Shared pieces of the browser tests: a local static server that records every
// request, and a Chrome instance with the harness page loaded.
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENGINE = join(HERE, "..", "..");
const WEB = join(ENGINE, "build", "web");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".txt": "text/plain" };

export const sha256File = (path, start = 0, end) => new Promise((resolve, reject) => {
	const h = createHash("sha256");
	createReadStream(path, { start, end: end === undefined ? undefined : end - 1 })
		.on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

export async function startHarness() {
	if (!existsSync(join(WEB, "untrunc.wasm"))) throw new Error("run engine/scripts/build-web.sh engine/build/web first");
	const serverRequests = [];
	const server = createServer((req, res) => {
		let bodyBytes = 0;
		req.on("data", (d) => { bodyBytes += d.length; });
		req.on("end", () => {
			serverRequests.push({ method: req.method, url: req.url, bodyBytes });
			const url = req.url.split("?")[0];
			const path = url === "/harness.html" ? join(HERE, "harness.html")
				: url === "/sha256.js" ? join(HERE, "sha256.js")
				: url.startsWith("/engine/") ? join(WEB, url.slice("/engine/".length)) : null;
			if (req.method !== "GET" || !path || !existsSync(path)) { res.writeHead(404).end(); return; }
			res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
			createReadStream(path).pipe(res);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;

	const profile = mkdtempSync(join(tmpdir(), "fr-engine-test-"));
	const browser = await puppeteer.launch({
		executablePath: CHROME, headless: true, userDataDir: profile, protocolTimeout: 60 * 60 * 1000,
		args: ["--no-first-run", "--no-default-browser-check"],
	});
	const page = await browser.newPage();
	const pageRequests = [];
	page.on("request", (r) => pageRequests.push({ method: r.method(), url: r.url(), postData: r.postData() ? r.postData().length : 0 }));
	page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) console.log("  [page]", m.text()); });
	await page.goto(`${origin}/harness.html`);
	await page.waitForFunction("window.harnessReady === true");

	return {
		page, origin,
		async setFiles(broken, reference) {
			await (await page.$("#broken")).uploadFile(broken);
			await (await page.$("#reference")).uploadFile(reference);
		},
		// true if the page only fetched its own files and never sent any data
		networkCheck() {
			const foreign = pageRequests.filter((r) => !r.url.startsWith(origin) || r.method !== "GET" || r.postData > 0);
			const uploaded = serverRequests.filter((r) => r.bodyBytes > 0 || r.method !== "GET");
			return { ok: foreign.length === 0 && uploaded.length === 0, requests: pageRequests.length,
				paths: [...new Set(pageRequests.map((r) => new URL(r.url).pathname))] };
		},
		async close() {
			await browser.close();
			server.close();
			rmSync(profile, { recursive: true, force: true });
		},
	};
}
