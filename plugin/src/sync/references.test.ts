import { describe, expect, it } from "vitest";
import { mentions, referencingNotes, referencingNotesMany } from "./references";

const note = (path: string, text: string) => ({ path, read: async () => text });

describe("Verweise auf gelöschte Anhänge", () => {
	it("findet Ink-Hintergrund im Codeblock, Einbettung und URL-kodierten Link", () => {
		expect(mentions('```ink\nfile: _ink/a.ink\nbg: "[[Screenshot 1.jpg]]"\n```', "Bilder/Screenshot 1.jpg")).toBe(true);
		expect(mentions("![[Screenshot 1.jpg|300]]", "Screenshot 1.jpg")).toBe(true);
		expect(mentions("![](Bilder/Screenshot%201.jpg)", "Bilder/Screenshot 1.jpg")).toBe(true);
		expect(mentions("nichts davon", "Screenshot 1.jpg")).toBe(false);
	});

	it("listet nur Notizen, deren Verweis jetzt ins Leere zeigt", async () => {
		const notes = [
			note("BAB.md", 'bg: "[[Screenshot.jpg]]"'),
			note("Andere.md", "![[Screenshot.jpg]]"),
			note("Ohne.md", "Text"),
		];
		// In „Andere.md“ löst der Name auf eine gleichnamige Datei in einem anderen Ordner auf.
		const refs = await referencingNotes("Screenshot.jpg", notes, (_n, p) => p === "Andere.md");
		expect(refs).toEqual(["BAB.md"]);
	});

	it("prüft mehrere gelöschte Dateien in einem Durchgang und liest jede Notiz nur einmal", async () => {
		let reads = 0;
		const n = (path: string, text: string) => ({ path, read: async () => (reads++, text) });
		const notes = [n("A.md", "![[a.png]] und ![[b.png]]"), n("B.md", "![[b.png]]"), n("C.md", "nichts")];
		const refs = await referencingNotesMany(["x/a.png", "y/b.png", "z/c.png"], notes, () => false);
		expect(Object.fromEntries(refs)).toEqual({ "x/a.png": ["A.md"], "y/b.png": ["A.md", "B.md"], "z/c.png": [] });
		expect(reads).toBe(3);
	});
});
