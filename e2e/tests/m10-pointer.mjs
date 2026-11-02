// Stift-/Mausposition anderer auf Schreibflächen: schwebender Stift (Ring), schreibend (gefüllt), Verlassen.
import { check, client, idle, startServer, waitFor } from "../lib.mjs";
import { inkPlugin, surfaceRect, word } from "../lib-ink.mjs";

const remotePtr = (h) =>
	h.evaluate(() => {
		const g = document.querySelector(".markdown-source-view .ink-remote-pointer");
		if (!g) return null;
		const c = g.querySelector("circle");
		return { label: g.querySelector("text")?.textContent, x: +c.getAttribute("cx"), y: +c.getAttribute("cy"), fill: c.getAttribute("fill") };
	});
const toDoc = (h, cx, cy) =>
	h.evaluate(([cx, cy]) => {
		const el = document.querySelector(".markdown-source-view .ink-surface");
		const r = el.getBoundingClientRect();
		const s = r.width / 1000; // Heft-Modus: 1000 Doc-Einheiten breit (ohne Rahmen ungefähr)
		return { x: (cx - r.left) / s, y: (cy - r.top) / s };
	}, [cx, cy]);

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { extraPlugins: [inkPlugin()] });
	const b = await client(server, "bob", { extraPlugins: [inkPlugin()] });
	try {
		await a.evaluate(async () => {
			const f = await app.vault.create("Zeiger.md", "# Zeiger\n\nText davor\n\n");
			await app.workspace.getLeaf().openFile(f, { state: { mode: "source", source: false } });
		});
		await a.sleep(600);
		await a.evaluate(() => {
			app.workspace.activeEditor.editor.setCursor({ line: 3, ch: 0 });
			app.commands.executeCommandById("obsidian-ink-blocks:insert-notebook");
		});
		await waitFor(() => surfaceRect(a), { what: "Fläche bei Alice" });
		await idle(a);
		await waitFor(() => b.evaluate(() => !!app.vault.getFileByPath("Zeiger.md") && app.vault.getFiles().some((f) => f.extension === "ink")), { what: "Dateien bei Bob" });
		await b.evaluate(() => app.workspace.getLeaf().openFile(app.vault.getFileByPath("Zeiger.md"), { state: { mode: "source", source: false } }));
		await waitFor(() => surfaceRect(b), { what: "Fläche bei Bob" });
		await waitFor(() => b.evaluate(() => app.plugins.plugins.tandem.ink?.stage === "B"), { what: "Stufe B" });
		const ra = await surfaceRect(a);

		// 1. Stift schwebt über der Fläche (kein Kontakt)
		const hover = async (x, y) => a.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "pen" });
		for (let i = 0; i < 10; i++) {
			await hover(ra.x + 200 + i * 20, ra.y + 150);
			await a.sleep(30);
		}
		const t0 = Date.now();
		await waitFor(async () => (await remotePtr(b))?.label === "Alice", { interval: 20, what: "Alices Stift bei Bob" });
		const p = await remotePtr(b);
		const want = await toDoc(a, ra.x + 200 + 9 * 20, ra.y + 150);
		await waitFor(async () => {
			const q = await remotePtr(b);
			return q && Math.abs(q.x - want.x) < 12 && Math.abs(q.y - want.y) < 12;
		}, { what: "Position stimmt" });
		check(p.fill === "none", "schwebender Stift: Ring mit Namen „Alice“ an der richtigen Stelle");
		console.log(`    Zeiger sichtbar ~${Date.now() - t0} ms nach der letzten Bewegung`);
		await b.screenshot("m10-hover.png");

		// 2. Beim Schreiben: gefüllter Punkt folgt dem Stift
		const pts = word(ra, 300, 220, 20);
		await a.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pts[0][0], y: pts[0][1], button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: 0.6 });
		for (const q of pts.slice(1, 12)) {
			await a.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: q[0], y: q[1], button: "left", buttons: 1, pointerType: "pen", force: 0.6 });
			await a.sleep(15);
		}
		await waitFor(async () => (await remotePtr(b))?.fill !== "none", { what: "gefüllter Punkt beim Schreiben" });
		check(true, "schreibender Stift: gefüllter Punkt");
		await a.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pts[11][0], y: pts[11][1], button: "left", buttons: 0, pointerType: "pen" });

		// 3. Stift verlässt die Fläche → Zeiger verschwindet
		await hover(ra.x + ra.w / 2, ra.y - 120);
		await waitFor(async () => (await remotePtr(b)) === null, { timeout: 5000, what: "Zeiger weg" });
		check(true, "Verlassen der Fläche entfernt den Zeiger");

		// 4. Maus zeigt ebenfalls (gefüllter Punkt)
		await a.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ra.x + 100, y: ra.y + 100, button: "none", buttons: 0, pointerType: "mouse" });
		await a.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ra.x + 110, y: ra.y + 105, button: "none", buttons: 0, pointerType: "mouse" });
		await waitFor(async () => (await remotePtr(b))?.label === "Alice", { what: "Mauszeiger" });
		check(true, "Mauszeiger wird ebenfalls angezeigt");

		// 5. Alice geht offline → weg
		await a.close();
		await waitFor(async () => (await remotePtr(b)) === null, { timeout: 8000, what: "Zeiger nach Trennung weg" });
		check(true, "Zeiger verschwindet, wenn die Person offline geht");
		const errs = b.logs.filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close().catch(() => {});
		await b.close();
		await server.close();
	}
}
