/**
 * Große Anhänge liegen beim Übertragen komplett im Speicher (`requestUrl`, `readBinary`). In der Android-App hat schon
 * ein einzelner Download von 51 MB die ganze App beendet, ohne Fehlermeldung im Plugin. Beim nächsten Start fasste der
 * Abgleich dieselbe Datei wieder an: eine Absturzschleife.
 *
 * Deshalb laufen große Übertragungen einzeln, und davor wird eine Marke dauerhaft gespeichert. Liegt sie beim nächsten
 * Start noch da, kam die Übertragung nicht zu Ende. Diese Fassung der Datei wird dann auf diesem Gerät übersprungen,
 * bis jemand es in den Einstellungen neu versucht oder sich der Inhalt ändert.
 *
 * „Einzeln“ heißt wirklich allein: Eine große Übertragung wartet, bis laufende kleine fertig sind, und neue kleine
 * warten auf sie. Sonst sterben beim Absturz kleine Anhänge (Bilder) mit, ohne dass eine Marke davon weiß.
 */

/** Ab dieser Größe wird einzeln übertragen und abgesichert. */
export const BIG_BLOB = 16 * 1024 * 1024;

export interface Transfer {
	/** Fassung der Datei: Eine neue Fassung hebt das Überspringen auf. */
	key: string;
	path: string;
	dir: "down" | "up";
	/** Download: Hash der Fassung (zum erneuten Versuch). */
	hash?: string;
	/** Fehlt bei alten Index-Einträgen; zählt dann als groß. */
	size?: number;
}

export interface GuardStore {
	getMeta<T>(key: string): Promise<T | undefined>;
	setMeta(key: string, value: unknown): Promise<void>;
	setMetaDurable(key: string, value: unknown): Promise<void>;
}

export class TransferGuard {
	private skipped = new Map<string, Transfer>();
	/** Kleine Übertragungen teilen sich die Sperre, große haben sie allein. */
	private readonly lock = new SharedLock();
	readonly loaded: Promise<void>;

	constructor(
		private readonly store: GuardStore,
		private readonly space: string,
		onLost?: (t: Transfer) => void,
	) {
		this.loaded = this.load(onLost);
	}

	private get markerKey() {
		return `blob-transfer:${this.space}`;
	}

	private async load(onLost?: (t: Transfer) => void) {
		for (const t of (await this.store.getMeta<Transfer[]>(`blobs-skipped:${this.space}`)) ?? []) this.skipped.set(t.key, t);
		const open = await this.store.getMeta<Transfer | null>(this.markerKey);
		if (!open) return;
		this.skipped.set(open.key, open);
		await this.saveSkipped();
		await this.store.setMeta(this.markerKey, null);
		onLost?.(open);
	}

	private saveSkipped() {
		return this.store.setMeta(`blobs-skipped:${this.space}`, [...this.skipped.values()]);
	}

	isSkipped(key: string) {
		return this.skipped.has(key);
	}

	list(): Transfer[] {
		return [...this.skipped.values()];
	}

	/** Überspringen aufheben. Gibt zurück, was vorher übersprungen wurde. */
	async clear(): Promise<Transfer[]> {
		const list = this.list();
		this.skipped.clear();
		await this.saveSkipped();
		return list;
	}

	run<T>(t: Transfer, fn: () => Promise<T>): Promise<T> {
		if (t.size !== undefined && t.size < BIG_BLOB) return this.lock.shared(fn);
		return this.lock.exclusive(async () => {
			await this.store.setMetaDurable(this.markerKey, t);
			try {
				return await fn();
			} finally {
				await this.store.setMeta(this.markerKey, null);
			}
		});
	}
}

/**
 * Lese-/Schreibsperre in Ankunftsreihenfolge: beliebig viele `shared` gleichzeitig, `exclusive` allein. Wartet eine
 * exklusive, stellen sich später ankommende geteilte dahinter an (sonst käme die große nie dran).
 */
export class SharedLock {
	private holders = 0;
	private held = false;
	private queue: { exclusive: boolean; go: () => void }[] = [];

	shared<T>(fn: () => Promise<T>) {
		return this.with(false, fn);
	}

	exclusive<T>(fn: () => Promise<T>) {
		return this.with(true, fn);
	}

	private async with<T>(exclusive: boolean, fn: () => Promise<T>): Promise<T> {
		await this.acquire(exclusive);
		try {
			return await fn();
		} finally {
			this.release(exclusive);
		}
	}

	private free(exclusive: boolean) {
		return !this.held && (!exclusive || this.holders === 0);
	}

	private take(exclusive: boolean) {
		if (exclusive) this.held = true;
		else this.holders++;
	}

	private acquire(exclusive: boolean): Promise<void> {
		if (this.queue.length === 0 && this.free(exclusive)) {
			this.take(exclusive);
			return Promise.resolve();
		}
		return new Promise((go) => this.queue.push({ exclusive, go }));
	}

	private release(exclusive: boolean) {
		if (exclusive) this.held = false;
		else this.holders--;
		while (this.queue.length && this.free(this.queue[0].exclusive)) {
			const next = this.queue.shift()!;
			this.take(next.exclusive);
			next.go();
			if (next.exclusive) break;
		}
	}
}
