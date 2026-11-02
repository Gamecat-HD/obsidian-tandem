/**
 * Anhänge (PDF, Bilder, sonstige Binärdateien): kein CRDT, sondern Inhalt nach SHA-256 auf dem Server,
 * im Index nur Hash + Größe. Gleichzeitige Änderungen: die spätere gewinnt, die andere wird Konfliktkopie.
 */
import { requestUrl, type App, type TFile } from "obsidian";
import type { VaultIndex } from "../docs/VaultIndex";
import type { DiskBridge } from "../disk/DiskBridge";
import { sha256Hex } from "../disk/diff";
import type { LocalStore } from "../docs/LocalStore";

export const MAX_BLOB = 100 * 1024 * 1024;

export class BlobSync {
	/** Pfad → Hash, den die Datei zuletzt hatte, als sie mit dem Index übereinstimmte. */
	private known = new Map<string, string>();
	/** Uploads, die (z. B. offline) fehlgeschlagen sind – werden beim nächsten Abgleich wiederholt. */
	pendingUploads = new Set<string>();
	private loaded: Promise<void>;
	private saveTimer: number | null = null;

	constructor(
		readonly app: App,
		readonly index: VaultIndex,
		readonly bridge: DiskBridge,
		readonly store: LocalStore,
		readonly space: string,
		readonly http: () => { base: string; token: string },
	) {
		this.loaded = Promise.all([
			store.getMeta<Record<string, string>>(`blobs:${space}`).then((m) => {
				for (const [p, h] of Object.entries(m ?? {})) this.known.set(p, h);
			}),
			store.getMeta<string[]>(`blobs-pending:${space}`).then((l) => {
				for (const p of l ?? []) this.pendingUploads.add(p);
			}),
		]).then(() => {});
	}

	private url(hash: string) {
		const { base } = this.http();
		return `${base}/api/blob/${encodeURIComponent(this.space)}/${hash}`;
	}

	private headers() {
		return { Authorization: `Bearer ${this.http().token}` };
	}

	private remember(path: string, hash: string | null) {
		if (hash) this.known.set(path, hash);
		else this.known.delete(path);
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.store.setMeta(`blobs:${this.space}`, Object.fromEntries(this.known));
		}, 500);
	}

	renamed(from: string, to: string) {
		if (this.pendingUploads.delete(from)) {
			this.pendingUploads.add(to);
			this.savePending();
		}
		const h = this.known.get(from);
		if (h) {
			this.known.delete(from);
			this.remember(to, h);
		}
	}

	/** Lokale Datei → Server + Index (falls geändert). Pro Pfad nacheinander mit fetch(). */
	upload(file: TFile): Promise<void> {
		return this.bridge.run(`blob:${file.path}`, async () => {
			try {
				await this.doUpload(file);
				if (this.pendingUploads.delete(file.path)) this.savePending();
			} catch (e) {
				this.pendingUploads.add(file.path);
				this.savePending();
				throw e;
			}
		});
	}

	private savePending() {
		void this.store.setMeta(`blobs-pending:${this.space}`, [...this.pendingUploads]);
	}

	private async doUpload(file: TFile): Promise<void> {
		await this.loaded;
		if (!this.app.vault.getFileByPath(file.path)) return;
		if (file.stat.size > MAX_BLOB) {
			console.warn(`[tandem] ${file.path}: größer als ${MAX_BLOB / 1048576} MiB, wird nicht synchronisiert`);
			return;
		}
		const data = await this.app.vault.readBinary(file);
		const hash = await sha256Hex(data);
		const id = this.index.idForPath(file.path);
		const entry = id ? this.index.get(id) : undefined;
		if (entry && entry.hash === hash) {
			this.remember(file.path, hash);
			return;
		}
		const head = await requestUrl({ url: this.url(hash), method: "HEAD", headers: this.headers(), throw: false });
		if (head.status === 404) {
			const r = await requestUrl({
				url: this.url(hash),
				method: "PUT",
				headers: { ...this.headers(), "Content-Type": "application/octet-stream" },
				body: data,
				throw: false,
			});
			if (r.status >= 300) throw new Error(`Upload ${file.path}: HTTP ${r.status}`);
		} else if (head.status >= 300) throw new Error(`Upload ${file.path}: HTTP ${head.status}`);
		if (id) this.index.update(id, { hash, size: data.byteLength, parent: entry?.hash });
		else this.index.add(file.path, "blob", { hash, size: data.byteLength });
		this.remember(file.path, hash);
	}

	/**
	 * Index-Eintrag → lokale Datei (falls Hash abweicht).
	 * `parent` = Fassung, auf der die entfernte Änderung beruht. Ist die lokale Datei weder diese noch
	 * die neue Fassung, wurde hier gleichzeitig geändert → lokale Fassung als Konfliktkopie behalten.
	 */
	fetch(path: string, hash: string, parent?: string): Promise<void> {
		return this.bridge.run(`blob:${path}`, () => this.doFetch(path, hash, parent));
	}

	private async doFetch(path: string, hash: string, parent?: string): Promise<void> {
		await this.loaded;
		// Inzwischen von noch neuerer Fassung überholt?
		const id = this.index.idForPath(path);
		if (id && this.index.get(id)?.hash !== hash) return;
		const file = this.app.vault.getFileByPath(path);
		if (file) {
			const local = await sha256Hex(await this.app.vault.readBinary(file));
			if (local === hash) return this.remember(path, hash);
			const known = this.known.get(path);
			const concurrent = parent !== undefined ? local !== parent : !!known && known !== local;
			if (concurrent) {
				// Lokal geändert UND remote geändert → lokale Fassung als Konfliktkopie behalten.
				const dot = path.lastIndexOf(".");
				const copy = `${path.slice(0, dot)} (Konflikt ${new Date().toISOString().slice(0, 10)})${path.slice(dot)}`;
				await this.app.vault.copy(file, copy);
			}
		}
		const r = await requestUrl({ url: this.url(hash), method: "GET", headers: this.headers(), throw: false });
		if (r.status !== 200) throw new Error(`Download ${path}: HTTP ${r.status}`);
		const got = await sha256Hex(r.arrayBuffer);
		if (got !== hash) throw new Error(`Download ${path}: Hash stimmt nicht`);
		await this.bridge.writeBinary(path, r.arrayBuffer);
		this.remember(path, hash);
	}

	/** Lokale Datei seit dem letzten Abgleich verändert? */
	async changedLocally(file: TFile): Promise<boolean> {
		await this.loaded;
		const known = this.known.get(file.path);
		if (!known) return true;
		return (await sha256Hex(await this.app.vault.readBinary(file))) !== known;
	}

	forget(path: string) {
		this.remember(path, null);
	}
}
