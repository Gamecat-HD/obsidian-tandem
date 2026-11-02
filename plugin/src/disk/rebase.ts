import diff from "fast-diff";

export interface Edit {
	from: number;
	to: number;
	insert: string;
}

/** Bearbeitungen, die `base` in `target` überführen (Positionen in `base`). */
export function editsBetween(base: string, target: string): Edit[] {
	const out: Edit[] = [];
	let pos = 0;
	for (const [op, str] of diff(base, target)) {
		if (op === diff.EQUAL) pos += str.length;
		else if (op === diff.DELETE) {
			const last = out.at(-1);
			if (last && last.to === pos && last.from === pos && last.insert) last.to = pos + str.length;
			else out.push({ from: pos, to: pos + str.length, insert: "" });
			pos += str.length;
		} else {
			const last = out.at(-1);
			if (last && last.to === pos) last.insert += str;
			else out.push({ from: pos, to: pos, insert: str });
		}
	}
	return out;
}

/**
 * Bildet eine Position in `base` auf `other` ab (beide Texte stammen von `base` ab).
 * `assoc` < 0: bei Einfügungen in `other` genau an dieser Stelle davor bleiben, sonst dahinter.
 */
function mapper(base: string, other: string) {
	const parts = diff(base, other);
	return (p: number, assoc = -1): number => {
		let b = 0;
		let o = 0;
		for (const [op, str] of parts) {
			const len = str.length;
			if (op === diff.EQUAL) {
				if (p <= b + len) return o + (p - b);
				b += len;
				o += len;
			} else if (op === diff.DELETE) {
				if (p < b + len) return o; // Bereich in `other` gelöscht → auf den Anfang kollabieren
				b += len;
			} else {
				if (p === b && assoc < 0) return o;
				o += len;
			}
		}
		return o + (p - b);
	};
}

/**
 * 3-Wege-Zusammenführung: Die Änderungen base → `mine` werden auf `theirs` übertragen.
 * Beide Seiten bleiben erhalten; überlappen Löschungen, wird nur gelöscht, was in `theirs` noch existiert.
 * Liefert die Bearbeitungen relativ zu `theirs` (absteigend sortiert, direkt anwendbar).
 */
export function rebaseEdits(base: string, mine: string, theirs: string): Edit[] {
	const map = mapper(base, theirs);
	const edits = editsBetween(base, mine).map((e) => {
		const from = map(e.from, -1);
		const to = Math.max(from, map(e.to, -1));
		return { from, to, insert: e.insert };
	});
	return edits.sort((a, b) => b.from - a.from || b.to - a.to);
}

export function applyEdits(text: string, edits: Edit[]): string {
	let out = text;
	for (const e of edits) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
	return out;
}

/** 3-Wege-Merge als Text. */
export function merge3(base: string, mine: string, theirs: string): string {
	if (mine === base) return theirs;
	if (theirs === base) return mine;
	if (mine === theirs) return mine;
	return applyEdits(theirs, rebaseEdits(base, mine, theirs));
}
