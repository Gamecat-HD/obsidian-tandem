import { beforeEach, describe, expect, it, vi } from "vitest";

const requestUrl = vi.fn();
vi.mock("obsidian", () => ({ requestUrl }));
vi.stubGlobal("window", globalThis);
const { BlobSync } = await import("./BlobSync");
const { BIG_BLOB } = await import("./TransferGuard");
const { sha256Hex } = await import("../disk/diff");

const data = new TextEncoder().encode("Inhalt").buffer as ArrayBuffer;
const file = { path: "a.pdf", stat: { size: data.byteLength, mtime: 1 } };

function memoryStore(meta: Record<string, unknown> = {}) {
	return {
		getMeta: async (k: string) => meta[k],
		setMeta: async (k: string, v: unknown) => void (meta[k] = v),
		setMetaDurable: async (k: string, v: unknown) => void (meta[k] = v),
	};
}

function setup(opts: { entry?: Record<string, unknown>; local?: boolean; localData?: ArrayBuffer; meta?: Record<string, unknown>; onLost?: (t: unknown) => void; writeBinary?: () => Promise<void> } = {}) {
	const index = {
		idForPath: () => (opts.entry ? "id" : undefined),
		get: () => opts.entry,
		update: vi.fn(),
		add: vi.fn(),
	};
	const app = { vault: { getFileByPath: () => (opts.local === false ? null : file), readBinary: async () => opts.localData ?? data, copy: vi.fn() } };
	const bridge = { run: (_k: string, fn: () => Promise<void>) => fn(), writeBinary: vi.fn(opts.writeBinary ?? (async () => {})) };
	const blobs = new BlobSync(app as never, index as never, bridge as never, memoryStore(opts.meta) as never, "s", () => ({ base: "https://x", token: "t" }), null, opts.onLost as never);
	return { blobs, index, bridge, app };
}

const methods = () => requestUrl.mock.calls.map(([r]) => r.method);

describe("BlobSync: Upload", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it("HEAD wirft (Android): lädt trotzdem hoch", async () => {
		requestUrl.mockImplementation(async (r: { method: string }) => {
			if (r.method === "HEAD") throw new Error("Request Failed. IOException Stream closed");
			return { status: 201 };
		});
		const { blobs, index } = setup();
		await blobs.upload(file as never);
		expect(methods()).toEqual(["HEAD", "PUT"]);
		expect(index.add).toHaveBeenCalledOnce();
		expect(blobs.pendingUploads.size).toBe(0);
	});

	it("schon auf dem Server: kein zweites Hochladen", async () => {
		requestUrl.mockResolvedValue({ status: 200 });
		const { blobs, index } = setup();
		await blobs.upload(file as never);
		expect(methods()).toEqual(["HEAD"]);
		expect(index.add).toHaveBeenCalledOnce();
	});

	it("nicht auf dem Server: lädt hoch", async () => {
		requestUrl.mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 201 });
		const { blobs } = setup();
		await blobs.upload(file as never);
		expect(methods()).toEqual(["HEAD", "PUT"]);
	});

	it("Serverfehler beim Prüfen: nichts eintragen, später wiederholen", async () => {
		requestUrl.mockResolvedValue({ status: 500 });
		const { blobs, index } = setup();
		await expect(blobs.upload(file as never)).rejects.toThrow("HTTP 500");
		expect(index.add).not.toHaveBeenCalled();
		expect(blobs.pendingUploads.has("a.pdf")).toBe(true);
	});

	it("scheitert auch das Hochladen: später wiederholen", async () => {
		requestUrl.mockRejectedValue(new Error("offline"));
		const { blobs } = setup();
		await expect(blobs.upload(file as never)).rejects.toThrow("offline");
		expect(blobs.pendingUploads.has("a.pdf")).toBe(true);
	});
});

describe("BlobSync: abgestürzte Übertragung", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it("Download, der die App beendet hat, wird übersprungen und gemeldet", async () => {
		const hash = await sha256Hex(data);
		const onLost = vi.fn();
		const lost = { key: `down:a.pdf:${hash}`, path: "a.pdf", dir: "down", hash, size: BIG_BLOB };
		const { blobs, bridge } = setup({ entry: { hash, size: BIG_BLOB }, local: false, meta: { "blob-transfer:s": lost }, onLost });
		await blobs.fetch("a.pdf", hash);
		expect(onLost).toHaveBeenCalledOnce();
		expect(requestUrl).not.toHaveBeenCalled();
		expect(bridge.writeBinary).not.toHaveBeenCalled();
	});

	it("eine neue Fassung derselben Datei wird wieder geladen", async () => {
		const hash = await sha256Hex(data);
		const old = { key: "down:a.pdf:alt", path: "a.pdf", dir: "down", hash: "alt", size: BIG_BLOB };
		requestUrl.mockResolvedValue({ status: 200, arrayBuffer: data });
		const { blobs, bridge } = setup({ entry: { hash, size: BIG_BLOB }, local: false, meta: { "blobs-skipped:s": [old] } });
		await blobs.fetch("a.pdf", hash);
		expect(bridge.writeBinary).toHaveBeenCalledOnce();
	});
});

