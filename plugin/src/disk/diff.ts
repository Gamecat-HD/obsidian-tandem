import diff from "fast-diff";
import type * as Y from "yjs";

/**
 * Überträgt den Unterschied alt → neu als minimale Einfüge-/Löschoperationen in ein Y.Text.
 * So bleiben gleichzeitige Änderungen anderer erhalten (kein Komplett-Ersetzen).
 * Gibt zurück, ob sich etwas geändert hat.
 */
export function applyTextDiff(ytext: Y.Text, from: string, to: string, origin?: unknown): boolean {
	if (from === to) return false;
	const parts = diff(from, to);
	const doc = ytext.doc;
	const run = () => {
		let pos = 0;
		for (const [op, str] of parts) {
			if (op === diff.EQUAL) pos += str.length;
			else if (op === diff.DELETE) ytext.delete(pos, str.length);
			else {
				ytext.insert(pos, str);
				pos += str.length;
			}
		}
	};
	if (doc) doc.transact(run, origin);
	else run();
	return true;
}

/** Gleiche Operationen als CodeMirror-ChangeSpec-Liste (für den Editor). */
export function textChanges(from: string, to: string): { from: number; to: number; insert: string }[] {
	const out: { from: number; to: number; insert: string }[] = [];
	let pos = 0;
	for (const [op, str] of diff(from, to)) {
		if (op === diff.EQUAL) pos += str.length;
		else if (op === diff.DELETE) {
			out.push({ from: pos, to: pos + str.length, insert: "" });
			pos += str.length;
		} else out.push({ from: pos, to: pos, insert: str });
	}
	return out;
}

/**
 * Ersetzung `old` → `neu` als Folge kleiner Schritte (Positionen relativ zum Anfang, nacheinander anzuwenden),
 * wenn beide Texte überwiegend gleich sind. Sonst `null` (dann bleibt es beim einfachen Ersetzen,
 * z. B. beim Überschreiben einer Markierung mit ganz anderem Text).
 */
export function minimalReplace(old: string, neu: string): { from: number; to: number; insert: string }[] | null {
	if (old === neu) return [];
	if (old.length + neu.length > 1_000_000) return null; // Diff zu teuer; einfach ersetzen
	const parts = diff(old, neu);
	let same = 0;
	for (const [op, s] of parts) if (op === diff.EQUAL) same += s.length;
	if (same * 2 < Math.max(old.length, neu.length)) return null;
	const out: { from: number; to: number; insert: string }[] = [];
	let pos = 0;
	for (const [op, s] of parts) {
		if (op === diff.EQUAL) pos += s.length;
		else if (op === diff.DELETE) out.push({ from: pos, to: pos + s.length, insert: "" });
		else {
			out.push({ from: pos, to: pos, insert: s });
			pos += s.length;
		}
	}
	return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
	const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
