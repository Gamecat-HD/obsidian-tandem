// Admin-Oberfläche: Änderungen über die Admin-API kommen in echten Obsidian-Instanzen an –
// geschlossene Dateien auf der Platte, offene Dateien live im Editor (CRDT, auch bei gleichzeitigem Tippen).
import { createHmac } from "node:crypto";
import { check, client, cursorTo, editorText, isBound, openFile, readFile, startServer, status, type, waitFor } from "../lib.mjs";

function totp(secret, t = Date.now() / 1000) {
	const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const c of secret) bits += alpha.indexOf(c).toString(2).padStart(5, "0");
	const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(Math.floor(t / 30)));
	const h = createHmac("sha1", key).update(buf).digest();
	const o = h[19] & 15;
	return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

async function adminSession(server) {
	const out = server.cli("admin", "setup", "alice");
	const code = /#setup=([0-9a-f]+)/.exec(out)[1];
	const post = (p, body) =>
		fetch(`${server.url}/admin/api${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tandem-Admin": "1" }, body: JSON.stringify(body) });
	const s = await (await post("/setup/start", { code, password: "e2e-admin-passwort" })).json();
	const r = await post("/setup/finish", { code, totp: totp(s.secret) });
	const cookie = r.headers.get("set-cookie").split(";")[0];
	return async (method, p, body, raw) => {
		const res = await fetch(`${server.url}/admin/api${p}`, {
			method,
			headers: { Cookie: cookie, "X-Tandem-Admin": "1", ...(raw ? {} : { "Content-Type": "application/json" }) },
			body: raw ?? (body ? JSON.stringify(body) : undefined),
		});
		const text = await res.text();
		if (!res.ok && res.status !== 409) throw new Error(`${method} ${p}: ${res.status} ${text}`);
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};
}

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice");
	const b = await client(server, "bob");
	try {
		const api = await adminSession(server);
		const sp = server.space;

		// 1. Neue Notiz über die Admin-API → landet bei beiden auf der Platte
		const { body: n } = await api("POST", `/spaces/${sp}/files`, { path: "Admin/Neu.md", text: "# Vom Admin\n\nZeile 1\n" });
		await waitFor(async () => (await readFile(a, "Admin/Neu.md")) === "# Vom Admin\n\nZeile 1\n" && (await readFile(b, "Admin/Neu.md")) === "# Vom Admin\n\nZeile 1\n", {
			what: "neue Notiz bei Alice und Bob",
		});
		check(true, "Admin legt Notiz an → erscheint in beiden Vaults");

		// 2. Geschlossene Datei bearbeiten
		let { body: d } = await api("GET", `/spaces/${sp}/docs/${n.id}`);
		await api("PUT", `/spaces/${sp}/docs/${n.id}`, { text: "# Vom Admin\n\nZeile 1 geändert\n", version: d.version });
		await waitFor(async () => (await readFile(b, "Admin/Neu.md")) === "# Vom Admin\n\nZeile 1 geändert\n", { what: "Änderung auf Bobs Platte" });
		check(true, "Bearbeitung einer geschlossenen Datei kommt auf der Platte an");

		// 3. Offene Datei: Alice tippt, gleichzeitig ändert der Admin eine andere Stelle → beides bleibt
		await openFile(a, "Admin/Neu.md");
		await waitFor(async () => (await editorText(a)) === "# Vom Admin\n\nZeile 1 geändert\n", { what: "Editor bei Alice" });
		await waitFor(() => isBound(a, "Admin/Neu.md"), { what: "Editor bei Alice gebunden" });
		await cursorTo(a, 2, 0);
		const typing = type(a, "Alice: ", 40);
		({ body: d } = await api("GET", `/spaces/${sp}/docs/${n.id}`));
		// Absichtlich warten, bis Alice weitergetippt hat: Die Version ist dann veraltet → 3-Wege-Merge mit `base`
		await a.sleep(150);
		const put = await api("PUT", `/spaces/${sp}/docs/${n.id}`, { text: d.text.replace("# Vom Admin", "# Vom Admin (überarbeitet)"), version: d.version, base: d.text });
		await typing;
		check(put.status === 200, `Admin-Speichern während Alice tippt: ${put.status}${put.body?.merged ? " (zusammengeführt)" : ""}`);
		const want = "# Vom Admin (überarbeitet)\n\nAlice: Zeile 1 geändert\n";
		await waitFor(async () => (await editorText(a)) === want, { what: `Editor zeigt beide Änderungen (${JSON.stringify(await editorText(a))})` });
		await waitFor(async () => (await readFile(b, "Admin/Neu.md")) === want, { what: "Bob hat beide Änderungen" });
		({ body: d } = await api("GET", `/spaces/${sp}/docs/${n.id}`));
		check(d.text === want, "Server, Editor und Bobs Platte stimmen überein – nichts verloren");

		// 4. Ordner verschieben → Umbenennung auf der Platte
		await api("POST", `/spaces/${sp}/move`, { from: "Admin", to: "Verwaltung/Admin" });
		await waitFor(async () => (await readFile(b, "Verwaltung/Admin/Neu.md")) === want && (await readFile(b, "Admin/Neu.md")) === null, { what: "Ordner verschoben bei Bob" });
		check(true, "Ordner verschoben");

		// 5. Anhang hochladen → Datei mit gleichen Bytes
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...Array.from({ length: 300 }, (_, i) => i % 256)]);
		await api("POST", `/spaces/${sp}/upload?path=${encodeURIComponent("Verwaltung/bild.png")}`, null, bytes);
		await waitFor(
			() => b.evaluate(async () => {
				const f = app.vault.getFileByPath("Verwaltung/bild.png");
				return f ? (await app.vault.readBinary(f)).byteLength : 0;
			}),
			{ what: "Anhang bei Bob" },
		);
		const same = await b.evaluate(async () => [...new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath("Verwaltung/bild.png")))].join(","));
		check(same === [...bytes].join(","), "Anhang kommt byte-gleich an");

		// 6. Löschen → Papierkorb; Wiederherstellen → wieder da
		await api("POST", `/spaces/${sp}/delete`, { path: "Verwaltung/Admin/Neu.md" });
		await waitFor(async () => (await readFile(b, "Verwaltung/Admin/Neu.md")) === null, { what: "gelöscht bei Bob" });
		check(true, "Löschen kommt an");
		await api("POST", `/spaces/${sp}/undelete`, { doc: n.id });
		await waitFor(async () => (await readFile(b, "Verwaltung/Admin/Neu.md")) === want, { what: "wiederhergestellt bei Bob" });
		check(true, "Wiederherstellen aus dem Papierkorb");

		// 7. Statistik: Latenz je Gerät aus den WS-Pings (erste Messung ~2 s nach dem Verbinden)
		let st;
		await waitFor(async () => {
			st = (await api("GET", "/stats?range=1h")).body;
			return st.devices.length >= 2 && st.devices.every((d) => d.rttMs !== null);
		}, { what: "Latenz je Gerät", timeout: 40000 });
		check(st.devices.every((d) => d.rttMs >= 0 && d.rttMs < 1000 && d.bytesIn > 0), `Latenz gemessen: ${st.devices.map((d) => `${d.user} ${d.rttMs} ms`).join(", ")}`);
		check(st.recent.some((r) => r.path === "Verwaltung/Admin/Neu.md"), "zuletzt geänderte Dateien mit Pfad");

		// 8. Gerät sperren → Bob fliegt raus und kommt nicht wieder rein
		const { body: users } = await api("GET", "/users");
		const dev = users.find((u) => u.id === "bob").devices[0];
		check(dev.online, "Bobs Gerät als online erkannt");
		await api("POST", `/devices/${dev.id}/revoke`);
		await waitFor(async () => (await status(b)) !== "online", { what: "Bob getrennt" });
		check(true, `Gesperrtes Gerät getrennt (${await status(b)})`);
		await api("DELETE", `/devices/${dev.id}`);
		const { body: after } = await api("GET", "/users");
		check(!after.find((u) => u.id === "bob").devices.some((d) => d.id === dev.id), "Gesperrtes Gerät endgültig entfernt");
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
