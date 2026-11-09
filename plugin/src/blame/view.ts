/**
 * Blame im Editor – ohne dem Text Platz wegzunehmen:
 *
 * - Eine eigene CodeMirror-Ebene (`layer`) zeichnet links neben jedem Block zusammenhängender Zeilen derselben
 *   Änderung einen schmalen Balken in der Farbe der Person. Der Text verschiebt sich nicht.
 * - Ist links genug freier Rand (lesbare Zeilenbreite), steht dort „Name · vor 3 Std.“ (bzw. nur der Name).
 * - Ist der Rand zu schmal (Handy, schmales Fenster), steht die Angabe zur Zeile mit dem Cursor dezent am
 *   Zeilenende (wie GitLens) – außer es ist gerade die eigene, frische Änderung.
 * - Überfahren von Balken/Name zeigt Gerät, genaue Zeit, weitere Beteiligte.
 *
 * Rechenaufwand: Die Zuordnung (AuthorLookup) wird nur neu gebaut, wenn sich die Autoren-Angaben ändern; die
 * Zeilen werden nach einer Tipppause (bzw. spätestens alle 2 s) neu bestimmt. Dazwischen wandern die Einträge
 * mit den Änderungen mit (RangeSet.map). Gezeichnet wird nur der sichtbare Bereich.
 */
import { RangeSet, RangeValue, StateEffect, StateField, type Extension } from "@codemirror/state";
import { BlockType, Decoration, EditorView, layer, ViewPlugin, WidgetType, type DecorationSet, type LayerMarker, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { setTooltip } from "obsidian";
import { ySyncFacet, type YSyncConfig } from "y-codemirror.next";
import { AuthorLookup, blameLines, describe, relativeTime, textRuns, type Author, type LineBlame } from "./authorship";

export interface BlameContext {
	/** Eigene Person (für die eigene clientID, bevor sie im Doc steht; „Du“ in der Anzeige) */
	me(): Author | null;
}

class LineInfo extends RangeValue {
	constructor(
		readonly b: LineBlame,
		/** Kennung des Blocks (gleiche Person + gleiche Änderung) */
		readonly group: string,
	) {
		super();
	}
	eq(o: LineInfo) {
		return o.b === this.b;
	}
}

const setBlame = StateEffect.define<RangeSet<LineInfo>>();

const blameField = StateField.define<RangeSet<LineInfo>>({
	create: () => RangeSet.empty,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setBlame)) return e.value;
		return tr.docChanged ? value.map(tr.changes) : value;
	},
});

const IDLE_MS = 350;
const MAX_WAIT_MS = 2000;

function groupKey(b: LineBlame) {
	return b.who.author ? `${b.who.author.id}|${b.who.key}` : "?";
}

/** Rechnet die Zuordnung und hält sie aktuell. */
function controller(ctx: BlameContext) {
	return ViewPlugin.fromClass(
		class implements PluginValue {
			conf: YSyncConfig | undefined;
			lookup: AuthorLookup | null = null;
			timer: number | null = null;
			firstPending = 0;
			tick: number;
			unhook: (() => void) | null = null;

			constructor(readonly view: EditorView) {
				this.hook(view.state.facet(ySyncFacet));
				// Relative Zeiten („vor 2 Min.“) aktuell halten – billig, Zuordnung bleibt im Zwischenspeicher
				this.tick = window.setInterval(() => this.schedule(0), 60_000);
			}

			hook(conf: YSyncConfig | undefined) {
				this.unhook?.();
				this.unhook = null;
				this.conf = conf;
				this.lookup = null;
				if (!conf) {
					this.schedule(0);
					return;
				}
				const doc = conf.ytext.doc!;
				const onText = () => this.schedule();
				const onMeta = () => {
					this.lookup = null;
					this.schedule();
				};
				conf.ytext.observe(onText);
				const offMeta = AuthorLookup.watch(doc, onMeta);
				conf.awareness?.on("change", onMeta);
				this.unhook = () => {
					conf.ytext.unobserve(onText);
					offMeta();
					conf.awareness?.off("change", onMeta);
				};
				this.schedule(0);
			}

			update(u: ViewUpdate) {
				const conf = u.state.facet(ySyncFacet);
				if (conf !== this.conf) this.hook(conf);
			}

			/** Nach einer Pause neu rechnen, beim Dauertippen aber spätestens alle MAX_WAIT_MS. */
			schedule(ms = IDLE_MS) {
				const now = Date.now();
				if (this.timer !== null) {
					window.clearTimeout(this.timer);
					if (now - this.firstPending >= MAX_WAIT_MS) ms = 0;
				} else this.firstPending = now;
				this.timer = window.setTimeout(() => {
					this.timer = null;
					this.recompute();
				}, ms);
			}

			getLookup(conf: YSyncConfig) {
				if (this.lookup) return this.lookup;
				const doc = conf.ytext.doc!;
				const own = doc.clientID;
				this.lookup = new AuthorLookup(doc, (client) => {
					if (client === own) return ctx.me() ?? undefined;
					// Gerade verbundene Personen (auch mit älterem Plugin) über ihre Präsenz erkennen
					const st = conf.awareness?.getStates().get(client) as { user?: Author; device?: string } | undefined;
					return st?.user?.id ? { id: st.user.id, name: st.user.name, color: st.user.color } : undefined;
				});
				return this.lookup;
			}

			recompute() {
				const conf = this.conf;
				const cur = this.view.state.field(blameField);
				if (!conf) {
					if (cur.size) this.view.dispatch({ effects: setBlame.of(RangeSet.empty) });
					return;
				}
				const doc = this.view.state.doc;
				// Editor und Y.Text müssen übereinstimmen (sonst passen die Zeilen nicht) → kurz danach erneut
				if (doc.length !== conf.ytext.length) {
					this.schedule();
					return;
				}
				try {
					const lines: [number, number][] = new Array(doc.lines);
					let pos = 0;
					let i = 0;
					for (const iter = doc.iterLines(); !iter.next().done; i++) {
						lines[i] = [pos, pos + iter.value.length];
						pos += iter.value.length + 1;
					}
					const blamed = blameLines(lines, textRuns(conf.ytext), this.getLookup(conf));
					const ranges = blamed.map((b) => new LineInfo(b, groupKey(b)).range(lines[b.index][0]));
					this.view.dispatch({ effects: setBlame.of(RangeSet.of(ranges)) });
				} catch (e) {
					console.warn("[tandem] Blame", e);
				}
			}

			destroy() {
				this.unhook?.();
				if (this.timer !== null) window.clearTimeout(this.timer);
				window.clearInterval(this.tick);
			}
		},
	);
}

