/**
 * Zusammenspiel mit Ink Blocks.
 *
 * Stufe A (immer): .ink-Dateien laufen als Ink-Doc über die DiskBridge; Ink Blocks lädt sie über seinen
 * modify-Handler neu und führt sie per mergeInk zusammen.
 *
 * Stufe B (wenn Ink Blocks `api.version >= 1` anbietet):
 *  - Eigene Striche gehen WÄHREND des Zeichnens raus – als Awareness-Feld `ink` auf dem Index-Doc,
 *    jeweils nur die neuen Punkte (`from` = Index, ab dem `pts` gilt). Gedrosselt auf ~25 Nachrichten/s.
 *  - Fremde Striche werden pro Person aufgesammelt und in Ink Blocks als „Geist“ mit Namen gezeigt.
 *  - Nach jeder abgeschlossenen Änderung speichert Ink Blocks sofort (statt nach 1,5 s), damit der
 *    fertige Strich ohne Verzögerung als CRDT-Änderung rausgeht und den Geist ersetzt.
 *  - .ink-Dateien, die gerade offen sind, bleiben abonniert → Änderungen anderer kommen ohne Umweg an.
 */
import type { App } from "obsidian";
import type { Awareness } from "y-protocols/awareness";
import type { SpaceSync } from "../sync/SpaceSync";
import type * as Y from "yjs";
import { AuthorLookup, mapOrigins, type Author } from "../blame/authorship";

const INK_PLUGIN = "obsidian-ink-blocks";
const SEND_EVERY = 40;

interface LiveStroke {
	id: string;
	tool: string;
	color: number | string;
	size: number;
	points: number[];
	simulated?: boolean;
}

interface InkApiV1 {
	version: number;
	onLiveStroke(fn: (file: string, s: LiveStroke | null) => void): () => void;
	onCommit(fn: (file: string) => void): () => void;
	flush(file: string): Promise<void>;
	openFiles(): string[];
	setRemoteStroke(file: string, key: string, s: LiveStroke | null, label?: { name: string; color: string }): void;
	clearRemote(key: string): void;
	// ab Ink Blocks mit Zeiger-Unterstützung (optional)
	onPointer?(fn: (file: string, p: PointerPos | null) => void): () => void;
	exclusive?<T>(file: string, fn: () => Promise<T>): Promise<T>;
	setRemotePointer?(file: string, key: string, p: PointerPos | null, label?: { name: string; color: string }): void;
	// ab Ink Blocks mit Blame-Anzeige (optional)
	setBlame?(file: string, blame: InkBlame | null): void;
}

/** Wer hat welchen Strich gezeichnet (für Ink Blocks `setBlame`). */
export interface InkBlame {
	authors: { key: string; name: string; color: string; device?: string; you?: boolean }[];
	/** Strich-ID → [Index in `authors`, Zeit in ms oder null] – Striche unbekannter Herkunft fehlen */
	strokes: Record<string, [number, number | null]>;
}

/** Strich-Zuordnung eines Ink-Docs berechnen. */
export function inkBlame(doc: Y.Doc, lookup: AuthorLookup, you?: string): InkBlame {
	const authors: InkBlame["authors"] = [];
	const index = new Map<string, number>();
	const strokes: InkBlame["strokes"] = {};
	for (const [id, o] of mapOrigins(doc.getMap("strokes"))) {
		const w = lookup.who(o.client, o.clock);
		const a = w.author;
		if (!a) continue;
		const key = `${a.id}|${a.device ?? ""}`;
		let i = index.get(key);
		if (i === undefined) {
			index.set(key, (i = authors.length));
			authors.push({ key, name: a.name, color: a.color, ...(a.device ? { device: a.device } : {}), ...(a.id === you ? { you: true } : {}) });
		}
		strokes[id] = [i, w.ts];
	}
	return { authors, strokes };
}

interface PointerPos {
	x: number;
	y: number;
	kind: "pen" | "mouse" | "touch";
	down?: boolean;
}

