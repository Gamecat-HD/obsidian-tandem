// M3: Vault-Sync – geschlossene Dateien, Anlegen/Umbenennen/Löschen, Schreiber von außen, Offline-Konflikte, Erstimport.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, client, cursorTo, editorText, idle, isBound, openFile, readFile, startServer, status, type, waitFor } from "../lib.mjs";

const write = (h, p, c) =>
	h.evaluate(async (p, c) => {
		const f = app.vault.getFileByPath(p);
		if (f) await app.vault.modify(f, c);
		else {
			const dir = p.split("/").slice(0, -1).join("/");
			if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
			await app.vault.create(p, c);
		}
	}, p, c);
const files = (h) => h.evaluate(() => app.vault.getFiles().map((f) => f.path).filter((p) => !p.startsWith(".")).sort());
const same = async (a, b, p) => (await readFile(a, p)) === (await readFile(b, p));

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice");
	const b = await client(server, "bob");
	try {
		// 1. Geschlossene Datei: Änderung kommt auf der Platte des anderen an
		await write(a, "Willkommen.md", "# Willkommen\n\nGeändert von Alice, Datei ist bei Bob zu.\n");
		await waitFor(async () => (await readFile(b, "Willkommen.md"))?.includes("Geändert von Alice"), { what: "Änderung bei Bob" });
		check(true, "Änderung an geschlossener Datei kommt an");

		// 2. Neue Datei + Ordner
		await write(a, "Projekte/2026/Plan.md", "# Plan\n\n- [ ] Tandem fertig\n");
		await waitFor(async () => (await readFile(b, "Projekte/2026/Plan.md")) === "# Plan\n\n- [ ] Tandem fertig\n", { what: "neue Datei bei Bob" });
		check(true, "neue Datei in neuem Ordner angelegt");

		// 3. Umbenennen (Datei + Ordner)
		await a.evaluate(() => app.fileManager.renameFile(app.vault.getFileByPath("Projekte/2026/Plan.md"), "Projekte/2026/Jahresplan.md"));
		await waitFor(async () => (await readFile(b, "Projekte/2026/Jahresplan.md")) !== null && (await readFile(b, "Projekte/2026/Plan.md")) === null, { what: "Umbenennung bei Bob" });
		check(true, "Datei umbenannt");
		await b.evaluate(() => app.fileManager.renameFile(app.vault.getFolderByPath("Projekte"), "Archiv"));
		await waitFor(async () => (await readFile(a, "Archiv/2026/Jahresplan.md"))?.includes("Tandem fertig"), { what: "Ordner umbenannt bei Alice" });
		check((await readFile(a, "Projekte/2026/Jahresplan.md")) === null, "Ordner umbenannt (Bob → Alice), Inhalt erhalten");

		// 4. Löschen
		await write(a, "Weg.md", "kommt weg");
		await waitFor(async () => (await readFile(b, "Weg.md")) === "kommt weg", { what: "Weg.md bei Bob" });
		await a.evaluate(() => app.vault.delete(app.vault.getFileByPath("Weg.md")));
		await waitFor(async () => (await readFile(b, "Weg.md")) === null, { what: "gelöscht bei Bob" });
		check(true, "Löschen wird übertragen");

		// 5. Schreiber von außen (wie Claude Code / git), während Alice die Datei offen hat
		await openFile(a, "Willkommen.md");
		await waitFor(() => isBound(a, "Willkommen.md"), { what: "gekoppelt" });
		await cursorTo(a, 0, 4);
		const ext = "# Willkommen\n\nGeändert von Alice, Datei ist bei Bob zu.\nZeile von Claude Code.\n";
		await writeFile(join(b.vault, "Willkommen.md"), ext);
		await waitFor(async () => (await editorText(a)).includes("Zeile von Claude Code."), { what: "externe Änderung im Editor bei Alice" });
		const cur = await a.evaluate(() => app.workspace.activeEditor.editor.getCursor());
		check(cur.line === 0 && cur.ch === 4, `Alices Cursor bleibt stehen (${JSON.stringify(cur)})`);
		await type(a, "X");
		await waitFor(async () => (await readFile(b, "Willkommen.md")) === (await editorText(a)), { what: "Bob gleicht nach" });
		check(true, "externe Datei-Änderung zusammengeführt");

		// 6. Beide offline, gleiche geschlossene Datei unterschiedlich geändert → 3-Wege-Merge
		await write(a, "Liste.md", "Äpfel\nBirnen\nKirschen\n");
		await waitFor(async () => (await readFile(b, "Liste.md")) === "Äpfel\nBirnen\nKirschen\n", { what: "Liste bei Bob" });
		await idle(a);
		await idle(b);
		await server.stop();
		await waitFor(async () => (await status(a)) !== "online" && (await status(b)) !== "online", { what: "offline" });
		await write(a, "Liste.md", "Äpfel\nBirnen (Alice)\nKirschen\n");
		await write(b, "Liste.md", "Äpfel\nBirnen\nKirschen\nPflaumen (Bob)\n");
		// Löschen vs. Ändern: Alice löscht, Bob ändert → Änderung gewinnt
		await write(a, "Streit.md", "x");
		await a.evaluate(() => app.vault.delete(app.vault.getFileByPath("Willkommen.md")));
		await write(b, "Willkommen.md", (await readFile(b, "Willkommen.md")) + "Bob war offline fleißig.\n");
		// Gleicher neuer Pfad auf beiden Seiten
		await write(a, "Neu.md", "Neu von Alice");
		await write(b, "Neu.md", "Neu von Bob");
		await server.start();
		await waitFor(async () => (await status(a)) === "online" && (await status(b)) === "online", { timeout: 30000, what: "online" });
		await idle(a);
		await idle(b);
		await a.sleep(1500);
		await idle(a);
		await idle(b);
		const want = "Äpfel\nBirnen (Alice)\nKirschen\nPflaumen (Bob)\n";
		await waitFor(async () => (await readFile(a, "Liste.md")) === want && (await readFile(b, "Liste.md")) === want, { what: "Merge der Liste" });
		check(true, "Offline-Änderungen beider Seiten an derselben Datei zusammengeführt");
		await waitFor(async () => (await readFile(a, "Willkommen.md"))?.includes("Bob war offline fleißig."), { what: "Willkommen wiederhergestellt" });
		check(true, "Löschen vs. Ändern: Änderung gewinnt, Datei wiederhergestellt");
		await waitFor(async () => JSON.stringify(await files(a)) === JSON.stringify(await files(b)), { what: "gleiche Dateiliste" }).catch(async (e) => {
			const idx = (h) => h.evaluate(() => [...app.plugins.plugins.tandem.sync.index.files].filter(([, e]) => e.path.startsWith("Neu") || e.path.startsWith("Streit")).map(([id, e]) => `${id}:${e.path}:${e.del ? "del" : ""}:${e.origin}`));
			console.log("A files", await files(a), "\nB files", await files(b), "\nA idx", await idx(a), "\nB idx", await idx(b));
			console.log("A origin", await a.evaluate(() => app.plugins.plugins.tandem.sync.origin), "B origin", await b.evaluate(() => app.plugins.plugins.tandem.sync.origin));
			console.log([...a.logs, ...b.logs].filter((l) => l.includes("tandem")).join("\n"));
			throw e;
		});
		const neu = (await files(a)).filter((p) => p.startsWith("Neu"));
		const contents = await Promise.all(neu.map((p) => readFile(a, p)));
		check(neu.length === 2 && contents.includes("Neu von Alice") && contents.includes("Neu von Bob"), `gleicher Pfad offline angelegt → beide behalten (${neu.join(", ")})`);

		// 7. Plugin aus, Dateien ändern, Plugin an → Änderungen werden beim Start erkannt
		await a.evaluate(() => app.plugins.plugins.tandem.shutdown());
		await writeFile(join(a.vault, "Liste.md"), want + "Nachtrag bei ausgeschaltetem Plugin\n");
		await writeFile(join(a.vault, "Offline-neu.md"), "neu, während Tandem aus war");
		await a.sleep(800);
		await a.evaluate(() => app.plugins.plugins.tandem.restart());
		await waitFor(async () => (await readFile(b, "Liste.md"))?.includes("Nachtrag") && (await readFile(b, "Offline-neu.md")) !== null, { what: "Startabgleich" });
		check(true, "Änderungen bei ausgeschaltetem Plugin werden beim Start übernommen");

		// 8. Temp-Dateien werden ignoriert
		await writeFile(join(a.vault, "Notiz.md.tmp.12345.abc123"), "tmp");
		await a.sleep(1500);
		const known = await a.evaluate(() => [...app.plugins.plugins.tandem.sync.index.files.values()].some((e) => e.path.includes(".tmp.")));
		check(!known, "Atomic-Write-Temp-Dateien werden ignoriert");

		// 9. Erstimport: 300 Dateien
		const t0 = Date.now();
		await a.evaluate(async () => {
			await app.vault.createFolder("Masse");
			for (let i = 0; i < 300; i++) await app.vault.create(`Masse/Notiz ${String(i).padStart(3, "0")}.md`, `# Notiz ${i}\n\n${"Lorem ipsum dolor sit amet. ".repeat(20)}\n`);
		});
		await waitFor(async () => (await files(b)).filter((p) => p.startsWith("Masse/")).length === 300, { timeout: 90000, interval: 500, what: "300 Dateien bei Bob" });
		await idle(b, 60000);
		const okAll = await b.evaluate(async () => {
			let ok = 0;
			for (const f of app.vault.getFiles()) if (f.path.startsWith("Masse/") && (await app.vault.read(f)).includes("Lorem ipsum")) ok++;
			return ok;
		});
		check(okAll === 300, `300 neue Dateien mit Inhalt bei Bob nach ${((Date.now() - t0) / 1000).toFixed(1)} s`);
		check(await same(a, b, "Masse/Notiz 299.md"), "Inhalt identisch");

		const errs = [a, b].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
