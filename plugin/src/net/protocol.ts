/**
 * Tandem-Protokoll v1 (siehe docs/PROTOKOLL.md). Reine Kodierung, kein I/O – wird auch vom
 * Referenz-Server (protocol/reference-server.mjs) und den Testvektoren verwendet.
 */
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export const PROTOCOL_VERSION = 1;

export const enum Msg {
	Hello = 0,
	Welcome = 1,
	Sync = 2,
	Awareness = 3,
	Unsub = 4,
	Error = 5,
	Changes = 6,
	Catchup = 7,
	Ping = 8,
	Pong = 9,
	// Ende-zu-Ende-verschlüsselte Spaces (docs/E2EE.md): der Server führt nur ein Log aus Chiffretext.
	ESub = 10,
	ELog = 11,
	EUpd = 12,
	EAck = 13,
	ECompact = 14,
}

export const enum SyncSub {
	Step1 = 0,
	Step2 = 1,
	Update = 2,
}

/** Öffentliche Schlüsselparameter eines verschlüsselten Space (Passphrase und Schlüssel bleiben auf den Geräten). */
export interface E2eeParams {
	v: 1;
	kdf: "pbkdf2-sha256";
	iter: number;
	salt: string;
	/** Mit dem Schlüssel verschlüsselter Prüfwert – zeigt, ob eine eingegebene Passphrase stimmt. */
	check: string;
}

export interface WelcomeSpace {
	id: string;
	name: string;
	role: "owner" | "write" | "read";
	/** fehlt = Klartext, "pending" = Besitzer muss die Passphrase noch festlegen */
	e2ee?: E2eeParams | "pending";
}

export interface WelcomeInfo {
	user: { id: string; name: string; color: string };
	spaces: WelcomeSpace[];
}

export type Frame =
	| { type: Msg.Hello; version: number; token: string; device: string }
	| { type: Msg.Welcome; info: WelcomeInfo }
	| { type: Msg.Sync; doc: string; sub: SyncSub; data: Uint8Array }
	| { type: Msg.Awareness; doc: string; data: Uint8Array }
	| { type: Msg.Unsub; doc: string }
	| { type: Msg.Error; code: number; doc: string; message: string }
	| { type: Msg.Changes; space: string; seq: number; docs: string[] }
	| { type: Msg.Catchup; space: string; since: number }
	| { type: Msg.Ping }
	| { type: Msg.Pong }
	| { type: Msg.ESub; doc: string; since: number }
	| { type: Msg.ELog; doc: string; total: number; rows: { id: number; data: Uint8Array }[] }
	| { type: Msg.EUpd; doc: string; id: number; data: Uint8Array }
	| { type: Msg.EAck; doc: string; id: number }
	| { type: Msg.ECompact; doc: string; upto: number; data: Uint8Array };

export function encodeFrame(f: Frame): Uint8Array {
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, f.type);
	switch (f.type) {
		case Msg.Hello:
			encoding.writeVarUint(e, f.version);
			encoding.writeVarString(e, f.token);
			encoding.writeVarString(e, f.device);
			break;
		case Msg.Welcome:
			encoding.writeVarString(e, JSON.stringify(f.info));
			break;
		case Msg.Sync:
			encoding.writeVarString(e, f.doc);
			encoding.writeVarUint(e, f.sub);
			encoding.writeVarUint8Array(e, f.data);
			break;
		case Msg.Awareness:
			encoding.writeVarString(e, f.doc);
			encoding.writeVarUint8Array(e, f.data);
			break;
		case Msg.Unsub:
			encoding.writeVarString(e, f.doc);
			break;
		case Msg.Error:
			encoding.writeVarUint(e, f.code);
			encoding.writeVarString(e, f.doc);
			encoding.writeVarString(e, f.message);
			break;
		case Msg.Changes:
			encoding.writeVarString(e, f.space);
			encoding.writeVarUint(e, f.seq);
			encoding.writeVarUint(e, f.docs.length);
			for (const d of f.docs) encoding.writeVarString(e, d);
			break;
		case Msg.Catchup:
			encoding.writeVarString(e, f.space);
			encoding.writeVarUint(e, f.since);
			break;
		case Msg.Ping:
		case Msg.Pong:
			break;
		case Msg.ESub:
			encoding.writeVarString(e, f.doc);
			encoding.writeVarUint(e, f.since);
			break;
		case Msg.ELog:
			encoding.writeVarString(e, f.doc);
			encoding.writeVarUint(e, f.total);
			encoding.writeVarUint(e, f.rows.length);
			for (const r of f.rows) {
				encoding.writeVarUint(e, r.id);
				encoding.writeVarUint8Array(e, r.data);
			}
			break;
		case Msg.EUpd:
			// Client → Server ohne ID (id = 0 wird nicht geschrieben), Server → Client mit Zeilen-ID
			encoding.writeVarString(e, f.doc);
			if (f.id) encoding.writeVarUint(e, f.id);
			encoding.writeVarUint8Array(e, f.data);
			break;
		case Msg.EAck:
			encoding.writeVarString(e, f.doc);
			encoding.writeVarUint(e, f.id);
			break;
		case Msg.ECompact:
			encoding.writeVarString(e, f.doc);
			encoding.writeVarUint(e, f.upto);
			encoding.writeVarUint8Array(e, f.data);
			break;
	}
	return encoding.toUint8Array(e);
}

