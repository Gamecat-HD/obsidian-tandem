/**
 * Ein Y.Doc, das über die gemeinsame Verbindung mit dem Server synchronisiert wird.
 * - Abo = SYNC Step1 mit eigenem State-Vector; nach jedem (Wieder-)Verbinden erneut.
 * - Lokale Updates gehen sofort raus (kein Sammeln → Live-Gefühl).
 * - Optional mit Awareness (nur offene Notizen / Index für Präsenz).
 *
 * Verschlüsselte Spaces (`key` gesetzt, docs/E2EE.md): Der Server kann keine State-Vectors auswerten,
 * er führt nur ein Log aus Chiffretext. Abo = ESUB ab der zuletzt gelesenen Zeile (`cursor`), lokale
 * Updates warten in `pending`, bis der Server sie per EACK bestätigt – auch über Neustarts hinweg
 * (DocManager speichert `cursor` und `pending` mit dem Doc).
 */
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { Connection } from "../net/Connection";
import { Msg, SyncSub } from "../net/protocol";
import type { SpaceKey } from "../crypto/e2ee";

export const REMOTE = Symbol("tandem-remote");

/** Ab so vielen Log-Zeilen verdichtet der Client ein verschlüsseltes Doc. */
export const E2EE_COMPACT_ROWS = 64;

export interface E2eeState {
	cursor: number;
	pending?: Uint8Array;
}

export class DocSession {
	readonly awareness: Awareness | null;
	private _synced = false;
	private syncWaiters: (() => void)[] = [];
	private offStatus: () => void;
	private destroyed = false;
	readOnly = false;
	lastError: string | null = null;
	/** Verschlüsselt: letzte vom Server gelesene Log-Zeile. */
	cursor = 0;
	/** Verschlüsselt: lokale Updates, die der Server noch nicht bestätigt hat (n = laufende Nummer). */
	private pending: { n: number; u: Uint8Array }[] = [];
	private nextN = 1;
	/** Pro gesendetem Paket die höchste enthaltene Nummer – EACKs kommen in derselben Reihenfolge. */
	private inflight: number[] = [];
	/** Ein- und ausgehende Krypto-Arbeit strikt nacheinander (Reihenfolge der Updates bleibt erhalten). */
	private inChain: Promise<void> = Promise.resolve();
	private outChain: Promise<void> = Promise.resolve();
	private started: boolean;
	/** Verschlüsselt: `cursor`/`pending` haben sich geändert → speichern lassen. */
	onDurable: (() => void) | null = null;
	/** Verschlüsselt: Entschlüsseln schlug fehl (falsche Passphrase / veränderte Daten). */
	onDecryptError: ((e: Error) => void) | null = null;

	constructor(
		readonly conn: Connection,
		readonly name: string,
		readonly doc: Y.Doc,
		opts: { awareness?: boolean; key?: SpaceKey | null; deferStart?: boolean } = {},
	) {
		this.key = opts.key ?? null;
		this.awareness = opts.awareness ? new Awareness(doc) : null;
		conn.register(name, {
			onSync: (sub, data) => this.onSync(sub, data),
			onAwareness: (data) => {
				if (!this.awareness) return;
				if (!this.key) return applyAwarenessUpdate(this.awareness, data, REMOTE);
				const key = this.key;
				this.inChain = this.inChain.then(async () => {
					if (this.destroyed || !this.awareness) return;
					applyAwarenessUpdate(this.awareness, await key.openAwareness(this.name, data), REMOTE);
				}).catch((e) => console.warn("[tandem] Awareness", e));
			},
			onError: (code, message) => {
				this.lastError = `${code} ${message}`;
				if (code === 403) {
					this.readOnly = true;
					if (this.pending.length) {
						this.pending = [];
						this.onDurable?.();
					}
				}
				console.warn(`[tandem] ${name}: ${code} ${message}`);
			},
			onELog: (total, rows) => this.onELog(total, rows),
			onEUpd: (id, data) => this.onEUpd(id, data),
			onEAck: (id) => this.onEAck(id),
		});
		doc.on("update", this.onLocalUpdate);
		this.awareness?.on("update", this.onAwarenessChange);
		this.offStatus = conn.onStatus((s) => {
			if (s === "online") this.subscribe();
			else {
				this._synced = false;
				this.inflight = [];
			}
		});
		this.started = !opts.deferStart;
		if (this.started && conn.status === "online") this.subscribe();
	}

	readonly key: SpaceKey | null;

	get isStarted() {
		return this.started;
	}

	/** Neue Session für dasselbe Doc (Upgrade auf Awareness): Log-Position und offene Updates übernehmen. */
	adopt(old: DocSession) {
		this.cursor = old.cursor;
		this.pending = [...old.pending];
		this.nextN = old.nextN;
	}

	/** Verzögerten Start nachholen (DocManager: erst nachdem der lokale Stand geladen ist). */
	start(state?: E2eeState) {
		if (this.started) return;
		if (state) {
			this.cursor = state.cursor;
			if (state.pending?.length) this.pending.unshift({ n: 0, u: state.pending });
		}
		this.started = true;
		if (this.conn.status === "online") this.subscribe();
	}

