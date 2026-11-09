import { describe, expect, it } from "vitest";
import { mentions, referencingNotes } from "./references";

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
});