/** Awareness-Feld `ptr` */
interface PtrWire {
	file: string;
	x: number;
	y: number;
	k: "pen" | "mouse" | "touch";
	d?: boolean;
}

const PTR_EVERY = 50;

/** Awareness-Feld `ink` */
interface InkWire {
	file: string;
	id: string;
	t?: string;
	c?: number | string;
	s?: number;
	sim?: boolean;
	from?: number;
	pts?: number[];
	end?: boolean;
}

export class InkBridge {
	private api: InkApiV1 | null = null;
	private offs: (() => void)[] = [];
	private probeTimer: number | null = null;
	private openTimer: number | null = null;
	// Senden
	private sent: { id: string; len: number } | null = null;
	private pending: { file: string; stroke: LiveStroke } | null = null;
	private lastSend = 0;
	private sendTimer: number | null = null;
	private clearTimer: number | null = null;
	// Empfangen: clientID → aufgesammelter Strich
	private acc = new Map<number, { file: string; id: string; points: number[]; ended: boolean }>();
	// Zeiger senden/empfangen
	private ptrPending: PtrWire | null | undefined = undefined;
	private ptrLast = 0;
	private ptrTimer: number | null = null;
	private ptrSeen = new Map<number, string>();
	/** .ink-docIds, die wir wegen offener Zeichenansicht abonniert halten */
	private held = new Set<string>();
	// Blame: docId → {Pfad, Abmelden, Zuordnung (zwischengespeichert)}
	private blameOn = false;
	private blamed = new Map<string, { path: string; off: () => void; lookup: AuthorLookup | null; timer: number | null }>();

	constructor(
		readonly app: App,
		readonly sync: SpaceSync,
		/** Eigene Person (Blame: „Du“, eigene clientID vor dem ersten Eintrag) */
		readonly me: () => Author | null = () => null,
	) {}

	/** Blame-Anzeige in Ink Blocks ein-/ausschalten (falls Ink Blocks sie anbietet). */
	setBlame(on: boolean) {
		this.blameOn = on;
		if (on) this.holdOpen();
		else for (const id of [...this.blamed.keys()]) this.unblame(id);
	}

	private blame(id: string, path: string) {
		const api = this.api;
		if (!api?.setBlame || this.blamed.has(id)) return;
		void this.sync.docs.acquire(id).then((s) => {
			if (!this.blameOn || !this.held.has(id) || this.blamed.has(id)) return this.sync.docs.release(id);
			const doc = s.doc;
			const entry = { path, lookup: null as AuthorLookup | null, timer: null as number | null, off: () => {} };
			const push = () => {
				entry.timer = null;
				const me = this.me();
				entry.lookup ??= new AuthorLookup(doc, (c) => (c === doc.clientID ? (me ?? undefined) : undefined));
				api.setBlame?.(entry.path, inkBlame(doc, entry.lookup, me?.id));
			};
			const schedule = () => {
				if (entry.timer === null) entry.timer = window.setTimeout(push, 400);
			};
			const offMeta = AuthorLookup.watch(doc, () => (entry.lookup = null));
			const strokes = doc.getMap("strokes");
			strokes.observe(schedule);
			entry.off = () => {
				offMeta();
				strokes.unobserve(schedule);
				if (entry.timer !== null) window.clearTimeout(entry.timer);
				this.sync.docs.release(id);
			};
			this.blamed.set(id, entry);
			push();
		});
	}

	private unblame(id: string) {
		const e = this.blamed.get(id);
		if (!e) return;
		this.blamed.delete(id);
		e.off();
		this.api?.setBlame?.(e.path, null);
	}

	get stage(): "A" | "B" {
		return this.api ? "B" : "A";
	}

	private get awareness(): Awareness {
		return this.sync.indexSession.awareness!;
	}

	start() {
		this.probe();
		if (!this.api) {
			// Ink Blocks lädt evtl. erst später (oder wird nachträglich aktiviert).
			this.probeTimer = window.setInterval(() => this.probe(), 3000);
		}
	}

