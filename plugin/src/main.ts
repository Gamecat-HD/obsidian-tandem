import { MarkdownView, Notice, Platform, Plugin, requestUrl, SuggestModal, type App } from "obsidian";
import * as Y from "yjs";
import { Connection, type ConnStatus } from "./net/Connection";
import { LocalStore } from "./docs/LocalStore";
import { collabBaseExtension } from "./editor/collab";
import { SpaceSync } from "./sync/SpaceSync";
import { Presence, initials, type Peer } from "./presence/Presence";
import { DEFAULT_SETTINGS, TandemSettingTab, type TandemSettings } from "./settings";
import { InkBridge } from "./ink/InkBridge";
import { HistoryModal, listSnapshots } from "./ui/History";
import { backupVault, canBackup } from "./ui/Backup";

const LS_TOKEN = "tandem-token";
const LS_DEVICE = "tandem-device";

export default class TandemPlugin extends Plugin {
	settings: TandemSettings = { ...DEFAULT_SETTINGS };
	conn: Connection | null = null;
	sync: SpaceSync | null = null;
	presence: Presence | null = null;
	ink: InkBridge | null = null;
	store: LocalStore | null = null;
	private statusEl!: HTMLElement;
	private following: number | null = null;
	private stopFollow: (() => void) | null = null;
	private hiddenTimer: number | null = null;
	api: Record<string, unknown> = {};

	get token(): string {
		return (this.app.loadLocalStorage(LS_TOKEN) as string | null) ?? "";
	}
	set token(t: string) {
		this.app.saveLocalStorage(LS_TOKEN, t || null);
	}
	get device(): string {
		let d = this.app.loadLocalStorage(LS_DEVICE) as string | null;
		if (!d) {
			d = Platform.isMobile ? (Platform.isIosApp ? "iPad/iPhone" : "Android") : "Desktop";
			this.app.saveLocalStorage(LS_DEVICE, d);
		}
		return d;
	}
	set device(d: string) {
		this.app.saveLocalStorage(LS_DEVICE, d);
	}

