/**
 * Präsenz: wer ist online und in welcher Notiz (Awareness auf dem Index-Doc).
 * Anzeige: Punkte im Dateibaum, Avatare in der Kopfzeile offener Notizen, Liste + „Folgen“.
 */
import { MarkdownView, type App } from "obsidian";
import type { Awareness } from "y-protocols/awareness";

export interface Peer {
	clientId: number;
	user: { id: string; name: string; color: string };
	path?: string;
	device?: string;
	/** Tippt gerade (letzte Eingabe vor < TYPING_MS). */
	typing: boolean;
}

export const TYPING_MS = 4000;

export class Presence {
	private listeners = new Set<(peers: Peer[]) => void>();
	private styleEl: HTMLStyleElement;
	private headerEls = new Map<HTMLElement, HTMLElement>();
	private lastTouch = 0;
	private typingTimer: number | null = null;
	private refreshTimer: number;
	peers: Peer[] = [];

	constructor(
		readonly app: App,
		readonly awareness: Awareness,
		readonly me: () => { id: string; name: string; color: string },
		readonly device: string,
	) {
		this.styleEl = document.head.createEl("style", { attr: { id: "tandem-presence-style" } });
		awareness.on("change", this.onChange);
		this.publish();
		// „Tippt gerade“ läuft ohne neue Nachricht ab → regelmäßig neu bewerten.
		this.refreshTimer = window.setInterval(() => this.onChange(), 1500);
	}

	/** Lokale Eingabe im Editor: höchstens alle 1,5 s eine Awareness-Nachricht. */
	touch() {
		const now = Date.now();
		if (now - this.lastTouch < 1500) return;
		this.lastTouch = now;
		this.publish();
		if (this.typingTimer !== null) window.clearTimeout(this.typingTimer);
		// Nach Ende des Tippens einmal „fertig“ melden, damit andere den Hinweis sofort ausblenden.
		this.typingTimer = window.setTimeout(() => {
			this.typingTimer = null;
			this.lastTouch = 0;
			this.publish(false);
		}, TYPING_MS);
	}

	onPeers(fn: (p: Peer[]) => void) {
		this.listeners.add(fn);
		fn(this.peers);
		return () => this.listeners.delete(fn);
	}

	/** Eigenen Zustand veröffentlichen (aktive Datei). */
	publish(typing = Date.now() - this.lastTouch < TYPING_MS) {
		const file = this.app.workspace.getActiveFile();
		this.awareness.setLocalState({
			// Andere Felder (z. B. `ink` von der InkBridge) erhalten
			...(this.awareness.getLocalState() ?? {}),
			user: this.me(),
			view: { path: file?.path ?? null },
			device: this.device,
			typingAt: typing ? Date.now() : 0,
		});
	}

	private onChange = () => {
		const own = this.awareness.clientID;
		const peers: Peer[] = [];
		const meta = this.awareness.meta;
		const states = this.awareness.getStates();
		for (const id of this.typingSeen.keys()) if (!states.has(id)) this.typingSeen.delete(id);
		for (const [id, st] of states) {
			if (id === own || !st?.user) continue;
			// typingAt ist die Uhr des anderen Geräts → mit dem lokalen Empfangszeitpunkt arbeiten. Maßgeblich ist,
			// wann sich typingAt zuletzt geändert hat – nicht das letzte Awareness-Update überhaupt: Zeiger und
			// Live-Striche (InkBridge, bis 20/s) würden „tippt gerade“ sonst endlos verlängern.
			const prev = this.typingSeen.get(id);
			if (!prev || prev.at !== st.typingAt) this.typingSeen.set(id, { at: st.typingAt, seen: meta.get(id)?.lastUpdated ?? Date.now() });
			const seen = this.typingSeen.get(id)!.seen;
			const typing = !!st.typingAt && Date.now() - seen < TYPING_MS;
			peers.push({ clientId: id, user: st.user, path: st.view?.path ?? undefined, device: st.device, typing });
		}
		peers.sort((a, b) => a.user.name.localeCompare(b.user.name));
		const key = JSON.stringify(peers);
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.peers = peers;
		this.render();
		for (const fn of this.listeners) fn(peers);
	};
	private lastKey = "";
	/** clientID → (zuletzt gesehener typingAt-Wert, lokaler Zeitpunkt dieser Änderung) */
	private typingSeen = new Map<number, { at: unknown; seen: number }>();

