/**
 * Verwaltet Y.Docs eines Space: lädt sie lokal (IndexedDB), koppelt sie an den Server,
 * zählt Referenzen und entlädt sie wieder. Nur offene Notizen + Index bleiben dauerhaft im RAM.
 */
import * as Y from "yjs";
import type { Connection } from "../net/Connection";
import { docName, INDEX_DOC } from "../net/protocol";
import { DocSession, REMOTE } from "./DocSession";
import type { LocalStore } from "./LocalStore";
import type { SpaceKey } from "../crypto/e2ee";

interface Live {
	session: DocSession;
	refs: number;
	base?: string;
	edited?: number;
	persistTimer: number | null;
	releaseTimer: number | null;
	loaded: Promise<void>;
	/** Stand aus IndexedDB wird gerade eingespielt (ist schon gespeichert). */
	loading: boolean;
	/** Laufende `withDoc`-Abgleiche vor ihrem Arbeitsschritt: Sie übernehmen fremde Änderungen ohnehin. */
	quiet: number;
	/** Dauer des letzten Kodierens beim Speichern (ms) – große Docs seltener speichern. */
	encodeMs: number;
}

const PERSIST_DELAY = 400;
/** Speichern darf höchstens etwa 1/PERSIST_COST_FACTOR der Zeit kosten (große Docs, Index mit Tausenden Einträgen). */
const PERSIST_COST_FACTOR = 25;
const PERSIST_MAX_DELAY = 4000;
const RELEASE_DELAY = 3000;

export class DocManager {
	private live = new Map<string, Live>();
	/** Wird bei jedem Remote-Update eines geladenen Docs aufgerufen (z. B. um die Datei zu schreiben). */
	onRemoteUpdate: ((docId: string) => void) | null = null;
	private dirty = new Set<string>();
	private dirtyLoaded: Promise<void>;
	private destroyed = false;

	/** Entschlüsseln schlug fehl (einmal pro Ursache melden). */
	onDecryptError: ((docId: string, e: Error) => void) | null = null;

	constructor(
		readonly conn: Connection,
		readonly store: LocalStore,
		readonly space: string,
		/** Gesetzt = Ende-zu-Ende-verschlüsselter Space. */
		readonly key: SpaceKey | null = null,
	) {
		this.dirtyLoaded = store.getMeta<string[]>(`dirty:${space}`).then((d) => {
			for (const id of d ?? []) this.dirty.add(id);
		});
		conn.onStatus((s) => {
			if (s === "online") void this.flushDirty();
		});
	}

	/** Doc holen (Referenz +1). `awareness` nur für Live-Ansichten. */
	async acquire(docId: string, opts: { awareness?: boolean; quiet?: boolean } = {}): Promise<DocSession> {
		let l = this.live.get(docId);
		if (l && opts.awareness && !l.session.awareness) {
			// Upgrade auf Live-Ansicht: Session mit Awareness neu aufbauen (selbes Y.Doc).
			const old = l.session;
			old.destroy(); // vor dem Neuanlegen: beide Sessions teilen sich den Handler-Platz der Verbindung
			l.session = this.newSession(docId, old.doc, { awareness: true });
			l.session.adopt(old);
			// Noch nicht gestartet (lokaler Stand lädt noch)? Dann startet sie der Lade-Abschluss.
			if (old.isStarted) l.session.start();
			this.hookDirty(docId, l.session);
		}
		if (!l) {
			const doc = new Y.Doc();
			const session = this.newSession(docId, doc, opts);
			const entry: Live = { session, refs: 0, persistTimer: null, releaseTimer: null, loaded: Promise.resolve(), loading: false, quiet: 0, encodeMs: 0 };
			entry.loaded = this.store.get(docName(this.space, docId)).then((rec) => {
				if (rec?.state?.length) {
					entry.loading = true;
					try {
						Y.applyUpdate(doc, rec.state, REMOTE);
					} finally {
						entry.loading = false;
					}
				}
				entry.base = rec?.base;
				entry.edited = rec?.edited;
				// Verschlüsselt: erst jetzt abonnieren – ab der gespeicherten Log-Position, mit den offenen Updates.
				entry.session.start(rec?.e2ee);
			});
			doc.on("update", (_u: Uint8Array, origin: unknown) => {
				if (entry.loading) {
					// Gespeicherter Stand: nichts neu zu speichern. Die Datei abgleichen lassen, außer ein Abgleich lädt gerade.
					if (entry.quiet === 0) this.onRemoteUpdate?.(docId);
					return;
				}
				if (origin === REMOTE) {
					if (entry.quiet === 0) this.onRemoteUpdate?.(docId);
				} else entry.edited = Date.now();
				this.schedulePersist(docId);
			});
			this.hookDirty(docId, session);
			this.live.set(docId, (l = entry));
		}
		l.refs++;
		if (opts.quiet) l.quiet++;
		if (l.releaseTimer !== null) window.clearTimeout(l.releaseTimer);
		l.releaseTimer = null;
		await l.loaded;
		return l.session;
	}

