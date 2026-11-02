// M6: Ink Blocks Stufe A – .ink-Dateien als Ink-Doc, Striche kommen nach dem Absetzen beim anderen an,
// gleichzeitiges Zeichnen auf derselben Fläche geht nicht verloren, Radieren wird übertragen.
import { check, client, idle, openFile, startServer, waitFor } from "../lib.mjs";
import { INK_ID, inkFileText, inkPlugin, strokeIds, surfaceRect, word } from "../lib-ink.mjs";

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { extraPlugins: [inkPlugin()] });
	const b = await client(server, "bob", { extraPlugins: [inkPlugin()] });
	try {
		check(await a.evaluate((id) => !!app.plugins.plugins[id], INK_ID), "Ink Blocks läuft neben Tandem");
		// Notiz mit Schreibfläche bei Alice
		await a.evaluate(async () => {
			const f = await app.vault.create("Mitschrift.md", "# Mitschrift\n\nText davor\n\n");
			await app.workspace.getLeaf().openFile(f, { state: { mode: "source", source: false } });
		});
		await a.sleep(800);
		await a.evaluate(() => {
			app.workspace.activeEditor.editor.setCursor({ line: 3, ch: 0 });
			app.commands.executeCommandById("obsidian-ink-blocks:insert-notebook");
		});
		await waitFor(() => surfaceRect(a), { what: "Schreibfläche bei Alice" });
		const ra = await surfaceRect(a);
		await a.draw(word(ra, 40, 60), { pointerType: "pen" });
		await waitFor(async () => (await strokeIds(a))?.length === 1, { what: "Strich bei Alice" });
		const inkPath = await a.evaluate((sel) => document.querySelector(sel).dataset.path, ".markdown-source-view .ink-surface");
		check(inkPath.endsWith(".ink"), `Ink-Datei ${inkPath}`);

		// Bob öffnet dieselbe Notiz
		await waitFor(async () => (await inkFileText(b, inkPath))?.includes('"strokes"'), { what: ".ink bei Bob" });
		await openFile(b, "Mitschrift.md");
		await b.evaluate(() => app.workspace.activeEditor && app.workspace.getLeaf().setViewState({ type: "markdown", state: { file: "Mitschrift.md", mode: "source", source: false } }));
		await waitFor(() => surfaceRect(b), { what: "Schreibfläche bei Bob" });
		await waitFor(async () => (await strokeIds(b))?.length === 1, { what: "Alices Strich bei Bob" });
		check(true, "Strich erscheint bei Bob (Stufe A: nach dem Absetzen)");

		// Weiterer Strich bei Alice → Latenz messen
		const t0 = Date.now();
		await a.draw(word(ra, 40, 120), { pointerType: "pen" });
		await waitFor(async () => (await strokeIds(b))?.length === 2, { interval: 50, what: "zweiter Strich bei Bob" });
		console.log(`    Strich A→B nach dem Absetzen: ${Date.now() - t0} ms`);

		// Gleichzeitig zeichnen
		const rb = await surfaceRect(b);
		await Promise.all([a.draw(word(ra, 300, 60), { pointerType: "pen" }), b.draw(word(rb, 500, 120), { pointerType: "pen" })]);
		await waitFor(async () => (await strokeIds(a))?.length === 4 && (await strokeIds(b))?.length === 4, { timeout: 15000, what: "4 Striche auf beiden Seiten" });
		check(JSON.stringify(await strokeIds(a)) === JSON.stringify(await strokeIds(b)), "gleichzeitiges Zeichnen: beide Striche überall");
		await idle(a);
		await idle(b);
		await waitFor(async () => (await inkFileText(a, inkPath)) === (await inkFileText(b, inkPath)), { what: ".ink-Dateien identisch" });
		check(true, ".ink-Dateien byte-identisch");

		// Radieren bei Bob: ganzen Strich löschen über die Ink-Blocks-API (Undo-fähiger Weg wie der Radierer)
		const victim = (await strokeIds(b))[0];
		await b.evaluate(([id, sid]) => {
			const el = document.querySelector(".markdown-source-view .ink-surface");
			const store = app.plugins.plugins[id].store;
			const e = store.entries.get(el.dataset.path);
			e.doc.strokes = e.doc.strokes.filter((s) => s.id !== sid);
			e.dirty = true;
			e.save();
		}, [INK_ID, victim]);
		await waitFor(async () => (await strokeIds(a))?.length === 3 && !(await strokeIds(a)).includes(victim), { what: "Radieren bei Alice" });
		check(true, "Radieren wird übertragen");
		await a.screenshot("m06-alice.png");
		const md = await a.evaluate(async () => app.vault.read(app.vault.getFileByPath("Mitschrift.md")));
		check((md.match(/```ink/g) ?? []).length === 1, "genau ein ink-Block in der Notiz");

		const errs = [a, b].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
