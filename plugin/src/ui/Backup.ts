/**
 * Vault-Sicherung vor dem ersten Abgleich (nur Desktop): vollständige Kopie neben den Vault-Ordner,
 * z. B. `Mein Vault.tandem-sicherung-2026-11-02-1530`. Auf Mobilgeräten gibt es keinen Dateisystemzugriff
 * außerhalb des Vaults – dort wird nur ein Hinweis gezeigt.
 */
import { FileSystemAdapter, Platform, type App } from "obsidian";

export function canBackup(app: App): boolean {
	return Platform.isDesktopApp && app.vault.adapter instanceof FileSystemAdapter;
}

export async function backupVault(app: App): Promise<string> {
	if (!canBackup(app)) throw new Error("Sicherung nur in der Desktop-App möglich");
	const base = (app.vault.adapter as FileSystemAdapter).getBasePath();
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const target = `${base.replace(/[\\/]+$/, "")}.tandem-sicherung-${stamp}`;
	// Node-fs der Desktop-App (Electron); nicht typisiert, weil das Plugin auch mobil gebaut wird.
	const fs = (window as unknown as { require(m: string): NodeFs }).require("fs");
	await fs.promises.cp(base, target, {
		recursive: true,
		errorOnExist: true,
		force: false,
		// Papierkorb und Zwischenstände von Atomic-Writes braucht niemand in der Sicherung
		filter: (src: string) => !/[\\/]\.trash([\\/]|$)/.test(src.slice(base.length)) && !/\.tmp\.\d+\.[0-9a-f]+$/.test(src),
	});
	return target;
}

interface NodeFs {
	promises: {
		cp(src: string, dst: string, opts: { recursive: boolean; errorOnExist: boolean; force: boolean; filter(src: string): boolean }): Promise<void>;
	};
}
