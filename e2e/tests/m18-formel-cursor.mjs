// M18: Cursor in gerenderten Formeln (Live-Vorschau). Der Formel-Block ersetzt den Quelltext; ein fremder
// Cursor darin wäre unsichtbar. Stattdessen wird der ganze Block in der Farbe der Person umrahmt.
import { check, client, cursorTo, idle, isBound, openFile, startServer, waitFor } from "../lib.mjs";

const NOTE = "Mathe.md";
const TEXT = "Text oben\n\n$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\nInline $x^2 + y$ hier\n\nEnde";

/** Liegt ein Rahmen mit Alice' Namen genau um das Element `sel`? */
const boxAround = (h, sel) =>
	h.evaluate((sel) => {
		const box = document.querySelector(".tandem-widget-cursor");
		const el = document.querySelector(sel);
		if (!box || !el) return false;
		const a = box.getBoundingClientRect();
		const b = el.getBoundingClientRect();
		const near = (x, y) => Math.abs(x - y) <= 3;
		const names = [...box.querySelectorAll(".tandem-widget-cursor-name")].map((n) => n.textContent);
		return near(a.left, b.left) && near(a.top, b.top) && near(a.width, b.width) && near(a.height, b.height) && names.join() === "Alice";
	}, sel);

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice");
	const b = await client(server, "bob");
	try {
		await a.evaluate((p, t) => app.vault.create(p, t), NOTE, TEXT);
		await idle(a);
		await waitFor(() => b.evaluate((p) => !!app.vault.getFileByPath(p), NOTE), { what: "Notiz bei Bob" });
		await openFile(a, NOTE);
		await openFile(b, NOTE);
		await waitFor(async () => (await isBound(a, NOTE)) && (await isBound(b, NOTE)), { what: "beide gekoppelt" });
		await waitFor(() => b.evaluate(() => document.querySelectorAll(".math mjx-container").length === 2), { timeout: 20000, what: "Formeln gerendert (MathJax)" });
		check(true, "Formel-Block bei Bob gerendert");

		await cursorTo(a, 4, 2);
		await waitFor(() => boxAround(b, ".math-block"), { what: "Rahmen um den Formel-Block" });
		check(true, "Cursor mitten in der Formel: Block in Alice' Farbe umrahmt, mit Namen");
		await b.screenshot("m18-formel.png");

		await cursorTo(a, 2, 0);
		await waitFor(() => boxAround(b, ".math-block"), { what: "Rahmen bei Cursor auf $$" });
		check(true, "auch am Rand ($$) umrahmt");

		await cursorTo(a, 9, 10);
		await waitFor(() => boxAround(b, ".math:not(.math-block)"), { what: "Rahmen um die Inline-Formel" });
		check(await b.evaluate(() => document.querySelectorAll(".tandem-widget-cursor").length === 1), "Inline-Formel umrahmt, Block nicht mehr");

		await cursorTo(a, 11, 0);
		await waitFor(() => b.evaluate(() => !document.querySelector(".tandem-widget-cursor")), { what: "Rahmen weg" });
		check(await b.evaluate(() => document.querySelector(".cm-ySelectionInfo")?.textContent === "Alice"), "außerhalb der Formel wieder normaler Cursor");

		const errs = [a, b].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
