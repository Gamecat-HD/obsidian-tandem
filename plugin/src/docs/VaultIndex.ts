/**
 * Dateibaum eines Space als Y.Map `files`: docId → Eintrag.
 * Umbenennen ändert nur `path`; Löschen setzt `del` (Grabstein), damit Offline-Geräte die Datei nicht zurückbringen.
 */
import * as Y from "yjs";

export type Kind = "md" | "ink" | "blob";

export interface IndexEntry {
	path: string;
	kind: Kind;
	/** blob: SHA-256 des Inhalts; md/ink: SHA-256 des Inhalts beim Eintragen (Erstimport) */
	hash?: string;
	/** Installation, die den Eintrag angelegt hat – nur sie lädt den Anfangsinhalt hoch. */
	origin?: string;
	size?: number;
	/** blob: Hash der Fassung, von der diese abgeleitet wurde (Erkennung gleichzeitiger Änderungen). */
	parent?: string;
	/** blob in verschlüsselten Spaces: Adresse auf dem Server = SHA-256 des Chiffretexts. */
	ehash?: string;
	del?: boolean;
	/** Nutzer-ID der letzten Änderung am Eintrag */
	by?: string;
	ts: number;
}

export function kindForPath(path: string): Kind {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "md" || ext === "txt") return "md";
	if (ext === "ink") return "ink";
	return "blob";
}

export function newDocId(): string {
	const a = new Uint8Array(9);
	crypto.getRandomValues(a);
	return [...a].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

export class VaultIndex {
	readonly files: Y.Map<IndexEntry>;
	/**
	 * Abgeleitete Nachschlagetabellen, bei jeder Änderung von `files` nur für die geänderten Schlüssel nachgeführt
	 * (vorher: kompletter Neuaufbau je Änderung und lineare Suchen → quadratisch beim Erstabgleich großer Vaults).
	 */
	private byPath = new Map<string, string>();
	/** Pfad → lebende Einträge mit diesem Pfad (mehr als einer = Namenskonflikt). */
	private claims = new Map<string, Set<string>>();
	/** Pfad → Grabsteine mit diesem Pfad. */
	private tombs = new Map<string, Set<string>>();
	/** Pfade mit mehr als einem lebenden Eintrag. */
	private contestedPaths = new Set<string>();
	/** docId → (Pfad, gelöscht), wie zuletzt eingetragen – zum Austragen bei Änderungen. */
	private seen = new Map<string, { path: string; del: boolean }>();

	constructor(
		readonly doc: Y.Doc,
		private userId: () => string,
	) {
		this.files = doc.getMap<IndexEntry>("files");
		for (const [id, e] of this.files) this.enter(id, e);
		this.files.observe((ev) => {
			for (const id of ev.keysChanged) {
				this.leave(id);
				const e = this.files.get(id);
				if (e) this.enter(id, e);
			}
		});
	}

	private enter(id: string, e: IndexEntry) {
		const del = !!e.del;
		this.seen.set(id, { path: e.path, del });
		const table = del ? this.tombs : this.claims;
		let set = table.get(e.path);
		if (!set) table.set(e.path, (set = new Set()));
		set.add(id);
		if (del) return;
		// Bei doppelten Pfaden (gleichzeitig offline angelegt) gewinnt die kleinere docId.
		const cur = this.byPath.get(e.path);
		if (cur === undefined || id < cur) this.byPath.set(e.path, id);
		if (set.size > 1) this.contestedPaths.add(e.path);
	}

	private leave(id: string) {
		const s = this.seen.get(id);
		if (!s) return;
		this.seen.delete(id);
		const table = s.del ? this.tombs : this.claims;
		const set = table.get(s.path);
		set?.delete(id);
		if (set && set.size === 0) table.delete(s.path);
		if (s.del) return;
		if (!set || set.size <= 1) this.contestedPaths.delete(s.path);
		if (this.byPath.get(s.path) !== id) return;
		let min: string | undefined;
		for (const other of set ?? []) if (min === undefined || other < min) min = other;
		if (min === undefined) this.byPath.delete(s.path);
		else this.byPath.set(s.path, min);
	}

	/** Pfad → docId. Bei doppelten Pfaden (gleichzeitig offline angelegt) gewinnt die kleinere docId. */
	idForPath(path: string): string | undefined {
		return this.byPath.get(path);
	}

	/** Zuletzt gelöschter Eintrag mit diesem Pfad (Grabstein). */
	deletedIdForPath(path: string): string | undefined {
		let best: [string, number] | undefined;
		for (const id of this.tombs.get(path) ?? []) {
			const e = this.files.get(id);
			if (e?.del && e.path === path && (!best || e.ts > best[1] || (e.ts === best[1] && id < best[0]))) best = [id, e.ts];
		}
		return best?.[0];
	}

	get(id: string): IndexEntry | undefined {
		return this.files.get(id);
	}

	/** Einträge, die denselben Pfad wie ein Gewinner beanspruchen (Konflikt beim Anlegen). */
	conflicts(): [string, IndexEntry][] {
		const out: [string, IndexEntry][] = [];
		for (const path of this.contestedPaths) {
			const winner = this.byPath.get(path);
			for (const id of [...(this.claims.get(path) ?? [])].sort()) {
				const e = this.files.get(id);
				if (id !== winner && e && !e.del) out.push([id, e]);
			}
		}
		return out;
	}

	/** Mehr als ein lebender Eintrag beansprucht diesen Pfad (Konflikt noch nicht aufgelöst). */
	contested(path: string): boolean {
		return this.contestedPaths.has(path);
	}

	live(): [string, IndexEntry][] {
		return [...this.files].filter(([, e]) => !e.del);
	}

	add(path: string, kind: Kind, extra: Partial<IndexEntry> = {}): string {
		const existing = this.byPath.get(path);
		if (existing) return existing;
		const id = newDocId();
		this.files.set(id, { path, kind, ts: Date.now(), by: this.userId(), ...extra });
		return id;
	}

	update(id: string, patch: Partial<IndexEntry>) {
		const e = this.files.get(id);
		if (!e) return;
		const next = { ...e, ...patch, ts: Date.now(), by: this.userId() };
		if (JSON.stringify(next) === JSON.stringify({ ...e, ts: next.ts, by: next.by })) return;
		this.files.set(id, next);
	}

	rename(oldPath: string, newPath: string) {
		this.doc.transact(() => {
			const id = this.byPath.get(oldPath);
			if (id) this.update(id, { path: newPath });
			// Ordner: alle Einträge darunter mitziehen.
			const prefix = oldPath + "/";
			for (const [cid, e] of this.files) {
				if (!e.del && e.path.startsWith(prefix)) this.update(cid, { path: newPath + "/" + e.path.slice(prefix.length) });
			}
		});
	}

	remove(path: string) {
		this.doc.transact(() => {
			const id = this.byPath.get(path);
			if (id) this.update(id, { del: true });
			const prefix = path + "/";
			for (const [cid, e] of this.files) if (!e.del && e.path.startsWith(prefix)) this.update(cid, { del: true });
		});
	}
}
