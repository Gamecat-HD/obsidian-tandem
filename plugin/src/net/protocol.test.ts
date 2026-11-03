import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeFrame, encodeFrame, Msg, type Frame } from "./protocol";

/** Gemeinsame Testvektoren mit dem Rust-Server (server/src/codec.rs liest dieselbe Datei). */
const FILE = resolve(__dirname, "../../../protocol/vectors.json");

const frames: [string, Frame][] = [
	["hello", { type: Msg.Hello, version: 1, token: "abc123", device: "iPad Pro ✏️" }],
	["welcome", { type: Msg.Welcome, info: { user: { id: "u", name: "Ünal", color: "#e5534b" }, spaces: [{ id: "s", name: "S", role: "write" }] } }],
	["sync-step1", { type: Msg.Sync, doc: "space/_index", sub: 0, data: new Uint8Array([0]) }],
	["sync-update", { type: Msg.Sync, doc: "space/abc", sub: 2, data: new Uint8Array(300).map((_, i) => i % 256) }],
	["awareness", { type: Msg.Awareness, doc: "space/abc", data: new Uint8Array([1, 200, 1, 3, 2, 123, 125]) }],
	["unsub", { type: Msg.Unsub, doc: "space/abc" }],
	["error", { type: Msg.Error, code: 403, doc: "space/abc", message: "kein Zugriff" }],
	["changes", { type: Msg.Changes, space: "space", seq: 70000, docs: ["space/a", "space/b"] }],
	["catchup", { type: Msg.Catchup, space: "space", since: 129 }],
	["ping", { type: Msg.Ping }],
	["pong", { type: Msg.Pong }],
	["elog", { type: Msg.ELog, doc: "space/abc", total: 3, rows: [{ id: 7, data: new Uint8Array([1, 2]) }, { id: 300, data: new Uint8Array([3]) }] }],
	["eupd-server", { type: Msg.EUpd, doc: "space/abc", id: 300, data: new Uint8Array([9, 8, 7]) }],
	["eack", { type: Msg.EAck, doc: "space/abc", id: 300 }],
];

/** Nur Client → Server (der Client dekodiert sie nicht selbst; der Rust-Server prüft sie). */
const clientOnly: [string, Frame][] = [
	["esub", { type: Msg.ESub, doc: "space/abc", since: 300 }],
	["eupd-client", { type: Msg.EUpd, doc: "space/abc", id: 0, data: new Uint8Array([9, 8, 7]) }],
	["ecompact", { type: Msg.ECompact, doc: "space/abc", upto: 300, data: new Uint8Array([5, 6]) }],
];

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("Protokoll-Testvektoren", () => {
	const current = Object.fromEntries([...frames, ...clientOnly].map(([k, f]) => [k, hex(encodeFrame(f))]));
	if (process.env.UPDATE_VECTORS) writeFileSync(FILE, JSON.stringify(current, null, "\t") + "\n");
	const stored = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
	for (const [name, f] of frames) {
		it(name, () => {
			expect(current[name]).toBe(stored[name]);
			const back = decodeFrame(new Uint8Array(Buffer.from(stored[name], "hex")));
			expect(JSON.stringify(back)).toBe(JSON.stringify(f));
		});
	}
	for (const [name] of clientOnly) it(name, () => expect(current[name]).toBe(stored[name]));
	it("lehnt Unsinn ab", () => {
		expect(() => decodeFrame(new Uint8Array([99]))).toThrow();
		expect(() => decodeFrame(new Uint8Array([2, 5, 97]))).toThrow();
	});
});
