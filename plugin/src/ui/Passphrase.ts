/**
 * Passphrase eines Ende-zu-Ende-verschlüsselten Vaults festlegen (Besitzer, einmalig) bzw. eingeben (jedes Gerät).
 */
import { App, Modal, Notice, Setting } from "obsidian";

export const MIN_PASSPHRASE = 12;

export class PassphraseModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		readonly kind: "set" | "unlock",
		readonly space: string,
		readonly submit: (passphrase: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		const set = this.kind === "set";
		this.setTitle(set ? `Verschlüsselung für „${this.space}“ einrichten` : `„${this.space}“ entsperren`);
		contentEl.addClass("tandem-passphrase");
		contentEl.createEl("p", {
			text: set
				? "Dieser Vault wird Ende-zu-Ende-verschlüsselt: Notizen, Dateinamen und Anhänge verlassen dieses Gerät nur verschlüsselt. Der Server – und wer ihn betreibt – kann nichts davon lesen."
				: "Dieser Vault ist Ende-zu-Ende-verschlüsselt. Gib die Passphrase ein, die beim Einrichten festgelegt wurde. Sie wird nur auf diesem Gerät gespeichert.",
		});
		if (set)
			contentEl.createEl("p", {
				cls: "tandem-warning",
				text: "Ohne Passphrase sind die Daten verloren – niemand kann sie zurücksetzen. Schreib sie dir auf. Jedes Gerät und jede eingeladene Person braucht sie.",
			});

		let p1 = "";
		let p2 = "";
		const err = contentEl.createDiv({ cls: "tandem-error" });
		new Setting(contentEl).setName("Passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.autocomplete = set ? "new-password" : "current-password";
			t.setPlaceholder(set ? `mindestens ${MIN_PASSPHRASE} Zeichen` : "").onChange((v) => (p1 = v));
			window.setTimeout(() => t.inputEl.focus(), 50);
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !set) void go();
			});
		});
		if (set)
			new Setting(contentEl).setName("Wiederholen").addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.autocomplete = "new-password";
				t.onChange((v) => (p2 = v));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") void go();
				});
			});

		let btn: HTMLButtonElement | null = null;
		const go = async () => {
			if (this.busy) return;
			err.setText("");
			if (set && p1.length < MIN_PASSPHRASE) return err.setText(`Bitte mindestens ${MIN_PASSPHRASE} Zeichen – am besten mehrere Wörter.`);
			if (set && p1 !== p2) return err.setText("Die beiden Eingaben stimmen nicht überein.");
			if (!p1) return err.setText("Bitte die Passphrase eingeben.");
			this.busy = true;
			if (btn) {
				btn.disabled = true;
				btn.setText(set ? "Richte ein …" : "Prüfe …");
			}
			try {
				await this.submit(p1);
				new Notice(set ? "Tandem: Verschlüsselung eingerichtet." : "Tandem: entsperrt.");
				this.close();
			} catch (e) {
				err.setText((e as Error).message);
			} finally {
				this.busy = false;
				if (btn) {
					btn.disabled = false;
					btn.setText(set ? "Einrichten" : "Entsperren");
				}
			}
		};
		new Setting(contentEl).addButton((b) => {
			btn = b.buttonEl;
			b.setButtonText(set ? "Einrichten" : "Entsperren")
				.setCta()
				.onClick(() => void go());
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