	private newSession(docId: string, doc: Y.Doc, opts: { awareness?: boolean }) {
		const s = new DocSession(this.conn, docName(this.space, docId), doc, { ...opts, key: this.key, deferStart: !!this.key });
		s.onDurable = () => this.schedulePersist(docId);
		s.onDecryptError = (e) => this.onDecryptError?.(docId, e);
		return s;
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
			// Verschlüsselt: noch unbestätigte Updates → beim nächsten Online-Gehen erneut laden und senden.
			if (l.session.e2eeState()?.pending) this.markDirty(docId);
			void this.persistNow(docId, l).finally(() => {
				l.session.destroy();
				l.session.doc.destroy();
			});
		};
		if (immediate) drop();
		else l.releaseTimer = window.setTimeout(drop, RELEASE_DELAY);
	}

	/**
	 * Kurzzeitig laden, synchronisieren (falls online) und `fn` ausführen.
	 * `reconciles`: `fn` gleicht selbst Datei und Doc ab. Bis `fn` startet, lösen fremde Änderungen (und der lokale
	 * Stand beim Laden) dann keinen weiteren Abgleich über `onRemoteUpdate` aus – `fn` sieht sie ohnehin. Sonst
	 * stieße jeder Abgleich gleich den nächsten an.
	 */
	async withDoc<T>(
		docId: string,
		fn: (s: DocSession, l: { base?: string; setBase(b: string): void }) => T | Promise<T>,
		syncTimeout = 4000,
		opts: { reconciles?: boolean } = {},
	): Promise<T> {
		const quiet = !!opts.reconciles;
		let s: DocSession;
		try {
			s = await this.acquire(docId, { quiet });
		} catch (e) {
			const l = this.live.get(docId);
			if (l && quiet) l.quiet--;
			throw e;
		}
		const l = this.live.get(docId)!;
		try {
			try {
				if (this.conn.status === "online") await s.whenSynced(syncTimeout);
			} finally {
				if (quiet) l.quiet--;
			}
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
		// Der Index bleibt immer geladen und wird nur per Zeitgeber gesichert: kurz halten, sonst kann ein
		// Absturz offline gelöschte/umbenannte Dateien zurückbringen bzw. doppeln.
		const delay =
			docId === INDEX_DOC ? PERSIST_DELAY : Math.min(PERSIST_MAX_DELAY, Math.max(PERSIST_DELAY, l.encodeMs * PERSIST_COST_FACTOR));
		l.persistTimer = window.setTimeout(() => void this.persistNow(docId, l), delay);
	}

	private async persistNow(docId: string, l: Live) {
		if (l.persistTimer !== null) window.clearTimeout(l.persistTimer);
		l.persistTimer = null;
		await l.loaded;
		if (this.destroyed) return;
		const t0 = performance.now();
		const state = Y.encodeStateAsUpdate(l.session.doc);
		l.encodeMs = performance.now() - t0;
		await this.store.put({
			name: docName(this.space, docId),
			state,
			base: l.base,
			edited: l.edited,
			e2ee: l.session.e2eeState(),
		});
	}

	/** Alles, was auf das Speichern wartet, sofort speichern (App geht in den Hintergrund). */
	async flushAllPersists() {
		await Promise.all([...this.live].filter(([, l]) => l.persistTimer !== null).map(([id, l]) => this.persistNow(id, l).catch(() => {})));
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
