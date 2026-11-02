/**
 * Versionsgeschichte: Snapshots einer Notiz vom Server holen, ansehen und wiederherstellen.
 * Wiederherstellen ist eine normale Änderung (per Diff ins Doc) – sie lässt sich selbst wieder rückgängig
 * machen und erreicht alle anderen live.
 */
import { App, Modal, Notice, requestUrl, Setting } from "obsidian";
import * as Y from "yjs";
import type { SpaceSync } from "../sync/SpaceSync";
import { applyTextDiff, textChanges } from "../disk/diff";
import { applyInkFile, encodeInkDoc } from "../ink/inkDoc";

export interface Snapshot {
	ts: number;
	size: number;
}

export async function listSnapshots(http: { base: string; token: string }, space: string, docId: string): Promise<Snapshot[]> {
	const r = await requestUrl({
		url: `${http.base}/api/history/${encodeURIComponent(space)}/${encodeURIComponent(docId)}`,
		headers: { Authorization: `Bearer ${http.token}` },
		throw: false,
	});
	if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
	return r.json as Snapshot[];
}

export async function loadSnapshot(http: { base: string; token: string }, space: string, docId: string, ts: number): Promise<Y.Doc> {
	const r = await requestUrl({
		url: `${http.base}/api/history/${encodeURIComponent(space)}/${encodeURIComponent(docId)}/${ts}`,
		headers: { Authorization: `Bearer ${http.token}` },
		throw: false,
	});
	if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(r.arrayBuffer));
	return doc;
}

/** Inhalt eines Snapshots in die aktuelle Fassung übernehmen. */
export async function restoreSnapshot(sync: SpaceSync, docId: string, snap: Y.Doc): Promise<void> {
	const entry = sync.index.get(docId);
	if (!entry) throw new Error("Datei nicht mehr im Index");
	// Offene Notiz: über den Editor anwenden → landet in Obsidians Undo-Verlauf (Strg+Z holt den alten Stand zurück)
	const open = entry.kind === "md" ? sync.binder.views().find((v) => v.path === entry.path) : undefined;
	if (open) {
		const cur = open.view.state.doc.toString();
		const target = snap.getText("content").toString();
		if (cur !== target) open.view.dispatch({ changes: textChanges(cur, target), userEvent: "input.restore" });
		return;
	}
	await sync.docs.withDoc(docId, (s) => {
		if (entry.kind === "ink") {
			const target = encodeInkDoc(snap);
			const cur = encodeInkDoc(s.doc);
			if (target && cur) applyInkFile(s.doc, target, cur);
		} else {
			const t = s.doc.getText("content");
			applyTextDiff(t, t.toString(), snap.getText("content").toString());
		}
	});
	// Geschlossene Datei: auf die Platte bringen (offene aktualisiert der Editor selbst)
	await sync.bridge.reconcile(docId);
}

export class HistoryModal extends Modal {
	private preview!: HTMLElement;
	constructor(
		app: App,
		readonly sync: SpaceSync,
		readonly http: { base: string; token: string },
		readonly space: string,
		readonly docId: string,
		readonly path: string,
	) {
		super(app);
	}

	async onOpen() {
		const { contentEl } = this;
		this.setTitle(`Versionsgeschichte: ${this.path}`);
		contentEl.addClass("tandem-history");
		const list = contentEl.createDiv({ cls: "tandem-history-list", text: "Lade …" });
		this.preview = contentEl.createEl("pre", { cls: "tandem-history-preview" });
		let snaps: Snapshot[];
		try {
			snaps = await listSnapshots(this.http, this.space, this.docId);
		} catch (e) {
			list.setText(`Fehler: ${(e as Error).message}`);
			return;
		}
		list.empty();
		if (!snaps.length) {
			list.setText("Noch keine gespeicherten Fassungen. Der Server legt höchstens stündlich eine an, sobald sich etwas geändert hat.");
			return;
		}
		for (const s of snaps) {
			const when = new Date(s.ts * 1000).toLocaleString("de-DE");
			new Setting(list)
				.setName(when)
				.setDesc(`${(s.size / 1024).toFixed(1)} KiB`)
				.addButton((b) => b.setButtonText("Ansehen").onClick(() => void this.show(s.ts)))
				.addButton((b) =>
					b
						.setButtonText("Wiederherstellen")
						.setCta()
						.onClick(async () => {
							try {
								const doc = await loadSnapshot(this.http, this.space, this.docId, s.ts);
								await restoreSnapshot(this.sync, this.docId, doc);
								new Notice(`Tandem: Fassung vom ${when} wiederhergestellt (rückgängig machbar).`);
								this.close();
							} catch (e) {
								new Notice(`Tandem: Wiederherstellen fehlgeschlagen – ${(e as Error).message}`);
							}
						}),
				);
		}
	}

	private async show(ts: number) {
		try {
			const doc = await loadSnapshot(this.http, this.space, this.docId, ts);
			const entry = this.sync.index.get(this.docId);
			const text = entry?.kind === "ink" ? `Handschrift-Fläche mit ${doc.getMap("strokes").size} Strichen` : doc.getText("content").toString();
			this.preview.setText(text.length > 20000 ? text.slice(0, 20000) + "\n…" : text);
		} catch (e) {
			this.preview.setText(`Fehler: ${(e as Error).message}`);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
