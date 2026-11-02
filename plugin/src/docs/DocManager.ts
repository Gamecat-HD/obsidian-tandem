/**
 * Verwaltet Y.Docs eines Space: lädt sie lokal (IndexedDB), koppelt sie an den Server,
 * zählt Referenzen und entlädt sie wieder. Nur offene Notizen + Index bleiben dauerhaft im RAM.
 */
import * as Y from "yjs";
import type { Connection } from "../net/Connection";
import { docName } from "../net/protocol";
import { DocSession, REMOTE } from "./DocSession";
import type { LocalStore } from "./LocalStore";

interface Live {
	session: DocSession;
	refs: number;
	base?: string;
	edited?: number;
	persistTimer: number | null;
	releaseTimer: number | null;
	loaded: Promise<void>;
}

const PERSIST_DELAY = 400;
const RELEASE_DELAY = 3000;

export class DocManager {
	private live = new Map<string, Live>();
	/** Wird bei jedem Remote-Update eines geladenen Docs aufgerufen (z. B. um die Datei zu schreiben). */
	onRemoteUpdate: ((docId: string) => void) | null = null;
	private dirty = new Set<string>();
	private dirtyLoaded: Promise<void>;
	private destroyed = false;

	constructor(
		readonly conn: Connection,
		readonly store: LocalStore,
		readonly space: string,
	) {
		this.dirtyLoaded = store.getMeta<string[]>(`dirty:${space}`).then((d) => {
			for (const id of d ?? []) this.dirty.add(id);
		});
		conn.onStatus((s) => {
			if (s === "online") void this.flushDirty();
		});
	}

	/** Doc holen (Referenz +1). `awareness` nur für Live-Ansichten. */
	async acquire(docId: string, opts: { awareness?: boolean } = {}): Promise<DocSession> {
		let l = this.live.get(docId);
		if (l && opts.awareness && !l.session.awareness) {
			// Upgrade auf Live-Ansicht: Session mit Awareness neu aufbauen (selbes Y.Doc).
			const doc = l.session.doc;
			l.session.destroy();
			l.session = new DocSession(this.conn, docName(this.space, docId), doc, { awareness: true });
			this.hookDirty(docId, l.session);
		}
		if (!l) {
			const doc = new Y.Doc();
			const session = new DocSession(this.conn, docName(this.space, docId), doc, opts);
			const entry: Live = { session, refs: 0, persistTimer: null, releaseTimer: null, loaded: Promise.resolve() };
			entry.loaded = this.store.get(docName(this.space, docId)).then((rec) => {
				if (rec?.state?.length) Y.applyUpdate(doc, rec.state, REMOTE);
				entry.base = rec?.base;
				entry.edited = rec?.edited;
			});
			doc.on("update", (_u: Uint8Array, origin: unknown) => {
				if (origin === REMOTE) this.onRemoteUpdate?.(docId);
				else entry.edited = Date.now();
				this.schedulePersist(docId);
			});
			this.hookDirty(docId, session);
			this.live.set(docId, (l = entry));
		}
		l.refs++;
		if (l.releaseTimer !== null) window.clearTimeout(l.releaseTimer);
		l.releaseTimer = null;
		await l.loaded;
		return l.session;
	}

	private hookDirty(docId: string, s: DocSession) {
		// Updates, die nicht gesendet werden konnten, beim nächsten Online-Gehen nachreichen.
		s.doc.on("update", (_u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE && this.conn.status !== "online") this.markDirty(docId);
		});
	}

	release(docId: string, immediate = false) {
		const l = this.live.get(docId);
		if (!l) return;
		l.refs = Math.max(0, l.refs - 1);
		if (l.refs > 0) return;
		const drop = () => {
			if (l.refs > 0) return;
			this.live.delete(docId);
			void this.persistNow(docId, l).finally(() => {
				l.session.destroy();
				l.session.doc.destroy();
			});
		};
		if (immediate) drop();
		else l.releaseTimer = window.setTimeout(drop, RELEASE_DELAY);
	}

	/** Kurzzeitig laden, synchronisieren (falls online) und `fn` ausführen. */
	async withDoc<T>(docId: string, fn: (s: DocSession, l: { base?: string; setBase(b: string): void }) => T | Promise<T>, syncTimeout = 4000): Promise<T> {
		const s = await this.acquire(docId);
		try {
			if (this.conn.status === "online") await s.whenSynced(syncTimeout);
			const l = this.live.get(docId)!;
			return await fn(s, {
				base: l.base,
				setBase: (b) => {
					l.base = b;
					this.schedulePersist(docId);
				},
			});
		} finally {
			this.release(docId);
		}
	}

	getBase(docId: string): string | undefined {
		return this.live.get(docId)?.base;
	}
	setBase(docId: string, base: string) {
		const l = this.live.get(docId);
		if (!l) return;
		l.base = base;
		this.schedulePersist(docId);
	}

	isLive(docId: string) {
		return this.live.has(docId);
	}

	private markDirty(docId: string) {
		if (this.dirty.has(docId) || this.destroyed) return;
		this.dirty.add(docId);
		void this.store.setMeta(`dirty:${this.space}`, [...this.dirty]);
	}

	/** Offline entstandene Änderungen hochladen: Abgleich per Step1/Step2 genügt. */
	async flushDirty() {
		await this.dirtyLoaded;
		if (this.destroyed) return;
		const ids = [...this.dirty];
		for (const id of ids) {
			try {
				await this.withDoc(id, async (s) => {
					if (await s.whenSynced(8000)) this.dirty.delete(id);
				});
			} catch (e) {
				console.warn("[tandem] flushDirty", id, e);
			}
		}
		if (!this.destroyed) await this.store.setMeta(`dirty:${this.space}`, [...this.dirty]);
	}

	private schedulePersist(docId: string) {
		if (this.destroyed) return;
		const l = this.live.get(docId);
		if (!l || l.persistTimer !== null) return;
		l.persistTimer = window.setTimeout(() => void this.persistNow(docId, l), PERSIST_DELAY);
	}

	private async persistNow(docId: string, l: Live) {
		if (l.persistTimer !== null) window.clearTimeout(l.persistTimer);
		l.persistTimer = null;
		await l.loaded;
		if (this.destroyed) return;
		await this.store.put({ name: docName(this.space, docId), state: Y.encodeStateAsUpdate(l.session.doc), base: l.base, edited: l.edited });
	}

	/** Ausstehendes Speichern sofort erledigen (falls das Doc gerade geladen ist). */
	async flushPersist(docId: string) {
		const l = this.live.get(docId);
		if (l) await this.persistNow(docId, l);
	}

	async forget(docId: string) {
		await this.store.delete(docName(this.space, docId));
	}

	async destroy() {
		for (const l of this.live.values()) if (l.releaseTimer !== null) window.clearTimeout(l.releaseTimer);
		for (const [id, l] of [...this.live]) {
			await this.persistNow(id, l).catch(() => {});
			l.session.destroy();
			l.session.doc.destroy();
		}
		this.destroyed = true;
		this.live.clear();
		this.onRemoteUpdate = null;
	}
}
