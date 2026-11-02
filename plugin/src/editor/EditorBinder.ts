/**
 * Sucht alle offenen Markdown-Editoren und koppelt sie an das Doc ihrer Datei.
 * Wechselt ein Tab die Datei, wird entkoppelt und neu gekoppelt.
 */
import { MarkdownView, type App, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { DocManager } from "../docs/DocManager";
import type { DocSession } from "../docs/DocSession";
import { bindEditor, filePathOf, unbindEditor } from "./collab";

interface Binding {
	path: string;
	docId: string;
	session: DocSession;
}

export interface BinderDeps {
	app: App;
	docs: DocManager;
	docIdFor(file: TFile): string | undefined;
	/** Vor dem Koppeln: Datei → Doc (offline entstandene Änderungen übernehmen). */
	prepare(docId: string): Promise<void>;
	localUser(): { id: string; name: string; color: string };
	readOnly(): boolean;
	onBound?(path: string, docId: string, session: DocSession): void;
	onUnbound?(path: string, docId: string): void;
}

export class EditorBinder {
	private bound = new Map<EditorView, Binding>();
	private pending = new Map<EditorView, string>();
	private boundPaths = new Map<string, number>();

	constructor(private d: BinderDeps) {}

	isBound(path: string) {
		return (this.boundPaths.get(path) ?? 0) > 0;
	}

	sessionFor(path: string): DocSession | undefined {
		for (const b of this.bound.values()) if (b.path === path) return b.session;
		return undefined;
	}

	views(): { view: EditorView; path: string; session: DocSession }[] {
		return [...this.bound].map(([view, b]) => ({ view, path: b.path, session: b.session }));
	}

	/** Bei jedem Layout-/Dateiwechsel aufrufen. */
	refresh() {
		const seen = new Set<EditorView>();
		for (const leaf of this.d.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;
			// @ts-expect-error – Obsidian stellt den CM6-EditorView als `cm` bereit (nicht offiziell typisiert).
			const cm = view.editor?.cm as EditorView | undefined;
			if (!cm) continue;
			seen.add(cm);
			const file = view.file;
			// Gelöschte Datei, Tab zeigt sie noch: entkoppeln.
			const docId = this.d.app.vault.getFileByPath(file.path) ? this.d.docIdFor(file) : undefined;
			const b = this.bound.get(cm);
			if (b && (b.path !== file.path || b.docId !== docId)) this.unbind(cm);
			if (!docId || this.bound.has(cm) || this.pending.get(cm) === file.path) continue;
			void this.bind(cm, file, docId);
		}
		for (const cm of [...this.bound.keys()]) if (!seen.has(cm)) this.unbind(cm);
	}

	private async bind(cm: EditorView, file: TFile, docId: string) {
		this.pending.set(cm, file.path);
		try {
			await this.d.prepare(docId);
			const session = await this.d.docs.acquire(docId, { awareness: true });
			// Inzwischen eine andere Datei im Tab, oder schon gekoppelt?
			if (this.pending.get(cm) !== file.path || filePathOf(cm.state) !== file.path || this.bound.has(cm)) {
				this.d.docs.release(docId);
				return;
			}
			const u = this.d.localUser();
			session.awareness!.setLocalStateField("user", { id: u.id, name: u.name, color: u.color, colorLight: u.color + "33" });
			const ytext = session.doc.getText("content");
			bindEditor(cm, file.path, ytext, session.awareness!, this.d.readOnly());
			this.bound.set(cm, { path: file.path, docId, session });
			this.boundPaths.set(file.path, (this.boundPaths.get(file.path) ?? 0) + 1);
			this.d.onBound?.(file.path, docId, session);
		} catch (e) {
			console.warn("[tandem] Koppeln fehlgeschlagen", file.path, e);
		} finally {
			if (this.pending.get(cm) === file.path) this.pending.delete(cm);
		}
	}

	private unbind(cm: EditorView) {
		const b = this.bound.get(cm);
		if (!b) return;
		this.bound.delete(cm);
		unbindEditor(cm);
		const n = (this.boundPaths.get(b.path) ?? 1) - 1;
		if (n <= 0) this.boundPaths.delete(b.path);
		else this.boundPaths.set(b.path, n);
		this.d.docs.release(b.docId);
		this.d.onUnbound?.(b.path, b.docId);
	}

	/** Pfad hat sich geändert (Umbenennen): Bindungen nachziehen. */
	renamed(oldPath: string, newPath: string) {
		for (const b of this.bound.values()) if (b.path === oldPath) b.path = newPath;
		const n = this.boundPaths.get(oldPath);
		if (n) {
			this.boundPaths.delete(oldPath);
			this.boundPaths.set(newPath, n);
		}
		// Der Wächter im Sync-Plugin kennt den alten Pfad → neu koppeln.
		for (const [cm, b] of [...this.bound]) if (b.path === newPath) this.unbind(cm);
		this.refresh();
	}

	destroy() {
		for (const cm of [...this.bound.keys()]) this.unbind(cm);
	}
}