	private probe() {
		// @ts-expect-error – interne API
		const api = this.app.plugins?.plugins?.[INK_PLUGIN]?.api as InkApiV1 | undefined;
		if (!api || typeof api.version !== "number" || api.version < 1 || api === this.api) return;
		this.api = api;
		if (this.probeTimer !== null) window.clearInterval(this.probeTimer);
		this.probeTimer = null;
		this.offs.push(
			api.onLiveStroke((file, s) => this.onLocalLive(file, s)),
			api.onCommit((file) => void api.flush(file)),
		);
		if (api.onPointer && api.setRemotePointer) this.offs.push(api.onPointer((file, p) => this.onLocalPointer(file, p)));
		if (api.exclusive) {
			this.sync.inkExclusive = (path, fn) => api.exclusive!(path, fn);
			this.offs.push(() => (this.sync.inkExclusive = null));
		}
		this.awareness.on("change", this.onAwareness);
		this.offs.push(() => this.awareness.off("change", this.onAwareness));
		// Offene Zeichenflächen abonniert halten
		this.openTimer = window.setInterval(() => this.holdOpen(), 2000);
		this.holdOpen();
		console.log("[tandem] Ink Blocks erkannt – Live-Striche aktiv (Stufe B)");
	}

	// ── Senden ──────────────────────────────────────────────────────────

	private onLocalLive(file: string, s: LiveStroke | null) {
		if (this.sync.role() === "read") return;
		if (!s) {
			this.flushSend();
			if (this.sent) {
				this.setWire({ file, id: this.sent.id, end: true });
				this.sent = null;
				// Feld etwas später leeren (Empfänger hat das Ende dann sicher gesehen)
				if (this.clearTimer !== null) window.clearTimeout(this.clearTimer);
				this.clearTimer = window.setTimeout(() => this.awareness.setLocalStateField("ink", null), 1500);
			}
			return;
		}
		this.pending = { file, stroke: s };
		const wait = SEND_EVERY - (Date.now() - this.lastSend);
		if (wait <= 0) this.flushSend();
		else if (this.sendTimer === null) this.sendTimer = window.setTimeout(() => this.flushSend(), wait);
	}

	private flushSend() {
		if (this.sendTimer !== null) window.clearTimeout(this.sendTimer);
		this.sendTimer = null;
		const p = this.pending;
		this.pending = null;
		if (!p) return;
		const { file, stroke } = p;
		const from = this.sent?.id === stroke.id ? this.sent.len : 0;
		if (from >= stroke.points.length && from > 0) return;
		this.setWire({
			file,
			id: stroke.id,
			t: stroke.tool,
			c: stroke.color,
			s: stroke.size,
			sim: stroke.simulated,
			from,
			pts: stroke.points.slice(from),
		});
		this.sent = { id: stroke.id, len: stroke.points.length };
		this.lastSend = Date.now();
		if (this.clearTimer !== null) window.clearTimeout(this.clearTimer);
		this.clearTimer = null;
	}

	private setWire(w: InkWire) {
		this.awareness.setLocalStateField("ink", w);
	}

	private onLocalPointer(file: string, p: PointerPos | null) {
		// Verlassen leicht verzögert senden: beim Wechsel zwischen Flächen nicht flackern
		this.ptrPending = p ? { file, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, k: p.kind, d: p.down || undefined } : null;
		const wait = p ? PTR_EVERY - (Date.now() - this.ptrLast) : 300;
		if (this.ptrTimer !== null) {
			if (p) return;
			window.clearTimeout(this.ptrTimer);
		}
		if (wait <= 0) this.flushPtr();
		else this.ptrTimer = window.setTimeout(() => this.flushPtr(), wait);
	}

	private flushPtr() {
		this.ptrTimer = null;
		if (this.ptrPending === undefined) return;
		this.awareness.setLocalStateField("ptr", this.ptrPending);
		this.ptrPending = undefined;
		this.ptrLast = Date.now();
	}

