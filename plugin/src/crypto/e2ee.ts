/**
 * Ende-zu-Ende-Verschlüsselung eines Space (docs/E2EE.md).
 *
 * Passphrase → PBKDF2-SHA256 (600 000 Runden, Salz vom Server) → Hauptschlüssel → per HKDF:
 * - `doc`:  AES-256-GCM für Yjs-Updates, verdichtete Stände, Awareness und den Prüfwert
 * - `blob`: AES-256-GCM für Anhänge
 * - `biv`:  HMAC-SHA256, leitet die IV eines Anhangs aus dessen Klartext-Hash ab (deterministisch:
 *           gleicher Inhalt → gleicher Chiffretext → Server kann weiter deduplizieren und den Hash prüfen)
 *
 * Format jedes Chiffretexts: `0x01 | IV (12 Byte) | AES-GCM(Daten) inkl. 16-Byte-Tag`.
 * Die AAD bindet ihn an seinen Ort (Doc-Name, Space), damit der Server nichts vertauschen kann.
 * Nur WebCrypto – läuft auf Desktop, Android und iOS.
 */
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { E2eeParams } from "../net/protocol";

export const KDF_ITER = 600_000;
const VERSION = 1;
const te = new TextEncoder();
const td = new TextDecoder();

export function b64(data: Uint8Array): string {
	let s = "";
	for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
	return btoa(s);
}

export function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

export class DecryptError extends Error {}

export class SpaceKey {
	private constructor(
		readonly space: string,
		private doc: CryptoKey,
		private blob: CryptoKey,
		private biv: CryptoKey,
		/** Rohschlüssel – nur zum Zwischenspeichern auf diesem Gerät (localStorage). */
		readonly raw: Uint8Array,
	) {}