	/** Punkte im Dateibaum per CSS (überlebt Neuzeichnen des Dateibaums). */
	private render() {
		const byPath = new Map<string, Peer[]>();
		for (const p of this.peers) if (p.path) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
		const css: string[] = [];
		for (const [path, ps] of byPath) {
			const sel = `.nav-file-title[data-path="${cssStr(path)}"]`;
			const dots = ps.map((p) => p.user.color);
			const bg = dots.map((c, i) => `radial-gradient(circle at ${6 + i * 10}px 50%, ${c} 3.5px, transparent 4px)`).join(",");
			const typing = ps.some((p) => p.typing);
			css.push(
				`${sel}::after{content:"";flex:0 0 ${dots.length * 10 + 4}px;height:12px;margin-left:auto;background:${bg};${typing ? "animation:tandem-pulse 1s ease-in-out infinite;" : ""}}`,
			);
			// Ordner, in denen jemand arbeitet, ebenfalls markieren (eingeklappte Ordner).
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) {
				const dir = parts.slice(0, i).join("/");
				css.push(`.nav-folder.is-collapsed > .nav-folder-title[data-path="${cssStr(dir)}"]::after{content:"";flex:0 0 10px;height:12px;margin-left:auto;background:radial-gradient(circle at 5px 50%, ${dots[0]} 3px, transparent 3.5px);opacity:.7;}`);
			}
		}
		this.styleEl.textContent = css.join("\n");
		this.renderHeaders(byPath);
	}

	/** Avatare (Initialen) in der Kopfzeile jeder offenen Notiz. */
	renderHeaders(byPath = new Map<string, Peer[]>()) {
		if (!byPath.size) for (const p of this.peers) if (p.path) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
		const seen = new Set<HTMLElement>();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			const actions = view.containerEl.querySelector<HTMLElement>(".view-header .view-actions");
			if (!actions || !view.file) continue;
			seen.add(actions);
			let el = this.headerEls.get(actions);
			if (!el) {
				el = createDiv({ cls: "tandem-avatars" });
				actions.prepend(el);
				this.headerEls.set(actions, el);
			}
			el.empty();
			for (const p of byPath.get(view.file.path) ?? []) {
				const a = el.createDiv({ cls: `tandem-avatar${p.typing ? " is-typing" : ""}`, text: initials(p.user.name) });
				a.style.setProperty("--tandem-color", p.user.color);
				a.setAttr("aria-label", `${p.user.name}${p.device ? ` (${p.device})` : ""}${p.typing ? " – tippt gerade" : ""}`);
				a.dataset.peer = String(p.clientId);
			}
		}
		for (const [actions, el] of [...this.headerEls]) {
			if (!seen.has(actions)) {
				el.remove();
				this.headerEls.delete(actions);
			}
		}
	}

	destroy() {
		window.clearInterval(this.refreshTimer);
		if (this.typingTimer !== null) window.clearTimeout(this.typingTimer);
		this.awareness.off("change", this.onChange);
		this.styleEl.remove();
		for (const el of this.headerEls.values()) el.remove();
		this.headerEls.clear();
	}
}

export function initials(name: string) {
	const parts = name.trim().split(/\s+/);
	return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Für Attributwerte in Anführungszeichen genügt es, " und \ zu maskieren (Zeilenumbrüche kommen in Pfaden nicht vor). */
function cssStr(s: string) {
	return s.replace(/["\\]/g, "\\$&");
}
