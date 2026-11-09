import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { LocalStore } from "../docs/LocalStore";
import { BIG_BLOB, TransferGuard, type Transfer } from "./TransferGuard";

let dbs = 0;
async function newStore() {
	const store = new LocalStore(`guard-test-${dbs++}`);
	await store.open();
	return store;
}

const MARKER = "blob-transfer:s";
const big = (key = "a"): Transfer => ({ key, path: `${key}.pdf`, dir: "down", hash: "h", size: BIG_BLOB });
const small = (key = "a"): Transfer => ({ key, path: `${key}.pdf`, dir: "down", hash: "h", size: BIG_BLOB - 1 });

function deferred() {
	let open!: () => void;
	const done = new Promise<void>((ok) => (open = ok));
	return { done, open };
}

describe("TransferGuard", () => {
	it("kleine Dateien laufen parallel und ohne Marke", async () => {
		const store = await newStore();
		const guard = new TransferGuard(store, "s");
		await guard.loaded;
		const gate = deferred();
		const started: string[] = [];
		const run = (key: string) =>
			guard.run(small(key), async () => {
				started.push(key);
				expect(await store.getMeta(MARKER)).toBeUndefined();
				await gate.done;
			});
		const all = Promise.all([run("a"), run("b")]);
		await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
		gate.open();
		await all;
	});

	it("große Dateien laufen nacheinander, auch unbekannte Größe zählt als groß", async () => {
		const store = await newStore();
		const guard = new TransferGuard(store, "s");
		await guard.loaded;
		const gate = deferred();
		const started: string[] = [];
		const first = guard.run(big("a"), async () => {
			started.push("a");
			await gate.done;
		});
		const second = guard.run({ ...big("b"), size: undefined }, async () => {
			started.push("b");
		});
		await vi.waitFor(() => expect(started).toEqual(["a"]));
		expect((await store.getMeta<Transfer>(MARKER))?.key).toBe("a");
		gate.open();
		await Promise.all([first, second]);
		expect(started).toEqual(["a", "b"]);
		expect(await store.getMeta(MARKER)).toBeNull();
	});

	it("eine große Datei wartet, bis laufende kleine fertig sind", async () => {
		const store = await newStore();
		const guard = new TransferGuard(store, "s");
		await guard.loaded;
		const gate = deferred();
		const log: string[] = [];
		const s = guard.run(small("bild"), async () => {
			log.push("bild start");
			await gate.done;
			log.push("bild ende");
		});
		const b = guard.run(big("pdf"), async () => void log.push("pdf"));
		await vi.waitFor(() => expect(log).toEqual(["bild start"]));
		expect(await store.getMeta(MARKER)).toBeUndefined();
		gate.open();
		await Promise.all([s, b]);
		expect(log).toEqual(["bild start", "bild ende", "pdf"]);
	});

	it("während einer großen Datei warten neue kleine – beim Absturz stirbt nur die große", async () => {
		const store = await newStore();
		const guard = new TransferGuard(store, "s");
		await guard.loaded;
		const gate = deferred();
		const log: string[] = [];
		const b = guard.run(big("pdf"), async () => {
			log.push("pdf start");
			await gate.done;
			log.push("pdf ende");
		});
		await vi.waitFor(() => expect(log).toEqual(["pdf start"]));
		const s1 = guard.run(small("bild1"), async () => void log.push("bild1"));
		const s2 = guard.run(small("bild2"), async () => void log.push("bild2"));
		await new Promise((ok) => setTimeout(ok, 20));
		expect(log).toEqual(["pdf start"]);
		gate.open();
		await Promise.all([b, s1, s2]);
		expect(log).toEqual(["pdf start", "pdf ende", "bild1", "bild2"]);
	});

	it("ein Fehler löscht die Marke, überspringt nichts und hält die nächste Datei nicht auf", async () => {
		const store = await newStore();
		const guard = new TransferGuard(store, "s");
		await guard.loaded;
		await expect(guard.run(big("a"), () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
		expect(await store.getMeta(MARKER)).toBeNull();
		await expect(guard.run(big("b"), async () => "ok")).resolves.toBe("ok");
		const again = new TransferGuard(store, "s");
		await again.loaded;
		expect(again.list()).toEqual([]);
	});

	it("nach einem Absturz wird genau diese Fassung übersprungen und einmal gemeldet", async () => {
		const store = await newStore();
		const crashed = new TransferGuard(store, "s");
		await crashed.loaded;
		// Die App stirbt während der Übertragung: fn kommt nie zurück.
		void crashed.run(big("a"), () => new Promise<void>(() => {}));
		await vi.waitFor(async () => expect((await store.getMeta<Transfer>(MARKER))?.key).toBe("a"));

		const lost = vi.fn();
		const next = new TransferGuard(store, "s", lost);
		await next.loaded;
		expect(lost).toHaveBeenCalledTimes(1);
		expect(lost.mock.calls[0][0].path).toBe("a.pdf");
		expect(next.isSkipped("a")).toBe(true);
		expect(next.isSkipped("neue-fassung")).toBe(false);

		// Bleibt über weitere Starts erhalten, ohne erneute Meldung.
		const lost2 = vi.fn();
		const later = new TransferGuard(store, "s", lost2);
		await later.loaded;
		expect(later.isSkipped("a")).toBe(true);
		expect(lost2).not.toHaveBeenCalled();
	});

	it("clear hebt das Überspringen dauerhaft auf", async () => {
		const store = await newStore();
		await store.setMeta(MARKER, big("a"));
		const guard = new TransferGuard(store, "s");
		await guard.loaded;
		expect((await guard.clear()).map((t) => t.key)).toEqual(["a"]);
		expect(guard.isSkipped("a")).toBe(false);
		const again = new TransferGuard(store, "s");
		await again.loaded;
		expect(again.list()).toEqual([]);
	});
});
