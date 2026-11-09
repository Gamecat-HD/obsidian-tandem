/**
 * Anhänge (PDF, Bilder, sonstige Binärdateien): kein CRDT, sondern Inhalt nach SHA-256 auf dem Server,
 * im Index nur Hash + Größe. Gleichzeitige Änderungen: die spätere gewinnt, die andere wird Konfliktkopie.
 */
import { requestUrl, type App, type TFile } from "obsidian";
import type { VaultIndex } from "../docs/VaultIndex";
import type { DiskBridge } from "../disk/DiskBridge";
import { sha256Hex } from "../disk/diff";
import type { LocalStore } from "../docs/LocalStore";
import type { SpaceKey } from "../crypto/e2ee";
import { TransferGuard, type Transfer } from "./TransferGuard";

export const MAX_BLOB = 100 * 1024 * 1024;

export class BlobSync {
	/** Pfad → Hash, den die Datei zuletzt hatte, als sie mit dem Index übereinstimmte. */
	private known = new Map<string, string>();
	/**
	 * Uploads, die nicht zu Ende kamen (offline, Fehler oder App beendet) – werden beim nächsten Abgleich wiederholt.
	 * Wird VOR dem Upload gespeichert: Stirbt die App mittendrin, kommt kein `catch` mehr dran.
	 */
	pendingUploads = new Set<string>();
	/**
	 * Pfad → Hash: Downloads, deren Schreiben auf die Platte begonnen, aber nicht geendet hat. Liegt beim Start noch
	 * einer da, ist die lokale Datei womöglich halb geschrieben. Sie darf dann nicht als lokale Änderung hochgeladen
	 * werden (sonst ersetzt das kaputte Bild die gute Fassung auf allen Geräten), sondern wird neu geladen.
	 */
	private writing = new Map<string, string>();
	private loaded: Promise<void>;
	private saveTimer: number | null = null;
	readonly guard: TransferGuard;
	/** Partner-Plugin führt diese Fassung bereits zusammen (Live-API) → bei Gleichzeitigkeit keine Konfliktkopie. */
	represented: ((path: string, hash: string) => boolean) | null = null;

	constructor(
		readonly app: App,
		readonly index: VaultIndex,
		readonly bridge: DiskBridge,
		readonly store: LocalStore,
		readonly space: string,
		readonly http: () => { base: string; token: string; headers: Record<string, string> },
		/** Verschlüsselter Space: Anhänge werden vor dem Hochladen verschlüsselt (Adresse = Hash des Chiffretexts). */
		readonly key: SpaceKey | null = null,
		/** Eine große Übertragung kam beim letzten Lauf nicht zu Ende (App beendet) und wird nun übersprungen. */
		onTransferLost?: (t: Transfer) => void,
	) {
		this.guard = new TransferGuard(store, space, onTransferLost);
		this.loaded = Promise.all([
			this.guard.loaded,
			store.getMeta<Record<string, string>>(`blobs:${space}`).then((m) => {
				for (const [p, h] of Object.entries(m ?? {})) this.known.set(p, h);
			}),
			store.getMeta<string[]>(`blobs-pending:${space}`).then((l) => {
				for (const p of l ?? []) this.pendingUploads.add(p);
			}),
			store.getMeta<Record<string, string>>(`blobs-writing:${space}`).then((m) => {
				for (const [p, h] of Object.entries(m ?? {})) this.writing.set(p, h);
			}),
		]).then(() => {});
	}

	private url(hash: string) {
		const { base } = this.http();
		return `${base}/api/blob/${encodeURIComponent(this.space)}/${hash}`;
	}

