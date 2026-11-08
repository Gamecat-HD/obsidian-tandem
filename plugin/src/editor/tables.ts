/**
 * Cursor in Tabellen (Live-Vorschau).
 *
 * Obsidian zeigt Tabellen als Block-Widget und bearbeitet eine Zelle in einem eigenen, eingebetteten
 * CodeMirror-Editor (`editorComponent.tableCell`). Jede Eingabe dort spiegelt Obsidian samt Auswahl in
 * den Haupteditor zurück. Zwei Lücken in y-codemirror.next:
 *
 * 1. Senden: yRemoteSelections übernimmt die Auswahl nur, wenn der Haupteditor selbst den Fokus hat.
 *    In einer Zelle liegt der Fokus im eingebetteten Editor → der alte Cursor blieb stehen.
 *    `tableCursorSync` springt genau dann ein.
 * 2. Anzeigen: Dekorationen innerhalb eines ersetzten Bereichs (das Tabellen-Widget) sind unsichtbar.
 *    `tableCarets` zeichnet fremde Cursor deshalb als Ebene über die passende Zelle.
 *
 * Die Tabellen-Objekte sind Obsidian-intern und nicht typisiert; sie werden über die
 * Dekorationen gefunden und nur per Duck-Typing benutzt. Fehlt etwas, entfällt nur die Anzeige.
 */
import { ChangeSet } from "@codemirror/state";
import { EditorView, ViewPlugin, layer, type LayerMarker, type ViewUpdate } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

interface ObsidianCell {
	el: HTMLElement;
	contentEl?: HTMLElement;
	getAbsoluteOffsets(): { start: number; end: number; textStart: number; textEnd: number };
}
interface ObsidianTable {
	start: number;
	end: number;
	rows: ObsidianCell[][];
	containerEl: HTMLElement;
}

function isTable(w: unknown): w is ObsidianTable {
	const t = w as ObsidianTable | null;
	return !!t && typeof t.start === "number" && typeof t.end === "number" && Array.isArray(t.rows) && t.containerEl instanceof HTMLElement;
}

/** Sichtbare Tabellen-Widgets des Editors. */
function tablesIn(view: EditorView): ObsidianTable[] {
	const out: ObsidianTable[] = [];
	const { from, to } = view.viewport;
	for (const src of view.state.facet(EditorView.decorations)) {
		let set;
		try {
			set = typeof src === "function" ? src(view) : src;
		} catch {
			continue;
		}
		set?.between(from, to, (_f, _t, deco) => {
			const w = deco.spec.widget;
			if (isTable(w) && w.containerEl.isConnected && !out.includes(w)) out.push(w);
		});
	}
	return out;
}

/** Fokus liegt in einem eingebetteten Editor (Tabellenzelle) dieses Editors. */
function focusInNested(view: EditorView): boolean {
	if (view.hasFocus) return false;
	const doc = view.dom.ownerDocument;
	const active = doc.activeElement;
	return doc.hasFocus() && !!active && active !== view.contentDOM && view.contentDOM.contains(active);
}

/** Trennzeile einer Markdown-Tabelle, z. B. `| --- | :-: |`. */
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Fremdänderungen so zuschneiden, wie Obsidians Tabellen-Editor sie verträgt:
 *
 * - Änderungen an der Trennzeile übernimmt Obsidian nur, wenn sie die ganze Zeile ersetzen (so schreibt
 *   der eigene Tabellen-Editor neue Spaltenbreiten). Einzelne `-`-Einfügungen aus Yjs lösen sonst ein
 *   komplettes Neuzeichnen aus, das den gerade offenen Zell-Editor zerstört; weitere Tasten gingen verloren.
 * - Wird gerade eine Zelle bearbeitet, bekommt die Transaktion die fortgeschriebene Auswahl mit. Obsidian setzt
 *   den Cursor im Zell-Editor nur dann zurück an seine Stelle, sonst springt er an den Zellenanfang.
 */
export function forObsidianTables(view: EditorView, changes: { from: number; to: number; insert: string }[]) {
	const doc = view.state.doc;
	const lines = new Map<number, { from: number; to: number }>();
	for (const c of changes) {
		const line = doc.lineAt(c.from);
		if (c.to <= line.to && !lines.has(line.number) && DELIMITER.test(line.text) && line.text.includes("|")) lines.set(line.number, line);
	}
	const focused = focusInNested(view);
	if (!lines.size && !focused) return { changes };
	const set = ChangeSet.of(changes, doc.length);
	let out = changes;
	if (lines.size) {
		const after = set.apply(doc);
		const spans = [...lines.values()];
		out = changes.filter((c) => !spans.some((l) => c.from >= l.from && c.to <= l.to));
		for (const l of spans) out.push({ from: l.from, to: l.to, insert: after.sliceString(set.mapPos(l.from, -1), set.mapPos(l.to, 1)) });
	}
	return focused ? { changes: out, selection: view.state.selection.map(set) } : { changes: out };
}

/** (1) Auswahl auch dann senden, wenn in einer Tabellenzelle getippt oder navigiert wird. */
export const tableCursorSync = ViewPlugin.fromClass(
	class {
		update(u: ViewUpdate) {
			if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
			const conf = u.state.facet(ySyncFacet);
			if (!conf || !focusInNested(u.view)) return;
			const { awareness, ytext } = conf;
			const local = awareness.getLocalState();
			if (!local) return;
			const sel = u.state.selection.main;
			const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
			const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
			const cur = local.cursor;
			if (
				cur &&
				Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.anchor), anchor) &&
				Y.compareRelativePositions(Y.createRelativePositionFromJSON(cur.head), head)
			)
				return;
			awareness.setLocalStateField("cursor", { anchor, head });
		}
	},
);

