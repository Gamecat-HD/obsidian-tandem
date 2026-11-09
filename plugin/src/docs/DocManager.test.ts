import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.stubGlobal("window", globalThis);
const { DocManager } = await import("./DocManager");

type Handler = { onSync(sub: number, data: Uint8Array): void };

/** Verbindung ohne Netz: merkt sich die Handler, damit der Test Server-Nachrichten einspielen kann. */
function fakeConn(status: "online" | "offline" = "online") {
	const handlers = new Map<string, Handler>();
	const sent: { type: number; doc?: string; sub?: number }[] = [];
	return {
		status,
		handlers,
		sent,
		register: (name: string, h: Handler) => void handlers.set(name, h),
		unregister: (name: string) => void handlers.delete(name),
		onStatus: () => () => {},
		send: (m: { type: number; doc?: string; sub?: number }) => {
			sent.push(m);
			return true;
		},
	};
}

function memStore(docs: Record<string, { name: string; state: Uint8Array; base?: string }> = {}) {
	const puts: string[] = [];
	return {
		puts,
		get: async (name: string) => docs[name],
		put: async (d: { name: string; state: Uint8Array; base?: string }) => {
			puts.push(d.name);
			docs[d.name] = d;
		},
		getMeta: async () => undefined,
		setMeta: async () => {},
	};
}

function stored(text: string) {
	const d = new Y.Doc();
	d.getText("content").insert(0, text);
	return { name: "s/x", state: Y.encodeStateAsUpdate(d), base: text };
}

const SYNC_STEP2 = 1;

describe("DocManager", () => {
	it("speichert den gerade geladenen Stand nicht erneut", async () => {
		vi.useFakeTimers();
		const store = memStore({ "s/x": stored("Hallo") });
		const dm = new DocManager(fakeConn("offline") as never, store as never, "s");
		const s = await dm.acquire("x");
		expect(s.doc.getText("content").toString()).toBe("Hallo");
		await vi.advanceTimersByTimeAsync(5000);
		expect(store.puts).toEqual([]);
		s.doc.getText("content").insert(5, "!");
		await vi.advanceTimersByTimeAsync(1000);
		expect(store.puts).toEqual(["s/x"]);
		await dm.destroy();
		vi.useRealTimers();
	});

	it("Laden meldet onRemoteUpdate – außer während eines Abgleichs (withDoc mit reconciles)", async () => {
		const store = memStore({ "s/x": stored("Hallo") });
		const conn = fakeConn("offline");
		const dm = new DocManager(conn as never, store as never, "s");
		const seen: string[] = [];
		dm.onRemoteUpdate = (id) => seen.push(id);
		await dm.withDoc("x", () => {}, 10, { reconciles: true });
		expect(seen).toEqual([]);
		await dm.destroy();

		const dm2 = new DocManager(conn as never, memStore({ "s/x": stored("Hallo") }) as never, "s");
		const seen2: string[] = [];
		dm2.onRemoteUpdate = (id) => seen2.push(id);
		await dm2.acquire("x");
		expect(seen2).toEqual(["x"]);
		await dm2.destroy();
	});

	it("fremde Änderung vor dem Arbeitsschritt still, danach gemeldet", async () => {
		const rec = stored("Hallo");
		const store = memStore({ "s/x": rec });
		const conn = fakeConn("online");
		const dm = new DocManager(conn as never, store as never, "s");
		const seen: string[] = [];
		dm.onRemoteUpdate = (id) => seen.push(id);
		const remote = new Y.Doc();
		Y.applyUpdate(remote, rec.state);
		const edit = (t: string) => {
			const sv = Y.encodeStateVector(remote);
			remote.getText("content").insert(0, t);
			return Y.encodeStateAsUpdate(remote, sv);
		};
		const run = dm.withDoc(
			"x",
			async (s) => {
				// Abgleich hat den Server-Stand (Step2) schon gesehen
				expect(s.doc.getText("content").toString()).toBe("A Hallo");
				expect(seen).toEqual([]);
				// Während des Arbeitsschritts eintreffend → muss einen weiteren Abgleich auslösen
				conn.handlers.get("s/x")!.onSync(2, edit("B "));
			},
			2000,
			{ reconciles: true },
		);
		await vi.waitFor(() => expect(conn.handlers.get("s/x")).toBeDefined());
		await vi.waitFor(() => expect(conn.sent.some((m) => m.doc === "s/x" && m.sub === 0)).toBe(true));
		conn.handlers.get("s/x")!.onSync(SYNC_STEP2, edit("A "));
		await run;
		expect(seen).toEqual(["x"]);
		await dm.destroy();
	});
});
