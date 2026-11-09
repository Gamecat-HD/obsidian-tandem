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
const CLIENT = `tandem-plugin/${require("./manifest.json").version}`;
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
		ws.on("open", () => ws.send(frame((e) => (encoding.writeVarUint(e, 0), encoding.writeVarUint(e, 1), encoding.writeVarString(e, token), encoding.writeVarString(e, "e2e"), encoding.writeVarString(e, CLIENT)))));
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

// Minimaler SSE-Leser: next() liefert das nächste Ereignis ({ event, id, data }), Kommentare (KeepAlive) fallen weg
async function openFeed(url, token, headers = {}) {
	const ctrl = new AbortController();
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: ctrl.signal });
	assert.equal(res.status, 200, `Feed ${res.status}`);
	assert.match(res.headers.get("content-type"), /text\/event-stream/);
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	return {
		async next(timeoutMs = 3000) {
			const until = Date.now() + timeoutMs;
			for (;;) {
				const end = buf.indexOf("\n\n");
				if (end >= 0) {
					const block = buf.slice(0, end);
					buf = buf.slice(end + 2);
					const ev = { event: "message", id: null, data: "" };
					for (const line of block.split("\n")) {
						const i = line.indexOf(":");
						if (i === 0) continue;
						const k = line.slice(0, i), v = line.slice(i + 1).replace(/^ /, "");
						if (k === "event") ev.event = v;
						else if (k === "id") ev.id = v;
						else if (k === "data") ev.data += v;
					}
					if (!ev.data) continue;
					ev.data = JSON.parse(ev.data);
					return ev;
				}
				const left = until - Date.now();
				assert.ok(left > 0, "kein Ereignis im Feed");
				const r = await Promise.race([reader.read(), sleep(left).then(() => null)]);
				assert.ok(r && !r.done, "Feed ohne Ereignis beendet");
				buf += dec.decode(r.value, { stream: true });
			}
		},
		close: () => ctrl.abort(),
	};
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
	const put = await fetch(`${srv.url}/api/blob/test/${hash}`, { method: "PUT", headers: { Authorization: `Bearer ${srv.tokens.alice}`, "X-Tandem-Client": CLIENT }, body: png });
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

	// Änderungs-Feed (SSE): erst Nachholen, dann laufend
	const feed = await openFeed(`${srv.url}/api/changes/test?since=0`, srv.tokens.reader);
	const first = await feed.next();
	assert.equal(first.event, "changes");
	assert.equal(first.data.catchup, true);
	assert.equal(String(first.data.seq), first.id, "Ereignis-ID = Sequenz");
	for (const id of ["_index", "n0000000000001", "i0000000000001"]) assert.ok(first.data.docs.includes(id), `Nachholen nennt ${id}: ${first.data.docs}`);
	note.getText("content").insert(0, "y");
	const live = await feed.next();
	assert.deepEqual(live.data.docs, ["n0000000000001"], "nur das geänderte Doc, ohne Space-Präfix");
	assert.ok(live.data.seq > first.data.seq && !live.data.catchup, JSON.stringify(live.data));
	feed.close();
	// Wiederaufnahme per Last-Event-ID: nichts verpasst → leeres Nachholen mit gleicher Sequenz
	const again = await openFeed(`${srv.url}/api/changes/test`, srv.tokens.reader, { "Last-Event-ID": live.id });
	const resumed = await again.next();
	assert.deepEqual([resumed.data.docs, resumed.data.seq, resumed.data.catchup], [[], live.data.seq, true]);
	ink.getMap("strokes").set("s2", JSON.stringify({ id: "s2", p: [4] }));
	assert.deepEqual((await again.next()).data.docs, ["i0000000000001"]);
	again.close();
	assert.equal((await get("/api/changes/test", "falsch")).status, 401);
	assert.equal((await get("/api/changes/anderer")).status, 403);
	// Braucht wie die übrige Lese-API keine Plugin-Kennung (s. o.: get() sendet keine)

	assert.equal((await get("/api/file/test/d0000000000001")).status, 404, "gelöschte Datei");
	assert.equal((await get("/api/files/test", "falsch")).status, 401);
	assert.equal((await get("/api/files/anderer")).status, 403);
	assert.equal((await get("/api/file/test/x.y")).status, 400);
	c.close();
	// Offener Feed hält das Beenden nicht auf (geordnetes Herunterfahren wartet sonst ewig auf den Strom)
	const lingering = await openFeed(`${srv.url}/api/changes/test`, srv.tokens.reader);
	await lingering.next();
	const t0 = Date.now();
	await srv.stop();
	assert.ok(Date.now() - t0 < 5000, `Beenden dauerte ${Date.now() - t0} ms`);
	console.log("files-api: alles bestanden");
} finally {
	await srv.stop();
}
