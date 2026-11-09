// M21: Gelöschter Anhang, den eine Notiz noch verwendet (Ink-Hintergrund im Codeblock, den Obsidian nicht als Link
// sieht) → Hinweis auf allen Geräten mit „Wiederherstellen“. Unbenutzte Anhänge und ganze Ordner: kein Hinweis.
import { check, client, idle, sleep, startServer, waitFor } from "../lib.mjs";

const putBin = (h, path, seed) =>
	h.evaluate(
		async (path, seed) => {
			const b = new Uint8Array(4000).map((_, i) => (i * seed) & 0xff);
			const dir = path.split("/").slice(0, -1).join("/");
			if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
			await app.vault.createBinary(path, b.buffer);
		},
		path,
		seed,
	);
const put = (h, path, text) =>
	h.evaluate(
		async (path, text) => {
			const dir = path.split("/").slice(0, -1).join("/");
			if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
			await app.vault.create(path, text);
		},
		path,
		text,
	);
const exists = (h, path) => h.evaluate((p) => !!app.vault.getAbstractFileByPath(p), path);
const trash = (h, path) => h.evaluate((p) => app.fileManager.trashFile(app.vault.getAbstractFileByPath(p)), path);
const notices = (h) => h.evaluate(() => [...document.querySelectorAll(".notice")].map((n) => n.textContent));
const warnings = async (h) => (await notices(h)).filter((t) => t.includes("noch verwendet"));
const clearNotices = (h) => h.evaluate(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice");
	const b = await client(server, "bob");
	try {
		await putBin(a, "WBL/Screenshot 1.jpg", 3);
		await put(a, "WBL/BAB.md", '# BAB\n\n```ink\nfile: _ink/x.ink\nbg: "[[Screenshot 1.jpg]]"\n```\n');
		await putBin(a, "Unbenutzt.png", 5);
		await putBin(a, "Alt/Bild.png", 7);
		await put(a, "Alt/Notiz.md", "![[Bild.png]]\n");
		for (const p of ["WBL/Screenshot 1.jpg", "WBL/BAB.md", "Unbenutzt.png", "Alt/Bild.png", "Alt/Notiz.md"])
			await waitFor(() => exists(b, p), { timeout: 20000, what: `${p} bei Bob` });
		await idle(a);
		await idle(b);

		// 1. Bob löscht das Hintergrundbild
		await trash(b, "WBL/Screenshot 1.jpg");
		await waitFor(async () => !(await exists(a, "WBL/Screenshot 1.jpg")), { what: "Löschung bei Alice" });
		await waitFor(async () => (await warnings(a)).length === 1, { timeout: 10000, what: "Hinweis bei Alice" });
		const wa = (await warnings(a))[0];
		check(wa.includes("Screenshot 1.jpg") && wa.includes("bob") && wa.includes("BAB"), `Hinweis bei Alice: ${wa}`);
		await waitFor(async () => (await warnings(b)).length === 1, { timeout: 10000, what: "Hinweis bei Bob" });
		check((await warnings(b))[0].includes("Hier gelöscht"), "Hinweis auch auf dem löschenden Gerät");

		// 2. Alice stellt wieder her → auf beiden Geräten zurück
		await a.evaluate(() => [...document.querySelectorAll(".notice button")].find((x) => x.textContent.includes("Wiederherstellen")).click());
		await waitFor(async () => (await exists(a, "WBL/Screenshot 1.jpg")) && (await exists(b, "WBL/Screenshot 1.jpg")), {
			timeout: 20000,
			what: "Bild auf beiden Geräten zurück",
		});
		check(true, "Wiederherstellen holt das Bild auf alle Geräte zurück");
		await clearNotices(a);
		await clearNotices(b);

		// 3. Unbenutzter Anhang: kein Hinweis
		await trash(b, "Unbenutzt.png");
		await waitFor(async () => !(await exists(a, "Unbenutzt.png")), { what: "Löschung Unbenutzt.png" });
		// 4. Ganzer Ordner mit Notiz und Bild: kein Hinweis
		await trash(b, "Alt");
		await waitFor(async () => !(await exists(a, "Alt/Bild.png")) && !(await exists(a, "Alt/Notiz.md")), { what: "Ordner gelöscht" });
		await sleep(3500);
		check((await warnings(a)).length === 0 && (await warnings(b)).length === 0, "kein Hinweis bei unbenutzten Anhängen und gelöschten Ordnern");

		const errs = [a, b].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
