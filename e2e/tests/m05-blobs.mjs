// M5: Anhänge (PDF/Bilder/Binärdateien) – Hochladen, Ändern, Umbenennen, Löschen, Konfliktkopie, Deduplizierung.
import { check, client, idle, startServer, status, waitFor } from "../lib.mjs";

const putBin = (h, path, seed, size) =>
	h.evaluate(async (path, seed, size) => {
		const b = new Uint8Array(size);
		let x = seed;
		for (let i = 0; i < size; i++) {
			x = (x * 1103515245 + 12345) & 0x7fffffff;
			b[i] = x & 0xff;
		}
		const f = app.vault.getFileByPath(path);
		if (f) await app.vault.modifyBinary(f, b.buffer);
		else {
			const dir = path.split("/").slice(0, -1).join("/");
			if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
			await app.vault.createBinary(path, b.buffer);
		}
	}, path, seed, size);

const hash = (h, path) =>
	h.evaluate(async (p) => {
		const f = app.vault.getFileByPath(p);
		if (!f) return null;
		const d = await crypto.subtle.digest("SHA-256", await app.vault.readBinary(f));
		return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
	}, path);

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice");
	const b = await client(server, "bob");
	try {
		// 1. Neue Anhänge
		await putBin(a, "Anhänge/Arbeitsblatt.pdf", 1, 2_500_000);
		await putBin(a, "Anhänge/Foto.png", 2, 300_000);
		const h1 = await hash(a, "Anhänge/Arbeitsblatt.pdf");
		await waitFor(async () => (await hash(b, "Anhänge/Arbeitsblatt.pdf")) === h1, { timeout: 20000, what: "PDF bei Bob" });
		check(true, "PDF (2,5 MB) kommt bytegenau an");
		await waitFor(async () => (await hash(b, "Anhänge/Foto.png")) === (await hash(a, "Anhänge/Foto.png")), { what: "PNG bei Bob" });
		check(true, "Bild kommt bytegenau an");

		// 2. Ändern
		await putBin(a, "Anhänge/Foto.png", 3, 310_000);
		const h2 = await hash(a, "Anhänge/Foto.png");
		await waitFor(async () => (await hash(b, "Anhänge/Foto.png")) === h2, { what: "geändertes PNG" });
		check(true, "geänderter Anhang wird ersetzt");

		// 3. Umbenennen (Bob → Alice)
		await b.evaluate(() => app.fileManager.renameFile(app.vault.getFileByPath("Anhänge/Foto.png"), "Anhänge/Klassenfoto.png"));
		await waitFor(async () => (await hash(a, "Anhänge/Klassenfoto.png")) === h2 && (await hash(a, "Anhänge/Foto.png")) === null, { what: "Umbenennung bei Alice" });
		check(true, "Umbenennen eines Anhangs");

		// 4. Deduplizierung: gleicher Inhalt unter neuem Namen → kein zweiter Upload
		const before = JSON.parse(server.cli("stats"));
		await putBin(a, "Kopie.pdf", 1, 2_500_000);
		await waitFor(async () => (await hash(b, "Kopie.pdf")) === h1, { what: "Kopie bei Bob" });
		const after = JSON.parse(server.cli("stats"));
		check(after.blob_bytes === before.blob_bytes, `gleicher Inhalt wird nicht doppelt gespeichert (${after.blob_bytes} Bytes)`);

		// 5. Löschen
		await a.evaluate(() => app.vault.delete(app.vault.getFileByPath("Kopie.pdf")));
		await waitFor(async () => (await hash(b, "Kopie.pdf")) === null, { what: "gelöscht bei Bob" });
		check(true, "Löschen eines Anhangs");

		// 6. Beide offline ändern denselben Anhang → Konfliktkopie, nichts geht verloren
		await idle(a);
		await idle(b);
		await server.stop();
		await waitFor(async () => (await status(a)) !== "online" && (await status(b)) !== "online", { what: "offline" });
		await putBin(a, "Anhänge/Arbeitsblatt.pdf", 10, 100_000);
		await a.sleep(300);
		await putBin(b, "Anhänge/Arbeitsblatt.pdf", 20, 120_000);
		const ha = await hash(a, "Anhänge/Arbeitsblatt.pdf");
		const hb = await hash(b, "Anhänge/Arbeitsblatt.pdf");
		await server.start();
		await waitFor(async () => (await status(a)) === "online" && (await status(b)) === "online", { timeout: 30000, what: "online" });
		await idle(a);
		await idle(b);
		await waitFor(async () => (await hash(a, "Anhänge/Arbeitsblatt.pdf")) === (await hash(b, "Anhänge/Arbeitsblatt.pdf")), { timeout: 15000, what: "gleicher Stand" }).catch(async (e) => {
			for (const h of [a, b]) {
				const fl = await h.evaluate(() => app.vault.getFiles().map((f) => f.path).filter((p) => p.includes("Arbeitsblatt")));
				console.log(h.user, "ha", ha.slice(0, 8), "hb", hb.slice(0, 8));
				for (const p of fl) console.log("  ", p, (await hash(h, p)).slice(0, 8));
				console.log("  idx", await h.evaluate(() => [...app.plugins.plugins.tandem.sync.index.files.values()].filter((e) => e.path.includes("Arbeitsblatt")).map((e) => `${e.path} ${e.hash?.slice(0, 8)} ${e.del ? "del" : ""}`)));
				console.log(h.logs.filter((l) => l.includes("tandem")).slice(-8).join("\n"));
			}
			throw e;
		});
		const all = await b.evaluate(() => app.vault.getFiles().map((f) => f.path).filter((p) => p.includes("Arbeitsblatt")));
		const hashes = await Promise.all(all.map((p) => hash(b, p)));
		check(hashes.includes(ha) && hashes.includes(hb), `beide Fassungen bleiben erhalten: ${all.join(", ")}`);

		// 7. Ohne Berechtigung kein Zugriff auf Blobs
		const r = await fetch(`${server.url}/api/blob/test/${h1}`);
		check(r.status === 401, `Blob ohne Token: HTTP ${r.status}`);
		const errs = [a, b].flatMap((h) => h.logs).filter((l) => /\[exception\]|\[error\]/.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
