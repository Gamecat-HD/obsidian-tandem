// Helfer für Tests mit dem Zellwerk-Plugin (Excel-Tabellen, Live über die Live-API).
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

export const ZW_ID = "zellwerk";
export const ZW_DIR = process.env.ZELLWERK_DIR ?? join(homedir(), "Projekte/obsidian-zellwerk");
export const zwPlugin = () => ({ id: ZW_ID, dir: ZW_DIR, data: { tandem: true, saveDelay: 400 } });

/** ExcelJS aus dem Zellwerk-Projekt (nur für Testdaten). */
export const ExcelJS = createRequire(join(ZW_DIR, "package.json"))("exceljs");

export async function xlsxBase64(fill) {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet("Noten");
	fill(ws, wb);
	return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

export async function readXlsx(path) {
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.readFile(path);
	return wb;
}

/** Code mit der (ersten) Zellwerk-Ansicht ausführen: fn(view) im Renderer. */
export const zw = (h, fn, ...args) =>
	h.evaluate(
		`(async () => { const view = app.workspace.getLeavesOfType("zellwerk-sheet").map((l) => l.view).find((v) => v.api) ; if (!view) return null; return (${fn})(view, ...${JSON.stringify(args)}); })()`,
	);

export const cells = (h, rows = 8, cols = 5) =>
	zw(
		h,
		(view, r, c) => view.api.sheets()[0].data.slice(0, r).map((row) => row.slice(0, c).map((x) => (x ? (x.f ? `${x.f}=${x.v}` : (x.v ?? null)) : null))),
		rows,
		cols,
	);

export const sessionInfo = (h) => zw(h, (view) => ({ linked: view.session.linked, writer: view.session.isWriter(), peers: view.session.peers.length }));

export async function openSheet(h, path) {
	await h.evaluate(async (p) => {
		const f = app.vault.getFileByPath(p);
		await app.workspace.getLeaf(false).openFile(f);
	}, path);
}

export async function writeBinary(h, path, b64) {
	await h.evaluate(
		async (p, b) => {
			const bin = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
			const f = app.vault.getFileByPath(p);
			if (f) await app.vault.modifyBinary(f, bin.buffer);
			else await app.vault.createBinary(p, bin.buffer);
		},
		path,
		b64,
	);
}

/** Wie ein Mensch: Zelle anklicken, Text tippen, Enter. */
export async function typeIn(h, r, c, text) {
	const p = await zw(h, (v, r0, c0) => v.api.cellCenter(r0, c0), r, c);
	if (!p) throw new Error("Zelle nicht gefunden");
	await h.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
	await h.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
	await h.sleep(80);
	for (const ch of String(text)) {
		await h.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
		await h.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
	}
	await h.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await h.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await h.sleep(80);
}
