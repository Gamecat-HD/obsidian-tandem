// M2: Live-Editor über den echten Rust-Server – Laptop + Tablet, Einladung, Nur-Lesen, Wiederverbinden, Split-Ansicht.
import { check, client, cursorTo, editorText, idle, isBound, openFile, readFile, startServer, status, type, waitFor } from "../lib.mjs";

export default async function () {
	const server = await startServer({ rust: true });
	const N = "Willkommen.md";
	const a = await client(server, "alice", { device: "Laptop" });
	const t = await client(server, "bob", { mobile: true, device: "Tablet" });
	const handles = [a, t];
	try {
		check(await t.evaluate(() => document.body.hasClass("is-mobile")), "Bob arbeitet in der Tablet-Oberfläche");

		// 1. Live zwischen Laptop und Tablet
		await openFile(a, N);
		await openFile(t, N);
		await waitFor(async () => (await isBound(a, N)) && (await isBound(t, N)), { what: "beide gekoppelt" });
		await cursorTo(t, -1);
		await type(t, "\nVom Tablet ✏️");
		await waitFor(async () => (await editorText(a)).includes("Vom Tablet ✏️"), { what: "Tablet → Laptop" });
		check(true, "Tablet-Eingabe erscheint live auf dem Laptop");
		await waitFor(() => a.evaluate(() => document.querySelector(".cm-ySelectionInfo")?.textContent === "Bob"), { what: "Bobs Cursor beim Laptop" });
		check(true, "Cursor des Tablets mit Namen sichtbar");
		const avatars = await a.evaluate(() => [...document.querySelectorAll(".view-header .tandem-avatar")].map((e) => e.getAttribute("aria-label")));
		check(avatars.some((l) => l?.includes("Bob") && l.includes("Tablet")), `Avatar in der Kopfzeile: ${avatars}`);
		await t.screenshot("m02-tablet.png");

		// 2. Einladung einlösen (neues Gerät)
		const code = server.cli("invite", "carol");
		const c = await client(server, "carol", { login: false });
		handles.push(c);
		const name = await c.evaluate(async (code) => {
			const p = app.plugins.plugins.tandem;
			const n = await p.redeem(code);
			await p.restart();
			return n;
		}, code.toLowerCase());
		check(name === "Carol", "Einladungscode eingelöst (auch kleingeschrieben)");
		await waitFor(async () => (await status(c)) === "online", { what: "Carol online" });
		await idle(c);
		check((await readFile(c, N)).includes("Vom Tablet ✏️"), "neues Gerät hat den aktuellen Stand");
		const again = await c.evaluate(async (code) => app.plugins.plugins.tandem.redeem(code).then(() => "ok", (e) => e.message), code);
		check(again !== "ok", `Code nur einmal gültig (${again})`);

		// 3. Nur-Lese-Mitglied: sieht live mit, kann nicht schreiben
		const r = await client(server, "reader");
		handles.push(r);
		await openFile(r, N);
		await waitFor(() => isBound(r, N), { what: "Leser gekoppelt" });
		check(await r.evaluate(() => app.workspace.activeEditor.editor.cm.state.readOnly), "Editor des Lesers ist schreibgeschützt");
		await cursorTo(a, -1);
		await type(a, " +live");
		await waitFor(async () => (await editorText(r)).includes("+live"), { what: "Leser sieht Änderung" });
		check(true, "Leser sieht Änderungen live");
		await r.evaluate(() => app.vault.create("Leser-Notiz.md", "geheim"));
		await r.sleep(1500);
		check((await readFile(a, "Leser-Notiz.md")) === null, "Datei des Lesers wird nicht verteilt");

		// 4. Server weg: beide tippen offline weiter, nach dem Neustart wird zusammengeführt
		await server.stop();
		await waitFor(async () => (await status(a)) !== "online" && (await status(t)) !== "online", { what: "offline erkannt" });
		check(true, "Verbindungsabbruch erkannt");
		await cursorTo(a, 0);
		await type(a, " [offline Laptop]");
		await cursorTo(t, -1);
		await type(t, " [offline Tablet]");
		await server.start();
		await waitFor(async () => (await status(a)) === "online" && (await status(t)) === "online", { timeout: 30000, what: "wieder online" });
		const both = (x) => x.includes("[offline Laptop]") && x.includes("[offline Tablet]");
		await waitFor(async () => both(await editorText(a)) && both(await editorText(t)), { timeout: 15000, what: "Offline-Änderungen zusammengeführt" });
		check((await editorText(a)) === (await editorText(t)), "nach dem Wiederverbinden identisch");

		// 5. Split-Ansicht: dieselbe Notiz zweimal offen
		await a.evaluate(async (p) => {
			const leaf = app.workspace.getLeaf("split");
			await leaf.openFile(app.vault.getFileByPath(p));
		}, N);
		await a.sleep(800);
		const views = await a.evaluate(() => app.workspace.getLeavesOfType("markdown").length);
		check(views === 2, "zwei Ansichten offen");
		await cursorTo(a, -1);
		await type(a, " [split]");
		await waitFor(async () => (await editorText(t)).includes("[split]"), { what: "Split-Änderung beim Tablet" });
		const texts = await a.evaluate(() => app.workspace.getLeavesOfType("markdown").map((l) => l.view.editor.getValue()));
		check(texts[0] === texts[1], "beide Ansichten identisch");
		const count = (await editorText(t)).split("[split]").length - 1;
		check(count === 1, "Änderung nicht doppelt");

		const errs = handles.flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		for (const h of handles) await h.close();
		await server.close();
	}
}
