/**
 * Blame-Spalte im Editor: links neben jeder Zeile, wer sie zuletzt geändert hat und wann (wie `git blame`).
 * Farbiger Balken in der Farbe der Person; Name + Zeit nur in der ersten Zeile eines zusammenhängenden Blocks.
 * Überfahren zeigt Gerät, genaue Zeit und weitere Beteiligte.
 *
 * Funktioniert nur in Editoren, die an ein Tandem-Doc gekoppelt sind (ySyncFacet gesetzt).
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { ySyncFacet, type YSyncConfig } from "y-codemirror.next";
import type * as Y from "yjs";
import { AUTHORS_KEY, AuthorLookup, blameLines, formatTime, MARKS_KEY, relativeTime, Source, textRuns, type Author, type LineBlame } from "./authorship";

export interface BlameContext {
	/** Eigene Person (für die eigene clientID, bevor sie im Doc steht) */
	me(): Author | null;
}

const setBlame = StateEffect.define<RangeSet<GutterMarker>>();

const blameField = StateField.define<RangeSet<GutterMarker>>({
	create: () => RangeSet.empty,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setBlame)) return e.value;
		return tr.docChanged ? value.map(tr.changes) : value;
	},
});

class BlameMarker extends GutterMarker {
	constructor(
		readonly b: LineBlame,
		readonly first: boolean,
		readonly label: string,
	) {
		super();
	}
	eq(o: BlameMarker) {
		return o.first === this.first && o.label === this.label && o.b.who.key === this.b.who.key && o.b.others.length === this.b.others.length && o.title() === this.title();
	}
	title() {
		const { who, others, unknown } = this.b;
		const a = who.author;
		const parts = [a ? `${a.name}${a.device ? ` (${a.device})` : ""}` : "Unbekannt (vor Blame bzw. älteres Plugin)"];
		if (who.ts !== null) parts.push(formatTime(who.ts));
		if (who.src === Source.File) parts.push("Datei von außen geändert (z. B. Claude Code, git, Ink Blocks)");
		if (others.length) parts.push(`auch: ${others.map((o) => o.name).join(", ")}`);
		if (unknown > 0 && a) parts.push(`${Math.round(unknown * 100)} % unbekannter Herkunft`);
		return parts.join("\n");
	}
	toDOM() {
		const el = document.createElement("div");
		el.className = "tandem-blame-line" + (this.first ? " is-first" : "") + (this.b.who.author ? "" : " is-unknown");
		if (this.b.who.author) el.style.setProperty("--tandem-blame-color", this.b.who.author.color);
		// Folgezeilen: leer, aber mit Höhe (sonst fehlt der Farbbalken)
		el.textContent = this.first ? this.label : "\u00a0";
		el.title = this.title();
		return el;
	}
}

function firstName(a: Author) {
	return a.name.trim().split(/\s+/)[0] || a.name;
}

function buildMarkers(view: EditorView, ytext: Y.Text, ctx: BlameContext, awareness: YSyncConfig["awareness"]): RangeSet<GutterMarker> {
	const doc = ytext.doc!;
	const own = doc.clientID;
	const lookup = new AuthorLookup(doc, (client) => {
		if (client === own) return ctx.me() ?? undefined;
		// Gerade verbundene Personen (auch mit älterem Plugin) über ihre Präsenz erkennen
		const st = awareness?.getStates().get(client) as { user?: Author } | undefined;
		return st?.user?.id ? { id: st.user.id, name: st.user.name, color: st.user.color } : undefined;
	});
	const lines = blameLines(ytext.toString(), textRuns(ytext), lookup);
	const now = Date.now();
	const markers = [];
	let prevKey = "";
	let prevLine = -1;
	const total = view.state.doc.lines;
	for (const b of lines) {
		if (b.line > total) break;
		const key = b.who.author ? `${b.who.author.id}|${b.who.key}` : "?";
		const first = key !== prevKey || b.line !== prevLine + 1;
		prevKey = key;
		prevLine = b.line;
		const a = b.who.author;
		const label = a ? `${firstName(a)}${b.who.ts !== null ? ` · ${relativeTime(b.who.ts, now)}` : ""}` : "?";
		markers.push(new BlameMarker(b, first, label).range(view.state.doc.line(b.line).from));
	}
	return RangeSet.of(markers);
}

const RECOMPUTE_MS = 300;

function blamePlugin(ctx: BlameContext) {
	return ViewPlugin.fromClass(
		class implements PluginValue {
			conf: YSyncConfig | undefined;
			timer: number | null = null;
			tick: number;
			unhook: (() => void) | null = null;

			constructor(readonly view: EditorView) {
				this.hook(view.state.facet(ySyncFacet));
				// Relative Zeiten („vor 2 Min.“) aktuell halten
				this.tick = window.setInterval(() => this.schedule(), 60_000);
			}

			hook(conf: YSyncConfig | undefined) {
				this.unhook?.();
				this.unhook = null;
				this.conf = conf;
				if (!conf) {
					this.schedule();
					return;
				}
				const doc = conf.ytext.doc!;
				const authors = doc.getMap(AUTHORS_KEY);
				const marks = doc.getArray(MARKS_KEY);
				const on = () => this.schedule();
				conf.ytext.observe(on);
				authors.observe(on);
				marks.observe(on);
				conf.awareness?.on("change", on);
				this.unhook = () => {
					conf.ytext.unobserve(on);
					authors.unobserve(on);
					marks.unobserve(on);
					conf.awareness?.off("change", on);
				};
				this.schedule(0);
			}

			update(u: ViewUpdate) {
				const conf = u.state.facet(ySyncFacet);
				if (conf !== this.conf) this.hook(conf);
			}

			schedule(ms = RECOMPUTE_MS) {
				if (this.timer !== null) return;
				this.timer = window.setTimeout(() => {
					this.timer = null;
					this.recompute();
				}, ms);
			}

			recompute() {
				const conf = this.conf;
				if (!conf) {
					if (this.view.state.field(blameField).size) this.view.dispatch({ effects: setBlame.of(RangeSet.empty) });
					return;
				}
				// Editor und Y.Text müssen übereinstimmen (sonst passen die Zeilen nicht) → kurz danach erneut
				if (this.view.state.doc.length !== conf.ytext.length) {
					this.schedule();
					return;
				}
				try {
					this.view.dispatch({ effects: setBlame.of(buildMarkers(this.view, conf.ytext, ctx, conf.awareness)) });
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

/** Hält die Spalte breit, solange der Editor gekoppelt ist – sonst fällt sie ganz weg. */
class Spacer extends GutterMarker {
	constructor(readonly wide: boolean) {
		super();
	}
	eq(o: Spacer) {
		return o.wide === this.wide;
	}
	toDOM() {
		const el = document.createElement("div");
		el.className = this.wide ? "tandem-blame-line tandem-blame-spacer" : "";
		return el;
	}
}
const WIDE = new Spacer(true);
const NARROW = new Spacer(false);
const spacerFor = (v: { state: EditorView["state"] }) => (v.state.facet(ySyncFacet) ? WIDE : NARROW);

export function blameExtension(ctx: BlameContext): Extension {
	return [
		blameField,
		blamePlugin(ctx),
		gutter({
			class: "tandem-blame",
			markers: (v) => v.state.field(blameField),
			initialSpacer: spacerFor,
			updateSpacer: (_s, u) => spacerFor(u),
		}),
	];
}
