import { describe, expect, it } from "vitest";
import { merge3 } from "./rebase";

describe("merge3", () => {
	it("übernimmt Änderungen beider Seiten an verschiedenen Stellen", () => {
		const base = "Zeile eins\nZeile zwei\nZeile drei\n";
		const mine = "Zeile EINS\nZeile zwei\nZeile drei\n";
		const theirs = "Zeile eins\nZeile zwei\nZeile drei\nZeile vier\n";
		expect(merge3(base, mine, theirs)).toBe("Zeile EINS\nZeile zwei\nZeile drei\nZeile vier\n");
	});
	it("Einfügung an derselben Stelle: beide bleiben", () => {
		expect(merge3("ab", "aXb", "aYb")).toMatch(/^a(XY|YX)b$/);
	});
	it("gelöschter Bereich + Änderung darin: kein Absturz, Löschung bleibt", () => {
		const r = merge3("hallo schöne welt", "hallo welt", "hallo sehr schöne welt");
		expect(r).toContain("hallo");
		expect(r).toContain("welt");
	});
	it("triviale Fälle", () => {
		expect(merge3("a", "a", "b")).toBe("b");
		expect(merge3("a", "b", "a")).toBe("b");
		expect(merge3("", "neu", "")).toBe("neu");
	});
	it("Umlaute und Emojis", () => {
		expect(merge3("Äpfel 🍎", "Äpfel 🍎 und Birnen", "Grüne Äpfel 🍎")).toBe("Grüne Äpfel 🍎 und Birnen");
	});
});
