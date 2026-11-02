/**
 * `.ink`-Dateien (Ink Blocks, Format v1) als Y.Doc:
 *   meta:    Y.Map  { head: JSON-Kopf ohne `strokes` }
 *   strokes: Y.Map  { strokeId → Strich als JSON-Zeile, unverändert aus der Datei }
 *   order:   Y.Array<strokeId>
 * Striche sind unveränderlich (siehe mergeInk in Ink Blocks) – Mengenlogik genügt, gleichzeitiges
 * Zeichnen auf derselben Fläche geht nie verloren. Die Kodierung entspricht encodeInk byte-genau.
 */
import * as Y from "yjs";

export interface ParsedInk {
	head: Record<string, unknown>;
	order: string[];
	lines: Map<string, string>;
}

export function parseInk(text: string): ParsedInk {
	const raw = JSON.parse(text) as Record<string, unknown>;
	if (raw?.v !== 1 || !Array.isArray(raw.strokes)) throw new Error("Keine .ink-Datei (v1)");
	const strokes = raw.strokes as { id?: unknown }[];
	delete raw.strokes;
	const order: string[] = [];
	const lines = new Map<string, string>();
	for (const s of strokes) {
		if (typeof s?.id !== "string" || lines.has(s.id)) continue;
		order.push(s.id);
		lines.set(s.id, JSON.stringify(s));
	}
	return { head: raw, order, lines };
}

export function encodeParsed(p: ParsedInk): string {
	const headJson = JSON.stringify(p.head).slice(0, -1);
	const lines = p.order.map((id) => p.lines.get(id)).filter((l): l is string => !!l);
	return `${headJson},"strokes":[${lines.length ? `\n${lines.join(",\n")}\n` : ""}]}\n`;
}

export function inkParts(doc: Y.Doc) {
	return {
		meta: doc.getMap<string>("meta"),
		strokes: doc.getMap<string>("strokes"),
		order: doc.getArray<string>("order"),
	};
}

export function readInkDoc(doc: Y.Doc): ParsedInk | null {
	const { meta, strokes, order } = inkParts(doc);
	const headJson = meta.get("head");
	if (!headJson) return null;
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const id of order.toArray()) {
		if (seen.has(id) || !strokes.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	for (const id of strokes.keys()) if (!seen.has(id)) ids.push(id);
	return { head: JSON.parse(headJson), order: ids, lines: new Map(strokes.entries()) };
}

export function encodeInkDoc(doc: Y.Doc): string | null {
	const p = readInkDoc(doc);
	return p ? encodeParsed(p) : null;
}

const headEq = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Änderungen der Datei (gegenüber `base`) ins Doc übernehmen.
 * Ohne `base` (Datei kennt dieses Gerät noch nicht): nur hinzufügen, nie löschen.
 */
export function applyInkFile(doc: Y.Doc, diskText: string, baseText: string | undefined, origin?: unknown) {
	const disk = parseInk(diskText);
	let base: ParsedInk | null = null;
	if (baseText !== undefined) {
		try {
			base = parseInk(baseText);
		} catch {
			base = null;
		}
	}
	const { meta, strokes, order } = inkParts(doc);
	doc.transact(() => {
		const curHead = meta.get("head");
		if (!curHead) {
			meta.set("head", JSON.stringify(disk.head));
		} else if (!base || !headEq(base.head, disk.head)) {
			const cur = JSON.parse(curHead) as Record<string, unknown>;
			// Höhe wächst nur (Fläche wird beim Schreiben länger) – nie durch einen älteren Stand kürzen.
			const h = Math.max(Number(cur.h) || 0, Number(disk.head.h) || 0);
			const next = base ? { ...disk.head, h } : { ...cur, ...disk.head, h };
			if (!headEq(cur, next)) meta.set("head", JSON.stringify(next));
		}
		for (const id of disk.order) {
			if (base?.lines.has(id)) continue;
			if (!strokes.has(id)) {
				strokes.set(id, disk.lines.get(id)!);
				order.push([id]);
			}
		}
		if (base) {
			for (const id of base.order) {
				if (disk.lines.has(id) || !strokes.has(id)) continue;
				strokes.delete(id);
			}
			// `order` aufräumen, damit es nicht endlos wächst.
			const arr = order.toArray();
			for (let i = arr.length - 1; i >= 0; i--) if (!strokes.has(arr[i])) order.delete(i, 1);
		}
	}, origin);
}
