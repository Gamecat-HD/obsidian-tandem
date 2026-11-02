// M0-Spike: zwei Obsidian-Instanzen tippen gleichzeitig in derselben Notiz.
import { check, client, cursorTo, editorText, idle, openFile, readFile, startServer, type, waitFor } from "../lib.mjs";

export default async function () {
	const server = await startServer();
	const a = await client(server, "alice");
	const b = await client(server, "bob");
	try {
		const N = "Willkommen.md";
		const orig = await readFile(a, N);
		await idle(a);
		await idle(b);
		check((await readFile(b, N)) === orig, "Erstimport: Inhalt nicht verdoppelt");

		await openFile(a, N);
		await openFile(b, N);
		await waitFor(() => a.evaluate((p) => app.plugins.plugins.tandem.sync.binder.isBound(p), N), { what: "A gekoppelt" });
		await waitFor(() => b.evaluate((p) => app.plugins.plugins.tandem.sync.binder.isBound(p), N), { what: "B gekoppelt" });

		// A tippt am Ende, B gleichzeitig in Zeile 0
		await cursorTo(a, -1);
		await cursorTo(b, 0);
		const t0 = Date.now();
		await Promise.all([type(a, "\nHallo von Alice"), type(b, " (Bob war hier)")]);
		const want = (t) => t.includes("Hallo von Alice") && t.includes("(Bob war hier)");
		await waitFor(async () => want(await editorText(a)) && want(await editorText(b)), { what: "beide Änderungen in beiden Editoren" });
		console.log(`    gleichzeitiges Tippen zusammengeführt nach ${Date.now() - t0} ms`);
		check((await editorText(a)) === (await editorText(b)), "Editoren identisch");

		// Latenz eines einzelnen Zeichens
		await cursorTo(a, -1);
		const t1 = Date.now();
		await type(a, "§", 0);
		await waitFor(async () => (await editorText(b)).includes("§"), { interval: 5, what: "Zeichen bei B" });
		console.log(`    Latenz eines Tastendrucks A→B: ${Date.now() - t1} ms`);

		// Remote-Cursor sichtbar
		await waitFor(() => b.evaluate(() => document.querySelectorAll(".cm-ySelectionCaret").length > 0), { what: "Remote-Cursor bei B" });
		const label = await b.evaluate(() => document.querySelector(".cm-ySelectionInfo")?.textContent);
		check(label === "Alice", `Namensschild „${label}“ bei B`);
		await a.screenshot("m00-a.png");
		await b.screenshot("m00-b.png");

		// Obsidian speichert selbst auf die Platte
		await waitFor(async () => (await readFile(b, N)) === (await editorText(b)), { timeout: 8000, what: "B hat gespeichert" });
		check(true, "Datei bei B auf der Platte aktuell");

		// Undo bei B macht nur Bobs Änderung rückgängig
		await b.evaluate(() => app.workspace.activeEditor.editor.undo());
		await a.sleep(400);
		const afterUndo = await editorText(a);
		check(afterUndo.includes("Hallo von Alice") && !afterUndo.includes("(Bob war hier)"), "Undo bei B entfernt nur Bobs Text (auch bei A)");

		// Dateiwechsel im selben Tab darf die vorige Notiz nicht überschreiben
		const before = await editorText(a);
		await openFile(b, "Ordner/Zweite Notiz.md");
		await b.sleep(800);
		await openFile(b, N);
		await b.sleep(800);
		check((await editorText(a)) === before, "Tab-Wechsel bei B ändert Willkommen.md nicht");
		check((await readFile(a, "Ordner/Zweite Notiz.md")).includes("Inhalt B."), "Zweite Notiz unverändert");
		const errs = [...a.logs, ...b.logs].filter((l) => /exception|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
