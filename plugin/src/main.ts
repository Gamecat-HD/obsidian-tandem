import { MarkdownView, Notice, Platform, Plugin, requestUrl, SuggestModal, type App } from "obsidian";
import type { Extension } from "@codemirror/state";
import * as Y from "yjs";
import { Connection, ERR_VERSION, type ConnStatus } from "./net/Connection";
import { LocalStore } from "./docs/LocalStore";
import { collabBaseExtension } from "./editor/collab";
import { SpaceSync, type ReferencedDelete } from "./sync/SpaceSync";
import { Presence, initials, type Peer } from "./presence/Presence";
import { DEFAULT_SETTINGS, formatSize, TandemSettingTab, type TandemSettings } from "./settings";
import { InkBridge } from "./ink/InkBridge";
import { LiveApi } from "./live/LiveApi";
import { HistoryModal, listSnapshots, loadSnapshot } from "./ui/History";
import { backupVault, canBackup } from "./ui/Backup";
import { createParams, SpaceKey, b64, unb64, unlock } from "./crypto/e2ee";
import type { E2eeParams, WelcomeSpace } from "./net/protocol";
import { PassphraseModal } from "./ui/Passphrase";
import { checkTransport } from "./net/transport";
import { installRelease, latestRelease, newer, reloadPlugin, type Release } from "./ui/Update";
import { blameExtension } from "./blame/view";
import { AuthorLookup, blameLines, textLines, textRuns, type Author } from "./blame/authorship";

const LS_TOKEN = "tandem-token";
const LS_DEVICE = "tandem-device";
/** Pro Space: zuletzt bekannte E2EE-Einstellung ("plain" | "pending" | Parameter) – für den Start ohne Netz. */
const LS_E2EE_MODE = "tandem-e2ee-mode:";
/** Pro Space: abgeleiteter Schlüssel `{check, raw}` – nur auf diesem Gerät. */
const LS_E2EE_KEY = "tandem-e2ee-key:";
const LS_UPDATE_CHECK = "tandem-update-check";
/** Zuletzt vom Server gemeldete Person – damit offline Geschriebenes trotzdem einen Namen bekommt (Blame). */
const LS_USER = "tandem-user";

export type E2eeMode = "plain" | "pending" | E2eeParams;

