/**
 * Autorenschaft („Blame“): Wer hat welchen Text (bzw. welchen Strich) geschrieben, und wann?
 *
 * Yjs merkt sich zu jedem Element nur die clientID der Y.Doc-Instanz, die es eingefügt hat (zufällig, neu bei
 * jedem Laden). Damit daraus Personen werden, trägt jedes Gerät seine clientID **im Doc selbst** ein.
 * Kompaktes Format (ab 0.9):
 *
 * - `tandem:p` (Y.Map): Personen-ID → [Name, Farbe] – einmal pro Person und Doc.
 * - `tandem:a` (Y.Map): clientID → [Personen-ID, Gerät?] – einmal pro Doc-Instanz, beim ersten Schreiben.
 * - `tandem:t` (Y.Array): Zeitmarken [clock, Sekunde, Quelle?]. Die clientID steckt in der Yjs-ID des
 *   Array-Elements selbst (die Marke schreibt dieselbe Instanz wie den Text). Alles ab `clock` bis zur nächsten
 *   Marke derselben Instanz gilt als zu dieser Zeit geschrieben. Sekunden zählen ab 2026-01-01 → kleine
 *   Ganzzahlen (Varint statt Float64). Neue Marke nur nach einer Schreibpause (≥ PAUSE_MS), spätestens alle
 *   SESSION_MS bei Dauerschreiben, oder wenn die Quelle wechselt. Jede Marke unterbricht die Textstücke der
 *   Instanz (eigenes Yjs-Item, ~25 Byte) – daher so selten; die Zeit stimmt auf ±SESSION_MS.
 *   Logische Uhr: Wer nach fremden Änderungen schreibt, setzt (höchstens alle REMOTE_MARK_MS) eine neue Marke,
 *   die mindestens 1 s nach der jüngsten bekannten fremden Marke liegt. So bleibt „wer zuletzt?“ auch beim
 *   schnellen gemeinsamen Schreiben und bei falsch gehenden Geräteuhren richtig.
 *
 * Gelesen wird auch das Format von 0.8.0 (`tandem:authors` mit Objekten, `tandem:marks` mit [client, clock, ms, src]).
 * Beides reist mit dem Doc (auch Ende-zu-Ende-verschlüsselt), der Server muss nichts davon wissen.
 */
import * as Y from "yjs";

export const PEOPLE_KEY = "tandem:p";
export const AUTHORS_KEY = "tandem:a";
export const TIMES_KEY = "tandem:t";
/** Format 0.8.0 (nur noch gelesen) */
export const LEGACY_AUTHORS_KEY = "tandem:authors";
export const LEGACY_MARKS_KEY = "tandem:marks";
export const META_KEYS = [PEOPLE_KEY, AUTHORS_KEY, TIMES_KEY, LEGACY_AUTHORS_KEY, LEGACY_MARKS_KEY];

/** Neue Zeitmarke nach so langer Schreibpause … */
export const PAUSE_MS = 2 * 60_000;
/** … und spätestens nach so langem Dauerschreiben. */
export const SESSION_MS = 10 * 60_000;
/** Nach fremden Änderungen frühestens so bald wieder eine Marke (logische Uhr, siehe oben). */
export const REMOTE_MARK_MS = 3000;

/** Origin der eigenen Buchführungs-Transaktionen (werden nicht selbst wieder erfasst). */
export const TRACK = Symbol("tandem-blame");

/** 2026-01-01T00:00:00Z in Sekunden */
const EPOCH_S = 1_767_225_600;
export const toSec = (ms: number) => Math.floor(ms / 1000) - EPOCH_S;
export const fromSec = (s: number) => (s + EPOCH_S) * 1000;

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

export interface TrackOptions {
	now?: () => number;
	/** Quelle einer lokalen Transaktion (z. B. DiskBridge → Datei). */
	sourceOf?: (origin: unknown) => Source;
	/** Transaktionen mit diesen Origins nicht erfassen (z. B. Server-Updates). */
	ignore?: unknown[];
}

/**
 * Lokale Schreibvorgänge an `doc` mit Person und Zeit versehen. `who()` liefert null, solange unbekannt ist,
 * wer angemeldet ist – dann wird (noch) nichts eingetragen; die nächste Änderung holt das nach.
 * Kosten pro Transaktion: ein paar Vergleiche; geschrieben wird nur bei Pausen bzw. alle SESSION_MS.
 */
