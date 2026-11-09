/**
 * Live-Schnittstelle für andere Plugins (`api.live`), zuerst für Zellwerk (Excel-Tabellen).
 *
 * Zu jeder als Anhang synchronisierten Datei gibt es auf Wunsch ein Begleit-Dokument `<docId>-live`.
 * Das Partner-Plugin legt dort seinen eigenen Yjs-Inhalt ab (z. B. Zellen) und tauscht Updates als Bytes
 * aus – so bleibt jede Seite bei ihrer eigenen Yjs-Kopie. Präsenz läuft über die Awareness dieses Docs.
 *
 * Die Datei selbst bleibt ein normaler Anhang: Geräte ohne Partner-Plugin oder mit älterem Tandem
 * bekommen sie wie bisher. Das Partner-Plugin sorgt dafür, dass nur ein Gerät sie schreibt.
 */
import * as Y from "yjs";
import type { SpaceSync } from "../sync/SpaceSync";
import type { DocSession } from "../docs/DocSession";

export const LIVE_VERSION = 1;
/** Nur Kleinbuchstaben/Ziffern: Server erlaubt in Doc-IDs [A-Za-z0-9_-]. */
export const liveDocId = (docId: string) => `${docId}-live`;

export interface LiveUser {
	id: string;
	name: string;
	color: string;
}

export interface LivePeer {
	clientId: number;
	user: LiveUser;
	state: Record<string, unknown> | null;
}

export interface FileTypeHandler {
	/** Steckt dieser lokale Dateistand (Hash) bereits im Begleit-Dokument? Dann keine Konfliktkopie. */
	represented(path: string, hash: string): boolean;
}

interface Host {
	sync(): SpaceSync | null;
	user(): LiveUser;
}

const PUSH = Symbol("tandem-live-push");

class Channel {
	private offs: (() => void)[] = [];
	private closeFns = new Set<() => void>();
	private closed = false;

	constructor(
		private readonly api: LiveApi,
		readonly sync: SpaceSync,
		readonly docId: string,
		private readonly session: DocSession,
		private readonly host: Host,
	) {}

	get clientId() {
		return this.session.doc.clientID;
	}

	get role() {
		return this.sync.role() ?? "read";
	}

	get user() {
		return this.host.user();
	}

	state() {
		return Y.encodeStateAsUpdate(this.session.doc);
	}

	/**
	 * Ist dieser lokale Dateistand eine überholte, unveränderte Fassung (eine neuere ist schon im Index,
	 * der Download steht noch aus)? Dann ist er keine „Änderung von außen“.
	 */
	fileStale(hash: string): boolean {
		const e = this.sync.index.get(this.docId.replace(/-live$/, ""));
		if (!e || e.del || !e.hash) return false;
		return hash !== e.hash && this.sync.blobs.knownHash(e.path) === hash;
	}

	whenSynced(timeoutMs = 5000) {
		return this.session.whenSynced(timeoutMs);
	}

	push(update: Uint8Array) {
		if (this.closed || this.role === "read") return;
		Y.applyUpdate(this.session.doc, update, PUSH);
	}

	onUpdate(fn: (u: Uint8Array) => void) {
		const h = (u: Uint8Array, origin: unknown) => {
			if (origin !== PUSH && !this.closed) fn(u);
		};
		this.session.doc.on("update", h);
		const off = () => this.session.doc.off("update", h);
		this.offs.push(off);
		return off;
	}

	setPresence(state: Record<string, unknown> | null) {
		const aw = this.session.awareness;
		if (!aw || this.closed) return;
		if (state === null) aw.setLocalState(null);
		else aw.setLocalState({ user: this.host.user(), state });
	}

	onPresence(fn: (peers: LivePeer[]) => void) {
		const aw = this.session.awareness;
		if (!aw) return () => {};
		const emit = () => {
			const own = aw.clientID;
			const peers: LivePeer[] = [];
			for (const [id, st] of aw.getStates()) {
				if (id === own || !st?.user) continue;
				peers.push({ clientId: id, user: st.user as LiveUser, state: (st.state as Record<string, unknown>) ?? null });
			}
			fn(peers);
		};
		aw.on("change", emit);
		const off = () => aw.off("change", emit);
		this.offs.push(off);
		emit();
		return off;
	}

	onClose(fn: () => void) {
		this.closeFns.add(fn);
		return () => this.closeFns.delete(fn);
	}

	close() {
		this.end(false);
	}

	/** `notify`: Tandem trennt (Partner soll neu verbinden). */
	end(notify: boolean) {
		if (this.closed) return;
		try {
			this.session.awareness?.setLocalState(null);
		} catch {
			/* Session schon zerstört */
		}
		this.closed = true;
		for (const off of this.offs) off();
		this.offs = [];
		this.sync.docs.release(this.docId);
		this.api.forget(this);
		if (notify) for (const fn of this.closeFns) fn();
		this.closeFns.clear();
	}
}

export class LiveApi {
	readonly version = LIVE_VERSION;
	private types = new Map<string, FileTypeHandler>();
	private channels = new Set<Channel>();

	constructor(private readonly host: Host) {}

	/** Kanal zum Begleit-Dokument; null, wenn die Datei (noch) nicht als Anhang synchronisiert wird. */
	open = async (path: string): Promise<Channel | null> => {
		const sync = this.host.sync();
		if (!sync?.index) return null;
		if (!sync.syncable(path) || sync.index.contested(path)) return null;
		const id = sync.index.idForPath(path);
		const entry = id ? sync.index.get(id) : undefined;
		if (!id || !entry || entry.del || entry.kind !== "blob") return null;
		const docId = liveDocId(id);
		const session = await sync.docs.acquire(docId, { awareness: true });
		if (this.host.sync() !== sync) {
			sync.docs.release(docId);
			return null;
		}
		const ch = new Channel(this, sync, docId, session, this.host);
		this.channels.add(ch);
		return ch;
	};

	registerFileType = (ext: string, handler: FileTypeHandler) => {
		const key = ext.toLowerCase().replace(/^\./, "");
		this.types.set(key, handler);
		return () => {
			if (this.types.get(key) === handler) this.types.delete(key);
		};
	};

	/** Für BlobSync: lokale Fassung steckt im Begleit-Dokument → keine Konfliktkopie nötig. */
	represented(path: string, hash: string): boolean {
		const ext = path.split(".").pop()?.toLowerCase() ?? "";
		const h = this.types.get(ext);
		if (!h) return false;
		try {
			return !!h.represented(path, hash);
		} catch (e) {
			console.warn("[tandem] live.represented", e);
			return false;
		}
	}

	forget(ch: Channel) {
		this.channels.delete(ch);
	}

	/** Tandem stoppt (Trennen, Neustart): alle Kanäle schließen und Partner informieren. */
	closeAll() {
		for (const ch of [...this.channels]) ch.end(true);
	}

	/** Öffentliche Sicht für `api.live`. */
	facade() {
		return {
			version: this.version,
			open: this.open,
			registerFileType: this.registerFileType,
		};
	}
}
