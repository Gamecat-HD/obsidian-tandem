/**
 * Hält Vault-Dateien und Docs synchron – für alles, was gerade NICHT im Editor gekoppelt ist.
 * (Offene Notizen synchronisiert der Editor selbst; Obsidian speichert sie wie gewohnt.)
 *
 * Grundregel pro Doc: `base` = Dateiinhalt, der zuletzt mit dem Doc übereinstimmte.
 *   Datei ≠ base  → lokale Änderung (Claude Code, git, offline): 3-Wege-Merge ins Doc
 *   Doc   ≠ Datei → Datei schreiben
 */
import { normalizePath, TFile, type App } from "obsidian";
import type * as Y from "yjs";
import type { DocManager } from "../docs/DocManager";
import type { IndexEntry, VaultIndex } from "../docs/VaultIndex";
import { kindForPath } from "../docs/VaultIndex";
import { applyInkFile, encodeInkDoc } from "../ink/inkDoc";
import { applyEdits, rebaseEdits } from "./rebase";
import { applyTextDiff, sha256Hex } from "./diff";

export interface BridgeHooks {
	/** Gerade im Editor gekoppelt? Dann übernimmt der Editor. */
	isBound(path: string): boolean;
	/** Ink Blocks kann Änderungen direkt übernehmen (Stufe B), sonst über die Datei. */
	onInkWritten?(path: string): void;
	/** Kennung dieser Installation (siehe IndexEntry.origin). */
	origin(): string;
	/** Nur Lesezugriff: lokale Änderungen nie übernehmen, der Server gewinnt. */
	readOnly(): boolean;
	/** Schreibzugriff auf eine .ink-Datei mit Ink Blocks abstimmen (dessen Speicher-Warteschlange). */
	exclusive?<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

/** Origin für Änderungen, die aus der Datei auf der Platte stammen (fremde Schreiber, Offline-Bearbeitung). */
export const LOCAL = Symbol("tandem-disk");

export class DiskBridge {
	/**
	 * Eigene Dateioperationen, deren Vault-Events ignoriert werden sollen – getrennt nach Art:
	 *   w:<pfad>        Schreiben (Inhalt bzw. null = beliebig bei Binärdateien), läuft nach 2 s ab
	 *   r:<alt>␀<neu>   Umbenennen (einmalig)
	 *   d:<pfad>        Löschen (einmalig)
	 * Ein Schreib-Marker blockiert also nie ein späteres Umbenennen/Löschen durch die Person.
	 */
	private own = new Map<string, { content: string | null; until: number }>();
	private queue = new Map<string, Promise<void>>();

	constructor(
		readonly app: App,
		readonly docs: DocManager,
		readonly index: VaultIndex,
		readonly hooks: BridgeHooks,
	) {}

	/** Hintereinander pro docId, parallel über Docs. */
	run(docId: string, fn: () => Promise<void>): Promise<void> {
		const prev = this.queue.get(docId) ?? Promise.resolve();
		const next = prev.then(fn, fn).catch((e) => console.warn("[tandem] DiskBridge", docId, e));
		this.queue.set(docId, next);
		void next.finally(() => {
			if (this.queue.get(docId) === next) this.queue.delete(docId);
		});
		return next;
	}

	private mark(key: string, content: string | null = null, ms = 2000) {
		this.own.set(key, { content, until: Date.now() + ms });
	}

	private check(key: string, content?: string, consume = false): boolean {
		const m = this.own.get(key);
		if (!m) return false;
		if (m.until < Date.now()) {
			this.own.delete(key);
			return false;
		}
		const hit = m.content === null || content === undefined || m.content === content;
		if (hit && consume) this.own.delete(key);
		return hit;
	}

	/** Eigenes Schreiben (create/modify)? Bei Text wird der Inhalt verglichen. */
	isOwnWrite(path: string, content?: string) {
		return this.check(`w:${path}`, content);
	}
	isOwnRename(from: string, to: string) {
		return this.check(`r:${from}\u0000${to}`, undefined, true);
	}
	isOwnDelete(path: string) {
		return this.check(`d:${path}`, undefined, true);
	}

