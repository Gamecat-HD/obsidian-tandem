// Helfer für Tests mit dem echten Ink-Blocks-Plugin.
import { homedir } from "node:os";
import { join } from "node:path";

export const INK_ID = "obsidian-ink-blocks";
export const INK_DIR = process.env.INK_BLOCKS_DIR ?? join(homedir(), "Projekte/obsidian-ink-blocks");
export const inkPlugin = () => ({ id: INK_ID, dir: INK_DIR, data: { ocrEnabled: false } });

export const SURFACE = ".markdown-source-view .ink-surface";

export async function surfaceRect(h) {
	return h.evaluate((sel) => {
		const b = document.querySelector(sel)?.getBoundingClientRect();
		return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
	}, SURFACE);
}

/** Strich-IDs der ersten Fläche (aus dem Ink-Blocks-Speicher). */
export const strokeIds = (h) =>
	h.evaluate(([id, sel]) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const e = app.plugins.plugins[id].store.entries.get(el.dataset.path);
		return e ? e.doc.strokes.map((s) => s.id).sort() : null;
	}, [INK_ID, SURFACE]);

export const inkFileText = (h, path) =>
	h.evaluate(async (p) => {
		const f = app.vault.getFileByPath(p);
		return f ? await app.vault.read(f) : null;
	}, path);

/** Ein „Wort“ als Strichpunkte relativ zur Fläche. */
export const word = (r, x0, y0, n = 16) => Array.from({ length: n }, (_, i) => [r.x + x0 + i * 4, r.y + y0 + 8 * Math.sin(i), 0.6]);