	private applyRemotePointer(api: InkApiV1, id: number, st: Record<string, any> | undefined) {
		if (!api.setRemotePointer) return;
		const key = String(id);
		const p = st?.ptr as PtrWire | null | undefined;
		const prevFile = this.ptrSeen.get(id);
		if (prevFile && (!p || p.file !== prevFile)) {
			api.setRemotePointer(prevFile, key, null);
			this.ptrSeen.delete(id);
		}
		if (!p) return;
		api.setRemotePointer(p.file, key, { x: p.x, y: p.y, kind: p.k, down: p.d }, { name: st?.user?.name ?? "?", color: st?.user?.color ?? "#888" });
		this.ptrSeen.set(id, p.file);
	}

	// ── Empfangen ───────────────────────────────────────────────────────

	private onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
		const api = this.api;
		if (!api) return;
		const own = this.awareness.clientID;
		for (const id of [...added, ...updated]) {
			if (id === own) continue;
			const st = this.awareness.getStates().get(id);
			this.applyRemotePointer(api, id, st);
			const w = st?.ink as InkWire | null | undefined;
			const key = String(id);
			const prev = this.acc.get(id);
			if (!w) {
				if (prev && !prev.ended) api.setRemoteStroke(prev.file, key, null);
				this.acc.delete(id);
				continue;
			}
			if (w.end) {
				if (prev && prev.id === w.id && !prev.ended) {
					prev.ended = true;
					api.setRemoteStroke(prev.file, key, null);
				}
				continue;
			}
			let a = prev;
			if (!a || a.id !== w.id) {
				if (a && !a.ended) api.setRemoteStroke(a.file, key, null);
				if (w.from !== 0) continue; // Anfang verpasst → auf den nächsten Strich warten
				a = { file: w.file, id: w.id, points: [], ended: false };
				this.acc.set(id, a);
			}
			const from = w.from ?? 0;
			if (from > a.points.length) continue; // Lücke
			a.points = a.points.slice(0, from).concat(w.pts ?? []);
			api.setRemoteStroke(
				w.file,
				key,
				{ id: w.id, tool: w.t ?? "pen", color: w.c ?? 0, size: w.s ?? 2, points: a.points, simulated: w.sim },
				{ name: st?.user?.name ?? "?", color: st?.user?.color ?? "#888" },
			);
		}
		for (const id of removed) {
			this.acc.delete(id);
			this.ptrSeen.delete(id);
			api.clearRemote(String(id));
		}
	};

	// ── Offene Flächen abonniert halten ────────────────────────────────

	private holdOpen() {
		const api = this.api;
		if (!api) return;
		const want = new Map<string, string>();
		for (const f of api.openFiles()) {
			const id = this.sync.index.idForPath(f);
			if (id) want.set(id, f);
		}
		for (const id of want.keys()) {
			if (this.held.has(id)) continue;
			this.held.add(id);
			void this.sync.docs.acquire(id);
		}
		for (const id of [...this.held]) {
			if (want.has(id)) continue;
			this.held.delete(id);
			this.unblame(id);
			this.sync.docs.release(id);
		}
		if (!this.blameOn) return;
		for (const [id, path] of want) {
			const e = this.blamed.get(id);
			if (e && e.path !== path) this.unblame(id); // umbenannt
			this.blame(id, path);
		}
	}

	stop() {
		for (const id of [...this.blamed.keys()]) this.unblame(id);
		for (const off of this.offs) off();
		this.offs = [];
		for (const t of [this.probeTimer, this.openTimer]) if (t !== null) window.clearInterval(t);
		for (const t of [this.sendTimer, this.clearTimer, this.ptrTimer]) if (t !== null) window.clearTimeout(t);
		this.ptrSeen.clear();
		for (const id of this.held) this.sync.docs.release(id);
		this.held.clear();
		if (this.api) for (const id of this.acc.keys()) this.api.clearRemote(String(id));
		this.acc.clear();
		this.api = null;
	}
}