	/** Datei ⇄ Doc abgleichen (md/ink). */
	reconcile(docId: string): Promise<void> {
		return this.run(docId, async () => {
			const entry = this.index.get(docId);
			if (!entry || entry.del || entry.kind === "blob") return;
			// Namenskonflikt noch offen: Die Datei am Pfad gehört evtl. dem anderen Eintrag → erst auflösen lassen.
			if (this.index.contested(entry.path)) return;
			const file = this.app.vault.getFileByPath(entry.path);
			// Offene Notiz: der Editor synchronisiert selbst (außer die Datei fehlt – dann neu anlegen).
			if (file && this.hooks.isBound(entry.path)) return;
			const disk = file ? await this.app.vault.read(file) : null;
			await this.docs.withDoc(docId, async (s, l) => {
				if (this.hooks.readOnly()) {
					const final = entry.kind === "ink" ? encodeInkDoc(s.doc) : s.doc.getText("content").toString();
					if (final === null || (!s.synced && final === "")) return;
					if (disk !== final) await this.write(entry.path, final);
					l.setBase(final);
					return;
				}
				// Startwert für den Erstimport-Vergleich; zusammengeführt wird unten auf dem aktuellen Inhalt.
				let base = l.base;
				if (base === undefined && disk !== null && entry.origin && entry.origin !== this.hooks.origin() && entry.hash) {
					// Erstimport von einem anderen Gerät: Ist unsere Datei genau der importierte Stand,
					// ist sie schon „synchron“ – nicht noch einmal einfügen (sonst doppelter Inhalt).
					if ((await sha256Hex(disk)) === entry.hash) {
						const cur = entry.kind === "ink" ? encodeInkDoc(s.doc) : s.doc.getText("content").toString();
						if (!cur) {
							l.setBase(disk);
							return;
						}
						base = disk;
					}
				}
				const merge = (d: string | null) => (entry.kind === "ink" ? this.mergeInk(s.doc, d, base) : this.mergeText(s.doc, d, base));
				const f = this.app.vault.getFileByPath(entry.path);
				if (!f) {
					const final = merge(null);
					if (final === null) return;
					await this.write(entry.path, final);
					l.setBase(final);
					return;
				}
				// Lesen, zusammenführen und schreiben in EINEM Schritt auf dem aktuellen Dateiinhalt:
				// Hat Ink Blocks/Claude Code/… die Datei seit dem Lesen oben geändert, wird diese Fassung
				// zusammengeführt statt blind überschrieben (sonst gingen Striche/Radierungen verloren).
				let final: string | null = null;
				let current: string | null = null;
				const rmw = () =>
					this.app.vault.process(f, (data) => {
						current = data;
						final = merge(data);
						if (final === null || final === data) return data;
						this.mark(`w:${entry.path}`, final);
						return final;
					});
				// vault.process ist nicht atomar gegenüber gleichzeitigem Speichern durch Ink Blocks → dessen Warteschlange nutzen
				if (entry.kind === "ink" && this.hooks.exclusive) await this.hooks.exclusive(entry.path, rmw);
				else await rmw();
				if (final === null) return;
				l.setBase(final);
				if (entry.kind === "ink" && current !== final) this.hooks.onInkWritten?.(entry.path);
			});
		});
	}

	private mergeText(doc: Y.Doc, disk: string | null, base: string | undefined): string {
		const ytext = doc.getText("content");
		const cur = ytext.toString();
		if (disk !== null && disk !== base && disk !== cur) {
			if (base === undefined) {
				// Gerät kennt die Datei noch nicht: leeres Doc → Datei hochladen, sonst Datei als Diff gegen den Server.
				if (cur === "") doc.transact(() => ytext.insert(0, disk), LOCAL);
				else applyTextDiff(ytext, cur, disk, LOCAL);
			} else {
				const edits = rebaseEdits(base, disk, cur);
				doc.transact(() => {
					for (const e of edits) {
						if (e.to > e.from) ytext.delete(e.from, e.to - e.from);
						if (e.insert) ytext.insert(e.from, e.insert);
					}
				}, LOCAL);
				// Plausibilität (nur Entwicklung): Ergebnis muss dem reinen Text-Merge entsprechen.
				if (ytext.toString() !== applyEdits(cur, edits)) console.warn("[tandem] rebase weicht ab");
			}
		}
		return ytext.toString();
	}

