// Startet eine isolierte, headless Obsidian-Instanz (eigener XDG_CONFIG_HOME, frischer Test-Vault)
// und steuert sie per Chrome DevTools Protocol. Die laufende Obsidian-Instanz des Nutzers bleibt unberührt.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile, writeFile as wf } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const REPO = join(ROOT, "plugin");
const PLUGIN_ID = "tandem";

export class Cdp {
	#ws;
	#id = 0;
	#pending = new Map();
	#listeners = new Map();

	static async connect(url) {
		const cdp = new Cdp();
		cdp.#ws = new WebSocket(url);
		await new Promise((ok, fail) => {
			cdp.#ws.onopen = ok;
			cdp.#ws.onerror = fail;
		});
		cdp.#ws.onmessage = (msg) => cdp.#onMessage(JSON.parse(msg.data));
		return cdp;
	}

	#onMessage(m) {
		if (m.id !== undefined) {
			const p = this.#pending.get(m.id);
			this.#pending.delete(m.id);
			if (m.error) p?.fail(new Error(`${m.error.message} ${m.error.data ?? ""}`));
			else p?.ok(m.result);
		} else {
			for (const fn of this.#listeners.get(m.method) ?? []) fn(m.params);
		}
	}

	send(method, params = {}) {
		const id = ++this.#id;
		this.#ws.send(JSON.stringify({ id, method, params }));
		return new Promise((ok, fail) => this.#pending.set(id, { ok, fail }));
	}

	on(method, fn) {
		if (!this.#listeners.has(method)) this.#listeners.set(method, []);
		this.#listeners.get(method).push(fn);
	}

	close() {
		this.#ws.close();
	}
}

/** Freien TCP-Port vom Betriebssystem holen. */
function freePort() {
	return new Promise((ok, fail) => {
		const srv = createServer();
		srv.on("error", fail);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => ok(port));
		});
	});
}

async function waitFor(fn, { timeout = 20000, interval = 200, what = "Bedingung" } = {}) {
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
	throw new Error(`Timeout beim Warten auf ${what} (${last})`);
}

/**
 * @param {{ vaultTemplate?: string, port?: number, width?: number, height?: number, dpr?: number, keep?: boolean, ozone?: "headless" | "wayland" }} opts
 *   `ozone: "wayland"` öffnet ein echtes Fenster (für Tests mit echter bzw. virtueller Stift-Eingabe, scripts/e2e/pen/).
 */