// ── Zeichnen ───────────────────────────────────────────────────────────

type Mode = "full" | "name" | "bar";

class BlockMarker implements LayerMarker {
	constructor(
		readonly left: number,
		readonly top: number,
		readonly height: number,
		readonly color: string | null,
		readonly label: string,
		readonly tip: string,
		readonly maxLabel: number,
		/** Abstand der ersten Textzeile vom Blockanfang (Überschriften haben Innenabstand) */
		readonly labelTop: number,
	) {}
	eq(o: BlockMarker) {
		return o.maxLabel === this.maxLabel && o.labelTop === this.labelTop && o.left === this.left && o.top === this.top && o.height === this.height && o.color === this.color && o.label === this.label && o.tip === this.tip;
	}
	draw() {
		const el = document.createElement("div");
		el.className = "tandem-blame-block" + (this.color ? "" : " is-unknown");
		this.place(el);
		el.createDiv({ cls: "tandem-blame-bar" });
		if (this.label) {
			const l = el.createDiv({ cls: "tandem-blame-label", text: this.label });
			l.style.maxWidth = `${this.maxLabel}px`;
			l.style.top = `${this.labelTop}px`;
		}
		setTooltip(el, this.tip, { placement: "left" });
		return el;
	}
	update(el: HTMLElement, prev: BlockMarker) {
		if (prev.color !== this.color || prev.label !== this.label || prev.tip !== this.tip || prev.maxLabel !== this.maxLabel || prev.labelTop !== this.labelTop) return false;
		this.place(el);
		return true;
	}
	private place(el: HTMLElement) {
		el.style.left = `${this.left}px`;
		el.style.top = `${this.top}px`;
		el.style.height = `${this.height}px`;
		if (this.color) el.style.setProperty("--tandem-blame-color", this.color);
	}
}

function labelFor(b: LineBlame, mode: Mode, you: string | undefined, now: number): string {
	const a = b.who.author;
	if (!a || mode === "bar") return "";
	const name = a.id === you ? "Du" : a.name.trim().split(/\s+/)[0] || a.name;
	if (mode === "name" || b.who.ts === null) return name;
	return `${name} · ${relativeTime(b.who.ts, now).replace(/^vor /, "")}`;
}

/** Gemessener Modus je Editor (für die Zeilenend-Angabe). */
const modes = new WeakMap<EditorView, Mode>();

