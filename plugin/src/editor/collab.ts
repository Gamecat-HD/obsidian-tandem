/**
 * Bindet Obsidians CodeMirror-6-Editoren an Y.Text.
 * Eine Compartment-Erweiterung wird bei allen Editoren registriert und pro Editor umkonfiguriert.
 *
 * Eigene Sync-Erweiterung statt `ySync` aus y-codemirror.next. Sie hat einen **Pfad-Wächter**:
 * Obsidian verwendet denselben Editor für die nächste Datei im selben Tab weiter. Lädt Obsidian dort
 * eine andere Datei, darf deren Inhalt nie in das Y.Text der vorigen Notiz gelangen.
 * Remote-Cursor/Markierungen kommen aus y-codemirror.next (yRemoteSelections).
 *
 * Undo: Obsidians eigener Verlauf bleibt aktiv; Änderungen anderer werden aber nicht aufgezeichnet
 * (addToHistory=false), sodass Strg+Z nur die eigenen Änderungen rückgängig macht.
 */
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { yRemoteSelections, yRemoteSelectionsTheme, ySyncAnnotation, ySyncFacet, YSyncConfig } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { textChanges } from "../disk/diff";

export const collabCompartment = new Compartment();

const remoteOutOfHistory = EditorState.transactionExtender.of((tr) =>
	tr.annotation(ySyncAnnotation) !== undefined ? { annotations: Transaction.addToHistory.of(false) } : null,
);

/** Einmal per `registerEditorExtension` registrieren. */
export function collabBaseExtension(): Extension {
	return [collabCompartment.of([]), remoteOutOfHistory];
}

export function filePathOf(state: EditorState): string | undefined {
	return state.field(editorInfoField, false)?.file?.path;
}

function syncPlugin(path: string) {
	return ViewPlugin.fromClass(
		class implements PluginValue {
			conf: YSyncConfig;
			ytext: Y.Text;
			observer: (e: Y.YTextEvent, tr: Y.Transaction) => void;
			constructor(readonly view: EditorView) {
				this.conf = view.state.facet(ySyncFacet);
				this.ytext = this.conf.ytext;
				this.observer = (event, tr) => {
					if (tr.origin === this.conf) return;
					if (filePathOf(this.view.state) !== path) return;
					const changes: { from: number; to: number; insert: string }[] = [];
					let pos = 0;
					for (const d of event.delta) {
						if (d.insert != null) changes.push({ from: pos, to: pos, insert: d.insert as string });
						else if (d.delete != null) {
							changes.push({ from: pos, to: pos + d.delete, insert: "" });
							pos += d.delete;
						} else pos += d.retain ?? 0;
					}
					this.view.dispatch({ changes, annotations: [ySyncAnnotation.of(this.conf)] });
				};
				this.ytext.observe(this.observer);
			}
			update(update: ViewUpdate) {
				if (!update.docChanged) return;
				if (update.transactions.some((t) => t.annotation(ySyncAnnotation) === this.conf)) return;
				// Wächter: Editor zeigt inzwischen eine andere Datei → nichts übernehmen.
				if (filePathOf(update.state) !== path || filePathOf(update.startState) !== path) return;
				const ytext = this.ytext;
				ytext.doc!.transact(() => {
					let adj = 0;
					update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
						const text = insert.sliceString(0, insert.length, "\n");
						if (fromA !== toA) ytext.delete(fromA + adj, toA - fromA);
						if (text.length > 0) ytext.insert(fromA + adj, text);
						adj += text.length - (toA - fromA);
					});
				}, this.conf);
			}
			destroy() {
				this.ytext.unobserve(this.observer);
			}
		},
	);
}

/**
 * Editor auf den Stand von `ytext` bringen und koppeln.
 * Erwartet, dass lokale, noch nicht übernommene Änderungen vorher ins Y.Text gelangt sind.
 */
export function bindEditor(view: EditorView, path: string, ytext: Y.Text, awareness: Awareness, readOnly = false) {
	const cur = view.state.doc.toString();
	const target = ytext.toString();
	if (cur !== target) {
		view.dispatch({ changes: textChanges(cur, target), annotations: [Transaction.addToHistory.of(false)] });
	}
	const conf = new YSyncConfig(ytext, awareness);
	view.dispatch({
		effects: collabCompartment.reconfigure([
			ySyncFacet.of(conf),
			syncPlugin(path),
			yRemoteSelectionsTheme,
			yRemoteSelections,
			// Nur-Lese-Mitglieder sehen live mit, können aber nicht tippen.
			readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
		]),
	});
}

export function unbindEditor(view: EditorView) {
	try {
		view.dispatch({ effects: collabCompartment.reconfigure([]) });
	} catch {
		/* Editor schon zerstört */
	}
}
