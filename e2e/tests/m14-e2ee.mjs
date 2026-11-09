// M14: Ende-zu-Ende-verschlüsselter Vault – Einrichten, Entsperren, Sync von Notizen/Anhängen/Live-Tippen,
// Offline-Änderungen, Verdichten durch den Client, neues Gerät; der Server sieht nachweislich keinen Klartext.
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile as readFs } from "node:fs/promises";
import { join } from "node:path";
import { CLIENT, check, client, cursorTo, editorText, idle, isBound, openFile, readFile, startServer, type, waitFor } from "../lib.mjs";

const PASS = "korrekt pferd batterie heftklammer";
const ITER = 100_000; // kleinste erlaubte Rundenzahl – hält den Test schnell
const SECRET = "Streng geheimer Plan: Klassenfahrt nach Lissabon";

const tandem = (h, fn, ...args) => h.evaluate(fn, ...args);
const mode = (h) => tandem(h, () => app.plugins.plugins.tandem.api.e2ee());

const putBin = (h, path, seed, size) =>
	h.evaluate(async (path, seed, size) => {
		const b = new Uint8Array(size);
		let x = seed;
		for (let i = 0; i < size; i++) {
			x = (x * 1103515245 + 12345) & 0x7fffffff;
			b[i] = x & 0xff;
		}
		// erkennbarer Klartext im Anhang
		b.set(new TextEncoder().encode("ANHANG-KLARTEXT-MARKER"), 100);
		const f = app.vault.getFileByPath(path);
		if (f) await app.vault.modifyBinary(f, b.buffer);
		else await app.vault.createBinary(path, b.buffer);
	}, path, seed, size);

const hash = (h, path) =>
	h.evaluate(async (p) => {
		const f = app.vault.getFileByPath(p);
		if (!f) return null;
		const d = await crypto.subtle.digest("SHA-256", await app.vault.readBinary(f));
		return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
	}, path);

async function synced(h) {
	await waitFor(() => h.evaluate(() => !!app.plugins.plugins.tandem.sync && app.plugins.plugins.tandem.conn?.status === "online"), { what: `${h.user} synchronisiert` });
	await idle(h);
}