	private mergeInk(doc: Y.Doc, disk: string | null, base: string | undefined): string | null {
		if (disk !== null && disk !== base) {
			try {
				applyInkFile(doc, disk, base, LOCAL);
			} catch (e) {
				console.warn("[tandem] .ink nicht lesbar, wird nicht übernommen", e);
			}
		}
		return encodeInkDoc(doc);
	}

	/** Datei mit Inhalt schreiben (anlegen inkl. Ordner). */
	async write(path: string, content: string) {
		path = normalizePath(path);
		this.mark(`w:${path}`, content);
		const f = this.app.vault.getFileByPath(path);
		if (f) await this.app.vault.process(f, () => content);
		else {
			await this.ensureFolder(path);
			await this.app.vault.create(path, content);
		}
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		path = normalizePath(path);
		this.mark(`w:${path}`);
		const f = this.app.vault.getFileByPath(path);
		if (f) await this.app.vault.modifyBinary(f, data);
		else {
			await this.ensureFolder(path);
			await this.app.vault.createBinary(path, data);
		}
	}

	async rename(from: string, to: string) {
		const f = this.app.vault.getAbstractFileByPath(from);
		if (!f || this.app.vault.getAbstractFileByPath(to)) return;
		this.mark(`r:${from}\u0000${to}`);
		await this.ensureFolder(to);
		await this.app.vault.rename(f, to);
		await this.pruneEmpty(from);
	}

	async trash(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!f) return;
		this.mark(`d:${path}`);
		await this.app.fileManager.trashFile(f);
		await this.pruneEmpty(path);
	}

	/** Leere Ordner entfernen, die nach einem Umbenennen/Löschen von anderswo zurückbleiben. */
	private async pruneEmpty(path: string) {
		let dir = path.split("/").slice(0, -1).join("/");
		while (dir) {
			const folder = this.app.vault.getFolderByPath(dir);
			if (!folder || folder.children.length) return;
			this.mark(`d:${dir}`);
			try {
				await this.app.vault.delete(folder);
			} catch {
				return;
			}
			dir = dir.split("/").slice(0, -1).join("/");
		}
	}

	private async ensureFolder(path: string) {
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir && !this.app.vault.getFolderByPath(dir)) {
			try {
				await this.app.vault.createFolder(dir);
			} catch {
				/* existiert schon (Rennen) */
			}
		}
	}

	/** Einträge des Index auf die Platte bringen: neue Dateien anlegen, Umbenennungen, Löschungen. */
	async materialize(docId: string, entry: IndexEntry, prev: IndexEntry | undefined) {
		const vault = this.app.vault;
		if (entry.del) {
			// Lokalen Zustand behalten: wird die Löschung zurückgenommen, ist nichts verloren.
			if (prev && !prev.del && vault.getAbstractFileByPath(prev.path)) await this.trash(prev.path);
			return;
		}
		// Nur mitziehen, wenn die Datei am alten Pfad noch zu DIESEM Eintrag gehört
		// (bei Namenskonflikten gehört der alte Pfad dem Gewinner).
		const owner = prev ? this.index.idForPath(prev.path) : undefined;
		if (prev && !prev.del && prev.path !== entry.path && (!owner || owner === docId) && vault.getAbstractFileByPath(prev.path)) {
			await this.rename(prev.path, entry.path);
		}
		if (entry.kind !== "blob" && (!prev || prev.del || !vault.getFileByPath(entry.path))) await this.reconcile(docId);
	}

	static isSyncable(file: TFile, ignore: RegExp[]): boolean {
		if (ignore.some((r) => r.test(file.path))) return false;
		return !!kindForPath(file.path);
	}
}