function blameLayer(ctx: BlameContext) {
	return layer({
		above: true,
		class: "tandem-blame-layer",
		update: (u) => u.docChanged || u.viewportChanged || u.geometryChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setBlame))),
		markers(view) {
			const field = view.state.field(blameField, false);
			if (!field?.size) return [];
			const scroller = view.scrollDOM.getBoundingClientRect();
			const content = view.contentDOM.getBoundingClientRect();
			const padLeft = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
			const baseLeft = scroller.left - view.scrollDOM.scrollLeft;
			const baseTop = scroller.top - view.scrollDOM.scrollTop;
			const textLeft = content.left + padLeft;
			const margin = textLeft - scroller.left;
			const mode: Mode = margin >= 108 ? "full" : margin >= 72 ? "name" : "bar";
			if (modes.get(view) !== mode) {
				modes.set(view, mode);
				view.dom.classList.toggle("tandem-blame-narrow", mode === "bar");
			}
			// Balken knapp links vom Text
			const x = textLeft - baseLeft - Math.min(10, Math.max(4, margin - 4));
			const you = ctx.me()?.id;
			const now = Date.now();
			const out: BlockMarker[] = [];
			const doc = view.state.doc;
			const { from: vFrom, to: vTo } = view.viewport;
			// Block, der oberhalb des sichtbaren Bereichs beginnt, bekommt sein Schild in der ersten sichtbaren Zeile
			let cur: { info: LineInfo; firstPos: number; lastPos: number; lastLine: number } | null = null;
			const flush = () => {
				if (!cur) return;
				// Ink-Blöcke zeigen ihr eigenes Blame (Striche) – die Verweiszeile im Codeblock hier nicht
				if (/^\s*(```|~~~)\s*ink\b/.test(doc.lineAt(cur.firstPos).text)) {
					cur = null;
					return;
				}
				const top = view.lineBlockAt(cur.firstPos);
				const bottom = view.lineBlockAt(cur.lastPos);
				const b = cur.info.b;
				// Schild auf Höhe der ersten Textzeile (Grundlinie), nicht am Rand des Blocks
				const first = view.coordsAtPos(cur.firstPos, 1);
				const lineH = view.defaultLineHeight;
				const labelTop = first && top.type === BlockType.Text ? Math.max(0, first.bottom - (view.documentTop + top.top) - lineH) : 0;
				out.push(
					new BlockMarker(
						x,
						view.documentTop + top.top - baseTop,
						Math.max(4, bottom.bottom - top.top),
						b.who.author?.color ?? null,
						labelFor(b, mode, you, now),
						describe(b.who, b.others, b.unknown, you),
						Math.max(0, Math.min(180, margin - 24)),
						Math.round(labelTop),
					),
				);
				cur = null;
			};
			field.between(vFrom, vTo, (pos, _to, info) => {
				const line = doc.lineAt(pos).number;
				if (cur && cur.info.group === info.group && line === cur.lastLine + 1) {
					cur.lastPos = pos;
					cur.lastLine = line;
					return;
				}
				flush();
				cur = { info, firstPos: pos, lastPos: pos, lastLine: line };
			});
			flush();
			return out;
		},
	});
}

// ── Zeilenende (schmale Ansicht) ───────────────────────────────────────

class InlineWidget extends WidgetType {
	constructor(
		readonly text: string,
		readonly tip: string,
	) {
		super();
	}
	eq(o: InlineWidget) {
		return o.text === this.text && o.tip === this.tip;
	}
	toDOM() {
		const el = document.createElement("span");
		el.className = "tandem-blame-inline";
		el.textContent = this.text;
		setTooltip(el, this.tip);
		return el;
	}
	ignoreEvent() {
		return true;
	}
}

function inlineAnnotation(ctx: BlameContext) {
	return ViewPlugin.fromClass(
		class implements PluginValue {
			decorations: DecorationSet = Decoration.none;
			constructor(readonly view: EditorView) {
				this.decorations = this.build();
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setBlame)))) this.decorations = this.build();
			}
			build(): DecorationSet {
				const { state } = this.view;
				const field = state.field(blameField, false);
				if (!field?.size || state.selection.ranges.length !== 1) return Decoration.none;
				const line = state.doc.lineAt(state.selection.main.head);
				let info: LineInfo | null = null;
				field.between(line.from, line.from, (pos, _to, v) => {
					if (pos === line.from) info = v;
				});
				const b = (info as LineInfo | null)?.b;
				if (!b?.who.author) return Decoration.none;
				const me = ctx.me();
				const a = b.who.author;
				const ts = b.who.ts;
				// Eigene, frische Änderung: nichts anzeigen (würde beim Tippen nur mitlaufen)
				if (a.id === me?.id && (ts === null || Date.now() - ts < 5 * 60_000)) return Decoration.none;
				const text = `${a.id === me?.id ? "Du" : a.name}${ts !== null ? `, ${relativeTime(ts)}` : ""}`;
				return Decoration.set([Decoration.widget({ widget: new InlineWidget(text, describe(b.who, b.others, b.unknown, me?.id)), side: 1 }).range(line.to)]);
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

export function blameExtension(ctx: BlameContext): Extension {
	return [blameField, controller(ctx), blameLayer(ctx), inlineAnnotation(ctx)];
}