	private headers() {
		return this.http().headers;
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
			void this.savePending();
		}
		const w = this.writing.get(from);
		if (w !== undefined) {
			this.writing.delete(from);
			this.writing.set(to, w);
			void this.saveWriting();
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
			await this.loaded;
			if (this.writing.has(file.path)) return this.doRepair(file.path);
			if (!this.pendingUploads.has(file.path)) {
				this.pendingUploads.add(file.path);
				await this.savePending();
			}
			await this.doUpload(file);
			// Bei einem Fehler bleibt der Pfad offen und wird beim nächsten Abgleich wiederholt.
			this.pendingUploads.delete(file.path);
			await this.savePending();
		});
	}

	// Reicht ohne `durability: "strict"`: Gegen ein beendetes App-Prozess genügt, dass der Wert committet ist.
	private savePending() {
		return this.store.setMeta(`blobs-pending:${this.space}`, [...this.pendingUploads]);
	}

	private saveWriting() {
		return this.store.setMeta(`blobs-writing:${this.space}`, Object.fromEntries(this.writing));
	}

	/** Wurde das Schreiben dieser Datei durch einen Absturz unterbrochen? (Dann neu laden statt hochladen.) */
	interrupted(path: string): boolean {
		return this.writing.has(path);
	}

	/** Unterbrochenen Download wiederholen: Die lokale Datei wird ohne Konfliktkopie durch die Fassung im Index ersetzt. */
	repair(path: string): Promise<void> {
		return this.bridge.run(`blob:${path}`, async () => {
			await this.loaded;
			await this.doRepair(path);
		});
	}

	private async doRepair(path: string): Promise<void> {
		const id = this.index.idForPath(path);
		const entry = id ? this.index.get(id) : undefined;
		const addr = this.key ? entry?.ehash : entry?.hash;
		if (!entry?.hash || !addr) {
			// Nicht (mehr) im Index: nichts, wogegen sich die Datei prüfen ließe.
			this.writing.delete(path);
			await this.saveWriting();
			return;
		}
		const t: Transfer = { key: `down:${path}:${entry.hash}`, path, dir: "down", hash: entry.hash, size: entry.size };
		// Übersprungen (zu groß fürs Gerät): Marke bleiben lassen, damit die halbe Datei nie hochgeladen wird.
		if (this.guard.isSkipped(t.key)) return;
		await this.guard.run(t, () => this.receiveFile(path, entry.hash!, undefined, addr, true));
	}

	private async doUpload(file: TFile): Promise<void> {
		if (!this.app.vault.getFileByPath(file.path)) return;
		if (file.stat.size > MAX_BLOB) {
			console.warn(`[tandem] ${file.path}: größer als ${MAX_BLOB / 1048576} MiB, wird nicht synchronisiert`);
			return;
		}
		const t: Transfer = { key: `up:${file.path}:${file.stat.mtime}`, path: file.path, dir: "up", size: file.stat.size };
		if (this.guard.isSkipped(t.key)) return;
		await this.guard.run(t, () => this.sendFile(file));
	}

	private async sendFile(file: TFile): Promise<void> {
		const data = await this.app.vault.readBinary(file);
		const hash = await sha256Hex(data);
		const id = this.index.idForPath(file.path);
		const entry = id ? this.index.get(id) : undefined;
		if (entry && entry.hash === hash) {
			this.remember(file.path, hash);
			return;
		}
		const sealed = this.key ? await this.key.sealBlob(new Uint8Array(data), hash) : null;
		const addr = sealed?.ehash ?? hash;
		if (!(await this.onServer(addr))) {
			const r = await requestUrl({
				url: this.url(addr),
				method: "PUT",
				headers: { ...this.headers(), "Content-Type": "application/octet-stream" },
				body: sealed ? (sealed.data.buffer.slice(sealed.data.byteOffset, sealed.data.byteOffset + sealed.data.byteLength) as ArrayBuffer) : data,
				throw: false,
			});
			if (r.status >= 300) throw new Error(`Upload ${file.path}: HTTP ${r.status}`);
		}
		const extra = sealed ? { ehash: sealed.ehash } : {};
		if (id) this.index.update(id, { hash, size: data.byteLength, parent: entry?.hash, ...extra });
		else this.index.add(file.path, "blob", { hash, size: data.byteLength, ...extra });
		this.remember(file.path, hash);
	}

	/**
	 * Liegt der Inhalt schon auf dem Server? HEAD wirft in der Android-App „IOException Stream closed“. Dann gilt:
	 * nicht vorhanden. Der Upload schadet nicht, der Server legt Inhalte nach Hash ab und überschreibt sich nur selbst.
	 */
	private async onServer(addr: string): Promise<boolean> {
		let status: number;
		try {
			status = (await requestUrl({ url: this.url(addr), method: "HEAD", headers: this.headers(), throw: false })).status;
		} catch {
			return false;
		}
		if (status === 404) return false;
		if (status >= 300) throw new Error(`Anhang prüfen: HTTP ${status}`);
		return true;
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
		if (this.writing.has(path)) return this.doRepair(path);
		// Inzwischen von noch neuerer Fassung überholt?
		const id = this.index.idForPath(path);
		const entry = id ? this.index.get(id) : undefined;
		if (id && entry?.hash !== hash) return;
		const addr = this.key ? entry?.ehash : hash;
		if (!addr) throw new Error(`Download ${path}: Adresse des verschlüsselten Anhangs fehlt`);
		const t: Transfer = { key: `down:${path}:${hash}`, path, dir: "down", hash, size: entry?.size };
		if (this.guard.isSkipped(t.key)) return;
		await this.guard.run(t, () => this.receiveFile(path, hash, parent, addr));
	}

	private async receiveFile(path: string, hash: string, parent: string | undefined, addr: string, repair = false): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file) {
			const local = await sha256Hex(await this.app.vault.readBinary(file));
			if (local === hash) {
				this.remember(path, hash);
				return this.doneWriting(path);
			}
			const known = this.known.get(path);
			const concurrent = !repair && (parent !== undefined ? local !== parent : !!known && known !== local);
			if (concurrent && !this.represented?.(path, local)) {
				// Lokal geändert UND remote geändert → lokale Fassung als Konfliktkopie behalten.
				const dot = path.lastIndexOf(".");
				const copy = `${path.slice(0, dot)} (Konflikt ${new Date().toISOString().slice(0, 10)})${path.slice(dot)}`;
				await this.app.vault.copy(file, copy);
			}
		}
		const r = await requestUrl({ url: this.url(addr), method: "GET", headers: this.headers(), throw: false });
		if (r.status !== 200) throw new Error(`Download ${path}: HTTP ${r.status}`);
		let content = r.arrayBuffer;
		if (this.key) {
			const plain = await this.key.openBlob(new Uint8Array(content));
			content = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer;
		}
		const got = await sha256Hex(content);
		if (got !== hash) throw new Error(`Download ${path}: Hash stimmt nicht`);
		this.writing.set(path, hash);
		await this.saveWriting();
		await this.bridge.writeBinary(path, content);
		this.remember(path, hash);
		await this.doneWriting(path);
	}

	private async doneWriting(path: string) {
		if (this.writing.delete(path)) await this.saveWriting();
	}

	/** Lokale Datei seit dem letzten Abgleich verändert? */
	async changedLocally(file: TFile): Promise<boolean> {
		await this.loaded;
		const known = this.known.get(file.path);
		if (!known) return true;
		return (await sha256Hex(await this.app.vault.readBinary(file))) !== known;
	}

	/** Hash, den die Datei zuletzt hatte, als sie mit dem Index übereinstimmte. */
	knownHash(path: string): string | undefined {
		return this.known.get(path);
	}

	forget(path: string) {
		this.remember(path, null);
	}
}
