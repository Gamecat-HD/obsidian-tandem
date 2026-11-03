// M15: Admin-Anmeldung in zwei Schritten (Passwort → Code oder Passkey) und ob sie sich umgehen lässt.
// Läuft nur gegen die HTTP-API (kein Obsidian); der Passkey ist ein Software-Authenticator (P-256).
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { check, startServer } from "../lib.mjs";

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

// ── Minimaler CBOR-Encoder (Map, Int, Bytes, Text) ───────────────────
function head(major, n) {
	if (n < 24) return Buffer.from([(major << 5) | n]);
	if (n < 256) return Buffer.from([(major << 5) | 24, n]);
	const b = Buffer.alloc(3);
	b[0] = (major << 5) | 25;
	b.writeUInt16BE(n, 1);
	return b;
}
function cbor(v) {
	if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
	if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
	if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
	if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
	throw new Error("cbor: Typ");
}
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (b) => createHash("sha256").update(b).digest();

/** Software-Passkey: erzeugt Antworten wie navigator.credentials.create/get. */
function softKey(origin, rpId) {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = publicKey.export({ format: "jwk" });
	const id = Buffer.from("soft-passkey-1");
	let count = 0;
	const authData = (flags, attested) => {
		const c = Buffer.alloc(4);
		c.writeUInt32BE(count);
		const parts = [sha(rpId), Buffer.from([flags]), c];
		if (attested) {
			const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
			const len = Buffer.alloc(2);
			len.writeUInt16BE(id.length);
			parts.push(Buffer.alloc(16), len, id, cose);
		}
		return Buffer.concat(parts);
	};
	const clientData = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
	return {
		id: b64u(id),
		create(opts) {
			const ad = authData(0x45, true);
			return { response: { clientDataJSON: b64u(clientData("webauthn.create", opts.challenge)), attestationObject: b64u(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]))) } };
		},
		get(opts, { o, flags = 0x05 } = {}) {
			count++;
			const ad = authData(flags, false);
			const cd = clientData("webauthn.get", opts.challenge, o);
			return { id: b64u(id), response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sign("sha256", Buffer.concat([ad, sha(cd)]), privateKey)) } };
		},
	};
}

