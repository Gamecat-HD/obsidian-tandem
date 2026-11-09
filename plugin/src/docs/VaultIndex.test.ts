import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { VaultIndex, type IndexEntry } from "./VaultIndex";

/** Die frühere, lineare Auswertung direkt auf der Y.Map – Maßstab für die nachgeführten Tabellen. */
function naive(files: Y.Map<IndexEntry>) {
	const byPath = new Map<string, string>();
	for (const [id, e] of files) {
		if (e.del) continue;
		const cur = byPath.get(e.path);
		if (cur === undefined || id < cur) byPath.set(e.path, id);
	}
	const paths = new Set([...files.values()].map((e) => e.path));
	const deleted = new Map<string, string[]>();
	for (const p of paths) {
		const tombs = [...files].filter(([, e]) => e.del && e.path === p);
		const maxTs = Math.max(...tombs.map(([, e]) => e.ts));
		deleted.set(p, tombs.filter(([, e]) => e.ts === maxTs).map(([id]) => id));
	}
	return {
		byPath,
		paths,
		deleted,
		contested: (p: string) => [...files.values()].filter((e) => !e.del && e.path === p).length > 1,
		conflicts: () => [...files].filter(([id, e]) => !e.del && byPath.get(e.path) !== id).map(([id]) => id).sort(),
	};
}

function expectSame(ix: VaultIndex) {
	const ref = naive(ix.files);
	for (const p of ref.paths) {
		expect(ix.idForPath(p), `idForPath ${p}`).toBe(ref.byPath.get(p));
		expect(ix.contested(p), `contested ${p}`).toBe(ref.contested(p));
		const d = ix.deletedIdForPath(p);
		const allowed = ref.deleted.get(p)!;
		if (allowed.length) expect(allowed, `deletedIdForPath ${p}`).toContain(d);
		else expect(d).toBeUndefined();
	}
	expect(ix.conflicts().map(([id]) => id).sort()).toEqual(ref.conflicts());
}

/** Kleiner deterministischer Zufallsgenerator (reproduzierbare Fehlerfälle). */
function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

describe("VaultIndex", () => {
	it("Pfad, Grabstein, Konflikt", () => {
		const doc = new Y.Doc();
		const ix = new VaultIndex(doc, () => "u");
		const a = ix.add("a.md", "md");
		expect(ix.idForPath("a.md")).toBe(a);
		ix.files.set("00", { path: "a.md", kind: "md", ts: 1 });
		expect(ix.idForPath("a.md")).toBe("00");
		expect(ix.contested("a.md")).toBe(true);
		expect(ix.conflicts().map(([id]) => id)).toEqual([a]);
		ix.update("00", { del: true });
		expect(ix.idForPath("a.md")).toBe(a);
		expect(ix.contested("a.md")).toBe(false);
		expect(ix.deletedIdForPath("a.md")).toBe("00");
		ix.rename("a.md", "b.md");
		expect(ix.idForPath("a.md")).toBeUndefined();
		expect(ix.idForPath("b.md")).toBe(a);
		expectSame(ix);
	});

	it("baut sich aus einem schon gefüllten Doc auf", () => {
		const doc = new Y.Doc();
		const m = doc.getMap<IndexEntry>("files");
		m.set("b", { path: "x.md", kind: "md", ts: 1 });
		m.set("a", { path: "x.md", kind: "md", ts: 2 });
		m.set("c", { path: "y.md", kind: "md", ts: 3, del: true });
		const ix = new VaultIndex(doc, () => "u");
		expect(ix.idForPath("x.md")).toBe("a");
		expect(ix.deletedIdForPath("y.md")).toBe("c");
		expectSame(ix);
	});

	it("bleibt bei zufälligen lokalen und entfernten Änderungen gleich der linearen Auswertung", () => {
		for (let seed = 1; seed <= 15; seed++) {
			const r = rng(seed);
			const docs = [new Y.Doc(), new Y.Doc()];
			const ixs = docs.map((d) => new VaultIndex(d, () => "u"));
			const paths = ["a.md", "b.md", "c.md", "d/e.md", "d/f.md", "g.png"];
			const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
			let ts = 1;
			for (let step = 0; step < 250; step++) {
				const i = r() < 0.5 ? 0 : 1;
				const ix = ixs[i];
				const ids = [...ix.files.keys()];
				const op = r();
				if (op < 0.3) ix.files.set(`id${Math.floor(r() * 40)}`, { path: pick(paths), kind: "md", ts: ts++ });
				else if (op < 0.45 && ids.length) ix.update(pick(ids), { del: r() < 0.7 });
				else if (op < 0.6 && ids.length) ix.update(pick(ids), { path: pick(paths) });
				else if (op < 0.65) ix.rename("d", r() < 0.5 ? "h" : "d2");
				else if (op < 0.7) ix.remove(pick(paths));
				else if (op < 0.75 && ids.length) ix.files.delete(pick(ids));
				else if (op < 0.8) {
					// Mehrere Änderungen in einer Transaktion
					docs[i].transact(() => {
						for (let k = 0; k < 4; k++) ix.files.set(`id${Math.floor(r() * 40)}`, { path: pick(paths), kind: "md", ts: ts++, del: r() < 0.3 });
					});
				} else {
					// Abgleich in beide Richtungen (wie Remote-Updates vom Server)
					Y.applyUpdate(docs[1 - i], Y.encodeStateAsUpdate(docs[i], Y.encodeStateVector(docs[1 - i])));
				}
				expectSame(ixs[0]);
				expectSame(ixs[1]);
			}
		}
	}, 60000);
});
