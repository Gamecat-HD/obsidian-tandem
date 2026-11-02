/**
 * Ein Y.Doc, das über die gemeinsame Verbindung mit dem Server synchronisiert wird.
 * - Abo = SYNC Step1 mit eigenem State-Vector; nach jedem (Wieder-)Verbinden erneut.
 * - Lokale Updates gehen sofort raus (kein Sammeln → Live-Gefühl).
 * - Optional mit Awareness (nur offene Notizen / Index für Präsenz).
 */
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { Connection } from "../net/Connection";
import { Msg, SyncSub } from "../net/protocol";

export const REMOTE = Symbol("tandem-remote");

export class DocSession {
	readonly awareness: Awareness | null;
	private _synced = false;
	private syncWaiters: (() => void)[] = [];
	private offStatus: () => void;
	private destroyed = false;
	readOnly = false;
	lastError: string | null = null;

	constructor(
		readonly conn: Connection,
		readonly name: string,
		readonly doc: Y.Doc,
		opts: { awareness?: boolean } = {},
	) {
		this.awareness = opts.awareness ? new Awareness(doc) : null;
		conn.register(name, {
			onSync: (sub, data) => this.onSync(sub, data),
			onAwareness: (data) => {
				if (this.awareness) applyAwarenessUpdate(this.awareness, data, REMOTE);
			},
			onError: (code, message) => {
				this.lastError = `${code} ${message}`;
				if (code === 403) this.readOnly = true;
				console.warn(`[tandem] ${name}: ${code} ${message}`);
			},
		});
		doc.on("update", this.onLocalUpdate);
		this.awareness?.on("update", this.onAwarenessChange);
		this.offStatus = conn.onStatus((s) => {
			if (s === "online") this.subscribe();
			else this._synced = false;
		});
		if (conn.status === "online") this.subscribe();
	}

	get synced() {
		return this._synced;
	}

	/** Wartet auf den ersten vollständigen Abgleich – oder gibt nach `timeout` ms auf (offline). */
	whenSynced(timeout = 5000): Promise<boolean> {
		if (this._synced) return Promise.resolve(true);
		return new Promise((ok) => {
			const t = window.setTimeout(() => ok(false), timeout);
			this.syncWaiters.push(() => {
				window.clearTimeout(t);
				ok(true);
			});
		});
	}

	private subscribe() {
		this._synced = false;
		this.conn.send({ type: Msg.Sync, doc: this.name, sub: SyncSub.Step1, data: Y.encodeStateVector(this.doc) });
		if (this.awareness && this.awareness.getLocalState() !== null) {
			this.conn.send({
				type: Msg.Awareness,
				doc: this.name,
				data: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
			});
		}
	}

	private onSync(sub: number, data: Uint8Array) {
		if (this.destroyed) return;
		if (sub === SyncSub.Step1) {
			this.conn.send({ type: Msg.Sync, doc: this.name, sub: SyncSub.Step2, data: Y.encodeStateAsUpdate(this.doc, data) });
			return;
		}
		Y.applyUpdate(this.doc, data, REMOTE);
		if (sub === SyncSub.Step2 && !this._synced) {
			this._synced = true;
			for (const w of this.syncWaiters.splice(0)) w();
		}
	}

	private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE || this.destroyed) return;
		this.conn.send({ type: Msg.Sync, doc: this.name, sub: SyncSub.Update, data: update });
	};

	private onAwarenessChange = (
		{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin === REMOTE || !this.awareness) return;
		const changed = [...added, ...updated, ...removed];
		this.conn.send({ type: Msg.Awareness, doc: this.name, data: encodeAwarenessUpdate(this.awareness, changed) });
	};

	destroy() {
		if (this.destroyed) return;
		if (this.awareness) {
			removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
			this.awareness.off("update", this.onAwarenessChange);
			this.awareness.destroy();
		}
		this.destroyed = true;
		this.doc.off("update", this.onLocalUpdate);
		this.offStatus();
		this.conn.send({ type: Msg.Unsub, doc: this.name });
		this.conn.unregister(this.name);
	}
}
