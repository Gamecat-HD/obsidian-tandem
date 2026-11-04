/**
 * Lokaler Offline-Speicher (IndexedDB, eine Datenbank pro Vault):
 * - `docs`: pro Doc der zusammengeführte Yjs-Zustand und `base` = Dateiinhalt, der zuletzt mit
 *   dem Doc übereinstimmte (Grundlage für den Diff, wenn die Datei offline geändert wurde).
 * - `meta`: kleine Werte (z. B. letzte Sequenznummer pro Space).
 */
export interface StoredDoc {
	name: string;
	state: Uint8Array;
	/** Text (md) bzw. Hash (ink/blob), der zuletzt auf der Platte mit dem Doc übereinstimmte. */
	base?: string;
	/** Zeitpunkt der letzten lokalen (nicht vom Server stammenden) Änderung. */
	edited?: number;
	/** Verschlüsselte Spaces: gelesene Log-Position + noch unbestätigte lokale Updates. */
	e2ee?: { cursor: number; pending?: Uint8Array };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((ok, fail) => {
		r.onsuccess = () => ok(r.result);
		r.onerror = () => fail(r.error);
	});
}

export class LocalStore {
	private db: IDBDatabase | null = null;
	constructor(readonly dbName: string) {}

	async open(): Promise<void> {
		if (this.db) return;
		const r = indexedDB.open(this.dbName, 1);
		r.onupgradeneeded = () => {
			const db = r.result;
			if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "name" });
			if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
		};
		this.db = await req(r);
	}

	close() {
		this.db?.close();
		this.db = null;
	}

	private store(name: "docs" | "meta", mode: IDBTransactionMode) {
		if (!this.db) throw new Error("LocalStore nicht geöffnet");
		return this.db.transaction(name, mode).objectStore(name);
	}

	async get(name: string): Promise<StoredDoc | undefined> {
		return req(this.store("docs", "readonly").get(name)) as Promise<StoredDoc | undefined>;
	}

	async put(doc: StoredDoc): Promise<void> {
		await req(this.store("docs", "readwrite").put(doc));
	}

	async delete(name: string): Promise<void> {
		await req(this.store("docs", "readwrite").delete(name));
	}

	async getMeta<T>(key: string): Promise<T | undefined> {
		return req(this.store("meta", "readonly").get(key)) as Promise<T | undefined>;
	}

	async setMeta(key: string, value: unknown): Promise<void> {
		await req(this.store("meta", "readwrite").put(value, key));
	}

	/** Wie `setMeta`, wartet aber, bis der Wert sicher gespeichert ist – für Werte, die einen Absturz überstehen müssen. */
	async setMetaDurable(key: string, value: unknown): Promise<void> {
		if (!this.db) throw new Error("LocalStore nicht geöffnet");
		const tx = this.db.transaction("meta", "readwrite", { durability: "strict" });
		tx.objectStore("meta").put(value, key);
		await new Promise<void>((ok, fail) => {
			tx.oncomplete = () => ok();
			tx.onerror = tx.onabort = () => fail(tx.error);
		});
	}

	/** Alles löschen (Space wechseln / Neu einrichten). */
	async clear(): Promise<void> {
		await req(this.store("docs", "readwrite").clear());
		await req(this.store("meta", "readwrite").clear());
	}
}
