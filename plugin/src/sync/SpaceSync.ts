/**
 * Synchronisiert einen Vault mit einem Space: Index, Dateien, Editoren, Anhänge.
 */
import { TFile, TFolder, type App, type TAbstractFile, type EventRef } from "obsidian";
import * as Y from "yjs";
import type { Connection } from "../net/Connection";
import { INDEX_DOC, Msg, splitDocName } from "../net/protocol";
import { DocManager } from "../docs/DocManager";
import { REMOTE, type DocSession } from "../docs/DocSession";
import type { LocalStore } from "../docs/LocalStore";
import { kindForPath, newDocId, VaultIndex, type IndexEntry } from "../docs/VaultIndex";
import { sha256Hex } from "../disk/diff";
import { DiskBridge } from "../disk/DiskBridge";
import { EditorBinder } from "../editor/EditorBinder";
import { BlobSync } from "../blobs/BlobSync";
import type { SpaceKey } from "../crypto/e2ee";
import type { Transfer } from "../blobs/TransferGuard";
import { referencingNotesMany } from "./references";

/** Ein gelöschter Anhang, auf den Notizen noch verweisen. */
export interface ReferencedDelete {
	path: string;
	/** Wer gelöscht hat (Benutzerkennung); `local`: auf diesem Gerät. */
	by?: string;
	local: boolean;
	notes: string[];
}

export interface SpaceSyncOptions {
	app: App;
	conn: Connection;
	store: LocalStore;
	space: string;
	ignore: RegExp[];
	user(): { id: string; name: string; color: string };
	http(): { base: string; token: string };
	log?(msg: string): void;
	/** Ende-zu-Ende-verschlüsselter Space: Schlüssel (sonst null). */
	key?: SpaceKey | null;
	/** Eine große Übertragung kam beim letzten Lauf nicht zu Ende (App beendet) und wird nun übersprungen. */
	onTransferLost?(t: Transfer): void;
	/**
	 * Anhänge wurden gelöscht, die Notizen noch verwenden (etwa als Ink-Hintergrund, den Obsidian nicht als Link
	 * erkennt). `restore` holt alle zurück, auf allen Geräten; fehlt bei Nur-Lese-Zugriff.
	 */
	onReferencedDelete?(items: ReferencedDelete[], restore: (() => number) | null): void;
	/** Partner-Plugin (Live-API): lokaler Stand einer Datei steckt im Begleit-Dokument → keine Konfliktkopie. */
	represented?(path: string, hash: string): boolean;
}

/** Standard-Ignorierliste (zusätzlich zu den Einstellungen). */
export const DEFAULT_IGNORE = [
	/^\.obsidian\//,
	/^\.trash\//,
	/(^|\/)\.git\//,
	/(^|\/)node_modules\//,
	/\.tmp\.\d+\.[0-9a-f]+$/, // Atomic-Write-Temp-Dateien (Claude Code u. a.)
	/(^|\/)\.DS_Store$/,
];

/**
 * Gleichzeitige Hintergrund-Abgleiche. Notizen warten fast nur auf das Netz (Abo → Step2, eine Rundlaufzeit), daher
 * viele parallel; Anhänge liegen beim Übertragen ganz im Speicher (siehe TransferGuard), daher wenige.
 */
const DOC_PARALLEL = 16;
const BLOB_PARALLEL = 4;
/** So viele IndexedDB-Lesezugriffe bzw. Datei-Hashes beim Scan gleichzeitig. */
const SCAN_PARALLEL = 32;

