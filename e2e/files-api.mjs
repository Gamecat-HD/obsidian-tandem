// Nur-Lese-API für Dienste (server/src/files_api.rs) gegen den echten Server: Ein Gerät legt wie das Plugin eine
// Notiz, eine Ink-Fläche und einen Anhang an, ein Nur-Lese-Token liest Index und Inhalte. Aufruf: node e2e/files-api.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startRustServer } from "./rust-server.mjs";

const require = createRequire(resolve(import.meta.dirname, "../plugin/package.json"));
const Y = require("yjs");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const WebSocket = require("ws");
const REMOTE = Symbol("remote");
const frame = (fn) => {
	const e = encoding.createEncoder();
	fn(e);
	return encoding.toUint8Array(e);
};

function connect(url, token) {
	const ws = new WebSocket(url.replace("http", "ws") + "/ws");
	ws.binaryType = "arraybuffer";
	const docs = new Map();
	const send = (doc, fn) => ws.send(frame((e) => (encoding.writeVarUint(e, 2), encoding.writeVarString(e, doc), fn(e))));
	const ready = new Promise((ok, fail) => {
		ws.on("open", () => ws.send(frame((e) => (encoding.writeVarUint(e, 0), encoding.writeVarUint(e, 1), encoding.writeVarString(e, token), encoding.writeVarString(e, "e2e")))));
		ws.on("error", fail);
		ws.on("message", (raw) => {
			const d = decoding.createDecoder(new Uint8Array(raw));
			const t = decoding.readVarUint(d);
			if (t === 1) return ok();
			if (t !== 2) return;
			const name = decoding.readVarString(d);
			const sub = decoding.readVarUint(d);
			const data = decoding.readVarUint8Array(d);
			const doc = docs.get(name);
			if (!doc) return;
			if (sub === 0) send(name, (e) => (encoding.writeVarUint(e, 1), encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(doc, data))));
			else Y.applyUpdate(doc, data, REMOTE);
		});
	});
	const open = (name) => {
		const doc = new Y.Doc();
		docs.set(name, doc);
		doc.on("update", (u, origin) => origin !== REMOTE && send(name, (e) => (encoding.writeVarUint(e, 2), encoding.writeVarUint8Array(e, u))));
		send(name, (e) => (encoding.writeVarUint(e, 0), encoding.writeVarUint8Array(e, Y.encodeStateVector(doc))));
		return doc;
	};
	return { ready, open, close: () => ws.close() };
}

const srv = await startRustServer({ build: !process.env.TANDEM_BIN });
try {
	const c = connect(srv.url, srv.tokens.alice);
	await c.ready;
	const index = c.open("test/_index");
	const note = c.open("test/n0000000000001");
	const ink = c.open("test/i0000000000001");
	const empty = c.open("test/i0000000000002"); // leere Fläche: im Update fehlen „strokes“ und „order“ ganz
	await sleep(200);
	note.getText("content").insert(0, "# Kunden\n\nMit WHERE filtert man Zeilen.\n");
	ink.getMap("meta").set("head", JSON.stringify({ v: 1, w: 800, h: 300 }));
	ink.getMap("strokes").set("s1", JSON.stringify({ id: "s1", p: [1, 2, 3] }));
	ink.getArray("order").push(["s1"]);
	empty.getMap("meta").set("head", JSON.stringify({ v: 1, w: 800, h: 200 }));
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const hash = createHash("sha256").update(png).digest("hex");
	const put = await fetch(`${srv.url}/api/blob/test/${hash}`, { method: "PUT", headers: { Authorization: `Bearer ${srv.tokens.alice}` }, body: png });
	assert.ok(put.ok, `Upload ${put.status}`);
	const files = index.getMap("files");
	const ts = Date.now();
	files.set("n0000000000001", { path: "SQL/Kunden.md", kind: "md", by: "alice", ts });
	files.set("i0000000000001", { path: "_ink/k.ink", kind: "ink", by: "alice", ts });
	files.set("i0000000000002", { path: "_ink/leer.ink", kind: "ink", by: "alice", ts });
	files.set("b0000000000001", { path: "SQL/bild.png", kind: "blob", hash, size: png.length, by: "alice", ts });
	files.set("d0000000000001", { path: "SQL/weg.md", kind: "md", del: true, by: "alice", ts });
	await sleep(400);

	const get = (p, token = srv.tokens.reader) => fetch(`${srv.url}${p}`, { headers: { Authorization: `Bearer ${token}` } });
	const list = await (await get("/api/files/test")).json();
	assert.deepEqual(list.files.map((f) => [f.path, f.kind]).sort(), [["SQL/Kunden.md", "md"], ["SQL/bild.png", "blob"], ["_ink/k.ink", "ink"], ["_ink/leer.ink", "ink"]], "Gelöschtes fehlt");
	const md = list.files.find((f) => f.kind === "md");
	assert.ok(Number(md.rev) > 0 && md.size > 0 && md.ts === ts, JSON.stringify(md));

	const text = await get(`/api/file/test/${md.id}`);
	assert.equal(await text.text(), "# Kunden\n\nMit WHERE filtert man Zeilen.\n");
	assert.equal(text.headers.get("x-tandem-rev"), md.rev);
	const inkFile = JSON.parse(await (await get("/api/file/test/i0000000000001")).text());
	assert.deepEqual(inkFile, { v: 1, w: 800, h: 300, strokes: [{ id: "s1", p: [1, 2, 3] }] });
	assert.deepEqual(JSON.parse(await (await get("/api/file/test/i0000000000002")).text()), { v: 1, w: 800, h: 200, strokes: [] }, "leere Fläche");
	const blob = Buffer.from(await (await get("/api/file/test/b0000000000001")).arrayBuffer());
	assert.ok(blob.equals(png));
	assert.equal(list.files.find((f) => f.kind === "blob").rev, hash);

	// Jede Änderung erhöht die Revision
	note.getText("content").insert(0, "x");
	await sleep(300);
	const after = (await (await get("/api/files/test")).json()).files.find((f) => f.id === md.id);
	assert.ok(Number(after.rev) > Number(md.rev), "Revision steigt mit jeder Änderung");

	assert.equal((await get("/api/file/test/d0000000000001")).status, 404, "gelöschte Datei");
	assert.equal((await get("/api/files/test", "falsch")).status, 401);
	assert.equal((await get("/api/files/anderer")).status, 403);
	assert.equal((await get("/api/file/test/x.y")).status, 400);
	c.close();
	console.log("files-api: alles bestanden");
} finally {
	await srv.stop();
}
