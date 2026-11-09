// M22: Blame – wer hat welche Zeile zuletzt geändert (Spalte im Editor, Datei von außen, beide Seiten gleich).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, client, cursorTo, editorText, idle, isBound, openFile, readFile, startServer, type, waitFor } from "../lib.mjs";

const blame = (h, p) => h.evaluate((p) => app.plugins.plugins.tandem.api.blame(p), p);
const gutter = (h) =>
	h.evaluate(() =>
		[...document.querySelectorAll(".workspace-leaf.mod-active .cm-gutter.tandem-blame .tandem-blame-line:not(.tandem-blame-spacer)")].map((e) => ({
			text: e.textContent,
			title: e.title,
			first: e.classList.contains("is-first"),
		})),
	);

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { device: "Laptop" });
	const b = await client(server, "bob", { device: "Tablet" });
	try {
		const P = "Blame.md";
		await a.evaluate((p) => app.vault.create(p, ""), P);
		await idle(a);
		await waitFor(() => b.evaluate((p) => !!app.vault.getFileByPath(p), P), { what: "Datei bei Bob" });
		await openFile(a, P);
		await openFile(b, P);
		await waitFor(() => isBound(a, P), { what: "Alice gekoppelt" });
		await waitFor(() => isBound(b, P), { what: "Bob gekoppelt" });

		await cursorTo(a, 0, 0);
		await type(a, "# Einkaufsliste\nÄpfel von Alice\n");
		await waitFor(async () => (await editorText(b)).includes("Äpfel von Alice"), { what: "Alices Text bei Bob" });
		await cursorTo(b, -1);
		await type(b, "Birnen von Bob");
		await waitFor(async () => (await editorText(a)).includes("Birnen von Bob"), { what: "Bobs Text bei Alice" });

		await waitFor(async () => (await blame(a, P))?.length === 3, { what: "Blame bei Alice" });
		const ra = await blame(a, P);
		const rb = await blame(b, P);
		check(ra[0].name === "Alice" && ra[1].name === "Alice" && ra[2].name === "Bob", `Zeilen richtig zugeordnet: ${ra.map((r) => r.name).join(", ")}`);
		check(ra[0].device === "Laptop" && ra[2].device === "Tablet", "Gerät wird mitgeführt");
		check(ra.every((r) => typeof r.ts === "number" && Date.now() - r.ts < 120000), "Zeitpunkt bekannt");
		await waitFor(async () => JSON.stringify((await blame(b, P)).map((r) => r.name)) === JSON.stringify(ra.map((r) => r.name)), { what: "Bob sieht dasselbe" });
		check(true, "beide Seiten sehen dieselbe Zuordnung");
		void rb;

		// Bob ergänzt Alices Zeile → letzte Änderung gewinnt, Alice bleibt Beteiligte
		await cursorTo(b, 1);
		await b.evaluate(() => {
			const e = app.workspace.activeEditor.editor;
			e.setCursor({ line: 1, ch: e.getLine(1).length });
		});
		await type(b, " und Bob");
		await waitFor(async () => (await blame(a, P))?.[1]?.name === "Bob", { what: "Zeile 2 jetzt Bob" });
		check((await blame(a, P))[1].others.includes("Alice"), "Alice als weitere Beteiligte genannt");

		// Datei von außen (wie Claude Code), während sie bei Alice geschlossen ist. (Ist sie offen, lädt Obsidian die
		// Änderung selbst in den Editor – dann zählt sie wie Tippen.)
		await idle(a);
		await openFile(a, "Willkommen.md");
		await waitFor(async () => !(await isBound(a, P)), { what: "Blame.md bei Alice zu" });
		const disk = (await readFile(a, P)) + "\nVon Claude Code";
		await writeFile(join(a.vault, P), disk);
		await waitFor(async () => (await editorText(b)).includes("Von Claude Code"), { what: "externe Zeile bei Bob" });
		await waitFor(async () => (await blame(b, P))?.some((r) => r.src === 1), { what: "Datei-Herkunft" });
		const ext = (await blame(b, P)).find((r) => r.src === 1);
		check(ext.name === "Alice", `Externe Änderung Alices Gerät zugeordnet, als „Datei“ markiert (Zeile ${ext.line})`);
		await openFile(a, P);
		await waitFor(() => isBound(a, P), { what: "Alice wieder gekoppelt" });

		// Spalte im Editor einschalten
		await a.evaluate(() => app.plugins.plugins.tandem.setBlame(true));
		await waitFor(async () => (await gutter(a)).some((g) => g.text.startsWith("Bob")), { what: "Blame-Spalte zeigt Bob" });
		const g = await gutter(a);
		check(g.some((x) => x.text.startsWith("Alice") && x.first), `Spalte: ${g.map((x) => x.text.trim() || "│").join(" / ")}`);
		check(g.some((x) => x.title.includes("Tablet")), "Tooltip nennt das Gerät");
		check(g.some((x) => x.title.includes("Datei von außen")), "Tooltip nennt Datei-Herkunft");
		await a.screenshot("m22-blame.png");

		// Live: neue Zeile von Bob erscheint in Alices Spalte
		await cursorTo(b, -1);
		await type(b, "\nNoch was von Bob");
		await waitFor(async () => (await gutter(a)).filter((x) => x.text.startsWith("Bob") || (!x.first && x.text.trim() === "")).length >= 2, { what: "Live-Aktualisierung" });
		check(true, "Spalte aktualisiert sich live");

		await a.evaluate(() => app.plugins.plugins.tandem.setBlame(false));
		await waitFor(async () => (await gutter(a)).length === 0, { what: "Spalte aus" });
		check(true, "Ausschalten entfernt die Spalte");
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
