// Geräte gehören zu einem Vault: Zwei Vaults auf einem Rechner sind zwei Einträge, jeder lässt sich für sich
// verwalten, und ein Zugang kommt nur an seinen Vault. Echte Obsidian-Instanzen gegen den Rust-Server.
import { createHmac } from "node:crypto";
import { CLIENT, check, client, idle, readFile, startServer, status, waitFor } from "../lib.mjs";

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
	const post = (p, body) => fetch(`${server.url}/admin/api${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tandem-Admin": "1" }, body: JSON.stringify(body) });
	const s = await (await post("/setup/start", { code, password: "e2e-admin-passwort" })).json();
	const r = await post("/setup/finish", { code, totp: totp(s.secret) });
	const cookie = r.headers.get("set-cookie").split(";")[0];
	return async (method, p, body) => {
		const res = await fetch(`${server.url}/admin/api${p}`, { method, headers: { Cookie: cookie, "X-Tandem-Admin": "1", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	};
}

export default async function () {
	const server = await startServer({ rust: true });
	server.cli("space", "add", "zweit", "Zweiter Vault");
	server.cli("space", "member", "zweit", "alice", "owner");
	server.cli("space", "member", "zweit", "bob", "write");
	const handles = [];
	try {
		const api = await adminSession(server);
		const devicesOf = async (user) => (await api("GET", "/users")).body.find((u) => u.id === user).devices;

		// 1. Altes, ungebundenes Gerät: bindet sich beim ersten Verbinden an den Vault, den es öffnet
		const before = await devicesOf("alice");
		check(before.length === 1 && before[0].space === null, "vor dem ersten Verbinden: Alices Gerät ist keinem Vault zugeordnet");
		const a1 = await client(server, "alice", { device: "Desktop" });
		handles.push(a1);
		await waitFor(async () => (await devicesOf("alice"))[0].space === "test", { what: "Bindung an test" });
		check(true, "beim Verbinden an den geöffneten Vault gebunden");
		check((await devicesOf("alice"))[0].device === "Desktop", "Gerätename aus dem Plugin wird übernommen");

		// 2. Der Zugang kommt nur noch an diesen Vault – auch über HTTP
		const tok = server.tokens.alice;
		const get = (p) => fetch(`${server.url}${p}`, { headers: { Authorization: `Bearer ${tok}`, "X-Tandem-Client": CLIENT } }).then((r) => r.status);
		check((await get("/api/members/test")) === 200, "HTTP: eigener Vault erlaubt");
		check((await get("/api/members/zweit")) === 403, "HTTP: anderer Vault der Person abgelehnt");

		// 3. Code für den zweiten Vault, eingelöst im zweiten Vault auf demselben Rechner („Desktop“ zum zweiten Mal)
		const inv = await api("POST", "/users/alice/invite", { hours: 24, space: "zweit" });
		check(inv.status === 200 && inv.body.space === "zweit", "Admin erzeugt Code für einen bestimmten Vault");
		const fremd = await api("POST", "/users/carol/invite", { hours: 24, space: "zweit" });
		check(fremd.status === 400, "Code für einen Vault ohne Zugriff wird abgelehnt");
		const a2 = await client({ ...server, space: "" }, "alice", { login: false });
		handles.push(a2);
		await a2.evaluate(async (code) => {
			const p = app.plugins.plugins.tandem;
			await p.redeem(code);
			await p.restart();
		}, inv.body.code);
		await waitFor(async () => (await status(a2)) === "online", { what: "zweiter Vault online" });
		check((await a2.evaluate(() => app.plugins.plugins.tandem.settings.space)) === "zweit", "Space wird beim Einlösen aus dem Code übernommen");
		const two = await devicesOf("alice");
		check(two.length === 2 && two.some((d) => d.space === "test") && two.some((d) => d.space === "zweit"), "zwei Einträge, je Vault einer");

		// 4. Inhalte bleiben getrennt
		await a1.evaluate(() => app.vault.create("Nur-Test.md", "test\n"));
		await a2.evaluate(() => app.vault.create("Nur-Zweit.md", "zweit\n"));
		await idle(a1);
		await idle(a2);
		check((await readFile(a2, "Nur-Test.md")) == null && (await readFile(a1, "Nur-Zweit.md")) == null, "beide Vaults synchronisieren getrennt");

		// 5. Gerät im falschen Vault: klare Meldung, kein Abgleich
		const b = await client({ ...server, space: "zweit" }, "bob");
		handles.push(b);
		await b.evaluate(async () => {
			const p = app.plugins.plugins.tandem;
			p.settings.space = "test";
			await p.saveSettings();
			await p.restart();
		});
		await waitFor(() => b.evaluate(() => app.plugins.plugins.tandem.conn?.status === "online" && app.plugins.plugins.tandem.sync === null), { what: "Bob verbunden ohne Abgleich" });
		const note = await b.evaluate(() => document.querySelector(".tandem-status")?.textContent ?? "");
		check(/kein Zugriff/.test(note), `falscher Space: Statusleiste sagt es (${note})`);
		check((await readFile(b, "Nur-Test.md")) == null, "falscher Space: nichts übernommen");

		// 6. Verwaltung je Vault: Gerät im einen Vault entfernen, das im anderen bleibt online
		const inZweit = (await devicesOf("alice")).find((d) => d.space === "zweit");
		await api("DELETE", `/devices/${inZweit.id}`);
		await waitFor(async () => (await status(a2)) !== "online", { what: "entferntes Gerät getrennt" });
		check((await status(a1)) === "online", "Gerät im anderen Vault bleibt verbunden");

		// 7. Von Hand zuordnen: nur Vaults der Person
		server.cli("token", "issue", "carol", "Dienst");
		const id = (await devicesOf("carol")).find((d) => d.device === "Dienst").id;
		check((await api("POST", `/devices/${id}/space`, { space: "zweit" })).status === 400, "Zuordnen ohne Zugriff wird abgelehnt");
		check((await api("POST", `/devices/${id}/space`, { space: "test" })).status === 204, "Zuordnen zum eigenen Vault klappt");
		check((await devicesOf("carol")).find((d) => d.id === id).space === "test", "Zuordnung gespeichert");

		// 8. Vault löschen nimmt seine Geräte mit, die anderen bleiben
		const delInv = await api("POST", "/users/bob/invite", { space: "zweit" });
		check(delInv.status === 200, "Code für den Vault vor dem Löschen");
		await api("DELETE", "/spaces/zweit", { confirm: "zweit" });
		const left = await devicesOf("bob");
		check(left.every((d) => d.space !== "zweit"), "Geräte des gelöschten Vaults sind weg");
		check((await status(a1)) === "online", "Gerät im anderen Vault bleibt verbunden");
	} finally {
		for (const h of handles) await h.close();
		await server.close();
	}
}