	/** Für den DocManager: was dauerhaft gespeichert werden muss. */
	e2eeState(): E2eeState | undefined {
		if (!this.key) return undefined;
		return { cursor: this.cursor, pending: this.pending.length ? Y.mergeUpdates(this.pending.map((p) => p.u)) : undefined };
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
		if (!this.started || this.destroyed) return;
		this._synced = false;
		if (this.key) {
			this.inflight = [];
			this.conn.send({ type: Msg.ESub, doc: this.name, since: this.cursor });
		} else {
			this.conn.send({ type: Msg.Sync, doc: this.name, sub: SyncSub.Step1, data: Y.encodeStateVector(this.doc) });
		}
		if (this.awareness && this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID]);
	}

	private sendAwareness(clients: number[]) {
		if (!this.awareness) return;
		const data = encodeAwarenessUpdate(this.awareness, clients);
		if (!this.key) {
			this.conn.send({ type: Msg.Awareness, doc: this.name, data });
			return;
		}
		const key = this.key;
		this.outChain = this.outChain
			.then(async () => {
				const sealed = await key.sealAwareness(this.name, data);
				if (!this.destroyed) this.conn.send({ type: Msg.Awareness, doc: this.name, data: sealed });
			})
			.catch((e) => console.warn("[tandem] Awareness senden", e));
	}

	// ── Verschlüsselte Spaces ──────────────────────────────────────────

	private markSynced() {
		if (this._synced) return;
		this._synced = true;
		for (const w of this.syncWaiters.splice(0)) w();
	}

	private onELog(total: number, rows: { id: number; data: Uint8Array }[]) {
		const key = this.key;
		if (!key) return;
		this.inChain = this.inChain
			.then(async () => {
				if (this.destroyed) return;
				// Erst alles entschlüsseln, dann in einem Rutsch anwenden (ein Remote-Update statt vieler).
				const plain: Uint8Array[] = [];
				let last = this.cursor;
				for (const r of rows) {
					if (r.id <= this.cursor) continue;
					plain.push(await key.openDoc(this.name, r.data));
					last = r.id;
				}
				if (this.destroyed) return;
				if (plain.length) Y.applyUpdate(this.doc, plain.length === 1 ? plain[0] : Y.mergeUpdates(plain), REMOTE);
				if (last !== this.cursor) {
					this.cursor = last;
					this.onDurable?.();
				}
				this.flushPending();
				this.markSynced();
				if (total >= E2EE_COMPACT_ROWS && !this.readOnly && this.cursor > 0) await this.compact(key);
			})
			.catch((e) => this.decryptFailed(e));
	}

	private onEUpd(id: number, data: Uint8Array) {
		const key = this.key;
		if (!key) return;
		this.inChain = this.inChain
			.then(async () => {
				if (this.destroyed || id <= this.cursor) return;
				const u = await key.openDoc(this.name, data);
				if (this.destroyed) return;
				Y.applyUpdate(this.doc, u, REMOTE);
				this.cursor = id;
				this.onDurable?.();
			})
			.catch((e) => this.decryptFailed(e));
	}

	private onEAck(id: number) {
		// In die Eingangskette, damit `cursor` nie an noch nicht angewendeten fremden Updates vorbeizieht.
		this.inChain = this.inChain.then(() => {
			const upto = this.inflight.shift();
			if (upto !== undefined) this.pending = this.pending.filter((p) => p.n > upto);
			if (id > this.cursor) this.cursor = id;
			this.onDurable?.();
		});
	}

	private decryptFailed(e: unknown) {
		const err = e instanceof Error ? e : new Error(String(e));
		this.lastError = err.message;
		console.error(`[tandem] ${this.name}:`, err);
		this.onDecryptError?.(err);
	}

	/** Alle noch unbestätigten lokalen Updates als ein Paket senden. */
	private flushPending() {
		if (!this.pending.length || this.readOnly) return;
		const upto = this.pending[this.pending.length - 1].n;
		const merged = this.pending.length === 1 ? this.pending[0].u : Y.mergeUpdates(this.pending.map((p) => p.u));
		this.sendSealed(merged, upto);
	}

	private sendSealed(update: Uint8Array, upto: number) {
		const key = this.key!;
		this.outChain = this.outChain
			.then(async () => {
				const data = await key.sealDoc(this.name, update);
				if (this.destroyed || !this._synced) return;
				if (this.conn.send({ type: Msg.EUpd, doc: this.name, id: 0, data })) this.inflight.push(upto);
			})
			.catch((e) => console.warn("[tandem] Verschlüsseln", e));
	}

	private async compact(key: SpaceKey) {
		const state = await key.sealDoc(this.name, Y.encodeStateAsUpdate(this.doc));
		if (!this.destroyed) this.conn.send({ type: Msg.ECompact, doc: this.name, upto: this.cursor, data: state });
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
		if (!this.key) {
			this.conn.send({ type: Msg.Sync, doc: this.name, sub: SyncSub.Update, data: update });
			return;
		}
		if (this.readOnly) return;
		const n = this.nextN++;
		this.pending.push({ n, u: update });
		this.onDurable?.();
		// Vor dem ersten ELOG nicht senden: dann geht alles gesammelt in flushPending() raus.
		if (this._synced) this.sendSealed(update, n);
	};

	private onAwarenessChange = (
		{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin === REMOTE || !this.awareness) return;
		this.sendAwareness([...added, ...updated, ...removed]);
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
