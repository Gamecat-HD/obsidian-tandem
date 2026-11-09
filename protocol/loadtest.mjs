// Lasttest gegen den Rust-Server: N Clients × D Docs, zufällige Bearbeitungen + Awareness,
// danach Konvergenz prüfen und RAM messen. Aufruf: node protocol/loadtest.mjs [clients] [docs] [sekunden]
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startRustServer } from "../e2e/rust-server.mjs";

const require = createRequire(resolve(import.meta.dirname, "../plugin/package.json"));
const Y = require("yjs");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const awarenessProto = require("y-protocols/awareness");
const WebSocket = require("ws");
// Wie das Plugin melden: Der Server bedient nur das Plugin mit seiner eigenen Version.
const CLIENT = `tandem-plugin/${require("./manifest.json").version}`;

const [N = 20, D = 50, SECS = 30] = process.argv.slice(2).map(Number);
const REMOTE = Symbol("remote");
const frame = (fn) => {
	const e = encoding.createEncoder();
	fn(e);
	return encoding.toUint8Array(e);
};

class Client {
	constructor(url, token, name) {
		this.docs = new Map();
		this.synced = new Set();
		this.name = name;
		this.ws = new WebSocket(url.replace("http", "ws") + "/ws");
		this.ws.binaryType = "arraybuffer";
		this.ready = new Promise((ok, fail) => {
			this.ws.on("open", () =>
				this.ws.send(frame((e) => (encoding.writeVarUint(e, 0), encoding.writeVarUint(e, 1), encoding.writeVarString(e, token), encoding.writeVarString(e, "load"), encoding.writeVarString(e, CLIENT)))),
			);
			this.ws.on("error", fail);
			this.ws.on("message", (raw) => {
				const d = decoding.createDecoder(new Uint8Array(raw));
				const t = decoding.readVarUint(d);
				if (t === 1) return ok();
				if (t === 2) {
					const name = decoding.readVarString(d);
					const sub = decoding.readVarUint(d);
					const data = decoding.readVarUint8Array(d);
					const x = this.docs.get(name);
					if (!x) return;
					if (sub === 0) this.send(2, name, (e) => (encoding.writeVarUint(e, 1), encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(x.doc, data))));
					else {
						Y.applyUpdate(x.doc, data, REMOTE);
						if (sub === 1) this.synced.add(name);
					}
				} else if (t === 3) {
					const name = decoding.readVarString(d);
					const data = decoding.readVarUint8Array(d);
					const x = this.docs.get(name);
					if (x) awarenessProto.applyAwarenessUpdate(x.aw, data, REMOTE);
				} else if (t === 5) {
					decoding.readVarUint(d);
					console.error("Serverfehler", decoding.readVarString(d), decoding.readVarString(d));
				}
			});
		});
	}
	send(type, doc, fn) {
		if (this.ws.readyState !== 1) return;
		this.ws.send(frame((e) => (encoding.writeVarUint(e, type), encoding.writeVarString(e, doc), fn(e))));
	}
	subscribe(name) {
		const doc = new Y.Doc();
		const aw = new awarenessProto.Awareness(doc);
		this.docs.set(name, { doc, aw });
		doc.on("update", (u, origin) => {
			if (origin !== REMOTE) this.send(2, name, (e) => (encoding.writeVarUint(e, 2), encoding.writeVarUint8Array(e, u)));
		});
		aw.on("update", ({ added, updated, removed }, origin) => {
			if (origin !== REMOTE) this.send(3, name, (e) => encoding.writeVarUint8Array(e, awarenessProto.encodeAwarenessUpdate(aw, [...added, ...updated, ...removed])));
		});
		this.send(2, name, (e) => (encoding.writeVarUint(e, 0), encoding.writeVarUint8Array(e, Y.encodeStateVector(doc))));
	}
	edit() {
		const names = [...this.docs.keys()];
		const name = names[Math.floor(Math.random() * names.length)];
		const { doc, aw } = this.docs.get(name);
		const t = doc.getText("content");
		if (t.length > 200 && Math.random() < 0.4) t.delete(Math.floor(Math.random() * (t.length - 5)), 3);
		else t.insert(Math.floor(Math.random() * (t.length + 1)), `${this.name}${Math.random().toString(36).slice(2, 6)} `);
		aw.setLocalStateField("cursor", { pos: Math.floor(Math.random() * t.length), user: this.name });
	}
	unsubscribeAll() {
		for (const [name, x] of this.docs) {
			x.aw.destroy();
			this.send(4, name, () => {});
		}
	}
}

const server = await startRustServer();
const mib = async () => ((await server.rssKib()) / 1024).toFixed(1);
try {
	console.log(`Server-RSS im Leerlauf: ${await mib()} MiB`);
	const names = ["test", "alice", "bob", "carol"];
	const clients = [];
	for (let i = 0; i < N; i++) {
		const c = new Client(server.url, server.tokens[names[1 + (i % 3)]], `c${i}`);
		await c.ready;
		clients.push(c);
	}
	for (const c of clients) for (let d = 0; d < D; d++) c.subscribe(`test/doc${d}`);
	await sleep(1500);
	console.log(`${N} Clients × ${D} Docs abonniert, RSS: ${await mib()} MiB`);
	let peak = 0;
	const t0 = Date.now();
	let edits = 0;
	while (Date.now() - t0 < SECS * 1000) {
		for (const c of clients) {
			c.edit();
			edits++;
		}
		await sleep(200);
		peak = Math.max(peak, await server.rssKib());
	}
	console.log(`${edits} Bearbeitungen in ${SECS} s (${(edits / SECS).toFixed(0)}/s), RSS-Spitze: ${(peak / 1024).toFixed(1)} MiB`);
	await sleep(3000);
	let diverged = 0;
	for (let d = 0; d < D; d++) {
		const ref = clients[0].docs.get(`test/doc${d}`).doc.getText("content").toString();
		for (const c of clients) if (c.docs.get(`test/doc${d}`).doc.getText("content").toString() !== ref) diverged++;
	}
	console.log(diverged ? `✘ ${diverged} abweichende Doc-Kopien` : `✓ alle ${N * D} Doc-Kopien identisch`);
	// Frischer Client muss denselben Stand aus der Datenbank bekommen
	const fresh = new Client(server.url, server.tokens.alice, "fresh");
	await fresh.ready;
	for (let d = 0; d < D; d++) fresh.subscribe(`test/doc${d}`);
	await sleep(2000);
	let freshBad = 0;
	for (let d = 0; d < D; d++) {
		if (fresh.docs.get(`test/doc${d}`).doc.getText("content").toString() !== clients[0].docs.get(`test/doc${d}`).doc.getText("content").toString()) freshBad++;
	}
	console.log(freshBad ? `✘ ${freshBad} Docs beim Neuladen abweichend` : "✓ neuer Client bekommt identischen Stand");
	for (const c of [...clients, fresh]) {
		c.unsubscribeAll();
		c.ws.close();
	}
	console.log("warte auf Entladen (30 s + Janitor) …");
	await sleep(45000);
	console.log(`RSS nach Entladen: ${await mib()} MiB`);
	console.log(server.cli("stats"));
	if (diverged || freshBad) process.exitCode = 1;
} finally {
	await server.close();
}