export async function launch(opts = {}) {
	const { width = 1280, height = 900, dpr = 1, ozone = "headless" } = opts;
	const port = opts.port ?? (await freePort());
	const root = await mkdtemp(join(tmpdir(), "tandem-e2e-"));
	const config = join(root, "config");
	const vault = join(root, "vault");
	await mkdir(join(config, "obsidian"), { recursive: true });

	// Gleiche App-Version wie die Nutzer-Instanz verwenden, falls ein Update-asar existiert.
	const userCfg = join(homedir(), ".config/obsidian");
	for (const f of existsSync(userCfg) ? await readdir(userCfg) : []) {
		if (/^obsidian-[\d.]+\.asar$/.test(f)) await cp(join(userCfg, f), join(config, "obsidian", f));
	}

	await cp(opts.vaultTemplate ?? join(ROOT, "e2e/vault-template"), vault, { recursive: true });
	const pluginDir = join(vault, ".obsidian/plugins", PLUGIN_ID);
	await mkdir(pluginDir, { recursive: true });
	for (const f of ["main.js", "manifest.json", "styles.css"]) await cp(join(opts.pluginFrom ?? REPO, f), join(pluginDir, f));
	if (opts.data) await writeFile(join(pluginDir, "data.json"), JSON.stringify(opts.data));
	// Weitere Plugins (z. B. Ink Blocks): { id, dir, data? }
	const extraIds = [];
	for (const x of opts.extraPlugins ?? []) {
		const d = join(vault, ".obsidian/plugins", x.id);
		await mkdir(d, { recursive: true });
		for (const f of ["main.js", "manifest.json", "styles.css"]) if (existsSync(join(x.dir, f))) await cp(join(x.dir, f), join(d, f));
		if (x.data) await writeFile(join(d, "data.json"), JSON.stringify(x.data));
		extraIds.push(x.id);
	}
	// Plugins aus einer Vorlage (z. B. Kopie eines echten Vaults) bleiben aktiv.
	const pluginList = join(vault, ".obsidian/community-plugins.json");
	const enabled = existsSync(pluginList) ? JSON.parse(await readFile(pluginList, "utf8")) : [];
	await writeFile(pluginList, JSON.stringify([...new Set([...enabled, ...extraIds, PLUGIN_ID])]));
	await wf(
		join(config, "obsidian/obsidian.json"),
		JSON.stringify({ vaults: { [opts.vaultId ?? "e2e" + Math.random().toString(16).slice(2, 15)]: { path: vault, ts: Date.now(), open: true } } }),
	);

	const proc = spawn(
		"electron43",
		["/usr/lib/obsidian/app.asar", `--remote-debugging-port=${port}`, `--ozone-platform=${ozone}`],
		{ env: { ...process.env, XDG_CONFIG_HOME: config }, stdio: ["ignore", "pipe", "pipe"], detached: true },
	);
	const exited = new Promise((ok) => proc.on("exit", ok));
	const procLog = [];
	proc.stdout.on("data", (d) => procLog.push(String(d)));
	proc.stderr.on("data", (d) => procLog.push(String(d)));

	const target = await waitFor(
		async () => {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			return list.find((t) => t.type === "page" && t.url.startsWith("app://obsidian.md/index.html"));
		},
		{ what: "Obsidian-Fenster" },
	).catch((e) => {
		try {
			process.kill(-proc.pid, "SIGTERM");
		} catch {}
		throw new Error(`${e.message}\n--- Obsidian-Log ---\n${procLog.join("").slice(-3000)}`);
	});

	const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
	const logs = [];
	cdp.on("Runtime.consoleAPICalled", (p) =>
		logs.push(`[${p.type}] ${p.args.map((a) => a.value ?? a.description ?? a.type).join(" ")}`),
	);
	cdp.on("Runtime.exceptionThrown", (p) =>
		logs.push(`[exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`),
	);
	await cdp.send("Runtime.enable");
	await cdp.send("Page.enable");
	// Ein echtes Fenster behält seine Größe und DPR (sonst stimmen Bildschirm- und Seitenkoordinaten nicht überein).
	if (ozone === "headless") await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });

	const h = {
		root,
		vault,
		cdp,
		logs,
		procLog,
		evalTimeout: 60000,
		sleep,
		waitFor,

		/** Führt Code im Renderer aus. `fn` als Funktion (mit JSON-Argumenten) oder als Ausdruck-String. */
		async evaluate(fn, ...args) {
			const call = typeof fn === "function" ? `(${fn})(...${JSON.stringify(args)})` : fn;
			// Nur JSON-fähige Rückgabewerte (Obsidian-Objekte wie TFile sind zirkulär).
			const expression = `Promise.resolve(${call}).then((v) => { try { return v === undefined ? v : JSON.parse(JSON.stringify(v)); } catch { return String(v); } })`;
			let timer;
			const r = await Promise.race([
				cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
				new Promise((_, fail) => {
					timer = setTimeout(() => fail(new Error(`evaluate: Timeout nach ${h.evalTimeout} ms`)), h.evalTimeout);
				}),
			]).finally(() => clearTimeout(timer));
			if (r.exceptionDetails) {
				throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
			}
			return r.result.value;
		},

		async screenshot(file) {
			const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
			const out = resolve(ROOT, "e2e-out", file);
			await mkdir(resolve(out, ".."), { recursive: true });
			await writeFile(out, Buffer.from(data, "base64"));
			return out;
		},

		/** Strich per CDP-Input: points = [[x, y, pressure?], …] in Viewport-Koordinaten. */
		async draw(points, { pointerType = "mouse", button = "left", buttons = 1, step = 8 } = {}) {
			const ev = (type, [x, y, p = 0.5], extra = {}) =>
				cdp.send("Input.dispatchMouseEvent", {
					type, x, y, button, buttons, clickCount: 1, pointerType, force: p, ...extra,
				});
			await ev("mouseMoved", points[0], { button: "none", buttons: 0 });
			await ev("mousePressed", points[0]);
			for (let i = 1; i < points.length; i++) {
				await ev("mouseMoved", points[i]);
				if (step) await sleep(step);
			}
			await ev("mouseReleased", points.at(-1), { buttons: 0 });
		},

		async click(x, y) {
			for (const type of ["mousePressed", "mouseReleased"]) {
				await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: 1, clickCount: 1 });
			}
		},

		async key(key, { code, modifiers = 0, text } = {}) {
			await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, text });
			await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
		},

		async close() {
			try {
				cdp.close();
			} catch {}
			try {
				process.kill(-proc.pid, "SIGTERM");
			} catch {}
			await Promise.race([exited, sleep(5000)]);
			if (!opts.keep) await rm(root, { recursive: true, force: true });
		},
	};

	try {
		await waitFor(() => h.evaluate(() => !!window.app?.workspace?.layoutReady), { what: "layoutReady" });
		await h.evaluate(async (id) => {
			await app.plugins.setEnable(true);
			if (!app.plugins.enabledPlugins.has(id)) await app.plugins.enablePluginAndSave(id);
		}, PLUGIN_ID);
		await waitFor(() => h.evaluate((id) => !!app.plugins.plugins[id], PLUGIN_ID), { what: "Plugin geladen" });
		// "Vertraust du dem Ersteller …"-Dialog per X schließen. Die Plugins sind über setEnable bereits aktiv.
		// (Der Button "Vertrauen" hinterlässt in Obsidian 1.14 einen Zustand, in dem keine Modals mehr öffnen.)
		if (opts.trust !== false) {
			await waitFor(
				() =>
					h.evaluate(() => {
						const x = document.querySelector(".mod-trust-folder .modal-header-button, .mod-trust-folder .modal-close-button");
						x?.click();
						return !!x;
					}),
				{ timeout: 5000, what: "Vertrauens-Dialog" },
			).catch(() => {});
			await sleep(200);
		}
	} catch (e) {
		await h.close();
		throw new Error(`${e.message}\n--- Obsidian-Log ---\n${procLog.join("").slice(-3000)}`);
	}
	return h;
}