/** Bildschirmposition eines Zeichen-Offsets im gerenderten Zelleninhalt (für Formatierung nur ungefähr). */
function caretInRendered(el: HTMLElement, offset: number): DOMRect | null {
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
		last = n;
		if (offset <= n.length) return rangeRect(n, offset);
		offset -= n.length;
	}
	return last ? rangeRect(last, last.length) : null;
}

function rangeRect(node: Text, offset: number): DOMRect | null {
	const r = node.ownerDocument.createRange();
	r.setStart(node, offset);
	r.setEnd(node, offset);
	const rects = r.getClientRects();
	return rects.length ? rects[0] : r.getBoundingClientRect();
}

interface CaretPos {
	left: number;
	top: number;
	height: number;
}

/** Fensterkoordinaten des Cursors an `pos` innerhalb einer Zelle. */
function caretCoords(view: EditorView, table: ObsidianTable, pos: number): CaretPos | null {
	for (const row of table.rows) {
		for (const cell of row) {
			const o = cell.getAbsoluteOffsets();
			if (pos < o.start || pos > o.end) continue;
			const offset = Math.max(0, Math.min(pos, o.textEnd) - o.textStart);
			// Diese Zelle wird hier gerade selbst bearbeitet: Position im eingebetteten Editor ist exakt.
			const nestedDom = cell.el.querySelector<HTMLElement>(".cm-editor");
			const nested = nestedDom ? EditorView.findFromDOM(nestedDom) : null;
			if (nested && nested !== view) {
				const c = nested.coordsAtPos(Math.min(offset, nested.state.doc.length));
				if (c) return { left: c.left, top: c.top, height: c.bottom - c.top };
			}
			const content = cell.contentEl && cell.contentEl.isShown?.() !== false ? cell.contentEl : cell.el;
			const r = caretInRendered(content, offset);
			if (r && (r.height > 0 || r.width > 0)) return { left: r.left, top: r.top, height: r.height };
			// Leere Zelle: an den Anfang des Inhalts.
			const box = content.getBoundingClientRect();
			const lh = parseFloat(getComputedStyle(content).lineHeight) || 16;
			return { left: box.left, top: box.top + Math.max(0, (box.height - lh) / 2), height: lh };
		}
	}
	return null;
}

class TableCaret implements LayerMarker {
	constructor(
		readonly color: string,
		readonly name: string,
		readonly left: number,
		readonly top: number,
		readonly height: number,
	) {}

	draw() {
		const el = document.createElement("div");
		el.className = "tandem-table-caret cm-ySelectionCaret";
		const dot = el.appendChild(document.createElement("div"));
		dot.className = "cm-ySelectionCaretDot";
		const info = el.appendChild(document.createElement("div"));
		info.className = "cm-ySelectionInfo";
		this.adjust(el);
		return el;
	}

	update(el: HTMLElement, prev: LayerMarker) {
		if (!(prev instanceof TableCaret) || prev.name !== this.name || prev.color !== this.color) return false;
		this.adjust(el);
		return true;
	}

	private adjust(el: HTMLElement) {
		el.style.left = `${this.left}px`;
		el.style.top = `${this.top}px`;
		el.style.height = `${this.height}px`;
		el.style.backgroundColor = this.color;
		el.style.borderColor = this.color;
		el.querySelector(".cm-ySelectionInfo")!.textContent = this.name;
	}

	eq(o: LayerMarker): boolean {
		return o instanceof TableCaret && o.name === this.name && o.color === this.color && o.left === this.left && o.top === this.top && o.height === this.height;
	}
}

/** (2) Fremde Cursor in Tabellenzellen anzeigen. */
export const tableCarets = layer({
	above: true,
	class: "tandem-table-carets",
	// Jede Transaktion: auch reine Awareness-Meldungen von yRemoteSelections und Zell-Eingaben.
	update: (u) => u.transactions.length > 0 || u.focusChanged,
	markers(view) {
		const conf = view.state.facet(ySyncFacet);
		if (!conf) return [];
		const ytext = conf.ytext;
		const awareness = conf.awareness as Awareness;
		const ydoc = ytext.doc!;
		let tables: ObsidianTable[] | null = null;
		const out: TableCaret[] = [];
		const rect = view.scrollDOM.getBoundingClientRect();
		const baseLeft = rect.left - view.scrollDOM.scrollLeft * view.scaleX;
		const baseTop = rect.top - view.scrollDOM.scrollTop * view.scaleY;
		awareness.getStates().forEach((st: Record<string, any>, id: number) => {
			if (id === awareness.clientID || !st?.cursor?.head) return;
			const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(st.cursor.head), ydoc);
			if (!head || head.type !== ytext || head.index > view.state.doc.length) return;
			if (!view.state.doc.lineAt(head.index).text.includes("|")) return; // keine Tabellenzeile
			tables ??= tablesIn(view);
			const table = tables.find((t) => head.index > t.start && head.index <= t.end);
			if (!table) return;
			const c = caretCoords(view, table, head.index);
			if (!c) return;
			const { color = "#30bced", name = "Anonymous" } = st.user ?? {};
			out.push(new TableCaret(color, name, (c.left - baseLeft) / view.scaleX, (c.top - baseTop) / view.scaleY, c.height / view.scaleY));
		});
		return out;
	},
});

export const tableCaretsTheme = EditorView.baseTheme({
	".tandem-table-carets": { pointerEvents: "none" },
	".tandem-table-carets .tandem-table-caret": {
		position: "absolute",
		width: "2px",
		marginLeft: "-1px",
		display: "block",
		pointerEvents: "auto",
	},
});
