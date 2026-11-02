import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyInkFile, encodeInkDoc, parseInk, encodeParsed } from "./inkDoc";

const ink = (strokes: string[], h = 400) =>
	`{"v":1,"id":"a1","space":"nb","w":1000,"h":${h},"q":10,"strokes":[${strokes.length ? `\n${strokes.join(",\n")}\n` : ""}]}\n`;
const s = (id: string) => `{"id":"${id}","t":"pen","c":0,"s":2,"p":[1,2,128,3,4,5]}`;

describe("inkDoc", () => {
	it("kodiert byte-genau wie encodeInk", () => {
		const t = ink([s("x"), s("y")]);
		expect(encodeParsed(parseInk(t))).toBe(t);
		expect(encodeParsed(parseInk(ink([])))).toBe(ink([]));
	});
	it("gleichzeitiges Zeichnen auf zwei Geräten verliert nichts", () => {
		const base = ink([s("a")]);
		const d1 = new Y.Doc();
		applyInkFile(d1, base, undefined);
		const d2 = new Y.Doc();
		Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
		applyInkFile(d1, ink([s("a"), s("b")]), base);
		applyInkFile(d2, ink([s("a"), s("c")], 600), base);
		Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
		Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
		const r1 = parseInk(encodeInkDoc(d1)!);
		expect(new Set(r1.order)).toEqual(new Set(["a", "b", "c"]));
		expect(encodeInkDoc(d1)).toBe(encodeInkDoc(d2));
		expect(r1.head.h).toBe(600);
	});
	it("Radieren auf einem Gerät löscht überall", () => {
		const base = ink([s("a"), s("b")]);
		const d = new Y.Doc();
		applyInkFile(d, base, undefined);
		applyInkFile(d, ink([s("b")]), base);
		expect(parseInk(encodeInkDoc(d)!).order).toEqual(["b"]);
	});
	it("ohne base wird nie gelöscht", () => {
		const d = new Y.Doc();
		applyInkFile(d, ink([s("a"), s("b")]), undefined);
		applyInkFile(d, ink([s("c")]), undefined);
		expect(parseInk(encodeInkDoc(d)!).order).toEqual(["a", "b", "c"]);
	});
});