describe("BlobSync: App stirbt mitten in der Übertragung (Android)", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	const never = () => new Promise<never>(() => {});

	it("Upload: Pfad ist schon vorher als offen gespeichert und wird beim nächsten Start wiederholt", async () => {
		const meta: Record<string, unknown> = {};
		requestUrl.mockImplementation(async (r: { method: string }) => (r.method === "HEAD" ? { status: 404 } : never()));
		const { blobs } = setup({ meta });
		void blobs.upload(file as never);
		await vi.waitFor(() => expect(methods()).toEqual(["HEAD", "PUT"]));
		expect(meta["blobs-pending:s"]).toEqual(["a.pdf"]);

		// Neuer Start: wird als offen geladen (der Abgleich lädt dann erneut hoch).
		const next = setup({ meta }).blobs;
		await vi.waitFor(() => expect(next.pendingUploads.has("a.pdf")).toBe(true));
	});

	it("Upload fertig: Pfad ist nicht mehr offen", async () => {
		const meta: Record<string, unknown> = {};
		requestUrl.mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 201 });
		const { blobs } = setup({ meta });
		await blobs.upload(file as never);
		expect(meta["blobs-pending:s"]).toEqual([]);
	});

	it("Download stirbt beim Schreiben: die halbe Datei wird beim nächsten Start neu geladen, nicht hochgeladen", async () => {
		const hash = await sha256Hex(data);
		const meta: Record<string, unknown> = {};
		requestUrl.mockResolvedValue({ status: 200, arrayBuffer: data });
		const crashed = setup({ entry: { hash, size: data.byteLength }, local: false, meta, writeBinary: never });
		void crashed.blobs.fetch("a.pdf", hash);
		await vi.waitFor(() => expect(crashed.bridge.writeBinary).toHaveBeenCalledOnce());
		expect(meta["blobs-writing:s"]).toEqual({ "a.pdf": hash });

		requestUrl.mockReset();
		requestUrl.mockResolvedValue({ status: 200, arrayBuffer: data });
		const half = new TextEncoder().encode("Inh").buffer as ArrayBuffer;
		const next = setup({ entry: { hash, size: data.byteLength }, localData: half, meta });
		await next.blobs.upload(file as never);
		expect(next.blobs.interrupted("a.pdf")).toBe(false);
		expect(methods()).toEqual(["GET"]);
		expect(next.bridge.writeBinary).toHaveBeenCalledWith("a.pdf", data);
		expect(next.index.update).not.toHaveBeenCalled();
		expect(next.app.vault.copy).not.toHaveBeenCalled();
		expect(meta["blobs-writing:s"]).toEqual({});
	});

	it("war das Schreiben doch fertig: nur Marke entfernen", async () => {
		const hash = await sha256Hex(data);
		const meta: Record<string, unknown> = { "blobs-writing:s": { "a.pdf": hash } };
		const { blobs, bridge } = setup({ entry: { hash, size: data.byteLength }, meta });
		await blobs.repair("a.pdf");
		expect(requestUrl).not.toHaveBeenCalled();
		expect(bridge.writeBinary).not.toHaveBeenCalled();
		expect(meta["blobs-writing:s"]).toEqual({});
	});

	it("halbe Datei einer übersprungenen großen Fassung wird nie hochgeladen", async () => {
		const hash = await sha256Hex(data);
		const meta: Record<string, unknown> = {
			"blobs-writing:s": { "a.pdf": hash },
			"blob-transfer:s": { key: `down:a.pdf:${hash}`, path: "a.pdf", dir: "down", hash, size: BIG_BLOB },
		};
		const half = new TextEncoder().encode("Inh").buffer as ArrayBuffer;
		const { blobs, index } = setup({ entry: { hash, size: BIG_BLOB }, localData: half, meta, onLost: () => {} });
		await blobs.upload(file as never);
		expect(requestUrl).not.toHaveBeenCalled();
		expect(index.update).not.toHaveBeenCalled();
		expect(blobs.interrupted("a.pdf")).toBe(true);
	});
});

describe("BlobSync: gleichzeitige Änderung", () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	const remote = new TextEncoder().encode("Fremd").buffer as ArrayBuffer;
	const mine = new TextEncoder().encode("Meins").buffer as ArrayBuffer;

	it("ohne Partner-Plugin: lokale Fassung wird Konfliktkopie", async () => {
		const hash = await sha256Hex(remote);
		requestUrl.mockResolvedValue({ status: 200, arrayBuffer: remote });
		const { blobs, app, bridge } = setup({ entry: { hash }, localData: mine });
		await blobs.fetch("a.pdf", hash, "eltern");
		expect(app.vault.copy).toHaveBeenCalledOnce();
		expect(bridge.writeBinary).toHaveBeenCalledOnce();
	});

	it("Partner-Plugin führt die lokale Fassung schon zusammen: keine Konfliktkopie", async () => {
		const hash = await sha256Hex(remote);
		const local = await sha256Hex(mine);
		requestUrl.mockResolvedValue({ status: 200, arrayBuffer: remote });
		const { blobs, app, bridge } = setup({ entry: { hash }, localData: mine });
		const seen: string[] = [];
		blobs.represented = (path, h) => (seen.push(`${path}:${h}`), h === local);
		await blobs.fetch("a.pdf", hash, "eltern");
		expect(seen).toEqual([`a.pdf:${local}`]);
		expect(app.vault.copy).not.toHaveBeenCalled();
		expect(bridge.writeBinary).toHaveBeenCalledOnce();
	});
});
