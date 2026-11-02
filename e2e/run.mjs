// Aufruf: node e2e/run.mjs [filter]   (TANDEM_SERVER=rust für den Rust-Server)
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "tests");
const filter = process.argv[2] ?? "";
const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs") && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
	console.log(`\n▶ ${f}`);
	const t0 = Date.now();
	try {
		const mod = await import(resolve(dir, f));
		await mod.default();
		console.log(`✔ ${f} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
	} catch (e) {
		failed++;
		console.log(`✘ ${f}: ${e.stack ?? e}`);
	}
}
console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : `\nAlle ${files.length} Tests bestanden`);
process.exit(failed ? 1 : 0);