export function trackAuthorship(doc: Y.Doc, who: () => Author | null, opts: TrackOptions = {}): () => void {
	const now = opts.now ?? Date.now;
	const ignore = new Set<unknown>([TRACK, ...(opts.ignore ?? [])]);
	const people = doc.getMap<[string, string]>(PEOPLE_KEY);
	const authors = doc.getMap<[string, string?]>(AUTHORS_KEY);
	const times = doc.getArray<number[]>(TIMES_KEY);
	const meta = new Set<unknown>([people, authors, times]);
	/** Letzte Marke dieser Instanz (Zeit, Quelle) und letzter Schreibzeitpunkt */
	let last: { client: number; at: number; src: Source; wrote: number } | null = null;
	let registered: { client: number; person: string } | null = null;
	/** Jüngste Marke (Sekunden) im Doc und ob seit der eigenen letzten Marke Fremdes ankam */
	let maxSeen = 0;
	let remoteSeen = false;
	const seeMarks = (items: Iterable<{ content: { getContent(): unknown[] } }>) => {
		for (const it of items) for (const v of it.content.getContent()) if (Array.isArray(v) && typeof v[1] === "number" && v[1] > maxSeen) maxSeen = v[1];
	};
	seeMarks(itemsOf(times));
	times.observe((ev) => seeMarks(ev.changes.added as unknown as Iterable<ItemLike>));

	const onAfter = (tr: Y.Transaction) => {
		if (!tr.local) {
			for (const t of tr.changed.keys()) if (!meta.has(t)) remoteSeen = true;
			return;
		}
		if (ignore.has(tr.origin)) return;
		const client = doc.clientID;
		const before = tr.beforeState.get(client) ?? 0;
		if ((tr.afterState.get(client) ?? 0) <= before) return; // nichts Neues geschrieben (z. B. nur gelöscht)
		let content = false;
		for (const t of tr.changed.keys()) if (!meta.has(t)) content = true;
		if (!content) return;
		const me = who();
		if (!me) return;
		const ts = now();
		const src = opts.sourceOf?.(tr.origin) ?? Source.Editor;
		const personKey = `${me.id}\u0000${me.name}\u0000${me.color}\u0000${me.device ?? ""}`;
		const needAuthor = registered?.client !== client || registered.person !== personKey;
		const needMark =
			!last ||
			last.client !== client ||
			last.src !== src ||
			ts - last.wrote >= PAUSE_MS ||
			ts - last.at >= SESSION_MS ||
			(remoteSeen && ts - last.at >= REMOTE_MARK_MS);
		if (last) last.wrote = ts;
		if (!needAuthor && !needMark) return;
		doc.transact(() => {
			if (needAuthor) {
				const p = people.get(me.id);
				if (!p || p[0] !== me.name || p[1] !== me.color) people.set(me.id, [me.name, me.color]);
				const a = authors.get(String(client));
				if (!a || a[0] !== me.id || a[1] !== me.device) authors.set(String(client), me.device ? [me.id, me.device] : [me.id]);
			}
			if (needMark) {
				const sec = Math.max(toSec(ts), remoteSeen ? maxSeen + 1 : 0);
				times.push([src === Source.Editor ? [before, sec] : [before, sec, src]]);
				remoteSeen = false;
			}
		}, TRACK);
		registered = { client, person: personKey };
		if (needMark) last = { client, at: ts, src, wrote: ts };
	};
	doc.on("afterTransaction", onAfter);
	return () => doc.off("afterTransaction", onAfter);
}

// ── Auswerten ──────────────────────────────────────────────────────────

/** Ein zusammenhängendes Stück Text von derselben Doc-Instanz. */
export interface Run {
	from: number;
	to: number;
	client: number;
	clock: number;
}

type ItemLike = {
	id: { client: number; clock: number };
	deleted: boolean;
	countable: boolean;
	length: number;
	right: ItemLike | null;
	content: { getContent(): unknown[] };
};
function* itemsOf(t: Y.AbstractType<any>): Generator<ItemLike> {
	for (let item = startOf(t); item; item = item.right) if (!item.deleted) yield item;
}

// _start/right/_map sind intern, aber stabil (y-codemirror.next & Co. nutzen sie ebenso).
const startOf = (t: Y.AbstractType<any>) => (t as unknown as { _start: ItemLike | null })._start;

