// M23: Blame in Ink Blocks – Striche in der Farbe der Person, Legende, Name beim Überfahren.
// Braucht Ink Blocks mit `api.setBlame` (INK_BLOCKS_DIR auf einen solchen Build zeigen lassen).
import { check, client, idle, startServer, waitFor } from "../lib.mjs";
import { inkPlugin, strokeIds, surfaceRect, word } from "../lib-ink.mjs";

async function draw(h, pts) {
	const ev = (type, [x, y, p = 0.6], extra = {}) => h.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: p, ...extra });
	await ev("mouseMoved", pts[0], { button: "none", buttons: 0 });
	await ev("mousePressed", pts[0]);
	for (const p of pts.slice(1)) {
		await ev("mouseMoved", p);
		await h.sleep(10);
	}
	await ev("mouseReleased", pts.at(-1), { buttons: 0 });
}

const view = (h) =>
	h.evaluate(() => {
		const s = document.querySelector(".markdown-source-view .ink-surface");
		if (!s) return null;
		return {
			groups: [...s.querySelectorAll(".ink-blame-author")].map((g) => ({ color: g.getAttribute("fill"), n: g.childElementCount })),
			chips: [...s.querySelectorAll(".ink-blame-chip")].map((c) => c.textContent),
			tip: getComputedStyle(s.querySelector(".ink-blame-tip") ?? s).display !== "none" ? s.querySelector(".ink-blame-tip")?.textContent : null,
		};
	});

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { device: "Laptop", extraPlugins: [inkPlugin()] });
	const b = await client(server, "bob", { device: "Tablet", extraPlugins: [inkPlugin()] });
	try {
		for (const h of [a, b]) await waitFor(() => h.evaluate(() => app.plugins.plugins.tandem.ink?.stage === "B"), { what: `${h.user}: Stufe B` });
		const hasApi = await a.evaluate(() => typeof app.plugins.plugins["obsidian-ink-blocks"].api.setBlame === "function");
		check(hasApi, "Ink Blocks bietet setBlame an");

		await a.evaluate(async () => {
			const f = await app.vault.create("Skizze.md", "# Skizze\n\nText davor\n\n");
			await app.workspace.getLeaf().openFile(f, { state: { mode: "source", source: false } });
		});
		await a.sleep(600);
		await a.evaluate(() => {
			app.workspace.activeEditor.editor.setCursor({ line: 3, ch: 0 });
			app.commands.executeCommandById("obsidian-ink-blocks:insert-notebook");
		});
		await waitFor(() => surfaceRect(a), { what: "Fläche bei Alice" });
		const ra = await surfaceRect(a);
		await draw(a, word(ra, 60, 80, 24));
		await idle(a);
		await waitFor(() => b.evaluate(() => app.vault.getFiles().some((f) => f.extension === "ink")), { what: ".ink bei Bob" });
		await b.evaluate(async () => {
			await app.workspace.getLeaf().openFile(app.vault.getFileByPath("Skizze.md"), { state: { mode: "source", source: false } });
		});
		await waitFor(() => surfaceRect(b), { what: "Fläche bei Bob" });
		await waitFor(async () => (await strokeIds(b))?.length === 1, { what: "Alices Strich bei Bob" });
		const rb = await surfaceRect(b);
		await draw(b, word(rb, 320, 140, 24));
		await waitFor(async () => (await strokeIds(a))?.length === 2, { what: "Bobs Strich bei Alice" });

		await a.evaluate(() => app.plugins.plugins.tandem.setBlame(true));
		await waitFor(async () => (await view(a))?.groups.length === 2, { timeout: 20000, what: "zwei Personen-Ebenen" });
		const v = await view(a);
		check(v.groups.every((g) => g.n === 1), `je ein Strich pro Person eingefärbt (${v.groups.map((g) => g.color).join(", ")})`);
		check(v.chips.some((c) => c.startsWith("Du")) && v.chips.some((c) => c.startsWith("Bob")), `Legende: ${v.chips.join(" | ")}`);

		// Überfahren von Bobs Strich (ohne zu zeichnen)
		const p = word(ra, 320, 140, 24)[10];
		await a.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p[0], y: p[1], button: "none", buttons: 0, pointerType: "mouse" });
		await waitFor(async () => (await view(a))?.tip?.includes("Bob"), { what: "Schild beim Überfahren" });
		const tip = (await view(a)).tip;
		check(tip.includes("Tablet"), `Schild: „${tip}“`);
		await a.screenshot("m23-blame-ink.png");

		// Neuer Strich von Bob → kommt live in die Anzeige
		await draw(b, word(rb, 120, 220, 18));
		await waitFor(async () => (await view(a))?.groups.find((g) => g.n === 2), { what: "zweiter Bob-Strich eingefärbt" });
		check(true, "neue Striche erscheinen live in der Anzeige");

		await a.evaluate(() => app.plugins.plugins.tandem.setBlame(false));
		await waitFor(async () => (await view(a))?.groups.length === 0, { what: "aus" });
		check(true, "Ausschalten entfernt die Einfärbung");
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
