/**
 * Autorenschaft („Blame“): Wer hat welchen Text geschrieben, und wann?
 *
 * Yjs merkt sich zu jedem Zeichen nur die clientID der Y.Doc-Instanz, die es eingefügt hat (zufällig, neu bei
 * jedem Laden). Damit daraus Personen werden, trägt jedes Gerät seine clientID **im Doc selbst** ein:
 *
 * - `tandem:authors` (Y.Map): clientID → {id, name, color, device} – einmal pro Doc-Instanz, beim ersten Schreiben.
 * - `tandem:marks` (Y.Array): [clientID, clock, Zeit, Quelle] – Zeitmarken. Eine neue Marke höchstens einmal pro
 *   Minute (oder wenn die Quelle wechselt). Alles ab `clock` bis zur nächsten Marke derselben clientID gilt als
 *   zu dieser Zeit geschrieben → Minutengenauigkeit, wenige Bytes pro Minute Schreiben.
 *
 * Beides reist mit dem Doc (auch Ende-zu-Ende-verschlüsselt), der Server muss nichts davon wissen.
 * Text von vor dieser Funktion (oder von Geräten mit älterem Plugin) bleibt „unbekannt“.
 */
import * as Y from "yjs";

export const AUTHORS_KEY = "tandem:authors";
export const MARKS_KEY = "tandem:marks";
/** Origin der eigenen Buchführungs-Transaktionen (werden nicht selbst wieder erfasst). */
export const TRACK = Symbol("tandem-blame");

export interface Author {
	/** Personen-ID auf dem Server */
	id: string;
	name: string;
	color: string;
	/** Gerätename */
	device?: string;
}

/** Herkunft einer Änderung: 0 = im Editor/Plugin, 1 = Datei von außen geändert (Claude Code, git, Ink Blocks …). */
export const Source = { Editor: 0, File: 1 } as const;
export type Source = (typeof Source)[keyof typeof Source];

/** [clientID, clock, Zeit (ms), Quelle] */
export type Mark = [number, number, number, Source];

export interface TrackOptions {
	/** Mindestabstand zwischen zwei Zeitmarken derselben Doc-Instanz (ms). */
	markEvery?: number;
	now?: () => number;
	/** Quelle einer lokalen Transaktion (z. B. DiskBridge → Datei). */
	sourceOf?: (origin: unknown) => Source;
	/** Transaktionen mit diesen Origins sind nicht lokal (z. B. Server-Updates). */
	ignore?: unknown[];
}

/**
 * Lokale Schreibvorgänge an `doc` mit Person und Zeit versehen. `who()` liefert null, solange unbekannt ist,
 * wer angemeldet ist – dann wird (noch) nichts eingetragen; die nächste Änderung holt das nach.
 * Gibt eine Funktion zum Abmelden zurück.
 */
export function trackAuthorship(doc: Y.Doc, who: () => Author | null, opts: TrackOptions = {}): () => void {
	const markEvery = opts.markEvery ?? 60_000;
	const now = opts.now ?? Date.now;
	const ignore = new Set<unknown>([TRACK, ...(opts.ignore ?? [])]);
	const authors = doc.getMap<Author>(AUTHORS_KEY);
	const marks = doc.getArray<Mark>(MARKS_KEY);
	let last: { client: number; ts: number; src: Source } | null = null;
	let registered = -1;

	const onAfter = (tr: Y.Transaction) => {
		if (!tr.local || ignore.has(tr.origin)) return;
		const client = doc.clientID;
		const before = tr.beforeState.get(client) ?? 0;
		const after = tr.afterState.get(client) ?? 0;
		if (after <= before) return; // nichts Neues geschrieben (z. B. nur gelöscht)
		let content = false;
		for (const t of tr.changed.keys()) if (t !== (authors as unknown) && t !== (marks as unknown)) content = true;
		if (!content) return;
		const me = who();
		if (!me) return;
		const ts = now();
		const src = opts.sourceOf?.(tr.origin) ?? Source.Editor;
		const needAuthor = registered !== client && !sameAuthor(authors.get(String(client)), me);
		const needMark = !last || last.client !== client || last.src !== src || ts - last.ts >= markEvery;
		if (!needAuthor && !needMark) return;
		doc.transact(() => {
			if (needAuthor) authors.set(String(client), { id: me.id, name: me.name, color: me.color, ...(me.device ? { device: me.device } : {}) });
			if (needMark) marks.push([[client, before, ts, src]]);
		}, TRACK);
		registered = client;
		if (needMark) last = { client, ts, src };
	};
	doc.on("afterTransaction", onAfter);
	return () => doc.off("afterTransaction", onAfter);
}

function sameAuthor(a: Author | undefined, b: Author) {
	return !!a && a.id === b.id && a.name === b.name && a.device === b.device;
}

// ── Auswerten ──────────────────────────────────────────────────────────

/** Ein zusammenhängendes Stück Text von derselben Doc-Instanz. */
export interface Run {
	from: number;
	to: number;
	client: number;
	clock: number;
}

/** Sichtbaren Text in Stücke nach Herkunft zerlegen (Position, clientID, clock des ersten Zeichens). */
export function textRuns(ytext: Y.Text): Run[] {
	const runs: Run[] = [];
	let pos = 0;
	// _start ist intern, aber stabil (y-codemirror.next & Co. nutzen es ebenso).
	for (let item = (ytext as unknown as { _start: Y.Item | null })._start; item; item = item.right) {
		if (item.deleted || !item.countable) continue;
		const len = item.length;
		const prev = runs[runs.length - 1];
		// Benachbarte Items derselben Instanz mit fortlaufender clock zusammenfassen
		if (prev && prev.to === pos && prev.client === item.id.client && prev.clock + (prev.to - prev.from) === item.id.clock) prev.to += len;
		else runs.push({ from: pos, to: pos + len, client: item.id.client, clock: item.id.clock });
		pos += len;
	}
	return runs;
}

