import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
	AUTHORS_KEY,
	AuthorLookup,
	blameLines,
	describe as describeWho,
	fromSec,
	LEGACY_AUTHORS_KEY,
	LEGACY_MARKS_KEY,
	mapOrigins,
	PEOPLE_KEY,
	relativeTime,
	Source,
	textLines,
	textRuns,
	TIMES_KEY,
	toSec,
	trackAuthorship,
	type Author,
} from "./authorship";

const alice: Author = { id: "alice", name: "Alice Muster", color: "#e11d48", device: "Laptop" };
const bob: Author = { id: "bob", name: "Bob", color: "#2563eb", device: "Tablet" };
const REMOTE = Symbol("remote");
const DISK = Symbol("disk");
const T0 = Date.UTC(2026, 10, 9, 10, 0);
const MIN = 60_000;

/** Zwei verbundene Docs (wie zwei Geräte über den Server). */
function pair(t: { now: number }) {
	const a = new Y.Doc();
	const b = new Y.Doc();
	a.on("update", (u: Uint8Array, o: unknown) => o !== REMOTE && Y.applyUpdate(b, u, REMOTE));
	b.on("update", (u: Uint8Array, o: unknown) => o !== REMOTE && Y.applyUpdate(a, u, REMOTE));
	const opts = { now: () => t.now, ignore: [REMOTE], sourceOf: (o: unknown) => (o === DISK ? Source.File : Source.Editor) };
	trackAuthorship(a, () => alice, opts);
	trackAuthorship(b, () => bob, opts);
	return { a, b };
}

const blame = (doc: Y.Doc) => {
	const t = doc.getText("content");
	return blameLines(textLines(t.toString()), textRuns(t), new AuthorLookup(doc));
};

