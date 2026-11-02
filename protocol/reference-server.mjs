// Referenz-Server für das Tandem-Protokoll v1 (nur Tests/Spike, kein Produktivbetrieb).
// Hält alles im RAM. Nutzer: Token "tok-<name>" → Nutzer <name>, Space "test" (Rolle write; "tok-reader" = read).
// Aufruf: node protocol/reference-server.mjs [port]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const require = createRequire(resolve(fileURLToPath(import.meta.url), "../../plugin/package.json"));
const Y = require("yjs");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const { WebSocketServer } = require("ws");

const COLORS = ["#e5534b", "#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#14b8a6"];

export function startReferenceServer(port = 0) {
	const docs = new Map(); // name → { doc, subs: Set<ws>, aw: Map<clientId, {clock, state, ws}> }
	const spaceSeq = new Map(); // space → { seq, changed: Map<doc, seq> }
	const conns = new Set();

	const room = (name) => {
		let r = docs.get(name);
		if (!r) docs.set(name, (r = { doc: new Y.Doc(), subs: new Set(), aw: new Map() }));
		return r;
	};
	const frame = (fn) => {
		const e = encoding.createEncoder();
		fn(e);
		return encoding.toUint8Array(e);
	};
	const sendSync = (ws, doc, sub, data) =>
		ws.send(frame((e) => (encoding.writeVarUint(e, 2), encoding.writeVarString(e, doc), encoding.writeVarUint(e, sub), encoding.writeVarUint8Array(e, data))));
	const sendAw = (ws, doc, data) =>
		ws.send(frame((e) => (encoding.writeVarUint(e, 3), encoding.writeVarString(e, doc), encoding.writeVarUint8Array(e, data))));
	const sendErr = (ws, code, doc, msg) =>
		ws.send(frame((e) => (encoding.writeVarUint(e, 5), encoding.writeVarUint(e, code), encoding.writeVarString(e, doc), encoding.writeVarString(e, msg))));
	const sendChanges = (ws, space, seq, list) =>
		ws.send(frame((e) => {
			encoding.writeVarUint(e, 6);
			encoding.writeVarString(e, space);
			encoding.writeVarUint(e, seq);
			encoding.writeVarUint(e, list.length);
			for (const d of list) encoding.writeVarString(e, d);
		}));

	const encodeAw = (entries) =>
		frame((e) => {
			encoding.writeVarUint(e, entries.length);
			for (const [id, { clock, state }] of entries) {
				encoding.writeVarUint(e, id);
				encoding.writeVarUint(e, clock);
				encoding.writeVarString(e, state);
			}
		});

	const bump = (name, origin) => {
		const space = name.split("/")[0];
		let s = spaceSeq.get(space);
		if (!s) spaceSeq.set(space, (s = { seq: 0, changed: new Map() }));
		s.seq++;
		s.changed.set(name, s.seq);
		const r = docs.get(name);
		for (const c of conns) if (c.authed && c !== origin && !r?.subs.has(c)) sendChanges(c, space, s.seq, [name]);
	};

	const dropAw = (ws, name) => {
		const r = docs.get(name);
		if (!r) return;
		const gone = [...r.aw].filter(([, v]) => v.ws === ws);
		if (!gone.length) return;
		for (const [id] of gone) r.aw.delete(id);
		const data = encodeAw(gone.map(([id, v]) => [id, { clock: v.clock + 1, state: "null" }]));
		for (const s of r.subs) sendAw(s, name, data);
	};

	const wss = new WebSocketServer({ port, path: "/ws" });
	wss.on("connection", (ws) => {
		conns.add(ws);
		ws.authed = false;
		ws.on("message", (raw) => {
			const d = decoding.createDecoder(new Uint8Array(raw));
			const type = decoding.readVarUint(d);
			if (!ws.authed) {
				if (type !== 0) return;
				decoding.readVarUint(d);
				const token = decoding.readVarString(d);
				const m = /^tok-([a-z0-9]+)$/.exec(token);
				if (!m) {
					sendErr(ws, 401, "", "Token ungültig");
					return ws.close();
				}
				ws.authed = true;
				ws.user = m[1];
				ws.role = m[1] === "reader" ? "read" : "write";
				const info = {
					user: { id: m[1], name: m[1][0].toUpperCase() + m[1].slice(1), color: COLORS[[...m[1]].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length] },
					spaces: [{ id: "test", name: "Test", role: ws.role }],
				};
				ws.send(frame((e) => (encoding.writeVarUint(e, 1), encoding.writeVarString(e, JSON.stringify(info)))));
				return;
			}
			if (type === 2) {
				const name = decoding.readVarString(d);
				const sub = decoding.readVarUint(d);
				const data = decoding.readVarUint8Array(d);
				const r = room(name);
				if (sub === 0) {
					r.subs.add(ws);
					sendSync(ws, name, 1, Y.encodeStateAsUpdate(r.doc, data));
					sendSync(ws, name, 0, Y.encodeStateVector(r.doc));
					if (r.aw.size) sendAw(ws, name, encodeAw([...r.aw]));
					return;
				}
				if (ws.role === "read") return sendErr(ws, 403, name, "nur Lesezugriff");
				// Achtung: reine Löschungen ändern den State-Vector NICHT – nie anhand des SV verwerfen.
				let changed = false;
				const mark = () => (changed = true);
				r.doc.on("update", mark);
				Y.applyUpdate(r.doc, data);
				r.doc.off("update", mark);
				if (!changed) return;
				for (const s of r.subs) if (s !== ws) sendSync(s, name, 2, data);
				bump(name, ws);
			} else if (type === 3) {
				const name = decoding.readVarString(d);
				const data = decoding.readVarUint8Array(d);
				const r = room(name);
				const ad = decoding.createDecoder(data);
				const n = decoding.readVarUint(ad);
				for (let i = 0; i < n; i++) {
					const id = decoding.readVarUint(ad);
					const clock = decoding.readVarUint(ad);
					const state = decoding.readVarString(ad);
					if (state === "null") r.aw.delete(id);
					else r.aw.set(id, { clock, state, ws });
				}
				for (const s of r.subs) if (s !== ws) sendAw(s, name, data);
			} else if (type === 4) {
				const name = decoding.readVarString(d);
				dropAw(ws, name);
				docs.get(name)?.subs.delete(ws);
			} else if (type === 7) {
				const space = decoding.readVarString(d);
				const since = decoding.readVarUint(d);
				const s = spaceSeq.get(space) ?? { seq: 0, changed: new Map() };
				sendChanges(ws, space, s.seq, [...s.changed].filter(([, q]) => q > since).map(([n]) => n));
			} else if (type === 8) {
				ws.send(frame((e) => encoding.writeVarUint(e, 9)));
			}
		});
		ws.on("close", () => {
			conns.delete(ws);
			for (const [name, r] of docs) {
				if (!r.subs.has(ws)) continue;
				dropAw(ws, name);
				r.subs.delete(ws);
			}
		});
	});
	return new Promise((ok) =>
		wss.on("listening", () => ok({ port: wss.address().port, docs, close: () => new Promise((c) => wss.close(c)) })),
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const s = await startReferenceServer(Number(process.argv[2] ?? 8790));
	console.log(`Referenz-Server auf ws://127.0.0.1:${s.port}/ws`);
}
