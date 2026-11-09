// Leistungsmessung mit zwei echten Obsidian-Instanzen (headless) und dem Rust-Server.
// Gemessen wird Ende-zu-Ende: Eingabe bei A (CDP) → sichtbar im Editor bzw. im Vault von B.
// Zeitstempel kommen aus beiden Prozessen (gleiche Systemuhr, performance.timeOrigin + now).
// Aufruf: node e2e/bench.mjs [verzögerung_ms_je_richtung]   z. B. 0 (lokal) oder 40 (≈ 80 ms RTT)
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latencyProxy } from "./latency-proxy.mjs";
import { client, cursorTo, idle, isBound, openFile, ROOT, sleep, startServer, waitFor } from "./lib.mjs";

const DELAY = Number(process.argv[2] ?? 0);
const KEYS = Number(process.env.KEYS ?? 100);
const NOTES = Number(process.env.NOTES ?? 1000);
const now = () => performance.timeOrigin + performance.now();
const stats = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0], max: s.at(-1) };
};
const fmt = (o) => `Median ${o.median.toFixed(1)} ms · p95 ${o.p95.toFixed(1)} ms · min ${o.min.toFixed(1)} · max ${o.max.toFixed(1)} (n=${o.n})`;

const real = await startServer({ rust: true });
const proxy = DELAY ? await latencyProxy(real.url, DELAY) : null;
const server = { ...real, url: proxy?.url ?? real.url };
const results = { delayMsEachWay: DELAY };
const handles = [];
try {
	const a = await client(server, "alice", { device: "A" });
	const b = await client(server, "bob", { device: "B" });
	handles.push(a, b);

	// 1. Tastendruck A → im Editor von B gerendert
	await a.evaluate(() => app.vault.create("Bench.md", "# Bench\n\n"));
	await idle(a);
	await waitFor(() => b.evaluate(() => !!app.vault.getFileByPath("Bench.md")), { what: "Bench.md bei B" });
	for (const h of [a, b]) {
		await openFile(h, "Bench.md");
		await waitFor(() => isBound(h, "Bench.md"), { what: `${h.user} gekoppelt` });
	}
	await b.evaluate(() => {
		const cm = app.workspace.activeEditor.editor.cm;
		window.__lens = [];
		new MutationObserver(() => window.__lens.push([cm.state.doc.length, performance.timeOrigin + performance.now()])).observe(cm.contentDOM, {
			childList: true, subtree: true, characterData: true,
		});
	});
	await cursorTo(a, -1);
	const keys = [];
	for (let i = 0; i < KEYS; i++) {
		const len = await b.evaluate(() => app.workspace.activeEditor.editor.cm.state.doc.length);
		const t0 = now();
		await a.cdp.send("Input.insertText", { text: "x" });
		const t1 = await waitFor(
			() => b.evaluate((l) => window.__lens.find(([n]) => n > l)?.[1] ?? null, len),
			{ interval: 2, what: `Zeichen ${i} bei B` },
		);
		keys.push(t1 - t0);
		await sleep(40);
	}
	results.keystroke = stats(keys);
	console.log(`Tastendruck A→B (gerendert):  ${fmt(results.keystroke)}`);

	// 2. Neue Notiz A → in Bs Vault (Datei auf der Platte angelegt)
	await b.evaluate(() => {
		window.__created = new Map();
		app.vault.on("create", (f) => window.__created.set(f.path, performance.timeOrigin + performance.now()));
	});
	const files = [];
	for (let i = 0; i < 20; i++) {
		const p = `Neu ${i}.md`;
		const start = now();
		await a.evaluate((p) => app.vault.create(p, "# Notiz\n\nText\n").then(() => 0), p);
		const t1 = await waitFor(() => b.evaluate((p) => window.__created.get(p) ?? null, p), { interval: 5, what: `${p} bei B` });
		files.push(t1 - start);
		await sleep(50);
	}
	results.newNote = stats(files);
	console.log(`Neue Notiz A→B:              ${fmt(results.newNote)}`);

	// 3. Anhang (5 MiB, zufällig = nicht komprimierbar) A → B
	const blobs = [];
	for (let i = 0; i < 3; i++) {
		const p = `Anhang ${i}.bin`;
		const start = now();
		await a.evaluate((p) => {
			const buf = new Uint8Array(5 * 1024 * 1024);
			for (let o = 0; o < buf.length; o += 65536) crypto.getRandomValues(buf.subarray(o, o + 65536));
			return app.vault.createBinary(p, buf.buffer).then(() => 0);
		}, p);
		const t1 = await waitFor(() => b.evaluate((p) => window.__created.get(p) ?? null, p), { interval: 10, timeout: 60000, what: `${p} bei B` });
		blobs.push(t1 - start);
	}
	results.attachment5MiB = stats(blobs);
	console.log(`Anhang 5 MiB A→B:            ${fmt(results.attachment5MiB)}`);
	results.serverRssMiB = real.rssKib ? +((await real.rssKib()) / 1024).toFixed(1) : null;
	console.log(`Server-RSS nach den Messungen: ${results.serverRssMiB} MiB`);

	// 4. Erstabgleich: A legt NOTES Notizen an, ein neues Gerät C mit leerem Vault holt alles
	const tpl = await mkdtemp(join(tmpdir(), "tandem-bench-vault-"));
	await mkdir(join(tpl, ".obsidian"), { recursive: true });
	await writeFile(join(tpl, ".obsidian/app.json"), JSON.stringify({ promptDelete: false }));
	const tCreate = now();
	await a.evaluate(async (n) => {
		await app.vault.createFolder("Massen").catch(() => {});
		for (let i = 0; i < n; i++) await app.vault.create(`Massen/Notiz ${String(i).padStart(4, "0")}.md`, `# Notiz ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(20)}\n`);
	}, NOTES);
	const tUp = now();
	await idle(a, 600000);
	results.uploadNotes = { notes: NOTES, ms: Math.round(now() - tUp), createAndUploadMs: Math.round(now() - tCreate) };
	console.log(`Notizen anlegen + hochladen:  ${NOTES} in ${(results.uploadNotes.createAndUploadMs / 1000).toFixed(1)} s (davon ${(results.uploadNotes.ms / 1000).toFixed(1)} s Nachlauf)`);
	// Bei B kommen die Notizen live an: bis B alle hat und fertig ist
	await waitFor(() => b.evaluate((n) => app.vault.getFiles().filter((f) => f.path.startsWith("Massen/")).length >= n, NOTES), { interval: 100, timeout: 600000, what: "Notizen bei B" });
	await idle(b, 600000);
	results.liveBulkB = { ms: Math.round(now() - tCreate) };
	console.log(`… bei B vollständig nach:     ${(results.liveBulkB.ms / 1000).toFixed(1)} s`);
	const c = await client(server, "carol", { device: "C", vaultTemplate: tpl, login: false });
	handles.push(c);
	const total = await a.evaluate(() => app.vault.getFiles().length);
	const start = now();
	await c.evaluate(async (token) => {
		app.saveLocalStorage("tandem-token", token);
		app.saveLocalStorage("tandem-device", "C");
		await app.plugins.plugins.tandem.restart();
	}, server.tokens.carol);
	await waitFor(() => c.evaluate((t) => app.vault.getFiles().length >= t, total), { interval: 100, timeout: 300000, what: "Erstabgleich" });
	results.initialSync = { files: total, ms: Math.round(now() - start) };
	console.log(`Erstabgleich neues Gerät:     ${total} Dateien in ${(results.initialSync.ms / 1000).toFixed(1)} s (inkl. ${3 * 5} MiB Anhänge)`);
	await idle(c, 600000);
	results.initialSync.idleMs = Math.round(now() - start);
	console.log(`… bis C nichts mehr zu tun hat: ${(results.initialSync.idleMs / 1000).toFixed(1)} s`);
	// Inhalt prüfen (nicht gemessen): jede Massen-Notiz bei C wie bei A
	const bad = await c.evaluate(async (n) => {
		let wrong = 0;
		for (let i = 0; i < n; i++) {
			const f = app.vault.getFileByPath(`Massen/Notiz ${String(i).padStart(4, "0")}.md`);
			const t = f ? await app.vault.read(f) : null;
			if (t !== `# Notiz ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(20)}\n`) wrong++;
		}
		return wrong;
	}, NOTES);
	results.initialSync.wrongContent = bad;
	console.log(`Inhalt bei C: ${bad === 0 ? "alle korrekt" : `${bad} FALSCH`}`);
	await rm(tpl, { recursive: true, force: true });
	results.serverRssAfterSyncMiB = +((await real.rssKib()) / 1024).toFixed(1);
	console.log(`Server-RSS danach:            ${results.serverRssAfterSyncMiB} MiB`);
} finally {
	for (const h of handles) await h.close().catch(() => {});
	await proxy?.close();
	await real.close();
}
await mkdir(join(ROOT, "e2e-out"), { recursive: true });
await writeFile(join(ROOT, `e2e-out/bench-${DELAY}ms.json`), JSON.stringify(results, null, 2));