export default async function () {
	const base = await startServer({ rust: true });
	base.cli("space", "add", "enc", "Verschlüsselt", "--e2ee");
	for (const [u, r] of [["alice", "owner"], ["bob", "write"], ["carol", "write"]]) base.cli("space", "member", "enc", u, r);
	const server = { ...base, space: "enc" };
	const clients = [];
	try {
		// 1. Besitzerin verbindet sich: Vault wartet auf die Passphrase, es wird nichts synchronisiert
		const a = await client(server, "alice", { expectOnline: false });
		clients.push(a);
		await waitFor(async () => (await mode(a)).mode === "pending", { what: "Modus pending" });
		check(!(await tandem(a, () => !!app.plugins.plugins.tandem.sync)), "vor dem Festlegen der Passphrase wird nicht synchronisiert");
		await tandem(a, () => document.querySelector(".modal-close-button")?.click());
		await tandem(a, (p, i) => app.plugins.plugins.tandem.api.e2eeSetup(p, i), PASS, ITER);
		await synced(a);
		check((await mode(a)).unlocked === true, "Passphrase festgelegt, Alice ist entsperrt");

		// 2. Notizen + Anhang bei Alice
		await a.evaluate(async (t) => {
			await app.vault.createFolder("Geheim");
			await app.vault.create("Geheim/Plan.md", `# Plan\n\n${t}\n`);
		}, SECRET);
		await putBin(a, "Geheim/Scan.pdf", 7, 400_000);
		await idle(a);

		// 3. Bob: gesperrt, falsche Passphrase abgelehnt, richtige entsperrt
		const b = await client(server, "bob", { expectOnline: false });
		clients.push(b);
		await waitFor(async () => typeof (await mode(b)).mode === "object", { what: "Bob kennt die Parameter" });
		check((await mode(b)).unlocked === false && !(await tandem(b, () => !!app.plugins.plugins.tandem.sync)), "Bob ist gesperrt und synchronisiert nichts");
		await tandem(b, () => document.querySelector(".modal-close-button")?.click());
		const wrong = await tandem(b, () => app.plugins.plugins.tandem.api.e2eeUnlock("falsche passphrase").then(() => "ok", (e) => e.message));
		check(/stimmt nicht/.test(wrong), `falsche Passphrase abgelehnt (${wrong})`);
		await tandem(b, (p) => app.plugins.plugins.tandem.api.e2eeUnlock(p), PASS);
		await synced(b);
		await waitFor(async () => (await readFile(b, "Geheim/Plan.md")) === `# Plan\n\n${SECRET}\n`, { what: "Notiz bei Bob" });
		check(true, "verschlüsselte Notiz kommt bei Bob an");
		const ha = await hash(a, "Geheim/Scan.pdf");
		await waitFor(async () => (await hash(b, "Geheim/Scan.pdf")) === ha, { timeout: 20000, what: "PDF bei Bob" });
		check(true, "verschlüsselter Anhang kommt bytegenau an");

		// 4. Live-Tippen (Awareness + Updates verschlüsselt)
		await openFile(a, "Geheim/Plan.md");
		await openFile(b, "Geheim/Plan.md");
		await waitFor(() => isBound(a, "Geheim/Plan.md"), { what: "Alice gebunden" });
		await waitFor(() => isBound(b, "Geheim/Plan.md"), { what: "Bob gebunden" });
		await cursorTo(a, -1);
		await type(a, "Treffpunkt: Gleis 7", 20);
		await waitFor(async () => (await editorText(b))?.includes("Treffpunkt: Gleis 7"), { what: "Live-Text bei Bob" });
		check(true, "Live-Tippen erreicht Bob");
		await waitFor(() => b.evaluate(() => app.plugins.plugins.tandem.presence?.peers.some((p) => p.user.id === "alice")), { what: "Alice als Peer bei Bob" });
		check(true, "Präsenz (verschlüsselte Awareness) funktioniert");

		// 5. Offline-Änderung bei Bob → nach dem Wiederverbinden bei Alice
		await b.evaluate(() => app.workspace.getLeaf(false).detach());
		await b.evaluate(() => app.plugins.plugins.tandem.conn.stop());
		await b.evaluate(async () => {
			await app.vault.create("Offline.md", "offline geschrieben\n");
			const f = app.vault.getFileByPath("Geheim/Plan.md");
			await app.vault.process(f, (t) => t + "Bob war offline da.\n");
		});
		await b.sleep(800);
		await b.evaluate(() => app.plugins.plugins.tandem.conn.start());
		await waitFor(async () => (await readFile(a, "Offline.md")) === "offline geschrieben\n", { what: "Offline-Notiz bei Alice" });
		await waitFor(async () => (await editorText(a))?.includes("Bob war offline da."), { what: "Offline-Änderung im Editor bei Alice" });
		check(true, "offline entstandene Änderungen werden nachgereicht");

		// 6. Viele Updates → Client verdichtet (ECOMPACT); neues Gerät baut alles aus dem Log auf
		await cursorTo(a, -1);
		await type(a, "\n" + "x".repeat(90), 5);
		await idle(a);
		await a.sleep(500);
		const docId = await a.evaluate(() => app.plugins.plugins.tandem.sync.index.idForPath("Geheim/Plan.md"));
		const rows = () => new DatabaseSync(join(base.data, "tandem.db"), { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM updates WHERE doc = ?").get(`enc/${docId}`).n;
		const before = rows();
		// Neu verbinden → ESUB liefert total ≥ 64 → Alice verdichtet
		await a.evaluate(() => app.plugins.plugins.tandem.restart());
		await synced(a);
		await waitFor(() => rows() < 10, { what: `Log verdichtet (vorher ${before} Zeilen, jetzt ${rows()})` });
		check(before >= 64, `Log wurde verdichtet: ${before} → ${rows()} Zeilen`);
		const snaps = await a.evaluate((id) => app.plugins.plugins.tandem.api.history(id), docId);
		check(snaps.length >= 1, `Verdichteter Stand dient als Fassung der Versionsgeschichte (${snaps.length})`);
		const sr = await fetch(`${base.url}/api/history/enc/${docId}/${snaps[0].ts}`, { headers: { Authorization: `Bearer ${base.tokens.alice}`, "X-Tandem-Client": CLIENT } });
		const sdata = Buffer.from(await sr.arrayBuffer());
		const snapText = { len: sdata.length, plain: sdata.includes(Buffer.from("Lissabon")) };
		const snapPlain = await a.evaluate((id, ts) => app.plugins.plugins.tandem.api.snapshotText(id, ts), docId, snaps[0].ts);
		check(snapPlain.includes("Lissabon"), "Plugin entschlüsselt die Fassung");
		check(!snapText.plain && snapText.len > 0, "Fassung liegt auf dem Server nur verschlüsselt");

		const c = await client(server, "carol", { expectOnline: false });
		clients.push(c);
		await waitFor(async () => typeof (await mode(c)).mode === "object", { what: "Carol kennt die Parameter" });
		await tandem(c, () => document.querySelector(".modal-close-button")?.click());
		await tandem(c, (p) => app.plugins.plugins.tandem.api.e2eeUnlock(p), PASS);
		await synced(c);
		const want = await readFile(a, "Geheim/Plan.md");
		await waitFor(async () => (await readFile(c, "Geheim/Plan.md")) === want, { what: "Carol hat den vollständigen Stand" });
		await waitFor(async () => (await hash(c, "Geheim/Scan.pdf")) === ha, { what: "Carol hat das PDF" });
		check(true, "neues Gerät baut den Vault aus dem verdichteten, verschlüsselten Log auf");

		// 7. Der Server sieht keinen Klartext: Datenbank, Anhänge, Lese-API
		const db = new DatabaseSync(join(base.data, "tandem.db"), { readOnly: true });
		const all = db.prepare("SELECT data FROM updates WHERE doc LIKE 'enc/%' UNION ALL SELECT data FROM snapshots WHERE doc LIKE 'enc/%'").all();
		const needles = ["Lissabon", "Geheim/Plan.md", "Plan.md", "Scan.pdf", "Treffpunkt", "offline geschrieben", "Alice"];
		const leaks = needles.filter((n) => all.some((r) => Buffer.from(r.data).includes(Buffer.from(n))));
		check(all.length > 0 && leaks.length === 0, `Datenbank (${all.length} Zeilen) enthält keinen Klartext${leaks.length ? `: ${leaks}` : ""}`);
		const blobDir = join(base.data, "blobs", "enc");
		let blobLeak = false;
		for (const sub of await readdir(blobDir)) for (const f of await readdir(join(blobDir, sub))) if ((await readFs(join(blobDir, sub, f))).includes("ANHANG-KLARTEXT-MARKER")) blobLeak = true;
		check(!blobLeak, "Anhänge liegen auf dem Server nur verschlüsselt");
		const api = await fetch(`${base.url}/api/files/enc`, { headers: { Authorization: `Bearer ${base.tokens.bob}` } });
		check(api.status === 409, `Lese-API verweigert verschlüsselte Vaults (${api.status})`);
		const bad = await fetch(`${base.url}/api/e2ee/enc`, {
			method: "POST",
			headers: { Authorization: `Bearer ${base.tokens.alice}`, "Content-Type": "application/json", "X-Tandem-Client": CLIENT },
			body: JSON.stringify({ v: 1, kdf: "pbkdf2-sha256", iter: 100000, salt: "AAAA", check: "AAAA" }),
		});
		check(bad.status === 409, `Schlüssel lässt sich bei vorhandenem Inhalt nicht mehr austauschen (${bad.status})`);
	} finally {
		for (const h of clients) await h.close().catch(() => {});
		if (process.env.KEEP) console.log("Server-Daten:", base.data, base.log.join("").slice(-3000));
		await base.close();
	}
}