export interface Who {
	author: Author | null;
	/** Zeitpunkt (ms), sofern eine Zeitmarke existiert */
	ts: number | null;
	src: Source;
	/** Kennung der Änderung (Instanz + Zeitmarke) – gleiche Kennung = derselbe Schreibvorgang */
	key: string;
}

/** Zuordnung clientID/clock → Person + Zeit, aus den im Doc gespeicherten Angaben. */
export class AuthorLookup {
	private authors: Map<number, Author>;
	private marks = new Map<number, Mark[]>();

	constructor(doc: Y.Doc, extra?: (client: number) => Author | undefined) {
		this.authors = new Map();
		for (const [k, v] of doc.getMap<Author>(AUTHORS_KEY)) this.authors.set(Number(k), v);
		for (const m of doc.getArray<Mark>(MARKS_KEY)) {
			if (!Array.isArray(m) || m.length < 3) continue;
			let list = this.marks.get(m[0]);
			if (!list) this.marks.set(m[0], (list = []));
			list.push(m);
		}
		for (const list of this.marks.values()) list.sort((a, b) => a[1] - b[1]);
		this.extra = extra;
	}
	private extra?: (client: number) => Author | undefined;

	who(client: number, clock: number): Who {
		const author = this.authors.get(client) ?? this.extra?.(client) ?? null;
		const list = this.marks.get(client);
		let mark: Mark | undefined;
		if (list) {
			// letzte Marke mit clock ≤ gesuchter clock (binäre Suche)
			let lo = 0;
			let hi = list.length - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (list[mid][1] <= clock) {
					mark = list[mid];
					lo = mid + 1;
				} else hi = mid - 1;
			}
		}
		return { author, ts: mark ? mark[2] : null, src: mark?.[3] ?? Source.Editor, key: `${client}:${mark ? mark[1] : "-"}` };
	}
}

export interface LineBlame {
	/** Zeilennummer, ab 1 */
	line: number;
	who: Who;
	/** Weitere Personen, die in dieser Zeile noch sichtbaren Text haben */
	others: Author[];
	/** Anteil unbekannter Herkunft (0..1) */
	unknown: number;
}

/**
 * Pro Zeile die letzte Änderung bestimmen – wie `git blame`: Gewinner ist das Stück mit der jüngsten Zeitmarke;
 * ohne Zeitmarken das größte Stück. Leere Zeilen bekommen keinen Eintrag. Der Zeilenumbruch selbst zählt nicht
 * zur Zeile (sonst „gehörte“ eine Zeile jedem, der dahinter Enter drückt).
 */
export function blameLines(text: string, runs: Run[], lookup: AuthorLookup): LineBlame[] {
	const out: LineBlame[] = [];
	const cache = new Map<string, Who>();
	const whoOf = (client: number, clock: number) => {
		const k = `${client}:${clock}`;
		let w = cache.get(k);
		if (!w) cache.set(k, (w = lookup.who(client, clock)));
		return w;
	};
	let r = 0;
	let start = 0;
	let line = 1;
	while (start <= text.length) {
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		if (end > start) {
			while (r < runs.length && runs[r].to <= start) r++;
			let best: { who: Who; len: number } | null = null;
			const others = new Map<string, Author>();
			let unknown = 0;
			for (let i = r; i < runs.length && runs[i].from < end; i++) {
				const run = runs[i];
				const from = Math.max(run.from, start);
				const to = Math.min(run.to, end);
				if (to <= from) continue;
				// Innerhalb eines Stücks steigt die clock; mehrere Zeitmarken möglich → jüngstes Zeichen maßgeblich
				const w = whoOf(run.client, run.clock + (to - 1 - run.from));
				const len = to - from;
				if (!w.author) unknown += len;
				else others.set(w.author.id, w.author);
				if (!best || newer(w, len, best.who, best.len)) best = { who: w, len };
			}
			if (best) {
				if (best.who.author) others.delete(best.who.author.id);
				out.push({ line, who: best.who, others: [...others.values()], unknown: unknown / (end - start) });
			}
		}
		start = end + 1;
		line++;
	}
	return out;
}

function newer(a: Who, aLen: number, b: Who, bLen: number) {
	if (a.ts !== null && b.ts !== null) return a.ts !== b.ts ? a.ts > b.ts : aLen > bLen;
	if (a.ts !== null) return true;
	if (b.ts !== null) return false;
	if (!!a.author !== !!b.author) return !!a.author;
	return aLen > bLen;
}

/** „jetzt“, „vor 5 Min.“, „vor 3 Std.“, „gestern“, „vor 4 Tagen“, sonst Datum. */
export function relativeTime(ts: number, now = Date.now()): string {
	const s = Math.max(0, (now - ts) / 1000);
	if (s < 60) return "jetzt";
	if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
	if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
	const days = Math.floor(s / 86400);
	if (days === 1) return "gestern";
	if (days < 7) return `vor ${days} Tagen`;
	const d = new Date(ts);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return d.toLocaleDateString("de-DE", sameYear ? { day: "2-digit", month: "2-digit" } : { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function formatTime(ts: number): string {
	return new Date(ts).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