/** Sichtbaren Text in Stücke nach Herkunft zerlegen (Position, clientID, clock des ersten Zeichens). */
export function textRuns(ytext: Y.Text): Run[] {
	const runs: Run[] = [];
	let pos = 0;
	let prev: Run | null = null;
	for (let item = startOf(ytext); item; item = item.right) {
		if (item.deleted || !item.countable) continue;
		const len = item.length;
		// Benachbarte Items derselben Instanz mit fortlaufender clock zusammenfassen
		if (prev && prev.to === pos && prev.client === item.id.client && prev.clock + (prev.to - prev.from) === item.id.clock) prev.to += len;
		else runs.push((prev = { from: pos, to: pos + len, client: item.id.client, clock: item.id.clock }));
		pos += len;
	}
	return runs;
}

/** Herkunft (clientID, clock) des aktuellen Werts jedes Schlüssels einer Y.Map – z. B. Ink-Striche. */
export function mapOrigins(ymap: Y.Map<unknown>): Map<string, { client: number; clock: number }> {
	const out = new Map<string, { client: number; clock: number }>();
	for (const [key, item] of (ymap as unknown as { _map: Map<string, ItemLike> })._map) {
		if (!item.deleted) out.set(key, { client: item.id.client, clock: item.id.clock });
	}
	return out;
}

export interface Who {
	author: Author | null;
	/** Zeitpunkt (ms, auf die Sekunde), sofern eine Zeitmarke existiert */
	ts: number | null;
	src: Source;
	/** Kennung der Änderung (Instanz + Zeitmarke) – gleiche Kennung = derselbe Schreibvorgang */
	key: string;
}

/** [clock, ms, src] je clientID, nach clock sortiert */
type Mark = [number, number, Source];

/**
 * Zuordnung clientID/clock → Person + Zeit, aus den im Doc gespeicherten Angaben.
 * Einmal bauen und wiederverwenden, solange sich die Angaben nicht ändern (`AuthorLookup.watch`).
 */
export class AuthorLookup {
	private authors = new Map<number, Author>();
	private marks = new Map<number, Mark[]>();
	private cache = new Map<string, Who>();

	constructor(
		doc: Y.Doc,
		private extra?: (client: number) => Author | undefined,
	) {
		const people = doc.getMap<[string, string]>(PEOPLE_KEY);
		for (const [k, v] of doc.getMap<unknown>(AUTHORS_KEY)) {
			if (!Array.isArray(v) || typeof v[0] !== "string") continue;
			const p = people.get(v[0]);
			this.authors.set(Number(k), { id: v[0], name: p?.[0] ?? v[0], color: p?.[1] ?? "#888888", ...(v[1] ? { device: String(v[1]) } : {}) });
		}
		for (const [k, v] of doc.getMap<unknown>(LEGACY_AUTHORS_KEY)) {
			const a = v as Author;
			if (a?.id && !this.authors.has(Number(k))) this.authors.set(Number(k), a);
		}
		const add = (client: number, m: Mark) => {
			let list = this.marks.get(client);
			if (!list) this.marks.set(client, (list = []));
			list.push(m);
		};
		for (let item = startOf(doc.getArray(TIMES_KEY)); item; item = item.right) {
			if (item.deleted) continue;
			for (const v of item.content.getContent()) {
				if (Array.isArray(v) && v.length >= 2) add(item.id.client, [v[0], fromSec(v[1]), (v[2] ?? 0) as Source]);
			}
		}
		for (const m of doc.getArray<unknown>(LEGACY_MARKS_KEY)) {
			if (Array.isArray(m) && m.length >= 3) add(m[0], [m[1], m[2], (m[3] ?? 0) as Source]);
		}
		for (const list of this.marks.values()) list.sort((a, b) => a[0] - b[0]);
	}

	/** Bei Änderungen an den gespeicherten Angaben `fn` aufrufen. Gibt eine Abmeldefunktion zurück. */
	static watch(doc: Y.Doc, fn: () => void): () => void {
		const types: Y.AbstractType<any>[] = META_KEYS.map((k) => (k === TIMES_KEY || k === LEGACY_MARKS_KEY ? doc.getArray(k) : doc.getMap(k)));
		for (const t of types) t.observe(fn);
		return () => {
			for (const t of types) t.unobserve(fn);
		};
	}

