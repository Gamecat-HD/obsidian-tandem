// M17: Cursor in Tabellen (Live-Vorschau). Obsidian bearbeitet Zellen in einem eigenen, eingebetteten
// Editor; der Cursor muss trotzdem an der Zellenposition ankommen und beim Gegenüber in der Zelle stehen.
import { check, client, cursorTo, editorText, idle, isBound, openFile, startServer, type, waitFor } from "../lib.mjs";

const NOTE = "Tabelle.md";
const TEXT = "Kopfzeile oben\n\n| Name | Wert |\n| --- | --- |\n| eins | zwei |\n| drei | vier |\n\nEnde";

/** Wo steht der Cursor der Person `name` laut Awareness (absolute Position im Dokument)? */
const remoteHead = (h, name) =>
	h.evaluate(
		(name) => app.plugins.plugins.tandem.api.cursors(app.workspace.getActiveFile().path).find((c) => c.name === name)?.head ?? null,
		name,
	);

/** Mitte einer Tabellenzelle mit diesem Text (Viewport-Koordinaten). */
const cellCenter = (h, text) =>
	h.evaluate((text) => {
		const td = [...document.querySelectorAll(".cm-table-widget td, .cm-table-widget th")].find((e) => e.textContent.trim() === text);
		if (!td) return null;
		const r = td.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}, text);

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { device: "Laptop" });
	const b = await client(server, "bob", { device: "Tablet" });
	try {
		await a.evaluate((p, t) => app.vault.create(p, t), NOTE, TEXT);
		await idle(a);
		await waitFor(() => b.evaluate((p) => !!app.vault.getFileByPath(p), NOTE), { what: "Notiz bei Bob" });
		await openFile(a, NOTE);
		await openFile(b, NOTE);
		await waitFor(async () => (await isBound(a, NOTE)) && (await isBound(b, NOTE)), { what: "beide gekoppelt" });
		check(await a.evaluate(() => !!document.querySelector(".cm-table-widget")), "Tabelle als Widget (Live-Vorschau)");

		// Alice steht zuerst in der Kopfzeile …
		await cursorTo(a, 0, 4);
		await waitFor(async () => (await remoteHead(b, "Alice")) === 4, { what: "Alice' Cursor in der Kopfzeile" });
		check(true, "Ausgangsposition kommt an");

		// … klickt dann in die Zelle „vier“ und tippt.
		const c = await cellCenter(a, "vier");
		check(!!c, "Zelle „vier“ gefunden");
		await a.click(c.x, c.y);
		await waitFor(() => a.evaluate(() => !!app.workspace.activeEditor.editor.editorComponent?.tableCell), { what: "Zell-Editor offen" });
		await a.key("End", { code: "End" });
		await type(a, "X");
		await idle(a);
		// Obsidian füllt die Spalten beim Tippen neu auf → Position aus dem echten Text.
		const want = (await editorText(a)).indexOf("vierX") + 5;
		await waitFor(async () => (await remoteHead(b, "Alice")) === want, { what: `Alice' Cursor hinter „vierX“ (${want})` });
		check(true, "Cursor beim Tippen in der Zelle kommt an der Zellenposition an");

		// Nur bewegen, ohne zu tippen
		await a.key("Home", { code: "Home" });
		await waitFor(async () => (await remoteHead(b, "Alice")) === want - 5, { what: "Alice' Cursor am Zellenanfang" });
		check(true, "reine Cursorbewegung in der Zelle kommt an");

		// Bob sieht Alice' Cursor in der Zelle (nicht nur irgendwo neben der Tabelle)
		const inCell = () =>
			b.evaluate(() => {
				const td = [...document.querySelectorAll(".cm-table-widget td")].find((e) => e.textContent.includes("vierX"));
				const caret = document.querySelector(".tandem-table-caret");
				if (!td || !caret) return false;
				const r = td.getBoundingClientRect();
				const k = caret.getBoundingClientRect();
				const label = caret.querySelector(".cm-ySelectionInfo")?.textContent;
				return label === "Alice" && k.left >= r.left - 2 && k.right <= r.right + 2 && k.top >= r.top - 2 && k.bottom <= r.bottom + 2;
			});
		await waitFor(inCell, { what: "Alice' Cursor bei Bob in der Zelle" });
		check(true, "Bob sieht Alice' Cursor in der Zelle");
		await b.screenshot("m17-tabelle.png");

		// Bob bearbeitet selbst dieselbe Zelle → Cursor erscheint im Zell-Editor
		const cb = await cellCenter(b, "vierX");
		await b.click(cb.x, cb.y);
		await waitFor(() => b.evaluate(() => !!app.workspace.activeEditor.editor.editorComponent?.tableCell), { what: "Zell-Editor bei Bob" });
		await b.screenshot("m17-zelle.png");
		await waitFor(inCell, { what: "Alice' Cursor im Zell-Editor bei Bob" });
		check(true, "Cursor auch sichtbar, wenn Bob dieselbe Zelle bearbeitet");
		await b.screenshot("m17-zelle.png");
		check((await editorText(b)) === (await editorText(a)), "Betreten der Zelle ändert nichts am Text");

		// Gleichzeitig in derselben Tabelle tippen: nichts geht verloren
		const cz = await cellCenter(a, "zwei");
		await a.click(cz.x, cz.y);
		await a.key("End", { code: "End" });
		await b.key("End", { code: "End" });
		await Promise.all([type(a, "aaa", 30), type(b, "bbb", 30)]);
		await idle(a);
		await idle(b);
		const both = (t) => t.includes("zweiaaa") && t.includes("vierXbbb");
		await waitFor(async () => both(await editorText(a)) && both(await editorText(b)), { what: "beide Eingaben bei beiden" }).catch(async (e) => {
			throw new Error(`${e.message}\nAlice: ${JSON.stringify(await editorText(a))}\nBob:   ${JSON.stringify(await editorText(b))}`);
		});
		check((await editorText(a)) === (await editorText(b)), "gleichzeitige Eingaben in der Tabelle bleiben bei beiden erhalten");

		// Zurück in normalen Text: Tabellen-Cursor verschwindet, normaler Cursor kommt an
		await cursorTo(a, 7);
		const end = (await editorText(a)).length;
		await waitFor(async () => (await remoteHead(b, "Alice")) === end, { what: "Alice' Cursor am Ende" });
		await waitFor(() => b.evaluate(() => !document.querySelector(".tandem-table-caret")), { what: "Tabellen-Cursor weg" });
		check(true, "Cursor verlässt die Tabelle sauber");

		const errs = [a, b].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
