// Runs the /rsv page's analysis steps (inspection, cascade) on real pairs.
// Usage: node browser/real-cascade.mjs <pairs.json>
import { readFileSync } from "node:fs";
import { startHarness } from "./lib.mjs";

const pairs = JSON.parse(readFileSync(process.argv[2], "utf8"));
const h = await startHarness();
for (const p of pairs) {
	await h.setFiles(p.broken, p.reference);
	const t0 = Date.now();
	const i = await h.page.evaluate(() => window.runInspect().catch((e) => ({ error: e.message })));
	const c = await h.page.evaluate(() => window.runCascade().catch((e) => ({ error: e.message })));
	const attempts = (c.attempts || []).map((a) => a.error ? `${a.method}: ${a.error}`
		: `${a.method}: ${a.quality.good ? "good" : "not good"} frames=${a.quality.frames} notMatched=${a.quality.notMatchedPct.toFixed(1)}% av=${a.quality.avDiffMs}ms`);
	console.log(`${p.id}  ${((Date.now() - t0) / 1000).toFixed(1)} s  best=${c.best?.method || "none"}`);
	console.log(`    rsv: ${JSON.stringify(i.rsv)}  ref: ${JSON.stringify({ d: i.reference?.durationS, v: i.reference?.video, a: i.reference?.audio })}`);
	attempts.forEach((a) => console.log(`    ${a}`));
}
await h.close();