export default class TandemPlugin extends Plugin {
	settings: TandemSettings = { ...DEFAULT_SETTINGS };
	conn: Connection | null = null;
	sync: SpaceSync | null = null;
	presence: Presence | null = null;
	ink: InkBridge | null = null;
	store: LocalStore | null = null;
	private statusEl!: HTMLElement;
	/** Per registerEditorExtension eingehängt; Inhalt wird beim Umschalten getauscht. */
	private blameExt: Extension[] = [];
	private following: number | null = null;
	private stopFollow: (() => void) | null = null;
	private hiddenTimer: number | null = null;
	api: Record<string, unknown> = {};
	/** Live-Schnittstelle für Partner-Plugins (Zellwerk). */
	live = new LiveApi({ sync: () => this.sync, user: () => this.userInfo() });
	/** Schlüssel des aktuellen Space (verschlüsselt) bzw. null. */
	key: SpaceKey | null = null;
	/** Aktueller Modus des Space (nach dem Start). */
	e2eeMode: E2eeMode = "plain";
	private passModal: PassphraseModal | null = null;
	/** Ersetzt „online“ in der Statusleiste, solange der Vault gesperrt ist / auf die Passphrase wartet. */
	private statusNote: string | null = null;
	private decryptWarned = false;
	/** Neuere Version auf GitHub (nach der letzten Prüfung), sonst null. */
	update: Release | null = null;
	/** Server-Version, wenn der Server diese Plugin-Version abgelehnt hat. */
	serverVersion: string | null = null;

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
		this.registerEditorExtension(this.blameExt);
		if (this.settings.blame) this.blameExt.push(blameExtension({ me: () => this.authorInfo() }));
		this.addSettingTab(new TandemSettingTab(this.app, this));
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("tandem-status");
		this.statusEl.onClickEvent(() => new PeerModal(this.app, this).open());
		this.renderStatus("offline");
		// Öffentliche Schnittstelle (Tests, andere Plugins wie Ink Blocks).
		this.api = {
			peers: () => this.presence?.peers ?? [],
			cursors: (path: string) => this.cursorsIn(path),
			status: () => this.conn?.status ?? "offline",
			history: (docId: string) => listSnapshots(this.http(), this.settings.space, docId),
			snapshotText: async (docId: string, ts: number) => (await loadSnapshot(this.http(), this.settings.space, docId, ts, this.key)).getText("content").toString(),
			invite: (user: string, name: string, role?: "write" | "read" | "owner", hours?: number) => this.createInvite(user, name, role, hours),
			members: () => this.members(),
			e2ee: () => ({ mode: this.e2eeMode, unlocked: !!this.key }),
			e2eeSetup: (passphrase: string, iter?: number) => this.setupE2ee(passphrase, iter),
			e2eeUnlock: (passphrase: string) => this.unlockWith(passphrase),
			e2eeForget: () => this.forgetKey(),
			live: this.live.facade(),
			blame: (path: string) => this.blameFor(path),
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
			id: "blame",
			name: "Blame ein/aus (wer hat welche Zeile geschrieben?)",
			callback: () => void this.setBlame(!this.settings.blame),
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
			// Große Docs werden verzögert gespeichert – bevor das System die App womöglich beendet, alles sichern.
			if (document.hidden) void this.sync?.docs.flushAllPersists();
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
		this.addCommand({ id: "check-update", name: "Nach Updates suchen", callback: () => void this.checkUpdate(false) });
		this.app.workspace.onLayoutReady(() => {
			void this.startup();
			// Höchstens einmal am Tag still nachsehen; gemeldet wird nur, wenn es etwas Neues gibt.
			const last = Number(this.app.loadLocalStorage(LS_UPDATE_CHECK) ?? 0);
			if (Date.now() - last > 24 * 3600 * 1000) window.setTimeout(() => void this.checkUpdate(true), 15000);
		});
	}

