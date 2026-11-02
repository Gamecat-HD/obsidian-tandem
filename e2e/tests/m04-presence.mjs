// M4: Präsenz – wer ist wo, wer tippt gerade, Folgen, Abmelden.
import { check, client, cursorTo, idle, isBound, openFile, startServer, type, waitFor } from "../lib.mjs";

const peers = (h) => h.evaluate(() => app.plugins.plugins.tandem.api.peers().map((p) => ({ name: p.user.name, path: p.path, typing: p.typing, device: p.device })));

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { device: "Laptop" });
	const b = await client(server, "bob", { device: "Tablet" });
	const c = await client(server, "carol", { device: "Notebook" });
	try {
		// Lange Notiz zum Scrollen
		await a.evaluate(() => app.vault.create("Lang.md", Array.from({ length: 300 }, (_, i) => `Zeile ${i + 1}: ${"Text ".repeat(8)}`).join("\n")));
		await idle(a);
		await waitFor(() => b.evaluate(() => !!app.vault.getFileByPath("Lang.md")), { what: "Lang.md bei Bob" });

		await openFile(b, "Willkommen.md");
		await openFile(c, "Ordner/Zweite Notiz.md");
		await waitFor(async () => {
			const p = await peers(a);
			return p.find((x) => x.name === "Bob")?.path === "Willkommen.md" && p.find((x) => x.name === "Carol")?.path === "Ordner/Zweite Notiz.md";
		}, { what: "Alice sieht, wer wo ist" });
		check(true, "Alice sieht: Bob in Willkommen.md, Carol in Ordner/Zweite Notiz.md");
		const css = await a.evaluate(() => document.getElementById("tandem-presence-style")?.textContent ?? "");
		check(css.includes('data-path="Willkommen.md"') && css.includes("Zweite") && css.includes("nav-folder"), "Punkte im Dateibaum (auch am eingeklappten Ordner)");
		const bar = await a.evaluate(() => document.querySelectorAll(".tandem-status .tandem-avatar").length);
		check(bar === 2, "zwei Avatare in der Statusleiste");

		// Tippen → „tippt gerade“, danach wieder aus
		await waitFor(() => isBound(b, "Willkommen.md"), { what: "Bob gekoppelt" });
		await cursorTo(b, -1);
		await type(b, " Bob schreibt gerade etwas", 40);
		await waitFor(async () => (await peers(a)).find((x) => x.name === "Bob")?.typing, { what: "Bob tippt (bei Alice)" });
		const statusText = await a.evaluate(() => document.querySelector(".tandem-status")?.textContent ?? "");
		check(statusText.includes("Bob tippt"), `Statusleiste: „${statusText.trim()}“`);
		await a.screenshot("m04-typing.png");
		await waitFor(async () => (await peers(a)).find((x) => x.name === "Bob")?.typing === false, { timeout: 10000, what: "Tipp-Hinweis endet" });
		check(true, "Tipp-Hinweis verschwindet nach dem Tippen");

		// Folgen: Alice folgt Bob
		const bobPeer = await a.evaluate(() => app.plugins.plugins.tandem.presence.peers.find((p) => p.user.name === "Bob"));
		await a.evaluate((p) => app.plugins.plugins.tandem.follow(p), bobPeer);
		await waitFor(() => a.evaluate(() => app.workspace.getActiveFile()?.path === "Willkommen.md"), { what: "Alice springt zu Bobs Notiz" });
		check(true, "Folgen öffnet Bobs Notiz");
		await openFile(b, "Lang.md");
		await waitFor(() => a.evaluate(() => app.workspace.getActiveFile()?.path === "Lang.md"), { what: "Alice folgt in die nächste Notiz" });
		check(true, "Bob wechselt die Notiz → Alice folgt");
		await waitFor(() => isBound(b, "Lang.md"), { what: "Lang gekoppelt" });
		await waitFor(() => isBound(a, "Lang.md"), { what: "Lang gekoppelt bei Alice" });
		await cursorTo(b, 250);
		await type(b, " ← hier", 20);
		await waitFor(
			() =>
				a.evaluate(() => {
					const cm = app.workspace.activeEditor.editor.cm;
					const r = cm.viewport;
					const l1 = cm.state.doc.lineAt(r.from).number;
					const l2 = cm.state.doc.lineAt(r.to).number;
					return l1 <= 251 && 251 <= l2 && l1 > 100;
				}),
			{ timeout: 8000, what: "Alice scrollt zu Bobs Cursor (Zeile 251)" },
		);
		check(true, "Alice scrollt mit Bobs Cursor mit");
		await a.key("Escape", { code: "Escape" });
		check(await a.evaluate(() => app.plugins.plugins.tandem.following === null), "Esc beendet das Folgen");

		// Carol geht offline → verschwindet sofort aus der Liste
		await c.close();
		await waitFor(async () => !(await peers(a)).some((x) => x.name === "Carol"), { timeout: 5000, what: "Carol verschwindet" });
		check(true, "Abmelden wird sofort angezeigt");

		const errs = [a, b].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await c.close().catch(() => {});
		await server.close();
	}
}
