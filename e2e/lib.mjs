// Gemeinsame Helfer für Tandem-E2E-Tests.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./harness.mjs";

export const ROOT = resolve(import.meta.dirname, "..");
export { sleep };

/** Server starten: Referenz (Node, Standard) oder Rust (TANDEM_SERVER=rust). Liefert {url, close, kind}. */
export async function startServer({ rust = false } = {}) {
	if (rust || process.env.TANDEM_SERVER === "rust") {
		const { startRustServer } = await import("./rust-server.mjs");
		return startRustServer();
	}
	const { startReferenceServer } = await import("../protocol/reference-server.mjs");
	const s = await startReferenceServer(0);
	return { kind: "ref", url: `http://127.0.0.1:${s.port}`, tokens: { alice: "tok-alice", bob: "tok-bob", reader: "tok-reader" }, space: "test", close: s.close, raw: s };
}

export async function waitFor(fn, { timeout = 15000, interval = 100, what = "Bedingung" } = {}) {
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end) {
		try {
			last = await fn();
			if (last) return last;
		} catch (e) {
			last = e;
		}
		await sleep(interval);
	}
	throw new Error(`Timeout beim Warten auf ${what} (letzter Wert: ${typeof last === "object" ? JSON.stringify(last) : last})`);
}

/** Obsidian-Instanz mit Tandem starten und anmelden. */
export async function client(server, user, opts = {}) {
	const h = await launch({
		...(process.env.TANDEM_PLUGIN_DIR ? { pluginFrom: process.env.TANDEM_PLUGIN_DIR } : {}),
		data: { enabled: true, serverUrl: server.url, space: server.space, displayName: user, ignore: "" },
		...opts,
	});
	h.user = user;
	if (opts.mobile) {
		void h.evaluate(() => app.emulateMobile(true)).catch(() => {});
		await h.sleep(1500);
		await waitFor(() => h.evaluate(() => !!window.app?.workspace?.layoutReady), { what: "layoutReady nach Mobil-Umschaltung" });
		await h.evaluate(async () => {
			if (!app.plugins.plugins.tandem) await app.plugins.enablePlugin("tandem");
		});
		await waitFor(() => h.evaluate(() => !!app.plugins.plugins.tandem && document.body.hasClass("is-mobile")), { what: "Plugin im Mobil-Modus" });
		await h.evaluate(() => document.querySelector(".mod-trust-folder .modal-header-button, .mod-trust-folder .modal-close-button")?.click());
	}
	if (opts.login !== false) {
		await h.evaluate(
			async (token, device) => {
				app.saveLocalStorage("tandem-token", token);
				app.saveLocalStorage("tandem-device", device);
				await app.plugins.plugins.tandem.restart();
			},
			server.tokens[user],
			opts.device ?? `e2e-${user}`,
		);
	} else return h;
	if (opts.expectOnline === false) return h;
	await waitFor(() => h.evaluate(() => app.plugins.plugins.tandem.conn?.status === "online"), { what: `${user} online` });
	await idle(h);
	return h;
}

export async function idle(h, timeout = 15000) {
	await h.sleep(150);
	await waitFor(
		() => h.evaluate(async () => {
			const s = app.plugins.plugins.tandem.sync;
			if (!s) return false;
			await s.idle();
			return s.pending === 0;
		}),
		{ timeout, what: "Sync idle" },
	);
}

export const readFile = (h, path) =>
	h.evaluate(async (p) => {
		const f = app.vault.getFileByPath(p);
		return f ? await app.vault.read(f) : null;
	}, path);

export const openFile = (h, path) =>
	h.evaluate(async (p) => {
		const f = app.vault.getFileByPath(p);
		await app.workspace.getLeaf(false).openFile(f);
		app.workspace.activeEditor?.editor?.focus();
	}, path);

export const editorText = (h) =>
	h.evaluate(() => app.workspace.activeEditor?.editor?.getValue() ?? null);

/** Echte Tastatureingabe über CDP (wie ein Mensch, Zeichen für Zeichen). */
export async function type(h, text, delay = 15) {
	for (const ch of text) {
		if (ch === "\n") await h.key("Enter", { code: "Enter", text: "\r" });
		else await h.cdp.send("Input.insertText", { text: ch });
		if (delay) await h.sleep(delay);
	}
}

/** Cursor ans Ende einer Zeile (0-basiert) bzw. des Dokuments setzen. */
export const cursorTo = (h, line, ch) =>
	h.evaluate((l, c) => {
		const ed = app.workspace.activeEditor.editor;
		const ln = l < 0 ? ed.lastLine() : l;
		ed.setCursor({ line: ln, ch: c ?? ed.getLine(ln).length });
		ed.focus();
	}, line, ch);

export function check(cond, msg) {
	if (!cond) throw new Error(`Prüfung fehlgeschlagen: ${msg}`);
	console.log(`  ✓ ${msg}`);
}

/** Tandem-Zustand für Prüfungen. */
export const status = (h) => h.evaluate(() => app.plugins.plugins.tandem.conn?.status ?? "none");
export const isBound = (h, path) => h.evaluate((p) => !!app.plugins.plugins.tandem.sync?.binder.isBound(p), path);
