import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type TandemPlugin from "./main";

export interface TandemSettings {
	enabled: boolean;
	/** https://tandem.example.org */
	serverUrl: string;
	space: string;
	/** Nur angezeigt, solange der Server noch keinen Namen geliefert hat. */
	displayName: string;
	/** Zusätzliche Ignorier-Regeln (reguläre Ausdrücke auf den Pfad, eine pro Zeile). */
	ignore: string;
	/** Vor dem ersten Abgleich eine Kopie des Vaults anlegen (Desktop). */
	backupBeforeFirstSync: boolean;
}

export const DEFAULT_SETTINGS: TandemSettings = {
	enabled: true,
	serverUrl: "",
	space: "",
	displayName: "",
	ignore: "",
	backupBeforeFirstSync: true,
};

export class TandemSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		readonly plugin: TandemPlugin,
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();

		if (p.livesyncActive()) {
			containerEl.createDiv({
				cls: "tandem-warning",
				text: "Self-hosted LiveSync ist aktiv. Tandem startet erst, wenn LiveSync deaktiviert ist (beide gleichzeitig würden Konflikte erzeugen).",
			});
		}

		new Setting(containerEl)
			.setName("Server")
			.setDesc("Adresse des Tandem-Servers, z. B. https://tandem.example.org")
			.addText((t) =>
				t
					.setPlaceholder("https://…")
					.setValue(p.settings.serverUrl)
					.onChange(async (v) => {
						p.settings.serverUrl = v.trim();
						await p.saveSettings();
					}),
			);

		let code = "";
		new Setting(containerEl)
			.setName("Einladungscode")
			.setDesc(p.token ? "Dieses Gerät ist angemeldet. Ein neuer Code ersetzt die Anmeldung." : "Code vom Server-Admin (tandem-server invite …)")
			.addText((t) => t.setPlaceholder("XXXX-XXXX-XXXX").onChange((v) => (code = v)))
			.addButton((b) =>
				b.setButtonText("Einlösen").onClick(async () => {
					try {
						const name = await p.redeem(code);
						new Notice(`Tandem: angemeldet als ${name}`);
						await p.restart();
						this.display();
					} catch (e) {
						new Notice(`Tandem: ${(e as Error).message}`);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Space")
			.setDesc("Kennung des gemeinsamen Vaults auf dem Server")
			.addText((t) =>
				t.setValue(p.settings.space).onChange(async (v) => {
					p.settings.space = v.trim();
					await p.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Gerätename")
			.setDesc("Wird anderen bei deiner Präsenz angezeigt (nur auf diesem Gerät gespeichert)")
			.addText((t) =>
				t.setValue(p.device).onChange((v) => {
					p.device = v.trim() || "Gerät";
				}),
			);

		new Setting(containerEl)
			.setName("Synchronisieren")
			.addToggle((t) =>
				t.setValue(p.settings.enabled).onChange(async (v) => {
					p.settings.enabled = v;
					await p.saveSettings();
					if (v) await p.restart();
					else await p.shutdown();
				}),
			);

		new Setting(containerEl)
			.setName("Ignorieren")
			.setDesc("Reguläre Ausdrücke auf den Pfad, eine pro Zeile. Immer ignoriert: .obsidian/, .trash/, .git/, Temp-Dateien.")
			.addTextArea((t) =>
				t.setValue(p.settings.ignore).onChange(async (v) => {
					p.settings.ignore = v;
					await p.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Vor dem ersten Abgleich sichern")
			.setDesc("Legt auf dem Desktop beim ersten Verbinden eine vollständige Kopie des Vaults neben dem Vault-Ordner an.")
			.addToggle((t) =>
				t.setValue(p.settings.backupBeforeFirstSync).onChange(async (v) => {
					p.settings.backupBeforeFirstSync = v;
					await p.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Neu verbinden").addButton((b) => b.setButtonText("Jetzt").onClick(() => void p.restart()));

		this.renderPeople(containerEl.createDiv());
	}

	/** Personen & Einladungen (Einladen nur für Besitzer). */
	private renderPeople(el: HTMLElement) {
		const p = this.plugin;
		new Setting(el).setName("Personen und Geräte").setHeading();
		if (p.conn?.status !== "online") {
			el.createEl("p", { cls: "setting-item-description", text: "Erst verbinden, dann erscheinen hier die Mitglieder und – für Besitzer – Einladungen." });
			return;
		}
		const list = el.createDiv({ cls: "tandem-members", text: "Lade …" });
		void p.members().then(
			(ms) => {
				list.empty();
				for (const m of ms) {
					const devs = m.devices.map((d) => d.device).join(", ") || "noch kein Gerät";
					const s = new Setting(list).setName(`${m.name} (${m.id})`).setDesc(`${roleLabel(m.role)} · ${devs}`);
					s.nameEl.prepend(Object.assign(createSpan({ cls: "tandem-dot" }), { style: `background:${m.color};margin-right:6px` }));
				}
			},
			(e) => list.setText(`Mitglieder nicht abrufbar: ${(e as Error).message}`),
		);

		if (p.role() !== "owner") return;
		const me = p.conn.welcome?.user;
		const form = { user: "", name: "", role: "write" as "write" | "read" | "owner", days: 7 };
		const out = el.createDiv({ cls: "tandem-invite-result" });
		const show = (code: string, who: string, hours: number) => {
			out.empty();
			out.createSpan({ text: `Code für ${who} (${Math.round(hours / 24)} Tage gültig, einmal verwendbar): ` });
			out.createEl("code", { text: code, cls: "tandem-code" });
			const btn = out.createEl("button", { text: "Kopieren" });
			btn.onclick = () => void navigator.clipboard.writeText(code).then(() => new Notice("Code kopiert"));
		};
		new Setting(el)
			.setName("Weiteres eigenes Gerät anmelden")
			.setDesc("Code für dein Tablet/Handy/zweites Notebook")
			.addButton((b) =>
				b.setButtonText("Code erzeugen").onClick(async () => {
					try {
						const r = await p.createInvite(me?.id ?? "", "", undefined, 7 * 24);
						show(r.code, "dich", r.hours);
					} catch (e) {
						new Notice(`Tandem: ${(e as Error).message}`);
					}
				}),
			);
		new Setting(el)
			.setName("Person einladen")
			.setDesc("Kennung (klein, ohne Leerzeichen, z. B. max) und Anzeigename. Neue Personen werden angelegt.")
			.addText((t) => t.setPlaceholder("kennung").onChange((v) => (form.user = v.trim().toLowerCase())))
			.addText((t) => t.setPlaceholder("Name").onChange((v) => (form.name = v.trim())))
			.addDropdown((d) =>
				d
					.addOptions({ write: "Schreiben", read: "Nur lesen", owner: "Besitzer" })
					.setValue("write")
					.onChange((v) => (form.role = v as typeof form.role)),
			)
			.addButton((b) =>
				b
					.setButtonText("Code erzeugen")
					.setCta()
					.onClick(async () => {
						if (!/^[a-z0-9_-]{1,64}$/.test(form.user)) return new Notice("Tandem: Kennung nur a-z, 0-9, _ und -");
						try {
							const r = await p.createInvite(form.user, form.name || form.user, form.role, form.days * 24);
							show(r.code, form.name || r.user, r.hours);
						} catch (e) {
							new Notice(`Tandem: ${(e as Error).message}`);
						}
					}),
			);
	}
}

function roleLabel(r: string) {
	return r === "owner" ? "Besitzer" : r === "read" ? "Nur lesen" : "Schreiben";
}
