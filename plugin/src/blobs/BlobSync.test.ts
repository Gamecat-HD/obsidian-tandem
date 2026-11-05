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

function setup(opts: { entry?: Record<string, unknown>; local?: boolean; meta?: Record<string, unknown>; onLost?: (t: unknown) => void } = {}) {
	const index = {
		idForPath: () => (opts.entry ? "id" : undefined),
		get: () => opts.entry,
		update: vi.fn(),
		add: vi.fn(),
	};
	const app = { vault: { getFileByPath: () => (opts.local === false ? null : file), readBinary: async () => data, copy: vi.fn() } };
	const bridge = { run: (_k: string, fn: () => Promise<void>) => fn(), writeBinary: vi.fn() };
	const blobs = new BlobSync(app as never, index as never, bridge as never, memoryStore(opts.meta) as never, "s", () => ({ base: "https://x", token: "t" }), null, opts.onLost as never);
	return { blobs, index, bridge };
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
