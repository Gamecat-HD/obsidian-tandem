import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { minimalReplace } from "./diff";

/** Schritte wie im Editor-Sync nacheinander auf ein Y.Text anwenden. */
function apply(text: string, from: number, old: string, neu: string, other?: (t: Y.Text) => void) {
	const doc = new Y.Doc();
	const t = doc.getText("t");
	t.insert(0, text);
	const peer = new Y.Doc();
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
	const parts = minimalReplace(old, neu);
	doc.transact(() => {
		if (!parts) {
			t.delete(from, old.length);
			t.insert(from, neu);
			return;
		}
		for (const p of parts) {
			if (p.from !== p.to) t.delete(from + p.from, p.to - p.from);
			if (p.insert) t.insert(from + p.from, p.insert);
		}
	});
	if (other) {
		other(peer.getText("t"));
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
	}
	return { parts, text: t.toString() };
}

describe("minimalReplace", () => {
	const table = "| A | B |\n| --- | --- |\n| eins | zwei |";

	it("unverändertes Neuschreiben ist keine Änderung", () => {
		expect(minimalReplace(table, table)).toEqual([]);
	});

	it("Neuschreiben mit Auffüllen ändert nur die Leerzeichen", () => {
		const neu = "| A    | B    |\n| ---- | ---- |\n| eins | zwei |";
		const r = apply("vor\n" + table + "\nnach", 4, table, neu);
		expect(r.text).toBe("vor\n" + neu + "\nnach");
		expect(r.parts!.every((p) => /^[ -]*$/.test(p.insert))).toBe(true);
	});

	it("gleichzeitige Eingabe eines anderen in der Tabelle bleibt erhalten", () => {
		const start = "vor\n" + table;
		// Der andere tippt in „zwei“, während hier die Tabelle unverändert neu geschrieben wird.
		const r = apply(start, 4, table, table, (t) => t.insert(start.indexOf("zwei") + 4, "X"));
		expect(r.text).toBe("vor\n" + table.replace("zwei", "zweiX"));
	});

	it("ganz anderer Text bleibt ein einfaches Ersetzen", () => {
		expect(minimalReplace("Hallo", "World")).toBeNull();
		expect(apply("xHallox", 1, "Hallo", "World").text).toBe("xWorldx");
	});

	it("Schritte ergeben auch bei Löschen und Einfügen gemischt den neuen Text", () => {
		const old = "Das ist ein langer Satz mit Inhalt";
		const neu = "Das war ein längerer Satz ohne Inhalt!";
		expect(apply(old, 0, old, neu).text).toBe(neu);
	});
});