export default async function () {
	const server = await startServer({ rust: true });
	// Wie im Browser: Host localhost (WebAuthn-rpId), Origin passend
	const base = server.url.replace("127.0.0.1", "localhost");
	const origin = base;
	// Die IP-Sperre (10 Fehlversuche / 15 min) würde den Test selbst aussperren: pro Abschnitt eine eigene Absender-IP.
	let ip = "10.0.0.1";
	const call = async (method, path, body, cookie, extra = {}) => {
		const r = await fetch(`${base}/admin/api${path}`, {
			method,
			headers: { "Content-Type": "application/json", "X-Tandem-Admin": "1", Origin: origin, "cf-connecting-ip": ip, ...(cookie ? { Cookie: cookie } : {}), ...extra },
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await r.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {}
		return { status: r.status, json, cookie: r.headers.get("set-cookie")?.split(";")[0] };
	};
	try {
		// Zugang einrichten
		const out = server.cli("admin", "setup", "alice");
		const code = /#setup=([0-9a-zA-Z]+)/.exec(out)[1];
		const s = (await call("POST", "/setup/start", { code, password: "e2e-admin-passwort" })).json;
		const setup = await call("POST", "/setup/finish", { code, totp: totp(s.secret) });
		check(setup.status === 200 && setup.cookie, "Einrichtung mit Passwort + TOTP");
		await call("POST", "/logout", null, setup.cookie);

		// Ohne Sitzung: jede geschützte Route → 401 (auch mit gefälschtem Cookie)
		const routes = ["/me", "/overview", "/users", "/spaces", "/sessions", "/audit", "/stats", "/backups", "/passkeys", "/spaces/test/files", "/spaces/test/search?q=a"];
		const open = [];
		for (const r of routes) {
			for (const ck of [null, "__Host-tandem-admin=" + "a".repeat(64), setup.cookie]) {
				const res = await call("GET", r, null, ck);
				if (res.status !== 401) open.push(`${r} (${res.status})`);
			}
		}
		check(open.length === 0, `ohne gültige Sitzung keine Daten (${routes.length} Routen × 3 Varianten)${open.length ? ": " + open : ""}`);
		const csrf = await fetch(`${base}/admin/api/spaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		check(csrf.status === 403, "schreibende Anfrage ohne X-Tandem-Admin abgelehnt (CSRF)");

		// Schritt 1
		const bad = await call("POST", "/login", { user: "alice", password: "falsch-falsch-falsch" });
		check(bad.status === 401 && !bad.json.ticket, "falsches Passwort → 401, kein Ticket");
		const ghost = await call("POST", "/login", { user: "niemand", password: "egal-egal-egal" });
		check(ghost.status === 401 && ghost.json.error === bad.json.error, "unbekannte Kennung: gleiche Antwort wie falsches Passwort");
		const old = await call("POST", "/login", { user: "alice", password: "e2e-admin-passwort", totp: totp(s.secret) });
		check(old.status === 200 && !old.cookie && old.json.ticket, "Passwort allein gibt nur ein Ticket, keine Sitzung (auch mit altem Feld totp)");
		const t1 = old.json.ticket;
		check((await call("GET", "/me", null, `__Host-tandem-admin=${t1}`)).status === 401, "Ticket taugt nicht als Sitzungs-Cookie");

		// Schritt 2 (Code): Wiederverwendung des Codes aus der Einrichtung → abgelehnt
		const reuse = await call("POST", "/login/totp", { ticket: t1, code: totp(s.secret) });
		check(reuse.status === 401, "bereits benutzter Code wird abgelehnt (Replay)");
		const forged = await call("POST", "/login/totp", { ticket: "f".repeat(64), code: totp(s.secret, Date.now() / 1000 + 30) });
		check(forged.status === 401, "erfundenes Ticket → 401");
		let left = 0;
		for (let i = 0; i < 6; i++) if ((await call("POST", "/login/totp", { ticket: t1, code: "000000" })).status === 401) left++;
		const after = await call("POST", "/login/totp", { ticket: t1, code: totp(s.secret, Date.now() / 1000 + 30) });
		check(after.status === 401 || after.status === 429, `nach 5 Fehlversuchen ist das Ticket verbraucht bzw. das Konto gesperrt (${after.status})`);

		ip = "10.0.0.3";
		// Fehlversuche haben das Konto gesperrt → Sperre aufheben lassen wie ein Admin (neuer Setup-Link setzt zurück)
		const code2 = /#setup=([0-9a-zA-Z]+)/.exec(server.cli("admin", "setup", "alice"))[1];
		const s2 = (await call("POST", "/setup/start", { code: code2, password: "e2e-admin-passwort" })).json;
		const fin = await call("POST", "/setup/finish", { code: code2, totp: totp(s2.secret) });
		await call("POST", "/logout", null, fin.cookie);

		// Erfolgreich mit Code (nächster Zeitschritt, damit er noch unbenutzt ist)
		const t2 = (await call("POST", "/login", { user: "alice", password: "e2e-admin-passwort" })).json;
		check(JSON.stringify(t2.methods) === '["totp"]' && t2.passkey === null, "ohne Passkey: nur Code als zweiter Faktor");
		const ok = await call("POST", "/login/totp", { ticket: t2.ticket, code: totp(s2.secret, Date.now() / 1000 + 30) });
		check(ok.status === 200 && ok.cookie, "Passwort + Code → Sitzung");
		const again = await call("POST", "/login/totp", { ticket: t2.ticket, code: totp(s2.secret, Date.now() / 1000 + 30) });
		check(again.status === 401, "Ticket ist nach der Anmeldung verbraucht");
		const sess = ok.cookie;

		// Passkey einrichten (angemeldet)
		const key = softKey(origin, "localhost");
		const opts = (await call("POST", "/passkeys/options", null, sess)).json;
		check(opts.rp.id === "localhost" && opts.authenticatorSelection.userVerification === "required", "Optionen für den Passkey (rpId localhost, Nutzerprüfung)");
		const add = await call("POST", "/passkeys", { name: "Testschlüssel", credential: key.create(opts) }, sess);
		check(add.status === 200 && add.json.id === key.id, "Passkey hinzugefügt");
		const replayAdd = await call("POST", "/passkeys", { name: "nochmal", credential: key.create(opts) }, sess);
		check(replayAdd.status === 400, "Einrichtungs-Challenge gilt nur einmal");
		await call("POST", "/logout", null, sess);

		// Anmelden mit Passkey
		ip = "10.0.0.2";
		const t3 = (await call("POST", "/login", { user: "alice", password: "e2e-admin-passwort" })).json;
		check(t3.methods[0] === "passkey" && t3.passkey.allowCredentials[0].id === key.id, "mit Passkey: Passkey wird als zweiter Faktor angeboten");
		const evil = await call("POST", "/login/passkey", { ticket: t3.ticket, credential: key.get(t3.passkey, { o: "https://evil.example" }) });
		check(evil.status === 401, "Passkey-Antwort für fremde Herkunft abgelehnt (Phishing)");
		const noUv = await call("POST", "/login/passkey", { ticket: t3.ticket, credential: key.get(t3.passkey, { flags: 0x01 }) });
		check(noUv.status === 401, "Passkey ohne Nutzerprüfung (PIN/Biometrie) abgelehnt");
		const wrongChallenge = await call("POST", "/login/passkey", { ticket: t3.ticket, credential: key.get({ challenge: b64u(Buffer.alloc(32)) }) });
		check(wrongChallenge.status === 401, "Passkey-Antwort auf fremde Challenge abgelehnt");
		const pk = await call("POST", "/login/passkey", { ticket: t3.ticket, credential: key.get(t3.passkey) });
		check(pk.status === 200 && pk.cookie, "Passwort + Passkey → Sitzung");
		const me = await call("GET", "/me", null, pk.cookie);
		check(me.status === 200 && me.json.user.id === "alice", "Sitzung gültig");
		// Passkey ohne Passwort-Schritt geht nicht (kein Ticket)
		const skip = await call("POST", "/login/passkey", { ticket: "", credential: key.get(t3.passkey) });
		check(skip.status === 401, "Passkey allein (ohne Passwort-Schritt) → 401");

		const audit = (await call("GET", "/audit", null, pk.cookie)).json;
		const actions = (audit.items ?? audit).map((x) => x.action);
		check(actions.includes("passkey.add") && actions.includes("login.failed"), "Anmeldungen und Passkey stehen im Protokoll");
		const del = await call("DELETE", `/passkeys/${encodeURIComponent(key.id)}`, null, pk.cookie);
		check(del.status === 204, "Passkey entfernt");
	} finally {
		await server.close();
	}
}