	async onload() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<TandemSettings>) };
		this.registerEditorExtension(collabBaseExtension());
		this.addSettingTab(new TandemSettingTab(this.app, this));
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("tandem-status");
		this.statusEl.onClickEvent(() => new PeerModal(this.app, this).open());
		this.renderStatus("offline");
		// Öffentliche Schnittstelle (Tests, andere Plugins wie Ink Blocks).
		this.api = {
			peers: () => this.presence?.peers ?? [],
			status: () => this.conn?.status ?? "offline",
			history: (docId: string) => listSnapshots(this.http(), this.settings.space, docId),
			invite: (user: string, name: string, role?: "write" | "read" | "owner", hours?: number) => this.createInvite(user, name, role, hours),
			members: () => this.members(),
		};

		this.addCommand({ id: "connect", name: "Verbinden / neu verbinden", callback: () => void this.restart() });
		this.addCommand({ id: "disconnect", name: "Trennen", callback: () => void this.shutdown() });
		this.addCommand({ id: "peers", name: "Wer ist online? (Folgen)", callback: () => new PeerModal(this.app, this).open() });
		this.addCommand({ id: "unfollow", name: "Nicht mehr folgen", callback: () => this.follow(null) });
		this.addCommand({ id: "resync", name: "Vollabgleich jetzt", callback: () => void this.sync?.scan() });
		this.addCommand({
			id: "history",
			name: "Versionsgeschichte dieser Datei",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				const id = f && this.sync?.index.idForPath(f.path);
				if (!f || !id || !this.sync) return false;
				if (!checking) new HistoryModal(this.app, this.sync, this.http(), this.settings.space, id, f.path).open();
				return true;
			},
		});
		this.addCommand({
			id: "backup",
			name: "Sicherung des Vaults erstellen (Kopie neben dem Vault-Ordner)",
			checkCallback: (checking) => {
				if (!canBackup(this.app)) return false;
				if (!checking)
					void backupVault(this.app).then(
						(p) => new Notice(`Tandem: Sicherung erstellt:\n${p}`, 10000),
						(e) => new Notice(`Tandem: Sicherung fehlgeschlagen – ${(e as Error).message}`),
					);
				return true;
			},
		});

		this.registerDomEvent(window, "online", () => this.conn?.kick());
		// Mobil: im Hintergrund trennen (Akku), beim Zurückkehren sofort neu abgleichen.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (!Platform.isMobile || !this.conn) return;
			if (document.hidden) {
				this.hiddenTimer = window.setTimeout(() => this.conn?.stop(), 20000);
			} else {
				if (this.hiddenTimer !== null) window.clearTimeout(this.hiddenTimer);
				this.hiddenTimer = null;
				this.conn.start();
				this.conn.kick();
			}
		});
		this.app.workspace.onLayoutReady(() => void this.startup());
	}

	async onunload() {
		await this.shutdown();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** LiveSync darf nie gleichzeitig denselben Vault synchronisieren. */
	livesyncActive(): boolean {
		// @ts-expect-error – interne API
		const enabled: Set<string> | undefined = this.app.plugins?.enabledPlugins;
		return !!enabled?.has("obsidian-livesync");
	}

	private async startup() {
		if (!this.settings.enabled || !this.settings.serverUrl || !this.token || !this.settings.space) return;
		if (this.livesyncActive()) {
			new Notice("Tandem: Self-hosted LiveSync ist aktiv. Bitte erst LiveSync deaktivieren – beide gleichzeitig würden sich gegenseitig stören.", 15000);
			this.renderStatus("offline", "LiveSync aktiv");
			return;
		}
		const url = this.settings.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/ws";
		const conn = new Connection({ url, token: this.token, device: this.device });
		this.conn = conn;
		// @ts-expect-error – interne API: eindeutige Vault-ID
		const vaultId: string = this.app.appId ?? this.app.vault.getName();
		this.store = new LocalStore(`tandem-${vaultId}-${this.settings.space}`);
		await this.store.open();
		// Vor dem allerersten Abgleich dieses Vaults mit diesem Space: Sicherung (Desktop)
		if (!(await this.store.getMeta<number>("first-sync-done"))) {
			if (this.settings.backupBeforeFirstSync && canBackup(this.app)) {
				try {
					const p = await backupVault(this.app);
					new Notice(`Tandem: Vor dem ersten Abgleich wurde der Vault gesichert:\n${p}`, 15000);
				} catch (e) {
					new Notice(`Tandem: Sicherung fehlgeschlagen (${(e as Error).message}) – Abgleich wird nicht gestartet.`, 15000);
					this.renderStatus("offline", "Sicherung fehlgeschlagen");
					return;
				}
			} else if (!canBackup(this.app)) {
				new Notice("Tandem: Erster Abgleich auf diesem Gerät. Tipp: vorher eine Sicherung des Vaults anlegen.", 10000);
			}
			await this.store.setMeta("first-sync-done", Date.now());
		}
		conn.onStatus((s) => this.renderStatus(s));
		conn.onError((code, doc, msg) => {
			if (code === 401) new Notice("Tandem: Anmeldung abgelehnt – bitte neu einladen lassen (Einstellungen).");
			else console.warn("[tandem] Serverfehler", code, doc, msg);
		});
		const user = () => conn.welcome?.user ?? { id: "local", name: this.settings.displayName || "Ich", color: "#888888" };
		const sync = new SpaceSync({
			app: this.app,
			conn,
			store: this.store,
			space: this.settings.space,
			ignore: this.settings.ignore
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.flatMap((l) => {
					try {
						return [new RegExp(l)];
					} catch {
						return [];
					}
				}),
			user,
			http: () => this.http(),
			log: (m) => console.log("[tandem]", m),
		});
		this.sync = sync;
		conn.start();
		await sync.start();
		this.presence = new Presence(this.app, sync.indexSession.awareness!, user, this.device);
		this.presence.onPeers(() => {
			this.renderStatus(conn.status);
			this.onPeersForFollow();
		});
		conn.onStatus((s) => {
			if (s === "online") this.presence?.publish();
		});
		this.registerEvent(this.app.workspace.on("file-open", () => this.presence?.publish()));
		// Eigene Eingaben → „tippt gerade“ für die anderen.
		this.registerDomEvent(document, "beforeinput", (e) => {
			if ((e.target as HTMLElement | null)?.closest?.(".cm-editor")) this.presence?.touch();
		});
		this.registerEvent(this.app.workspace.on("layout-change", () => this.presence?.renderHeaders()));
		this.ink = new InkBridge(this.app, sync);
		this.ink.start();
	}

	http() {
		return { base: this.settings.serverUrl.replace(/\/+$/, ""), token: this.token };
	}

	async restart() {
		await this.shutdown();
		await this.startup();
	}

	async shutdown() {
		this.follow(null);
		this.ink?.stop();
		this.ink = null;
		this.presence?.destroy();
		this.presence = null;
		await this.sync?.stop();
		this.sync = null;
		this.conn?.stop();
		this.conn = null;
		this.store?.close();
		this.store = null;
		this.renderStatus("offline");
	}

	renderStatus(s: ConnStatus, note?: string) {
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		const label = { offline: "offline", connecting: "verbinde …", online: "online", unauthorized: "nicht angemeldet" }[s];
		el.createSpan({ cls: `tandem-dot tandem-${s}` });
		el.createSpan({ text: ` Tandem ${note ?? label}` });
		const peers = this.presence?.peers ?? [];
		if (s === "online" && peers.length) {
			const wrap = el.createSpan({ cls: "tandem-status-peers" });
			for (const p of peers.slice(0, 5)) {
				const a = wrap.createSpan({ cls: `tandem-avatar small${p.typing ? " is-typing" : ""}`, text: initials(p.user.name) });
				a.style.setProperty("--tandem-color", p.user.color);
			}
			const typing = peers.filter((p) => p.typing);
			if (typing.length) el.createSpan({ cls: "tandem-typing", text: ` ${typing.map((p) => p.user.name).join(", ")} ${typing.length > 1 ? "tippen" : "tippt"} …` });
		}
		el.setAttr(
			"aria-label",
			peers.map((p) => `${p.user.name}${p.device ? ` (${p.device})` : ""}: ${p.path ?? "–"}${p.typing ? " – tippt gerade" : ""}`).join("\n") || "Niemand sonst online",
		);
	}

	/** Rolle in diesem Space (vom Server beim Verbinden gemeldet). */
	role(): string | undefined {
		return this.conn?.welcome?.spaces.find((s) => s.id === this.settings.space)?.role;
	}

	/** Einladungscode erzeugen (nur Besitzer). Legt die Person bei Bedarf an. */
	async createInvite(user: string, name: string, role: "write" | "read" | "owner" | undefined, hours = 168): Promise<{ code: string; user: string; role: string; hours: number }> {
		const { base, token } = this.http();
		const r = await requestUrl({
			url: `${base}/api/invite`,
			method: "POST",
			contentType: "application/json",
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify({ space: this.settings.space, user, name, role, hours }),
			throw: false,
		});
		if (r.status !== 200) throw new Error(r.text || `HTTP ${r.status}`);
		return r.json;
	}

	async members(): Promise<{ id: string; name: string; color: string; role: string; devices: { device: string; lastSeen: number | null }[] }[]> {
		const { base, token } = this.http();
		const r = await requestUrl({ url: `${base}/api/members/${encodeURIComponent(this.settings.space)}`, headers: { Authorization: `Bearer ${token}` }, throw: false });
		if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
		return r.json;
	}

	/** Einladungscode einlösen → Geräte-Token. */
	async redeem(code: string): Promise<string> {
		const base = this.settings.serverUrl.replace(/\/+$/, "");
		const r = await requestUrl({
			url: `${base}/api/redeem`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ code: code.trim(), device: this.device }),
			throw: false,
		});
		if (r.status !== 200) throw new Error(r.status === 404 || r.status === 400 ? "Code ungültig oder abgelaufen" : `HTTP ${r.status}`);
		const { token, user, spaces } = r.json as { token: string; user: { name: string }; spaces: { id: string }[] };
		this.token = token;
		if (!this.settings.space && spaces?.length) this.settings.space = spaces[0].id;
		await this.saveSettings();
		return user.name;
	}

	// ── Folgen ────────────────────────────────────────────────────────────

	follow(peer: Peer | null) {
		this.stopFollow?.();
		this.stopFollow = null;
		this.statusEl?.removeClass("is-following");
		this.following = peer?.clientId ?? null;
		if (!peer) return;
		new Notice(`Tandem: Du folgst ${peer.user.name}. Esc oder „Nicht mehr folgen“ beendet das.`);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.follow(null);
		};
		document.addEventListener("keydown", onKey, true);
		// Cursor der Person in der gerade offenen Notiz verfolgen (gedrosselt).
		let last = 0;
		let timer: number | null = null;
		const onAw = () => {
			const run = () => {
				last = Date.now();
				timer = null;
				const p = this.presence?.peers.find((x) => x.clientId === this.following);
				if (p) this.scrollToCursor(p);
			};
			if (timer !== null) return;
			const wait = Math.max(0, 250 - (Date.now() - last));
			timer = window.setTimeout(run, wait);
		};
		let watched: { off(): void } | null = null;
		const watch = () => {
			watched?.off();
			const v = this.app.workspace.getActiveViewOfType(MarkdownView);
			const aw = v?.file ? this.sync?.binder.sessionFor(v.file.path)?.awareness : undefined;
			if (!aw) return (watched = null);
			aw.on("change", onAw);
			watched = { off: () => aw.off("change", onAw) };
		};
		const ref = this.app.workspace.on("file-open", () => window.setTimeout(watch, 400));
		watch();
		this.stopFollow = () => {
			document.removeEventListener("keydown", onKey, true);
			this.app.workspace.offref(ref);
			watched?.off();
			if (timer !== null) window.clearTimeout(timer);
		};
		this.statusEl.addClass("is-following");
		void this.jumpTo(peer);
	}

	private onPeersForFollow() {
		if (this.following === null) return;
		const p = this.presence?.peers.find((x) => x.clientId === this.following);
		if (!p) {
			new Notice("Tandem: Die Person ist nicht mehr online.");
			return this.follow(null);
		}
		void this.jumpTo(p);
	}

	private async jumpTo(peer: Peer) {
		if (!peer.path) return;
		const ws = this.app.workspace;
		if (ws.getActiveFile()?.path !== peer.path) {
			const f = this.app.vault.getFileByPath(peer.path);
			if (!f) return;
			await ws.getLeaf(false).openFile(f);
		}
		window.setTimeout(() => this.scrollToCursor(peer), 300);
	}

	private scrollToCursor(peer: Peer) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const session = view?.file ? this.sync?.binder.sessionFor(view.file.path) : undefined;
		if (!view || !session?.awareness) return;
		for (const [, st] of session.awareness.getStates()) {
			if (st?.user?.id !== peer.user.id || !st.cursor?.head) continue;
			const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(st.cursor.head), session.doc);
			if (!abs) return;
			const pos = view.editor.offsetToPos(abs.index);
			view.editor.scrollIntoView({ from: pos, to: pos }, true);
			return;
		}
	}
}

class PeerModal extends SuggestModal<Peer> {
	constructor(
		app: App,
		readonly plugin: TandemPlugin,
	) {
		super(app);
		this.setPlaceholder("Wem folgen?");
		this.emptyStateText = plugin.conn?.status === "online" ? "Niemand sonst online" : "Tandem ist nicht verbunden";
	}
	getSuggestions(q: string): Peer[] {
		return (this.plugin.presence?.peers ?? []).filter((p) => p.user.name.toLowerCase().includes(q.toLowerCase()));
	}
	renderSuggestion(p: Peer, el: HTMLElement) {
		const a = el.createSpan({ cls: "tandem-avatar", text: initials(p.user.name) });
		a.style.setProperty("--tandem-color", p.user.color);
		el.createSpan({ text: ` ${p.user.name}` });
		el.createEl("small", { text: `  ${p.path ?? "–"}${p.device ? ` · ${p.device}` : ""}${p.typing ? " · tippt gerade" : ""}`, cls: "tandem-muted" });
	}
	onChooseSuggestion(p: Peer) {
		this.plugin.follow(p);
	}
}