	/** Hinweis: Gelöschte Anhänge werden noch verwendet. Bleibt stehen, bis man ihn anklickt. */
	private warnReferencedDelete(items: ReferencedDelete[], restore: (() => number) | null) {
		const base = (p: string) => p.split("/").pop() ?? p;
		const note = (p: string) => base(p).replace(/\.md$/, "");
		const frag = createFragment((f) => {
			f.createDiv({ text: "Tandem: Gelöscht, aber noch verwendet" }).style.fontWeight = "600";
			for (const i of items.slice(0, 5)) {
				const who = i.local ? "Hier gelöscht" : `Gelöscht von ${i.by ?? "jemand anderem"}`;
				const used = i.notes.slice(0, 3).map(note).join(", ") + (i.notes.length > 3 ? ` und ${i.notes.length - 3} weitere` : "");
				f.createDiv({ text: `„${base(i.path)}“ (${who}): verwendet in ${used}` });
			}
			if (items.length > 5) f.createDiv({ text: `… und ${items.length - 5} weitere Anhänge` });
			if (!restore) return;
			const btn = f.createEl("button", { text: items.length > 1 ? "Alle wiederherstellen" : "Wiederherstellen", cls: "mod-cta" });
			btn.style.marginTop = "6px";
			btn.onclick = () => {
				const n = restore();
				new Notice(n ? `Tandem: ${n} Anhang/Anhänge wiederhergestellt – auf allen Geräten.` : "Tandem: Nichts wiederhergestellt (inzwischen schon zurück oder Name neu vergeben).");
			};
		});
		new Notice(frag, 0);
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
		const transport = checkTransport(this.settings.serverUrl);
		if (!transport.ok) {
			new Notice(`Tandem: ${transport.reason}`, 15000);
			this.renderStatus("offline", "unsichere Adresse");
			return;
		}
		const url = this.settings.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/ws";
		const conn = new Connection({ url, token: this.token, device: this.device, client: this.clientId() });
		this.conn = conn;
		conn.onStatus((s) => this.renderStatus(s));
		conn.onStatus((s) => {
			const u = conn.welcome?.user;
			if (s === "online" && u) this.app.saveLocalStorage(LS_USER, JSON.stringify({ id: u.id, name: u.name, color: u.color }));
		});
		// Früh anhängen: Die Ablehnung kommt als Antwort auf HELLO, noch während unten gewartet wird.
		conn.onError((code, doc, msg) => {
			if (code === ERR_VERSION && !doc && this.conn === conn) void this.versionMismatch(msg);
		});
		// Erst die Anmeldung abwarten: WELCOME sagt, ob der Space Ende-zu-Ende-verschlüsselt ist.
		conn.start();
		await new Promise<void>((ok) => {
			if (conn.status === "online") return ok();
			const t = window.setTimeout(done, 6000);
			const off = conn.onStatus((s) => {
				if (s === "online" || s === "unauthorized" || s === "outdated") done();
			});
			function done() {
				window.clearTimeout(t);
				off();
				ok();
			}
		});
		if (this.conn !== conn) return; // inzwischen neu gestartet
		const space = this.settings.space;
		const hasAccess = () => !!conn.welcome?.spaces.some((s) => s.id === space);
		const denied = conn.status === "online" && !hasAccess();
		const mode = this.currentMode(conn.welcome?.spaces.find((s) => s.id === space));
		this.e2eeMode = mode;
		this.key = null;
		this.statusNote = null;
		// Modus hat sich auf dem Server geändert (z. B. Verschlüsselung eingerichtet) → neu starten.
		conn.onStatus((s) => {
			if (s !== "online" || this.conn !== conn) return;
			if (denied) {
				if (hasAccess()) void this.restart();
				return;
			}
			const now = this.currentMode(conn.welcome?.spaces.find((x) => x.id === space));
			if (modeKey(now) !== modeKey(mode)) void this.restart();
		});
		if (denied) {
			// Ein Gerät gehört zu einem Vault. Ohne Zugriff sähe der Server nur 403er, in der Statusleiste stünde aber „online“.
			const own = conn.welcome?.spaces.map((s) => `„${s.id}“`).join(", ");
			this.statusNote = "kein Zugriff auf den Space";
			this.renderStatus(conn.status);
			new Notice(`Tandem: Dieses Gerät hat keinen Zugriff auf den Space „${space}“.${own ? ` Es ist angemeldet für ${own}.` : ""} Space korrigieren oder einen Einladungscode für diesen Vault einlösen.`, 15000);
			return;
		}
		if (mode === "pending") {
			// Verbindung bleibt offen: Sobald die Passphrase festgelegt ist, trennt der Server alle → Neustart.
			const owner = conn.welcome?.spaces.find((s) => s.id === space)?.role === "owner";
			this.statusNote = owner ? "Passphrase festlegen" : "wartet auf Verschlüsselung";
			this.renderStatus(conn.status);
			if (owner) this.askPassphrase("set");
			else new Notice("Tandem: Dieser Vault wird Ende-zu-Ende-verschlüsselt. Die Besitzerin/der Besitzer muss erst die Passphrase festlegen.", 12000);
			return;
		}
		if (mode !== "plain") {
			this.key = await this.cachedKey(mode);
			if (this.conn !== conn) return;
			if (!this.key) {
				this.statusNote = "gesperrt – Passphrase eingeben";
				this.renderStatus(conn.status);
				this.askPassphrase("unlock");
				return;
			}
		}
		// @ts-expect-error – interne API: eindeutige Vault-ID
		const vaultId: string = this.app.appId ?? this.app.vault.getName();
		this.store = new LocalStore(`tandem-${vaultId}-${this.settings.space}`);
		await this.store.open();
		// Lokaler Stand passt nur zum selben Modus (Klartext bzw. derselbe Schlüssel) – sonst neu aufbauen.
		const marker = mode === "plain" ? "plain" : `e2ee:${mode.check}`;
		const prev = await this.store.getMeta<string>("mode");
		if (prev !== undefined && prev !== marker) {
			console.log("[tandem] Verschlüsselungsmodus geändert – lokaler Zwischenspeicher wird neu aufgebaut");
			await this.store.clear();
		}
		await this.store.setMeta("mode", marker);
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
		conn.onError((code, doc, msg) => {
			if (code === 401) new Notice("Tandem: Anmeldung abgelehnt – bitte neu einladen lassen (Einstellungen).");
			else if (code === 426 && this.conn === conn) void this.restart(); // Space wurde verschlüsselt
			else if (code !== ERR_VERSION) console.warn("[tandem] Serverfehler", code, doc, msg);
		});
		const user = () => this.userInfo();
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
			author: () => this.authorInfo(),
			http: () => this.http(),
			log: (m) => console.log("[tandem]", m),
			key: this.key,
			onReferencedDelete: (items, restore) => this.warnReferencedDelete(items, restore),
			represented: (path, hash) => this.live.represented(path, hash),
			onTransferLost: (t) => {
				const name = t.path.split("/").pop();
				new Notice(`Tandem: Beim Übertragen von „${name}“${formatSize(t.size)} wurde die App beendet. Die Datei wird auf diesem Gerät übersprungen. Erneut versuchen: Einstellungen → Tandem.`, 20000);
			},
		});
		this.sync = sync;
		sync.docs.onDecryptError = (docId, e) => {
			if (this.decryptWarned) return;
			this.decryptWarned = true;
			new Notice(`Tandem: Daten lassen sich nicht entschlüsseln (${e.message}). Wurde die Passphrase geändert? Einstellungen → Verschlüsselung → „Schlüssel vergessen“ und neu eingeben.`, 20000);
			console.error("[tandem] Entschlüsseln fehlgeschlagen", docId, e);
		};
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
		this.ink = new InkBridge(this.app, sync, () => this.authorInfo());
		this.ink.start();
		this.ink.setBlame(this.settings.blame);
	}

	/** Angemeldete Person (oder Platzhalter, solange keine Verbindung besteht). */
	userInfo(): { id: string; name: string; color: string } {
		return this.conn?.welcome?.user ?? { id: "local", name: this.settings.displayName || "Ich", color: "#888888" };
	}

	/** Wer gerade schreibt (für Blame): angemeldete Person samt Gerät, offline die zuletzt bekannte; sonst null. */
	authorInfo(): Author | null {
		let u: { id: string; name: string; color: string } | null | undefined = this.conn?.welcome?.user;
		if (!u) {
			try {
				u = JSON.parse((this.app.loadLocalStorage(LS_USER) as string | null) ?? "null") as typeof u;
			} catch {
				u = null;
			}
		}
		return u?.id ? { id: u.id, name: u.name, color: u.color, device: this.device } : null;
	}

	async setBlame(on: boolean) {
		this.settings.blame = on;
		await this.saveSettings();
		this.blameExt.length = 0;
		if (on) this.blameExt.push(blameExtension({ me: () => this.authorInfo() }));
		this.app.workspace.updateOptions();
		this.ink?.setBlame(on);
	}

	/** Für Tests/andere Plugins: Blame einer gekoppelten Notiz, pro Zeile. */
	blameFor(path: string) {
		const s = this.sync?.binder.sessionFor(path);
		if (!s) return null;
		const ytext = s.doc.getText("content");
		const me = this.authorInfo();
		const lookup = new AuthorLookup(s.doc, (c) => (c === s.doc.clientID ? (me ?? undefined) : undefined));
		return blameLines(textLines(ytext.toString()), textRuns(ytext), lookup).map((b) => ({
			line: b.index + 1,
			name: b.who.author?.name ?? null,
			device: b.who.author?.device ?? null,
			ts: b.who.ts,
			src: b.who.src,
			others: b.others.map((o) => o.name),
		}));
	}

	/** Kennung gegenüber dem Server; der bedient nur das Plugin mit genau seiner Version. */
	clientId() {
		return `tandem-plugin/${this.manifest.version}`;
	}

	http() {
		const token = this.token;
		return { base: this.settings.serverUrl.replace(/\/+$/, ""), token, headers: { Authorization: `Bearer ${token}`, "X-Tandem-Client": this.clientId() } };
	}

	/** Server lehnt diese Plugin-Version ab → passendes Release (= Server-Version) zum Installieren anbieten. */
	private async versionMismatch(msg: string) {
		const server = /Tandem-Server (\S+)/.exec(msg)?.[1];
		this.serverVersion = server ?? null;
		this.renderStatus("outdated");
		new Notice(`Tandem: ${msg}`, 0);
		// Den Knopf „Auf <Server-Version> aktualisieren“ in den Einstellungen vorbereiten.
		if (server)
			try {
				this.update = await latestRelease(server);
			} catch (e) {
				console.warn("[tandem] Release zur Server-Version nicht gefunden", e);
			}
	}

	// ── Updates ──────────────────────────────────────────────────────────

	/** Neueste Version auf GitHub abfragen. `quiet`: Fehler und „aktuell“ nicht melden. */
	async checkUpdate(quiet: boolean): Promise<Release | null> {
		try {
			// Lehnt der Server diese Version ab, zählt seine Version – auch wenn sie älter ist.
			const target = this.serverVersion && this.serverVersion !== this.manifest.version ? this.serverVersion : undefined;
			const rel = await latestRelease(target);
			this.app.saveLocalStorage(LS_UPDATE_CHECK, String(Date.now()));
			this.update = target || newer(rel.version, this.manifest.version) ? rel : null;
			if (this.update) new Notice(`Tandem ${rel.version} ist verfügbar (installiert: ${this.manifest.version}). Einstellungen → Tandem → „Aktualisieren“.`, 12000);
			else if (!quiet) new Notice(`Tandem ${this.manifest.version} ist aktuell.`);
			return this.update;
		} catch (e) {
			if (!quiet) new Notice(`Tandem: Update-Prüfung fehlgeschlagen – ${(e as Error).message}`);
			return null;
		}
	}

	/** Update installieren und das Plugin neu laden (Verbindung wird kurz getrennt). */
	async installUpdate(rel: Release): Promise<void> {
		await installRelease(this.app, this.manifest, rel);
		new Notice(`Tandem: ${rel.version} installiert – lade neu …`);
		await reloadPlugin(this.app, this.manifest.id);
	}

	// ── Ende-zu-Ende-Verschlüsselung ─────────────────────────────────────

	/** Modus aus WELCOME (online) bzw. zuletzt bekannter Modus (offline). Merkt sich den Online-Wert. */
	private currentMode(info: WelcomeSpace | undefined): E2eeMode {
		const k = LS_E2EE_MODE + this.settings.space;
		if (info) {
			const mode: E2eeMode = info.e2ee ?? "plain";
			this.app.saveLocalStorage(k, JSON.stringify(mode));
			return mode;
		}
		try {
			return (JSON.parse((this.app.loadLocalStorage(k) as string | null) ?? '"plain"') as E2eeMode) ?? "plain";
		} catch {
			return "plain";
		}
	}

	private async cachedKey(params: E2eeParams): Promise<SpaceKey | null> {
		try {
			const c = JSON.parse((this.app.loadLocalStorage(LS_E2EE_KEY + this.settings.space) as string | null) ?? "null") as { check: string; raw: string } | null;
			if (!c || c.check !== params.check) return null;
			return await SpaceKey.fromRaw(this.settings.space, unb64(c.raw));
		} catch {
			return null;
		}
	}

	private storeKey(params: E2eeParams, key: SpaceKey) {
		this.app.saveLocalStorage(LS_E2EE_KEY + this.settings.space, JSON.stringify({ check: params.check, raw: b64(key.raw) }));
	}

	/** Passphrase prüfen, Schlüssel auf diesem Gerät merken und neu starten. */
	async unlockWith(passphrase: string): Promise<void> {
		const mode = this.e2eeMode;
		if (mode === "plain" || mode === "pending") throw new Error("Dieser Vault ist nicht verschlüsselt");
		const key = await unlock(this.settings.space, passphrase, mode);
		if (!key) throw new Error("Passphrase stimmt nicht");
		this.storeKey(mode, key);
		this.decryptWarned = false;
		await this.restart();
	}

	/** Verschlüsselung für den (leeren) Space einrichten – nur Besitzer. */
	async setupE2ee(passphrase: string, iter?: number): Promise<void> {
		const { params, key } = await createParams(this.settings.space, passphrase, iter);
		const { base, headers } = this.http();
		const r = await requestUrl({
			url: `${base}/api/e2ee/${encodeURIComponent(this.settings.space)}`,
			method: "POST",
			contentType: "application/json",
			headers,
			body: JSON.stringify(params),
			throw: false,
		});
		if (r.status !== 204) throw new Error(r.text || `HTTP ${r.status}`);
		this.storeKey(params, key);
		this.app.saveLocalStorage(LS_E2EE_MODE + this.settings.space, JSON.stringify(params));
		await this.restart();
	}

	/** Schlüssel auf diesem Gerät löschen (beim nächsten Start wird nach der Passphrase gefragt). */
	async forgetKey(): Promise<void> {
		this.app.saveLocalStorage(LS_E2EE_KEY + this.settings.space, null);
		await this.restart();
	}

	askPassphrase(kind: "set" | "unlock") {
		this.passModal?.close();
		this.passModal = new PassphraseModal(this.app, kind, this.settings.space, async (pass) => {
			if (kind === "set") await this.setupE2ee(pass);
			else await this.unlockWith(pass);
		});
		this.passModal.open();
	}

	async restart() {
		await this.shutdown();
		await this.startup();
	}

	async shutdown() {
		this.passModal?.close();
		this.passModal = null;
		this.statusNote = null;
		this.follow(null);
		this.ink?.stop();
		this.ink = null;
		this.live.closeAll();
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
		note ??= s === "online" ? (this.statusNote ?? undefined) : undefined;
		const el = this.statusEl;
		if (!el) return;
		el.empty();
		const label = { offline: "offline", connecting: "verbinde …", online: "online", unauthorized: "nicht angemeldet", outdated: "Plugin-Version passt nicht" }[s];
		el.createSpan({ cls: `tandem-dot tandem-${s}` });
		el.createSpan({ text: ` Tandem ${note ?? label}` });
		if (this.key && s === "online" && !note) el.createSpan({ cls: "tandem-lock", text: " 🔒", attr: { "aria-label": "Ende-zu-Ende-verschlüsselt" } });
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
		const { base, headers } = this.http();
		const r = await requestUrl({
			url: `${base}/api/invite`,
			method: "POST",
			contentType: "application/json",
			headers,
			body: JSON.stringify({ space: this.settings.space, user, name, role, hours }),
			throw: false,
		});
		if (r.status !== 200) throw new Error(r.text || `HTTP ${r.status}`);
		return r.json;
	}

	async members(): Promise<{ id: string; name: string; color: string; role: string; devices: { device: string; lastSeen: number | null }[] }[]> {
		const { base, headers } = this.http();
		const r = await requestUrl({ url: `${base}/api/members/${encodeURIComponent(this.settings.space)}`, headers, throw: false });
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
		const { token, user, spaces, space } = r.json as { token: string; user: { name: string }; spaces: { id: string }[]; space?: string | null };
		this.token = token;
		if (!this.settings.space && spaces?.length) this.settings.space = spaces[0].id;
		// Bewusst nicht umstellen: Ein falscher Code darf diesen Vault nicht in einen anderen Space schreiben.
		else if (space && this.settings.space !== space) new Notice(`Tandem: Der Code gilt für den Space „${space}“, hier ist „${this.settings.space}“ eingetragen. Es wird nichts abgeglichen, bis das übereinstimmt.`, 15000);
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

	/** Cursor der anderen in einer gekoppelten Notiz, als absolute Positionen. */
	private cursorsIn(path: string): { name: string; anchor: number; head: number }[] {
		const session = this.sync?.binder.sessionFor(path);
		const aw = session?.awareness;
		if (!session || !aw) return [];
		const abs = (rel: unknown) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), session.doc)?.index;
		const out: { name: string; anchor: number; head: number }[] = [];
		for (const [id, st] of aw.getStates()) {
			if (id === aw.clientID || !st?.cursor?.head) continue;
			const head = abs(st.cursor.head);
			const anchor = abs(st.cursor.anchor);
			if (head !== undefined && anchor !== undefined) out.push({ name: st.user?.name ?? "", anchor, head });
		}
		return out;
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

function modeKey(m: E2eeMode): string {
	return typeof m === "string" ? m : `e2ee:${m.check}`;
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