	/** Aus der Passphrase ableiten (dauert je nach Gerät 0,3–2 s). */
	static async derive(space: string, passphrase: string, params: Pick<E2eeParams, "salt" | "iter">): Promise<SpaceKey> {
		const base = await crypto.subtle.importKey("raw", te.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
		const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(unb64(params.salt)), iterations: params.iter }, base, 256);
		return SpaceKey.fromRaw(space, new Uint8Array(bits));
	}

	static async fromRaw(space: string, raw: Uint8Array): Promise<SpaceKey> {
		const master = await crypto.subtle.importKey("raw", buf(raw), "HKDF", false, ["deriveKey"]);
		const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(`tandem-e2ee-v1 ${info}`) });
		const aes = { name: "AES-GCM", length: 256 };
		const [doc, blob, biv] = await Promise.all([
			crypto.subtle.deriveKey(hkdf("doc"), master, aes, false, ["encrypt", "decrypt"]),
			crypto.subtle.deriveKey(hkdf("blob"), master, aes, false, ["encrypt", "decrypt"]),
			crypto.subtle.deriveKey(hkdf("blob-iv"), master, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]),
		]);
		return new SpaceKey(space, doc, blob, biv, raw);
	}

	private static async seal(key: CryptoKey, data: Uint8Array, aad: string, iv?: Uint8Array): Promise<Uint8Array> {
		iv ??= crypto.getRandomValues(new Uint8Array(12));
		const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: te.encode(aad) }, key, buf(data)));
		const out = new Uint8Array(13 + ct.length);
		out[0] = VERSION;
		out.set(iv, 1);
		out.set(ct, 13);
		return out;
	}

	private static async open(key: CryptoKey, data: Uint8Array, aad: string): Promise<Uint8Array> {
		if (data.length < 29 || data[0] !== VERSION) throw new DecryptError("Unbekanntes Format");
		try {
			return new Uint8Array(
				await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(data.subarray(1, 13)), additionalData: te.encode(aad) }, key, buf(data.subarray(13))),
			);
		} catch {
			throw new DecryptError("Entschlüsseln fehlgeschlagen (falsche Passphrase oder veränderte Daten)");
		}
	}

	/** Yjs-Update bzw. verdichteter Stand eines Docs (`<space>/<docId>`). */
	sealDoc(docName: string, data: Uint8Array) {
		return SpaceKey.seal(this.doc, data, `doc:${docName}`);
	}
	openDoc(docName: string, data: Uint8Array) {
		return SpaceKey.open(this.doc, data, `doc:${docName}`);
	}

	/**
	 * Awareness-Update (y-protocols): Zustände einzeln verschlüsseln, `null` (= entfernt) bleibt lesbar,
	 * damit der Server verlassene Einträge erkennt und eigene Löschungen schicken kann.
	 */
	async sealAwareness(docName: string, update: Uint8Array): Promise<Uint8Array> {
		const d = decoding.createDecoder(update);
		const e = encoding.createEncoder();
		const n = decoding.readVarUint(d);
		encoding.writeVarUint(e, n);
		for (let i = 0; i < n; i++) {
			encoding.writeVarUint(e, decoding.readVarUint(d));
			encoding.writeVarUint(e, decoding.readVarUint(d));
			const state = decoding.readVarString(d);
			encoding.writeVarString(e, state === "null" ? state : JSON.stringify("e1:" + b64(await SpaceKey.seal(this.doc, te.encode(state), `aw:${docName}`))));
		}
		return encoding.toUint8Array(e);
	}

	/** Gegenstück zu `sealAwareness`. Unverschlüsselte Zustände (außer `null`) werden verworfen. */
	async openAwareness(docName: string, update: Uint8Array): Promise<Uint8Array> {
		const d = decoding.createDecoder(update);
		const out: [number, number, string][] = [];
		const n = decoding.readVarUint(d);
		for (let i = 0; i < n; i++) {
			const client = decoding.readVarUint(d);
			const clock = decoding.readVarUint(d);
			const state = decoding.readVarString(d);
			if (state === "null") {
				out.push([client, clock, state]);
				continue;
			}
			try {
				const s = JSON.parse(state) as unknown;
				if (typeof s !== "string" || !s.startsWith("e1:")) continue;
				out.push([client, clock, td.decode(await SpaceKey.open(this.doc, unb64(s.slice(3)), `aw:${docName}`))]);
			} catch {
				/* fremder/defekter Eintrag */
			}
		}
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, out.length);
		for (const [c, k, s] of out) {
			encoding.writeVarUint(e, c);
			encoding.writeVarUint(e, k);
			encoding.writeVarString(e, s);
		}
		return encoding.toUint8Array(e);
	}

	/** Anhang verschlüsseln. Liefert den Chiffretext und seine Adresse auf dem Server (SHA-256 des Chiffretexts). */
	async sealBlob(data: Uint8Array, plainHash: string): Promise<{ data: Uint8Array; ehash: string }> {
		const iv = new Uint8Array(await crypto.subtle.sign("HMAC", this.biv, te.encode(`${this.space}:${plainHash}`))).slice(0, 12);
		const sealed = await SpaceKey.seal(this.blob, data, `blob:${this.space}`, iv);
		return { data: sealed, ehash: await sha256(sealed) };
	}
	openBlob(data: Uint8Array) {
		return SpaceKey.open(this.blob, data, `blob:${this.space}`);
	}

	/** Prüfwert für die Schlüsselparameter: zeigt anderen Geräten, ob ihre Passphrase stimmt. */
	async makeCheck(): Promise<string> {
		return b64(await SpaceKey.seal(this.doc, te.encode("tandem-e2ee-check"), `check:${this.space}`));
	}
	async verifyCheck(check: string): Promise<boolean> {
		try {
			return td.decode(await SpaceKey.open(this.doc, unb64(check), `check:${this.space}`)) === "tandem-e2ee-check";
		} catch {
			return false;
		}
	}
}

async function sha256(data: Uint8Array): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(data)));
	return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Neue Schlüsselparameter für einen Space (Besitzer legt die Passphrase fest). */
export async function createParams(space: string, passphrase: string, iter = KDF_ITER): Promise<{ params: E2eeParams; key: SpaceKey }> {
	const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
	const key = await SpaceKey.derive(space, passphrase, { salt, iter });
	return { params: { v: 1, kdf: "pbkdf2-sha256", iter, salt, check: await key.makeCheck() }, key };
}

/** Passphrase prüfen und den Schlüssel ableiten – null, wenn sie nicht stimmt. */
export async function unlock(space: string, passphrase: string, params: E2eeParams): Promise<SpaceKey | null> {
	const key = await SpaceKey.derive(space, passphrase, params);
	return (await key.verifyCheck(params.check)) ? key : null;
}
