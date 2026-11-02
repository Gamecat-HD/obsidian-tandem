// M7: Ink Blocks Stufe B – man sieht live, wie jemand schreibt (Geister-Strich mit Namen), der fertige Strich
// ersetzt den Geist ohne Verzögerung, Undo bleibt erhalten, wenn andere nur zeichnen.
import { check, client, idle, startServer, waitFor } from "../lib.mjs";
import { INK_ID, inkPlugin, strokeIds, surfaceRect, word } from "../lib-ink.mjs";

// Namensschild sitzt am Geist oder – wenn ein Zeiger da ist – am Zeiger derselben Person
const remoteGhosts = (h) =>
	h.evaluate(() =>
		[...document.querySelectorAll(".markdown-source-view .ink-remote-stroke")].map((g) => ({
			stroke: g.dataset.stroke,
			label:
				g.querySelector("text")?.textContent ??
				document.querySelector(`.markdown-source-view .ink-remote-pointer[data-key="${g.dataset.key}"] text`)?.textContent ??
				"",
		})),
	);

/** Strich in Einzelschritten zeichnen (pointerdown … pointermove …), ohne abzusetzen. */
async function penDown(h, pts) {
	const ev = (type, [x, y, p = 0.6], extra = {}) => h.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: p, ...extra });
	await ev("mouseMoved", pts[0], { button: "none", buttons: 0 });
	await ev("mousePressed", pts[0]);
	for (const p of pts.slice(1)) {
		await ev("mouseMoved", p);
		await h.sleep(12);
	}
	return () => ev("mouseReleased", pts.at(-1), { buttons: 0 });
}

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { extraPlugins: [inkPlugin()] });
	const b = await client(server, "bob", { extraPlugins: [inkPlugin()] });
	try {
		for (const h of [a, b]) {
			await waitFor(() => h.evaluate(() => app.plugins.plugins.tandem.ink?.stage === "B"), { what: `${h.user}: Stufe B` });
		}
		check(true, "beide erkennen die Ink-Blocks-Schnittstelle (Stufe B)");

		await a.evaluate(async () => {
			const f = await app.vault.create("Tafel.md", "# Tafel\n\nText davor\n\n");
			await app.workspace.getLeaf().openFile(f, { state: { mode: "source", source: false } });
		});
		await a.sleep(600);
		await a.evaluate(() => {
			app.workspace.activeEditor.editor.setCursor({ line: 3, ch: 0 });
			app.commands.executeCommandById("obsidian-ink-blocks:insert-notebook");
		});
		await waitFor(() => surfaceRect(a), { what: "Fläche bei Alice" });
		await idle(a);
		await waitFor(() => b.evaluate(() => !!app.vault.getFileByPath("Tafel.md") && app.vault.getFiles().some((f) => f.extension === "ink")), { what: "Dateien bei Bob" });
		await b.evaluate(async () => {
			await app.workspace.getLeaf().openFile(app.vault.getFileByPath("Tafel.md"), { state: { mode: "source", source: false } });
		});
		await waitFor(() => surfaceRect(b), { what: "Fläche bei Bob" });
		const ra = await surfaceRect(a);

		// Alice setzt den Stift auf und zieht – noch NICHT abgesetzt
		const t0 = Date.now();
		const lift = await penDown(a, word(ra, 60, 80, 30));
		await waitFor(async () => (await remoteGhosts(b)).length === 1, { interval: 20, what: "Geist bei Bob während des Zeichnens" });
		const tGhost = Date.now() - t0;
		const g = (await remoteGhosts(b))[0];
		check(g.label === "Alice", `Bob sieht Alices Strich schon während des Schreibens (Namensschild „${g.label}“)`);
		check((await strokeIds(b)).length === 0, "noch kein fertiger Strich bei Bob");
		console.log(`    Geist sichtbar ${tGhost} ms nach Strichbeginn (inkl. 30 Zeichenschritten)`);
		const len1 = await b.evaluate(() => document.querySelector(".ink-remote-stroke path")?.getAttribute("d")?.length ?? 0);
		await b.screenshot("m07-bob-ghost.png");

		// Absetzen → fertiger Strich ersetzt den Geist (gleiche ID)
		const t1 = Date.now();
		await lift();
		await waitFor(async () => (await strokeIds(b))?.length === 1, { interval: 20, what: "fertiger Strich bei Bob" });
		console.log(`    fertiger Strich bei Bob ${Date.now() - t1} ms nach dem Absetzen (Stufe A: ~2000 ms)`);
		await waitFor(async () => (await remoteGhosts(b)).length === 0, { what: "Geist verschwindet" });
		check(JSON.stringify(await strokeIds(a)) === JSON.stringify(await strokeIds(b)), "Geist durch den echten Strich (gleiche ID) ersetzt");
		check(len1 > 50, "Geist hatte schon Form (SVG-Pfad)");

		// Beide zeichnen gleichzeitig – jeder sieht den Geist des anderen
		const rb = await surfaceRect(b);
		const liftA = await penDown(a, word(ra, 300, 160, 20));
		const liftB = await penDown(b, word(rb, 600, 160, 20));
		await waitFor(async () => (await remoteGhosts(a)).some((x) => x.label === "Bob") && (await remoteGhosts(b)).some((x) => x.label === "Alice"), { what: "gegenseitige Geister" });
		check(true, "gleichzeitig: jeder sieht den Strich des anderen live");
		await liftA();
		await liftB();
		await waitFor(async () => (await strokeIds(a))?.length === 3 && (await strokeIds(b))?.length === 3, { what: "3 Striche überall" });
		check(true, "beide Striche überall angekommen");

		// Undo bleibt bei Alice erhalten, obwohl Bob gezeichnet hat
		const canUndo = await a.evaluate((id) => {
			const el = document.querySelector(".markdown-source-view .ink-surface");
			return app.plugins.plugins[id].store.entries.get(el.dataset.path).history.canUndo;
		}, INK_ID);
		check(canUndo, "Alices Undo-Verlauf übersteht Bobs Striche");

		// Bob geht offline mitten im Strich → Geist verschwindet bei Alice
		const liftB2 = await penDown(b, word(rb, 100, 250, 15));
		await waitFor(async () => (await remoteGhosts(a)).length === 1, { what: "Geist von Bob" });
		await b.close();
		await waitFor(async () => (await remoteGhosts(a)).length === 0, { timeout: 8000, what: "Geist weg nach Trennung" });
		check(true, "Geist verschwindet, wenn der Zeichnende offline geht");
		void liftB2;

		const errs = [a].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close().catch(() => {});
		await server.close();
	}
}
