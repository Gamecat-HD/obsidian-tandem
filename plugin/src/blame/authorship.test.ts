import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { AUTHORS_KEY, AuthorLookup, blameLines, MARKS_KEY, relativeTime, Source, textRuns, trackAuthorship, type Author } from "./authorship";

const alice: Author = { id: "alice", name: "Alice Muster", color: "#e11d48", device: "Laptop" };
const bob: Author = { id: "bob", name: "Bob", color: "#2563eb", device: "Tablet" };
const REMOTE = Symbol("remote");
const DISK = Symbol("disk");

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
	return blameLines(t.toString(), textRuns(t), new AuthorLookup(doc));
};

describe("Autorenschaft", () => {
	it("ordnet Zeilen der Person zu, die sie geschrieben hat", () => {
		const t = { now: 1_000_000 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "Zeile von Alice\n");
		t.now += 120_000;
		b.getText("content").insert(16, "Zeile von Bob\n");
		const res = blame(a);
		expect(res.map((r) => [r.line, r.who.author?.name, r.who.ts])).toEqual([
			[1, "Alice Muster", 1_000_000],
			[2, "Bob", 1_120_000],
		]);
		// Beide Seiten sehen dasselbe
		expect(blame(b).map((r) => r.who.author?.id)).toEqual(["alice", "bob"]);
	});

	it("letzte Änderung in einer Zeile gewinnt, andere werden als Beteiligte genannt", () => {
		const t = { now: 0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "Einkaufsliste: Äpfel");
		t.now = 300_000;
		b.getText("content").insert(20, ", Birnen");
		const [l] = blame(a);
		expect(l.who.author?.id).toBe("bob");
		expect(l.others.map((o) => o.id)).toEqual(["alice"]);
	});

	it("Zeitmarken höchstens einmal pro Minute, aber jede Minute neu", () => {
		const t = { now: 0 };
		const { a } = pair(t);
		const text = a.getText("content");
		text.insert(0, "a");
		t.now = 10_000;
		text.insert(1, "b");
		t.now = 59_000;
		text.insert(2, "c\n");
		t.now = 3_600_000;
		text.insert(4, "später");
		expect(a.getArray(MARKS_KEY).length).toBe(2);
		const res = blame(a);
		expect(res[0].who.ts).toBe(0);
		expect(res[1].who.ts).toBe(3_600_000);
		// Autor nur einmal eingetragen
		expect([...a.getMap(AUTHORS_KEY).keys()]).toEqual([String(a.clientID)]);
	});

	it("späteres Weiterschreiben im selben Stück zählt mit der späteren Zeit", () => {
		const t = { now: 0 };
		const { a } = pair(t);
		const text = a.getText("content");
		text.insert(0, "abc");
		t.now = 600_000;
		text.insert(3, "def");
		expect(blame(a)[0].who.ts).toBe(600_000);
		t.now = 650_000; // innerhalb der Minute: keine neue Marke, Stück wächst mit
		text.insert(6, "g");
		expect(blame(a)[0].who.ts).toBe(600_000);
	});

	it("Änderungen aus der Datei werden als solche markiert", () => {
		const t = { now: 0 };
		const { a } = pair(t);
		a.transact(() => a.getText("content").insert(0, "von Claude Code\n"), DISK);
		a.getText("content").insert(16, "getippt");
		const res = blame(a);
		expect(res[0].who.src).toBe(Source.File);
		expect(res[1].who.src).toBe(Source.Editor);
	});

	it("Zeilenumbruch gehört nicht zur Zeile, leere Zeilen ohne Eintrag", () => {
		const t = { now: 0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "Titel");
		t.now = 120_000;
		b.getText("content").insert(5, "\n\nText");
		const res = blame(a);
		expect(res.map((r) => [r.line, r.who.author?.id])).toEqual([
			[1, "alice"],
			[3, "bob"],
		]);
	});

	it("Text ohne Angaben (älteres Plugin) bleibt unbekannt", () => {
		const old = new Y.Doc();
		old.getText("content").insert(0, "alter Text\n");
		const t = { now: 5 };
		const { a } = pair(t);
		Y.applyUpdate(a, Y.encodeStateAsUpdate(old), REMOTE);
		a.getText("content").insert(11, "neu");
		const res = blame(a);
		expect(res[0].who.author).toBeNull();
		expect(res[1].who.author?.id).toBe("alice");
	});

	it("schreibt nichts bei reinem Löschen, bei Remote-Updates oder ohne bekannte Person", () => {
		const t = { now: 0 };
		const { a, b } = pair(t);
		a.getText("content").insert(0, "hallo");
		const marksBefore = b.getArray(MARKS_KEY).length;
		t.now = 999_999;
		b.getText("content").delete(0, 2);
		expect(b.getArray(MARKS_KEY).length).toBe(marksBefore);
		expect(b.getMap(AUTHORS_KEY).has(String(b.clientID))).toBe(false);

		const c = new Y.Doc();
		trackAuthorship(c, () => null);
		c.getText("content").insert(0, "x");
		expect(c.getMap(AUTHORS_KEY).size).toBe(0);
		expect(c.getArray(MARKS_KEY).length).toBe(0);
	});

	it("Fremde Personen aus der Präsenz ergänzen", () => {
		const old = new Y.Doc();
		old.getText("content").insert(0, "live von Nico");
		const a = new Y.Doc();
		Y.applyUpdate(a, Y.encodeStateAsUpdate(old));
		const t = a.getText("content");
		const res = blameLines(t.toString(), textRuns(t), new AuthorLookup(a, (c) => (c === old.clientID ? { id: "nico", name: "Nico", color: "#0f0" } : undefined)));
		expect(res[0].who.author?.name).toBe("Nico");
		expect(res[0].who.ts).toBeNull();
	});
});

describe("relativeTime", () => {
	const now = new Date(2026, 10, 9, 12, 0).getTime();
	it("formatiert deutsch", () => {
		expect(relativeTime(now - 10_000, now)).toBe("jetzt");
		expect(relativeTime(now - 5 * 60_000, now)).toBe("vor 5 Min.");
		expect(relativeTime(now - 3 * 3_600_000, now)).toBe("vor 3 Std.");
		expect(relativeTime(now - 30 * 3_600_000, now)).toBe("gestern");
		expect(relativeTime(now - 4 * 86_400_000, now)).toBe("vor 4 Tagen");
		expect(relativeTime(new Date(2026, 9, 1).getTime(), now)).toBe("01.10.");
	});
});