	who(client: number, clock: number): Who {
		const k = `${client}:${clock}`;
		let w = this.cache.get(k);
		if (w) return w;
		const author = this.authors.get(client) ?? this.extra?.(client) ?? null;
		const list = this.marks.get(client);
		let mark: Mark | undefined;
		if (list) {
			// letzte Marke mit clock ≤ gesuchter clock (binäre Suche)
			let lo = 0;
			let hi = list.length - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (list[mid][0] <= clock) {
					mark = list[mid];
					lo = mid + 1;
				} else hi = mid - 1;
			}
		}
		w = { author, ts: mark ? mark[1] : null, src: mark?.[2] ?? Source.Editor, key: `${client}:${mark ? mark[0] : "-"}` };
		if (this.cache.size > 50_000) this.cache.clear();
		this.cache.set(k, w);
		return w;
	}
}

export interface LineBlame {
	/** Index der Zeile in der übergebenen Liste (bei `textLines` = Zeilennummer − 1) */
	index: number;
	who: Who;
	/** Weitere Personen, die in dieser Zeile noch sichtbaren Text haben */
	others: Author[];
	/** Anteil unbekannter Herkunft (0..1) */
	unknown: number;
}

/** Zeilen eines Texts als [from, to) ohne Zeilenumbruch. */
export function textLines(text: string): [number, number][] {
	const out: [number, number][] = [];
	let start = 0;
	for (;;) {
		const end = text.indexOf("\n", start);
		out.push([start, end === -1 ? text.length : end]);
		if (end === -1) return out;
		start = end + 1;
	}
}

/**
 * Pro Zeile die letzte Änderung bestimmen – wie `git blame`: Gewinner ist das Stück mit der jüngsten Zeitmarke;
 * ohne Zeitmarken das größte Stück. Leere Zeilen bekommen keinen Eintrag. Der Zeilenumbruch gehört nicht zur
 * Zeile (sonst „gehörte“ eine Zeile jedem, der dahinter Enter drückt). `lines` aufsteigend, ohne Überlappung.
 */
export function blameLines(lines: readonly (readonly [number, number])[], runs: Run[], lookup: AuthorLookup): LineBlame[] {
	const out: LineBlame[] = [];
	let r = 0;
	for (let i = 0; i < lines.length; i++) {
		const [start, end] = lines[i];
		if (end <= start) continue;
		while (r < runs.length && runs[r].to <= start) r++;
		let best: { who: Who; len: number } | null = null;
		let others: Map<string, Author> | null = null;
		let unknown = 0;
		for (let j = r; j < runs.length && runs[j].from < end; j++) {
			const run = runs[j];
			const from = Math.max(run.from, start);
			const to = Math.min(run.to, end);
			if (to <= from) continue;
			// Innerhalb eines Stücks steigt die clock; mehrere Zeitmarken möglich → jüngstes Zeichen maßgeblich
			const w = lookup.who(run.client, run.clock + (to - 1 - run.from));
			const len = to - from;
			if (!w.author) unknown += len;
			else (others ??= new Map()).set(w.author.id, w.author);
			if (!best || newer(w, len, best.who, best.len)) best = { who: w, len };
		}
		if (!best) continue;
		if (best.who.author) others?.delete(best.who.author.id);
		out.push({ index: i, who: best.who, others: others ? [...others.values()] : [], unknown: unknown / (end - start) });
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

/** Mehrzeiliger Hinweistext zu einer Herkunft (Tooltip). `you` = eigene Personen-ID. */
export function describe(who: Who, others: Author[] = [], unknown = 0, you?: string): string {
	const a = who.author;
	const parts = [a ? `${a.id === you ? `Du (${a.name})` : a.name}${a.device ? ` · ${a.device}` : ""}` : "Unbekannt – vor Blame geschrieben oder älteres Plugin"];
	if (who.ts !== null) parts.push(`${formatTime(who.ts)} (${relativeTime(who.ts)})`);
	if (who.src === Source.File) parts.push("Datei von außen geändert (Claude Code, git …)");
	if (others.length) parts.push(`Auch beteiligt: ${others.map((o) => o.name).join(", ")}`);
	if (unknown > 0 && a) parts.push(`${Math.round(unknown * 100)} % unbekannter Herkunft`);
	return parts.join("\n");
}
