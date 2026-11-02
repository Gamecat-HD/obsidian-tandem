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
	private byPath = new Map<string, string>();

	constructor(
		readonly doc: Y.Doc,
		private userId: () => string,
	) {
		this.files = doc.getMap<IndexEntry>("files");
		this.rebuild();
		this.files.observe(() => this.rebuild());
	}

	/** Pfad → docId. Bei doppelten Pfaden (gleichzeitig offline angelegt) gewinnt die kleinere docId. */
	private rebuild() {
		this.byPath.clear();
		for (const [id, e] of this.files) {
			if (e.del) continue;
			const cur = this.byPath.get(e.path);
			if (cur === undefined || id < cur) this.byPath.set(e.path, id);
		}
	}

	idForPath(path: string): string | undefined {
		return this.byPath.get(path);
	}

	/** Zuletzt gelöschter Eintrag mit diesem Pfad (Grabstein). */
	deletedIdForPath(path: string): string | undefined {
		let best: [string, number] | undefined;
		for (const [id, e] of this.files) if (e.del && e.path === path && (!best || e.ts > best[1])) best = [id, e.ts];
		return best?.[0];
	}

	get(id: string): IndexEntry | undefined {
		return this.files.get(id);
	}

	/** Einträge, die denselben Pfad wie ein Gewinner beanspruchen (Konflikt beim Anlegen). */
	conflicts(): [string, IndexEntry][] {
		const out: [string, IndexEntry][] = [];
		for (const [id, e] of this.files) if (!e.del && this.byPath.get(e.path) !== id) out.push([id, e]);
		return out;
	}

	/** Mehr als ein lebender Eintrag beansprucht diesen Pfad (Konflikt noch nicht aufgelöst). */
	contested(path: string): boolean {
		let n = 0;
		for (const e of this.files.values()) if (!e.del && e.path === path && ++n > 1) return true;
		return false;
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
