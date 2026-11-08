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
 * 2. Anzeigen: Dekorationen innerhalb eines ersetzten Bereichs (Tabellen-, Formel-, Callout-Widget …) sind
 *    unsichtbar. `hiddenCarets` zeichnet fremde Cursor deshalb als Ebene: in Tabellen exakt in der Zelle,
 *    in anderen Widgets als farbiger Rahmen um den ganzen Block.
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

/** Gerendertes Widget (Formel, Callout, Einbettung …), das die Stelle `pos` verdeckt. */
interface Cover {
	from: number;
	to: number;
	widget: unknown;
}

function coverAt(view: EditorView, pos: number): Cover | null {
	let found: Cover | null = null;
	for (const src of view.state.facet(EditorView.decorations)) {
		let set;
		try {
			set = typeof src === "function" ? src(view) : src;
		} catch {
			continue;
		}
		set?.between(pos, pos, (from, to, deco) => {
			const widget = deco.spec.widget;
			if (!widget || from === to) return;
			// Block-Widgets verschlucken auch Cursor an ihren Rändern, Inline-Widgets nur am Anfang.
			const inside = deco.spec.block ? pos >= from && pos <= to : pos >= from && pos < to;
			if (inside && (!found || to - from > found.to - found.from)) found = { from, to, widget };
		});
	}
	return found;
}

/** DOM-Element eines Widgets: Obsidians Widgets bringen `containerEl` mit, sonst über die Position suchen. */
function widgetDom(view: EditorView, cover: Cover): HTMLElement | null {
	const own = (cover.widget as { containerEl?: unknown }).containerEl;
	if (own instanceof HTMLElement && own.isConnected && view.contentDOM.contains(own)) return own;
	for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>('[contenteditable="false"]'))) {
		if (el.parentElement?.closest('[contenteditable="false"]')) continue;
		try {
			if (view.posAtDOM(el) === cover.from) return el;
		} catch {
			/* nicht im Dokument */
		}
	}
	return null;
}

interface Who {
	color: string;
	name: string;
}

/** Rahmen um ein Widget, in dem jemand mit dem Cursor steht; Namen als Schildchen darüber. */
class WidgetBox implements LayerMarker {
	constructor(
		readonly who: Who[],
		readonly left: number,
		readonly top: number,
		readonly width: number,
		readonly height: number,
	) {}

	draw() {
		const el = document.createElement("div");
		el.className = "tandem-widget-cursor";
		el.appendChild(document.createElement("div")).className = "tandem-widget-cursor-names";
		this.adjust(el);
		return el;
	}

	update(el: HTMLElement, prev: LayerMarker) {
		if (!(prev instanceof WidgetBox)) return false;
		this.adjust(el);
		return true;
	}

	private adjust(el: HTMLElement) {
		const c = this.who[0].color;
		Object.assign(el.style, {
			left: `${this.left}px`,
			top: `${this.top}px`,
			width: `${this.width}px`,
			height: `${this.height}px`,
			borderColor: c,
			backgroundColor: c + "1f",
		});
		const names = el.firstElementChild as HTMLElement;
		names.replaceChildren(
			...this.who.map((w) => {
				const n = document.createElement("span");
				n.className = "tandem-widget-cursor-name";
				n.textContent = w.name;
				n.style.backgroundColor = w.color;
				return n;
			}),
		);
	}

	eq(o: LayerMarker): boolean {
		return (
			o instanceof WidgetBox &&
			o.left === this.left &&
			o.top === this.top &&
			o.width === this.width &&
			o.height === this.height &&
			o.who.length === this.who.length &&
			o.who.every((w, i) => w.name === this.who[i].name && w.color === this.who[i].color)
		);
	}
}

/**
 * (2) Fremde Cursor in gerenderten Bereichen anzeigen: in Tabellen als Cursor in der Zelle,
 * in anderen Widgets (Formeln, Callouts, Einbettungen) als farbiger Rahmen um den ganzen Block.
 */
export const hiddenCarets = layer({
	above: true,
	class: "tandem-hidden-carets",
	// Jede Transaktion: auch reine Awareness-Meldungen von yRemoteSelections und Zell-Eingaben.
	update: (u) => u.transactions.length > 0 || u.focusChanged,
	markers(view) {
		const conf = view.state.facet(ySyncFacet);
		if (!conf) return [];
		const ytext = conf.ytext;
		const awareness = conf.awareness as Awareness;
		const ydoc = ytext.doc!;
		const out: LayerMarker[] = [];
		const boxes = new Map<HTMLElement, Who[]>();
		const rect = view.scrollDOM.getBoundingClientRect();
		const baseLeft = rect.left - view.scrollDOM.scrollLeft * view.scaleX;
		const baseTop = rect.top - view.scrollDOM.scrollTop * view.scaleY;
		awareness.getStates().forEach((st: Record<string, any>, id: number) => {
			if (id === awareness.clientID || !st?.cursor?.head) return;
			const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(st.cursor.head), ydoc);
			if (!head || head.type !== ytext || head.index > view.state.doc.length) return;
			const cover = coverAt(view, head.index);
			if (!cover) return;
			const { color = "#30bced", name = "Anonymous" } = st.user ?? {};
			if (isTable(cover.widget)) {
				const c = caretCoords(view, cover.widget, head.index);
				if (c) out.push(new TableCaret(color, name, (c.left - baseLeft) / view.scaleX, (c.top - baseTop) / view.scaleY, c.height / view.scaleY));
				return;
			}
			const el = widgetDom(view, cover);
			if (!el) return;
			const list = boxes.get(el) ?? [];
			list.push({ color, name });
			boxes.set(el, list);
		});
		for (const [el, who] of boxes) {
			const r = el.getBoundingClientRect();
			if (!r.width && !r.height) continue;
			who.sort((x, y) => x.name.localeCompare(y.name));
			out.push(new WidgetBox(who, (r.left - baseLeft) / view.scaleX, (r.top - baseTop) / view.scaleY, r.width / view.scaleX, r.height / view.scaleY));
		}
		return out;
	},
});

export const hiddenCaretsTheme = EditorView.baseTheme({
	".tandem-hidden-carets": { pointerEvents: "none" },
	".tandem-hidden-carets .tandem-table-caret": {
		position: "absolute",
		width: "2px",
		marginLeft: "-1px",
		display: "block",
		pointerEvents: "auto",
	},
	".tandem-hidden-carets .tandem-widget-cursor": {
		position: "absolute",
		boxSizing: "border-box",
		border: "2px solid",
		borderRadius: "4px",
	},
	".tandem-widget-cursor-names": {
		position: "absolute",
		top: "-1.35em",
		left: "-2px",
		display: "flex",
		gap: "2px",
		fontSize: ".75em",
		lineHeight: "normal",
		whiteSpace: "nowrap",
	},
	".tandem-widget-cursor-name": { color: "white", padding: "0 3px", borderRadius: "3px 3px 0 0" },
});