describe("Autorenschaft", () => {
	it("ordnet Zeilen der Person zu, die sie geschrieben hat", () => {
		const t = { now: T0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "Zeile von Alice\n");
		t.now += 2 * MIN;
		b.getText("content").insert(16, "Zeile von Bob\n");
		const res = blame(a);
		expect(res.map((r) => [r.index, r.who.author?.name, r.who.author?.device, r.who.ts])).toEqual([
			[0, "Alice Muster", "Laptop", T0],
			[1, "Bob", "Tablet", T0 + 2 * MIN],
		]);
		expect(blame(b).map((r) => r.who.author?.id)).toEqual(["alice", "bob"]);
	});

	it("letzte Änderung in einer Zeile gewinnt, andere werden als Beteiligte genannt", () => {
		const t = { now: T0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "Einkaufsliste: Äpfel");
		t.now += 5 * MIN;
		b.getText("content").insert(20, ", Birnen");
		const [l] = blame(a);
		expect(l.who.author?.id).toBe("bob");
		expect(l.others.map((o) => o.id)).toEqual(["alice"]);
	});

	it("neue Zeitmarke nur nach einer Pause; Person und Instanz nur einmal", () => {
		const t = { now: T0 };
		const { a } = pair(t);
		const text = a.getText("content");
		text.insert(0, "a");
		t.now += 10_000;
		text.insert(1, "b");
		t.now += 40_000;
		text.insert(2, "c\n");
		t.now = T0 + 60 * MIN;
		text.insert(4, "später");
		expect(a.getArray(TIMES_KEY).length).toBe(2);
		const res = blame(a);
		expect(res[0].who.ts).toBe(T0);
		expect(res[1].who.ts).toBe(T0 + 60 * MIN);
		expect([...a.getMap(AUTHORS_KEY).keys()]).toEqual([String(a.clientID)]);
		expect(a.getMap(PEOPLE_KEY).toJSON()).toEqual({ alice: ["Alice Muster", "#e11d48"] });
	});

	it("kompakt: Zeitmarken ohne clientID und als kleine Ganzzahlen", () => {
		const t = { now: T0 };
		const { a } = pair(t);
		a.getText("content").insert(0, "x");
		const [m] = a.getArray<number[]>(TIMES_KEY).toArray();
		expect(m).toEqual([0, toSec(T0)]);
		expect(m[1]).toBeLessThan(2 ** 31);
		expect(fromSec(m[1])).toBe(T0);
	});

	it("späteres Weiterschreiben im selben Stück zählt mit der späteren Zeit", () => {
		const t = { now: T0 };
		const { a } = pair(t);
		const text = a.getText("content");
		text.insert(0, "abc");
		t.now += 10 * MIN;
		text.insert(3, "def");
		expect(blame(a)[0].who.ts).toBe(T0 + 10 * MIN);
	});

	it("Änderungen aus der Datei werden als solche markiert", () => {
		const t = { now: T0 };
		const { a } = pair(t);
		a.transact(() => a.getText("content").insert(0, "von Claude Code\n"), DISK);
		a.getText("content").insert(16, "getippt");
		const res = blame(a);
		expect(res[0].who.src).toBe(Source.File);
		expect(res[1].who.src).toBe(Source.Editor);
	});

	it("Zeilenumbruch gehört nicht zur Zeile, leere Zeilen ohne Eintrag", () => {
		const t = { now: T0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "Titel");
		t.now += 2 * MIN;
		b.getText("content").insert(5, "\n\nText");
		expect(blame(a).map((r) => [r.index, r.who.author?.id])).toEqual([
			[0, "alice"],
			[2, "bob"],
		]);
	});

	it("Text ohne Angaben (älteres Plugin) bleibt unbekannt", () => {
		const old = new Y.Doc();
		old.getText("content").insert(0, "alter Text\n");
		const t = { now: T0 };
		const { a } = pair(t);
		Y.applyUpdate(a, Y.encodeStateAsUpdate(old), REMOTE);
		a.getText("content").insert(11, "neu");
		const res = blame(a);
		expect(res[0].who.author).toBeNull();
		expect(res[1].who.author?.id).toBe("alice");
	});

	it("liest das Format von 0.8.0", () => {
		const d = new Y.Doc();
		d.getText("content").insert(0, "aus 0.8.0");
		d.getMap(LEGACY_AUTHORS_KEY).set(String(d.clientID), { id: "nico", name: "Nico", color: "#0f0", device: "Tablet" });
		d.getArray(LEGACY_MARKS_KEY).push([[d.clientID, 0, T0, 0]]);
		const [l] = blame(d);
		expect(l.who.author?.name).toBe("Nico");
		expect(l.who.ts).toBe(T0);
	});

	it("schreibt nichts bei reinem Löschen, bei Remote-Updates oder ohne bekannte Person", () => {
		const t = { now: T0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "hallo");
		const marksBefore = b.getArray(TIMES_KEY).length;
		t.now += 99 * MIN;
		b.getText("content").delete(0, 2);
		expect(b.getArray(TIMES_KEY).length).toBe(marksBefore);
		expect(b.getMap(AUTHORS_KEY).has(String(b.clientID))).toBe(false);

		const c = new Y.Doc();
		trackAuthorship(c, () => null);
		c.getText("content").insert(0, "x");
		expect(c.getMap(AUTHORS_KEY).size).toBe(0);
		expect(c.getArray(TIMES_KEY).length).toBe(0);
	});

	it("fremde Personen aus der Präsenz ergänzen", () => {
		const old = new Y.Doc();
		old.getText("content").insert(0, "live von Nico");
		const a = new Y.Doc();
		Y.applyUpdate(a, Y.encodeStateAsUpdate(old));
		const t = a.getText("content");
		const res = blameLines(textLines(t.toString()), textRuns(t), new AuthorLookup(a, (c) => (c === old.clientID ? { id: "nico", name: "Nico", color: "#0f0" } : undefined)));
		expect(res[0].who.author?.name).toBe("Nico");
		expect(res[0].who.ts).toBeNull();
	});

	it("Ink-Striche (Y.Map) der Person zuordnen", () => {
		const t = { now: T0 };
		const { a, b } = pair(t);
		a.getMap("strokes").set("s1", "Strich von Alice");
		t.now += 3 * MIN;
		b.getMap("strokes").set("s2", "Strich von Bob");
		const lookup = new AuthorLookup(a);
		const res = [...mapOrigins(a.getMap("strokes"))].map(([id, o]) => [id, lookup.who(o.client, o.clock).author?.id, lookup.who(o.client, o.clock).ts]);
		expect(res.sort()).toEqual([
			["s1", "alice", T0],
			["s2", "bob", T0 + 3 * MIN],
		]);
		a.getMap("strokes").delete("s1");
		expect([...mapOrigins(b.getMap("strokes")).keys()]).toEqual(["s2"]);
	});

	it("logische Uhr: wer nach fremden Änderungen schreibt, ist neuer – auch in derselben Sekunde oder mit nachgehender Uhr", () => {
		const t = { now: T0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "Äpfel von Alice");
		b.getText("content").insert(15, " und Bob"); // gleiche Sekunde
		expect(blame(a)[0].who.author?.id).toBe("bob");

		const ta = { now: T0 };
		const tb = { now: T0 - 3600_000 }; // Bobs Uhr geht eine Stunde nach
		const x = new Y.Doc();
		const y = new Y.Doc();
		x.on("update", (u: Uint8Array, o: unknown) => o !== REMOTE && Y.applyUpdate(y, u, REMOTE));
		y.on("update", (u: Uint8Array, o: unknown) => o !== REMOTE && Y.applyUpdate(x, u, REMOTE));
		trackAuthorship(x, () => alice, { now: () => ta.now, ignore: [REMOTE] });
		trackAuthorship(y, () => bob, { now: () => tb.now, ignore: [REMOTE] });
		x.getText("content").insert(0, "Alice");
		y.getText("content").insert(5, " Bob");
		const [l] = blame(x);
		expect(l.who.author?.id).toBe("bob");
		expect(l.who.ts).toBe(T0 + 1000);
	});

	it("Dauerschreiben: höchstens alle 10 Minuten eine Marke", () => {
		const t = { now: T0 };
		const { a } = pair(t);
		const text = a.getText("content");
		for (let i = 0; i < 30; i++) {
			text.insert(i, "x");
			t.now += MIN;
		}
		expect(a.getArray(TIMES_KEY).length).toBe(3);
	});

	it("bleibt klein: unter 4 Byte pro Minute Schreiben", () => {
		const t = { now: T0 };
		const a = new Y.Doc();
		trackAuthorship(a, () => alice, { now: () => t.now });
		const plain = new Y.Doc();
		for (let i = 0; i < 1000; i++) {
			t.now += MIN;
			a.getText("content").insert(i, "y");
			plain.getText("content").insert(i, "y");
		}
		const overhead = Y.encodeStateAsUpdate(a).length - Y.encodeStateAsUpdate(plain).length;
		expect(overhead / 1000).toBeLessThan(4);
	});
});

describe("Anzeige-Texte", () => {
	const now = new Date(2026, 10, 9, 12, 0).getTime();
	it("relativeTime formatiert deutsch", () => {
		expect(relativeTime(now - 10_000, now)).toBe("jetzt");
		expect(relativeTime(now - 5 * MIN, now)).toBe("vor 5 Min.");
		expect(relativeTime(now - 3 * 60 * MIN, now)).toBe("vor 3 Std.");
		expect(relativeTime(now - 30 * 60 * MIN, now)).toBe("gestern");
		expect(relativeTime(now - 4 * 1440 * MIN, now)).toBe("vor 4 Tagen");
		expect(relativeTime(new Date(2026, 9, 1).getTime(), now)).toBe("01.10.");
	});
	it("Tooltip nennt „Du“, Gerät, Quelle und Beteiligte", () => {
		const tip = describeWho({ author: alice, ts: null, src: Source.File, key: "x" }, [bob], 0, "alice");
		expect(tip).toContain("Du (Alice Muster) · Laptop");
		expect(tip).toContain("Datei von außen");
		expect(tip).toContain("Auch beteiligt: Bob");
	});
});