export class ProtocolError extends Error {}

export function decodeFrame(buf: Uint8Array): Frame {
	try {
		const d = decoding.createDecoder(buf);
		const type = decoding.readVarUint(d);
		switch (type) {
			case Msg.Hello:
				return { type, version: decoding.readVarUint(d), token: decoding.readVarString(d), device: decoding.readVarString(d) };
			case Msg.Welcome:
				return { type, info: JSON.parse(decoding.readVarString(d)) as WelcomeInfo };
			case Msg.Sync: {
				const doc = decoding.readVarString(d);
				const sub = decoding.readVarUint(d);
				if (sub > 2) throw new ProtocolError(`Unbekannter Sync-Typ ${sub}`);
				return { type, doc, sub, data: decoding.readVarUint8Array(d) };
			}
			case Msg.Awareness:
				return { type, doc: decoding.readVarString(d), data: decoding.readVarUint8Array(d) };
			case Msg.Unsub:
				return { type, doc: decoding.readVarString(d) };
			case Msg.Error:
				return { type, code: decoding.readVarUint(d), doc: decoding.readVarString(d), message: decoding.readVarString(d) };
			case Msg.Changes: {
				const space = decoding.readVarString(d);
				const seq = decoding.readVarUint(d);
				const n = decoding.readVarUint(d);
				const docs: string[] = [];
				for (let i = 0; i < n; i++) docs.push(decoding.readVarString(d));
				return { type, space, seq, docs };
			}
			case Msg.Catchup:
				return { type, space: decoding.readVarString(d), since: decoding.readVarUint(d) };
			case Msg.Ping:
			case Msg.Pong:
				return { type };
			// Nur Server → Client (EUPD mit Zeilen-ID)
			case Msg.ELog: {
				const doc = decoding.readVarString(d);
				const total = decoding.readVarUint(d);
				const n = decoding.readVarUint(d);
				const rows: { id: number; data: Uint8Array }[] = [];
				for (let i = 0; i < n; i++) rows.push({ id: decoding.readVarUint(d), data: decoding.readVarUint8Array(d) });
				return { type, doc, total, rows };
			}
			case Msg.EUpd:
				return { type, doc: decoding.readVarString(d), id: decoding.readVarUint(d), data: decoding.readVarUint8Array(d) };
			case Msg.EAck:
				return { type, doc: decoding.readVarString(d), id: decoding.readVarUint(d) };
			default:
				throw new ProtocolError(`Unbekannter Frame-Typ ${type}`);
		}
	} catch (e) {
		if (e instanceof ProtocolError) throw e;
		throw new ProtocolError(`Frame nicht lesbar: ${(e as Error).message}`);
	}
}

/** `<space>/<docId>` */
export const docName = (space: string, docId: string) => `${space}/${docId}`;
export const INDEX_DOC = "_index";
export function splitDocName(name: string): { space: string; docId: string } {
	const i = name.indexOf("/");
	return i < 0 ? { space: "", docId: name } : { space: name.slice(0, i), docId: name.slice(i + 1) };
}