/** `fn` für alle Elemente, höchstens `n` gleichzeitig. */
async function eachLimited<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
	let i = 0;
	const worker = async () => {
		while (i < items.length) await fn(items[i++]);
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Begrenzte Parallelität für Hintergrund-Abgleiche. */
class Limiter {
	private active = 0;
	private waiting: (() => void)[] = [];
	constructor(private max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) await new Promise<void>((ok) => this.waiting.push(ok));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}

export class SpaceSync {
	readonly docs: DocManager;
	index!: VaultIndex;
	indexSession!: DocSession;
	bridge!: DiskBridge;
	binder!: EditorBinder;
	blobs!: BlobSync;
	private refs: EventRef[] = [];
	private offs: (() => void)[] = [];
	private limiter = new Limiter(DOC_PARALLEL);
	private blobLimiter = new Limiter(BLOB_PARALLEL);
	/** Abgleiche, die noch in der Warteschlange stehen (ein weiterer Anlass ändert nichts, sie lesen beim Start alles neu). */
	private queuedReconciles = new Set<string>();
	/** docIds, deren lokaler Stand eine Grundlage (`base`) hat – einmal gesehen, bleibt das so. */
	private based = new Set<string>();
	private seq = 0;
	private remoteTimers = new Map<string, number>();
	/** Von der InkBridge gesetzt, wenn Ink Blocks `api.exclusive` anbietet. */
	inkExclusive: (<T>(path: string, fn: () => Promise<T>) => Promise<T>) | null = null;
	origin = "";
	private started = false;
	private scanning: Promise<void> | null = null;
	/** Für Tests/Statusanzeige: laufende Hintergrundarbeit. */
	pending = 0;
	private idleWaiters: (() => void)[] = [];
	/** Gelöschte Anhänge (docId → Angaben), gesammelt und kurz danach auf Verweise geprüft. */
	private deleted = new Map<string, { path: string; by?: string; local: boolean }>();
	private deletedTimer: number | null = null;

	constructor(readonly o: SpaceSyncOptions) {
		this.docs = new DocManager(o.conn, o.store, o.space, o.key ?? null);
	}

	private log(msg: string) {
		this.o.log?.(msg);
	}

	async start() {
		const { app, conn } = this.o;
		this.indexSession = await this.docs.acquire(INDEX_DOC, { awareness: true });
		this.index = new VaultIndex(this.indexSession.doc, () => this.o.user().id);
		this.origin = (await this.o.store.getMeta<string>("origin")) ?? "";
		if (!this.origin) {
			this.origin = newDocId();
			await this.o.store.setMeta("origin", this.origin);
		}
		this.bridge = new DiskBridge(app, this.docs, this.index, {
			isBound: (p) => this.binder?.isBound(p) ?? false,
			origin: () => this.origin,
			readOnly: () => this.role() === "read",
			exclusive: <T,>(path: string, fn: () => Promise<T>) => (this.inkExclusive ? this.inkExclusive(path, fn) : fn()),
			queueReconcile: (id) => this.trackReconcile(id),
		});
		this.blobs = new BlobSync(app, this.index, this.bridge, this.o.store, this.o.space, this.o.http, this.o.key ?? null, (t) => this.o.onTransferLost?.(t));
		this.blobs.represented = (path, hash) => this.o.represented?.(path, hash) ?? false;
		this.binder = new EditorBinder({
			app,
			docs: this.docs,
			docIdFor: (f) => (kindForPath(f.path) === "md" && this.syncable(f.path) ? this.index.idForPath(f.path) : undefined),
			prepare: (id) => this.bridge.reconcile(id),
			localUser: this.o.user,
			readOnly: () => this.role() === "read",
		});
		this.seq = (await this.o.store.getMeta<number>(`seq:${this.o.space}`)) ?? 0;
		// Remote-Änderung an einem geladenen, aber nicht im Editor offenen Doc → Datei nachziehen.
		this.docs.onRemoteUpdate = (docId) => {
			if (docId === INDEX_DOC) return;
			const e = this.index.get(docId);
			if (!e || e.del || e.kind === "blob" || this.binder.isBound(e.path)) return;
			const t = this.remoteTimers.get(docId);
			if (t !== undefined) window.clearTimeout(t);
			this.remoteTimers.set(
				docId,
				window.setTimeout(() => {
					this.remoteTimers.delete(docId);
					this.trackReconcile(docId);
				}, 250),
			);
		};

		this.index.files.observe((ev, tr) => {
			if (tr.origin !== REMOTE) return;
			// Pfade, um die gerade ein Namenskonflikt besteht: erst auflösen, dann den Gewinner holen.
			const contested = new Set(this.index.conflicts().map(([, e]) => e.path));
			for (const [id, change] of ev.changes.keys) {
				const entry = this.index.get(id);
				if (!entry) continue;
				const prev = change.oldValue as IndexEntry | undefined;
				if (!entry.del && contested.has(entry.path)) continue;
				this.track(() => this.applyRemoteEntry(id, entry, prev), entry.kind === "blob" ? "blob" : "doc");
			}
			if (contested.size) this.track(() => this.resolveConflicts());
			this.binder.refresh();
		});

		this.offs.push(
			conn.onChanges((space, seq, names) => {
				if (space !== this.o.space) return;
				for (const n of names) {
					const { docId } = splitDocName(n);
					if (docId === INDEX_DOC) continue;
					const e = this.index.get(docId);
					if (!e || e.del || e.kind === "blob") continue;
					if (this.binder.isBound(e.path)) continue;
					this.trackReconcile(docId);
				}
				if (seq > this.seq) {
					this.seq = seq;
					void this.o.store.setMeta(`seq:${this.o.space}`, seq);
				}
			}),
			conn.onStatus((s) => {
				if (s === "online") void this.onOnline();
			}),
		);

		const v = app.vault;
		this.refs.push(
			v.on("create", (f) => this.onCreate(f)),
			v.on("modify", (f) => this.onModify(f)),
			v.on("delete", (f) => this.onDelete(f)),
			v.on("rename", (f, old) => this.onRename(f, old)),
			app.workspace.on("layout-change", () => this.binder.refresh()),
			app.workspace.on("file-open", () => this.binder.refresh()),
		);
		this.started = true;
		if (conn.status === "online") await this.onOnline();
		else this.binder.refresh();
	}

	private async onOnline() {
		if (!this.started) return;
		await this.indexSession.whenSynced(10000);
		this.o.conn.send({ type: Msg.Catchup, space: this.o.space, since: this.seq });
		await this.scan();
		this.binder.refresh();
	}

	get key(): SpaceKey | null {
		return this.o.key ?? null;
	}

	role(): string | undefined {
		return this.o.conn.welcome?.spaces.find((s) => s.id === this.o.space)?.role;
	}

	syncable(path: string) {
		return !DEFAULT_IGNORE.some((r) => r.test(path)) && !this.o.ignore.some((r) => r.test(path));
	}

	private track(fn: () => Promise<void>, lane: "doc" | "blob" = "doc") {
		if (!this.started && this.refs.length) return;
		this.pending++;
		void (lane === "blob" ? this.blobLimiter : this.limiter)
			.run(fn)
			.catch((e) => console.warn("[tandem]", e))
			.finally(() => {
				this.pending--;
				if (this.pending === 0) for (const w of this.idleWaiters.splice(0)) w();
			});
	}

	/** Datei ⇄ Doc abgleichen lassen; steht schon ein Abgleich dieses Docs aus, genügt der. */
	private trackReconcile(id: string) {
		if (this.queuedReconciles.has(id) || (!this.started && this.refs.length)) return;
		this.queuedReconciles.add(id);
		this.track(() => {
			this.queuedReconciles.delete(id);
			return this.bridge.reconcile(id);
		});
	}

	/** Übersprungene Anhänge erneut übertragen (Einstellungen). */
	async retrySkipped() {
		for (const t of await this.blobs.guard.clear()) {
			if (t.dir === "down" && t.hash) {
				const hash = t.hash;
				this.track(() => this.blobs.fetch(t.path, hash), "blob");
			} else if (t.dir === "up") {
				const file = this.o.app.vault.getFileByPath(t.path);
				if (file) this.track(() => this.blobs.upload(file), "blob");
			}
		}
	}

	/** Wartet, bis keine Hintergrundarbeit mehr läuft (Tests, Statusanzeige). */
	idle(): Promise<void> {
		if (this.pending === 0 && !this.scanning) return Promise.resolve();
		return new Promise((ok) => this.idleWaiters.push(ok));
	}

	/**
	 * Vollabgleich Platte ⇄ Index: neue lokale Dateien eintragen, fehlende anlegen,
	 * geänderte Dateien (mtime/size seit dem letzten Lauf) abgleichen.
	 */
	scan(): Promise<void> {
		if (this.scanning) return this.scanning;
		this.scanning = this.doScan().finally(() => {
			this.scanning = null;
			if (this.pending === 0) for (const w of this.idleWaiters.splice(0)) w();
		});
		return this.scanning;
	}

	private async doScan() {
		const { app, store, space } = this.o;
		const stats = (await store.getMeta<Record<string, [number, number]>>(`stats:${space}`)) ?? {};
		const next: Record<string, [number, number]> = {};
		const files = app.vault.getFiles().filter((f) => this.syncable(f.path));
		const ro = this.role() === "read";
		const fresh: { path: string; kind: ReturnType<typeof kindForPath>; hash?: string }[] = [];
		const unknown: TFile[] = [];
		for (const f of files) {
			if (ro || this.index.idForPath(f.path)) continue;
			const kind = kindForPath(f.path);
			// Datei wurde anderswo gelöscht, ist hier aber noch da: geändert → wiederherstellen, sonst Löschung übernehmen.
			const dead = this.index.deletedIdForPath(f.path);
			if (dead) {
				const e = this.index.get(dead)!;
				const rec = await store.get(`${space}/${dead}`);
				let changed: boolean;
				if (kind === "blob") changed = await this.blobs.changedLocally(f);
				else changed = rec?.base === undefined || (await app.vault.read(f)) !== rec.base || (rec.edited ?? 0) > e.ts;
				if (changed) {
					this.log(`${f.path}: nach dem Löschen noch bearbeitet → wiederhergestellt`);
					this.index.update(dead, { del: false });
				} else await this.bridge.trash(f.path);
				continue;
			}
			unknown.push(f);
		}
		// Neue Dateien lesen und hashen – parallel (Erstimport: Tausende Dateien).
		await eachLimited(unknown, SCAN_PARALLEL, async (f) => {
			const kind = kindForPath(f.path);
			if (kind === "blob") return void fresh.push({ path: f.path, kind });
			try {
				fresh.push({ path: f.path, kind, hash: await sha256Hex(await app.vault.read(f)) });
			} catch (e) {
				// Inzwischen gelöscht/umbenannt: Das melden die Vault-Ereignisse, der Scan läuft weiter.
				console.warn("[tandem] Scan", f.path, e);
			}
		});
		let added = 0;
		this.index.doc.transact(() => {
			for (const n of fresh) {
				if (this.index.idForPath(n.path)) continue;
				this.index.add(n.path, n.kind, n.hash ? { hash: n.hash, origin: this.origin } : { origin: this.origin });
				added++;
			}
		});
		if (added) this.log(`${added} neue Datei(en) eingetragen`);
		await this.resolveConflicts();
		const all = app.vault.getFiles().filter((f) => this.syncable(f.path));
		// Unveränderte Notizen ohne gespeicherte Grundlage (z. B. Abgleich vor dem Beenden nicht fertig) brauchen einen
		// Abgleich. Nachsehen parallel statt einzeln nacheinander, und nur einmal pro Doc (bei jedem Wiederverbinden).
		const check: string[] = [];
		for (const f of all) {
			const old = stats[f.path];
			if (!old || old[0] !== f.stat.mtime || old[1] !== f.stat.size) continue;
			const id = this.index.idForPath(f.path);
			if (id && !this.based.has(id) && this.index.get(id)?.kind !== "blob") check.push(id);
		}
		await eachLimited(check, SCAN_PARALLEL, async (id) => {
			if (await this.hasBase(id)) this.based.add(id);
		});
		for (const f of all) {
			next[f.path] = [f.stat.mtime, f.stat.size];
			const old = stats[f.path];
			const changed = !old || old[0] !== f.stat.mtime || old[1] !== f.stat.size;
			const id = this.index.idForPath(f.path);
			if (!id) continue;
			const e = this.index.get(id)!;
			if (e.kind === "blob") {
				// Absturz beim Schreiben eines Downloads: Datei womöglich halb → neu laden, nie hochladen.
				if (this.blobs.interrupted(f.path)) {
					this.track(() => this.blobs.repair(f.path), "blob");
					continue;
				}
				if (ro) continue;
				if (changed || !e.hash || this.blobs.pendingUploads.has(f.path)) this.track(() => this.blobs.upload(f), "blob");
			} else if (changed || !this.based.has(id)) {
				this.trackReconcile(id);
			}
		}
		// Im Index, aber lokal fehlend → anlegen (sofern nicht absichtlich gelöscht – das meldet onDelete).
		for (const [id, e] of this.index.live()) {
			if (!this.syncable(e.path) || app.vault.getAbstractFileByPath(e.path)) continue;
			if (this.index.idForPath(e.path) !== id) continue;
			if (e.kind === "blob") {
				if (e.hash) this.track(() => this.blobs.fetch(e.path, e.hash!), "blob");
			} else this.trackReconcile(id);
		}
		await store.setMeta(`stats:${space}`, next);
	}

	private async hasBase(id: string) {
		const rec = await this.o.store.get(`${this.o.space}/${id}`);
		return rec?.base !== undefined;
	}

	/**
	 * Gleichzeitig (offline) angelegte Dateien mit gleichem Pfad: Die kleinere docId behält den Pfad.
	 * Das Gerät, das den Verlierer angelegt hat, benennt SEINE Datei um („Neu (2).md“) und holt danach
	 * die Fassung des Gewinners an den ursprünglichen Pfad. So geht kein Inhalt verloren.
	 */
	private async resolveConflicts() {
		for (const [id, e] of this.index.conflicts()) {
			if (e.origin !== this.origin) continue;
			const oldPath = e.path;
			const dot = oldPath.lastIndexOf(".");
			let n = 2;
			let p: string;
			do p = `${oldPath.slice(0, dot)} (${n++})${oldPath.slice(dot)}`;
			while (this.index.idForPath(p) || this.o.app.vault.getAbstractFileByPath(p));
			// Bis die Datei umbenannt ist, liegt am alten Pfad noch der Inhalt des Verlierers → dort nicht abgleichen
			await this.bridge.holdWhile(oldPath, async () => {
				this.index.update(id, { path: p });
				if (this.o.app.vault.getFileByPath(oldPath)) await this.bridge.rename(oldPath, p);
			});
			this.log(`Namenskonflikt: ${oldPath} → ${p}`);
			const winner = this.index.idForPath(oldPath);
			if (winner) {
				const w = this.index.get(winner)!;
				if (w.kind === "blob") {
					if (w.hash) this.track(() => this.blobs.fetch(oldPath, w.hash!), "blob");
				} else this.trackReconcile(winner);
			}
		}
	}

	private async applyRemoteEntry(id: string, entry: IndexEntry, prev: IndexEntry | undefined) {
		if (!this.syncable(entry.path)) return;
		if (entry.kind === "blob") {
			if (entry.del) {
				if (prev && !prev.del) {
					await this.bridge.trash(prev.path);
					this.blobs.forget(prev.path);
					this.noteDeleted(id, prev.path, entry.by, false);
				}
				return;
			}
			const owner = prev ? this.index.idForPath(prev.path) : undefined;
			if (prev && !prev.del && prev.path !== entry.path && (!owner || owner === id)) {
				await this.bridge.rename(prev.path, entry.path);
				this.blobs.renamed(prev.path, entry.path);
			}
			if (entry.hash && (!prev || prev.hash !== entry.hash || !this.o.app.vault.getFileByPath(entry.path))) {
				await this.blobs.fetch(entry.path, entry.hash, entry.parent);
			}
			return;
		}
		if (entry.del && prev && !prev.del) {
			// Hier nach dem Löschzeitpunkt noch bearbeitet (z. B. offline)? Dann gewinnt die Änderung.
			await this.docs.flushPersist(id);
			const rec = await this.o.store.get(`${this.o.space}/${id}`);
			const f = this.o.app.vault.getFileByPath(prev.path);
			const pendingDisk = f && rec?.base !== undefined && (await this.o.app.vault.read(f)) !== rec.base;
			if ((rec?.edited ?? 0) > entry.ts || pendingDisk) {
				this.log(`${prev.path}: nach dem Löschen noch bearbeitet → wiederhergestellt`);
				this.index.update(id, { del: false, path: prev.path });
				return;
			}
		}
		if (prev && !prev.del && prev.path !== entry.path) this.binder.renamed(prev.path, entry.path);
		await this.bridge.materialize(id, entry, prev);
	}

	// ── Vault-Ereignisse (lokal) ────────────────────────────────────────────

	private get ro() {
		return this.role() === "read";
	}

	private onCreate(f: TAbstractFile) {
		if (this.ro) return;
		if (!(f instanceof TFile) || !this.syncable(f.path) || this.bridge.isOwnWrite(f.path)) return;
		const kind = kindForPath(f.path);
		if (kind === "blob") return this.track(() => this.blobs.upload(f), "blob");
		this.track(async () => {
			const hash = await sha256Hex(await this.o.app.vault.read(f));
			const id = this.index.add(f.path, kind, { hash, origin: this.origin });
			await this.bridge.reconcile(id);
		});
	}

	private onModify(f: TAbstractFile) {
		if (this.ro || !(f instanceof TFile) || !this.syncable(f.path)) return;
		const kind = kindForPath(f.path);
		if (kind === "blob") {
			// Nicht anhand des eigenen Schreib-Markers überspringen: Eine echte Änderung kurz nach einem
			// Download (z. B. Excel-Datei aus einem anderen Programm) ginge sonst verloren. Der Upload
			// vergleicht den Hash mit dem Index und tut bei der eigenen Fassung nichts.
			return this.track(() => this.blobs.upload(f), "blob");
		}
		const id = this.index.idForPath(f.path);
		if (!id) return this.onCreate(f);
		if (this.binder.isBound(f.path)) {
			// Obsidian hat den Editor gespeichert: Platte = Doc → neue Grundlage.
			const s = this.binder.sessionFor(f.path);
			void this.o.app.vault.read(f).then((t) => {
				if (s && t === s.doc.getText("content").toString()) this.docs.setBase(id, t);
			});
			return;
		}
		void this.o.app.vault.read(f).then((t) => {
			if (this.bridge.isOwnWrite(f.path, t)) return;
			this.trackReconcile(id);
		});
	}

	private onDelete(f: TAbstractFile) {
		if (this.ro) return;
		if (!this.syncable(f.path) || this.bridge.isOwnDelete(f.path)) return;
		const id = f instanceof TFile ? this.index.idForPath(f.path) : undefined;
		this.index.remove(f.path);
		if (id && this.index.get(id)?.kind === "blob") this.noteDeleted(id, f.path, undefined, true);
		if (f instanceof TFile) this.blobs.forget(f.path);
		this.binder.refresh();
	}

	private onRename(f: TAbstractFile, old: string) {
		if (this.ro) return;
		if (this.bridge.isOwnRename(old, f.path)) return;
		const wasSync = this.syncable(old);
		const isSync = this.syncable(f.path);
		if (wasSync && !isSync) return this.index.remove(old);
		if (!wasSync && isSync) {
			if (f instanceof TFile) this.onCreate(f);
			else if (f instanceof TFolder) void this.scan();
			return;
		}
		if (!isSync) return;
		this.index.rename(old, f.path);
		if (f instanceof TFile) this.blobs.renamed(old, f.path);
		this.binder.renamed(old, f.path);
	}

	/**
	 * Gelöschten Anhang vormerken. Geprüft wird erst nach einer kurzen Pause: Beim Löschen eines ganzen Ordners
	 * verschwinden die Notizen kurz nach den Bildern, und mehrere Löschungen ergeben nur einen Hinweis.
	 */
	private noteDeleted(id: string, path: string, by: string | undefined, local: boolean) {
		if (!this.o.onReferencedDelete) return;
		this.deleted.set(id, { path, by, local });
		if (this.deletedTimer !== null) window.clearTimeout(this.deletedTimer);
		this.deletedTimer = window.setTimeout(() => {
			this.deletedTimer = null;
			void this.checkDeleted().catch((e) => console.warn("[tandem] Verweise prüfen", e));
		}, 2000);
	}

	private async checkDeleted() {
		const batch = [...this.deleted];
		this.deleted.clear();
		const { app } = this.o;
		const notes = app.vault
			.getMarkdownFiles()
			.filter((f) => this.syncable(f.path))
			.map((f) => ({ path: f.path, read: () => app.vault.cachedRead(f) }));
		const stillResolves = (name: string, from: string) => !!app.metadataCache.getFirstLinkpathDest(name, from);
		// Inzwischen wiederhergestellt oder ohne Inhalt auf dem Server: nichts zu melden.
		const gone = batch.filter(([id, d]) => {
			const e = this.index.get(id);
			return e?.del && e.hash && !app.vault.getAbstractFileByPath(d.path);
		});
		// Ein Durchgang über alle Notizen für alle gelöschten Anhänge (Ordner mit vielen Bildern gelöscht).
		const refsByPath = await referencingNotesMany([...new Set(gone.map(([, d]) => d.path))], notes, stillResolves);
		const items: (ReferencedDelete & { id: string })[] = [];
		for (const [id, d] of gone) {
			const refs = refsByPath.get(d.path) ?? [];
			if (refs.length) items.push({ id, ...d, notes: refs });
		}
		if (!items.length) return;
		for (const i of items) this.log(`${i.path}: gelöscht${i.local ? "" : ` von ${i.by ?? "?"}`}, wird aber noch verwendet in ${i.notes.join(", ")}`);
		const restore = this.ro ? null : () => items.filter((i) => this.restoreBlob(i.id)).length;
		this.o.onReferencedDelete?.(
			items.map(({ id: _id, ...rest }) => rest),
			restore,
		);
	}

	/** Gelöschten Anhang zurückholen (Index-Eintrag wieder lebendig → alle Geräte laden ihn). */
	restoreBlob(id: string): boolean {
		const e = this.index.get(id);
		if (!e?.del || !e.hash || this.index.idForPath(e.path)) return false;
		this.index.update(id, { del: false });
		const hash = e.hash;
		this.track(() => this.blobs.fetch(e.path, hash), "blob");
		this.log(`${e.path}: wiederhergestellt`);
		return true;
	}

	async stop() {
		this.started = false;
		if (this.deletedTimer !== null) window.clearTimeout(this.deletedTimer);
		this.deletedTimer = null;
		this.deleted.clear();
		for (const t of this.remoteTimers.values()) window.clearTimeout(t);
		this.remoteTimers.clear();
		for (const r of this.refs) this.o.app.vault.offref(r);
		for (const r of this.refs) this.o.app.workspace.offref(r);
		for (const off of this.offs) off();
		this.binder?.destroy();
		await this.docs.destroy();
	}

	/** Für Tests: aktueller Text eines Docs (aus dem RAM oder lokal). */
	async debugText(path: string): Promise<string | null> {
		const id = this.index.idForPath(path);
		if (!id) return null;
		const s = await this.docs.acquire(id);
		try {
			return s.doc.getText("content").toString();
		} finally {
			this.docs.release(id);
		}
	}
}

export { Y };
