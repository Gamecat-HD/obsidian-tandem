// M8: Ablösung von LiveSync – Sicherung vor dem ersten Abgleich, Schutz vor gleichzeitigem LiveSync,
// Versionsgeschichte mit Wiederherstellen.
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { check, client, editorText, idle, isBound, openFile, readFile, startServer, status, waitFor } from "../lib.mjs";

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice");
	const handles = [a];
	try {
		// 1. Sicherung vor dem ersten Abgleich
		const siblings = await readdir(dirname(a.vault));
		const backup = siblings.find((n) => n.startsWith("vault.tandem-sicherung-"));
		check(!!backup, `Vault vor dem ersten Abgleich gesichert (${backup})`);
		const copied = await readdir(join(dirname(a.vault), backup));
		check(copied.includes("Willkommen.md") && copied.includes(".obsidian"), "Sicherung enthält Notizen und .obsidian");

		// 2. LiveSync aktiv → Tandem startet nicht
		const l = await client(server, "bob", { extraPlugins: [{ id: "obsidian-livesync", dir: join(import.meta.dirname, "../fake-livesync") }], expectOnline: false });
		handles.push(l);
		await l.sleep(1000);
		check((await status(l)) !== "online", "mit aktivem LiveSync bleibt Tandem aus");
		const txt = await l.evaluate(() => document.querySelector(".tandem-status")?.textContent ?? "");
		check(txt.includes("LiveSync"), `Statusleiste erklärt warum: „${txt.trim()}“`);

		// 3. Versionsgeschichte: Snapshot entsteht beim Entladen, Wiederherstellen als normale Änderung
		await openFile(a, "Willkommen.md");
		await waitFor(() => isBound(a, "Willkommen.md"), { what: "gekoppelt" });
		const v1 = await editorText(a);
		await idle(a);
		// Notiz schließen → Server entlädt nach 30 s und legt einen Snapshot an
		await a.evaluate(() => app.workspace.getLeaf().openFile(app.vault.getFileByPath("Ordner/Zweite Notiz.md")));
		const id = await a.evaluate(() => app.plugins.plugins.tandem.sync.index.idForPath("Willkommen.md"));
		const snaps = await waitFor(
			async () => {
				const list = await a.evaluate((id) => app.plugins.plugins.tandem.api.history(id), id);
				return list.length ? list : null;
			},
			{ timeout: 60000, interval: 2000, what: "Snapshot auf dem Server" },
		);
		check(snaps.length >= 1, `Snapshot vorhanden (${snaps.length})`);
		// Jetzt kaputt machen
		await openFile(a, "Willkommen.md");
		await waitFor(() => isBound(a, "Willkommen.md"), { what: "wieder gekoppelt" });
		await a.evaluate(() => app.workspace.activeEditor.editor.setValue("versehentlich alles gelöscht\n"));
		await idle(a);
		await a.evaluate(() => app.commands.executeCommandById("tandem:history"));
		await waitFor(() => a.evaluate(() => document.querySelectorAll(".tandem-history .setting-item").length > 0), { what: "Liste der Fassungen" });
		await a.screenshot("m08-history.png");
		await a.evaluate(() => [...document.querySelectorAll(".tandem-history button")].find((b) => b.textContent === "Wiederherstellen").click());
		await waitFor(async () => (await editorText(a)) === v1, { what: "wiederhergestellt im Editor" });
		check(true, "Fassung wiederhergestellt (live im Editor)");
		await waitFor(async () => (await readFile(a, "Willkommen.md")) === v1, { what: "auf der Platte" });
		check(true, "wiederhergestellte Fassung auf der Platte");
		await a.evaluate(() => app.workspace.activeEditor.editor.undo());
		await a.sleep(300);
		check((await editorText(a)).includes("versehentlich"), "Wiederherstellen lässt sich rückgängig machen");
		const errs = handles.flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		for (const h of handles) await h.close();
		await server.close();
	}
}
