// README-Screenshots: drei echte Obsidian-Instanzen (headless) + Admin-Oberfläche in headless Chromium
// gegen einen frischen lokalen tandem-server mit dem Demo-Vault (e2e/demo-vault). Nichts davon berührt echte Daten.
// Aufruf: node e2e/screenshots.mjs   (INK_BLOCKS_DIR für das Ink-Bild, CHROMIUM für den Browser-Pfad)
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp } from "./harness.mjs";
import { client, cursorTo, idle, isBound, openFile, ROOT, sleep, startServer, type, waitFor } from "./lib.mjs";
import { INK_DIR, inkPlugin, surfaceRect } from "./lib-ink.mjs";

const OUT = resolve(ROOT, "docs/img");
const DEMO = resolve(ROOT, "e2e/demo-vault");
const W = 1280, H = 800;
const withInk = existsSync(join(INK_DIR, "main.js"));

function totp(secret, t = Date.now() / 1000) {
	const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const c of secret) bits += alpha.indexOf(c).toString(2).padStart(5, "0");
	const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(Math.floor(t / 30)));
	const h = createHmac("sha1", key).update(buf).digest();
	const o = h[19] & 15;
	return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

async function shot(h, name) {
	// Hinweise (z. B. „Vault wurde gesichert“) würden das Bild verdecken.
	await h.evaluate(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
	await sleep(250);
	const { data } = await h.cdp.send("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, name), Buffer.from(data, "base64"));
	console.log(`  ✓ docs/img/${name}`);
}

/** Headless Chromium mit CDP-Verbindung. */
async function chromium() {
	const port = 9300 + Math.floor(Math.random() * 500);
	const profile = await mkdtemp(join(tmpdir(), "tandem-shot-"));
	const proc = spawn(process.env.CHROMIUM ?? "chromium", [
		"--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, "--hide-scrollbars",
		// Das Admin-Cookie ist immer `Secure` (__Host-) → Chromium akzeptiert es über http nur für „localhost“.
		"--host-resolver-rules=MAP localhost 127.0.0.1", "about:blank",
	], { stdio: "ignore", detached: true });
	const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"), { what: "Chromium" });
	const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
	await cdp.send("Runtime.enable");
	await cdp.send("Page.enable");
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
	await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	const evaluate = async (expr) => {
		const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	return {
		cdp,
		evaluate,
		async go(url) {
			await cdp.send("Page.navigate", { url });
			await sleep(900);
		},
		async shot(name) {
			const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
			await writeFile(join(OUT, name), Buffer.from(data, "base64"));
			console.log(`  ✓ docs/img/${name}`);
		},
		async close() {
			cdp.close();
			try { process.kill(-proc.pid, "SIGTERM"); } catch {}
			await sleep(300);
			await rm(profile, { recursive: true, force: true });
		},
	};
}

/** Ein Strich aus Punkten in Flächen-Koordinaten (CDP-Pen-Eingabe). */
async function pen(h, r, pts, { lift = true } = {}) {
	const ev = (type, [x, y], extra = {}) =>
		h.cdp.send("Input.dispatchMouseEvent", { type, x: r.x + x, y: r.y + y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: 0.6, ...extra });
	await ev("mouseMoved", pts[0], { button: "none", buttons: 0 });
	await ev("mousePressed", pts[0]);
	for (const p of pts.slice(1)) {
		await ev("mouseMoved", p);
		await sleep(8);
	}
	if (lift) await ev("mouseReleased", pts.at(-1), { buttons: 0 });
}
const line = (x0, y0, x1, y1, n = 14) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const arc = (cx, cy, rx, ry, a0, a1, n = 28) => Array.from({ length: n + 1 }, (_, i) => {
	const a = a0 + ((a1 - a0) * i) / n;
	return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
});

await mkdir(OUT, { recursive: true });
const server = await startServer({ rust: true });
server.cli("space", "add", "gruppe", "Gruppenprojekt");
for (const [u, role] of [["alice", "owner"], ["bob", "write"], ["carol", "write"]]) server.cli("space", "member", "gruppe", u, role);
server.space = "gruppe";
const extra = withInk ? { extraPlugins: [inkPlugin()] } : {};
const handles = [];
const doc = "Projekte/Hausarbeit Netzwerke.md";
const ONLY_ADMIN = !!process.env.ONLY_ADMIN; // schneller Durchlauf nur für die Admin-Bilder
try {
	if (!ONLY_ADMIN) {
	const a = await client(server, "alice", { device: "Laptop", vaultTemplate: DEMO, width: W, height: H, ...extra });
	handles.push(a);
	const b = await client(server, "bob", { device: "Tablet", vaultTemplate: DEMO, width: W, height: H, ...extra });
	handles.push(b);
	const c = await client(server, "carol", { device: "Notebook", vaultTemplate: DEMO, width: W, height: H, ...extra });
	handles.push(c);
	for (const h of handles) await idle(h);

	// 1. Live-Bearbeitung: alle drei in derselben Notiz, Bob tippt gerade

	for (const h of handles) {
		await openFile(h, doc);
		await waitFor(() => isBound(h, doc), { what: `${h.user} gekoppelt` });
	}
	await cursorTo(c, 4);
	await type(c, " (mit Beispielen)", 25);
	// Carol markiert einen Satz → erscheint bei Alice als farbige Markierung
	await c.evaluate(() => {
		const ed = app.workspace.activeEditor.editor;
		const l = ed.getLine(11);
		ed.setSelection({ line: 11, ch: l.indexOf("Subnetting hilft") }, { line: 11, ch: l.length });
	});
	await cursorTo(b, 15);
	await type(b, " Ein /26 teilt es in vier Netze mit je 62 Hosts.", 25);
	await cursorTo(a, 21);
	await waitFor(() => a.evaluate(() => document.querySelector(".tandem-status")?.textContent.includes("tippt")), { what: "„Bob tippt“ bei Alice" });
	await shot(a, "live-editing.png");

	// 2. Präsenz: Wer ist wo? (Dateibaum-Punkte, Avatare, Folgen-Dialog)
	await openFile(c, "Treffen/2026-11-02 Gruppentreffen.md");
	await openFile(a, "Willkommen.md");
	await a.evaluate(() => {
		const ex = app.workspace.getLeavesOfType("file-explorer")[0]?.view;
		for (const p of ["Projekte", "Treffen"]) ex?.fileItems?.[p]?.setCollapsed?.(false);
	});
	await sleep(800);
	await a.evaluate(() => app.commands.executeCommandById("tandem:peers"));
	await sleep(600);
	await shot(a, "presence.png");
	await a.key("Escape", { code: "Escape" });
	await sleep(400);

	// 3. Einstellungen
	// Das native Einstellungsfenster öffnet headless nicht → Tab direkt rendern und als Fenster einblenden (wie m09)
	await a.evaluate(() => {
		const tab = app.setting.pluginTabs.find((t) => t.plugin?.manifest?.id === "tandem");
		tab.display();
		const el = tab.containerEl;
		el.id = "tandem-settings-shot";
		el.addClass("vertical-tab-content");
		Object.assign(el.style, {
			position: "fixed", inset: "48px 170px", zIndex: 999, background: "var(--background-primary)", overflow: "auto",
			padding: "24px 32px", borderRadius: "12px", border: "1px solid var(--background-modifier-border)", boxShadow: "0 16px 48px rgba(0,0,0,.5)",
		});
		const dim = Object.assign(document.createElement("div"), { id: "tandem-settings-dim" });
		Object.assign(dim.style, { position: "fixed", inset: 0, zIndex: 998, background: "rgba(0,0,0,.45)" });
		document.body.append(dim, el);
	});
	await waitFor(() => a.evaluate(() => document.querySelectorAll("#tandem-settings-shot .tandem-members .setting-item").length >= 3), { what: "Mitglieder in den Einstellungen" });
	// Lokale Test-Adresse im Bild durch eine Beispiel-Adresse ersetzen (nur Anzeige)
	await a.evaluate(() => {
		const i = document.querySelector("#tandem-settings-shot input[type=text]");
		if (i) i.value = "https://tandem.example.com";
	});
	await sleep(400);
	await shot(a, "settings.png");
	await a.evaluate(() => ["tandem-settings-shot", "tandem-settings-dim"].forEach((id) => document.getElementById(id)?.remove()));

	// 4. Ink Blocks: Bob sieht Alices Strich, während sie noch schreibt
	if (withInk) {
		for (const h of [a, b]) await waitFor(() => h.evaluate(() => app.plugins.plugins.tandem.ink?.stage === "B"), { what: `${h.user}: Stufe B` });
		await a.evaluate(async () => {
			const f = await app.vault.create("Tafel.md", "# Skizze: VLAN-Routing\n\nRouter-on-a-Stick mit zwei VLANs\n\n");
			await app.workspace.getLeaf().openFile(f, { state: { mode: "source", source: false } });
		});
		await sleep(600);
		await a.evaluate(() => {
			app.workspace.activeEditor.editor.setCursor({ line: 3, ch: 0 });
			app.commands.executeCommandById("obsidian-ink-blocks:insert-notebook");
		});
		await waitFor(() => surfaceRect(a), { what: "Fläche bei Alice" });
		await idle(a);
		await waitFor(() => b.evaluate(() => !!app.vault.getFileByPath("Tafel.md") && app.vault.getFiles().some((f) => f.extension === "ink")), { what: "Tafel bei Bob" });
		await b.evaluate(async () => {
			await app.workspace.getLeaf().openFile(app.vault.getFileByPath("Tafel.md"), { state: { mode: "source", source: false } });
		});
		await waitFor(() => surfaceRect(b), { what: "Fläche bei Bob" });
		await sleep(1000);
		const r = await surfaceRect(a);
		// Router (Kasten) + zwei Switches (Kreise) + Verbindungen, fertig gezeichnet
		await pen(a, r, [[300, 40], [301, 41]]); // erster Kontakt aktiviert die Fläche (Punkt liegt auf der Kastenecke)
		await sleep(400);
		await pen(a, r, [...line(300, 40, 420, 40), ...line(420, 40, 420, 90).slice(1), ...line(420, 90, 300, 90).slice(1), ...line(300, 90, 300, 40).slice(1)]);
		await pen(a, r, arc(180, 200, 45, 30, 0, Math.PI * 2));
		await pen(a, r, arc(540, 200, 45, 30, 0, Math.PI * 2));
		await pen(a, r, line(320, 92, 210, 172));
		await idle(a);
		// …und während Alice die zweite Leitung zieht, schaut Bob zu
		await pen(a, r, line(400, 92, 480, 150, 20), { lift: false });
		await waitFor(() => b.evaluate(() => document.querySelectorAll(".markdown-source-view .ink-remote-stroke").length > 0), { what: "Geist bei Bob" });
		await sleep(300);
		await shot(b, "ink-live.png");
		await a.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 480, y: r.y + 150, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
		await idle(a);
	}

	// 5. Versionsgeschichte im Plugin (Snapshot erzwingen: Server schreibt Fassungen beim Entladen/Speichern)
	await openFile(a, doc);
	await waitFor(() => isBound(a, doc), { what: "Alice gekoppelt" });
	await a.evaluate(() => app.commands.executeCommandById("tandem:history"));
	await sleep(1200);
	if (await a.evaluate(() => document.querySelectorAll(".tandem-history .setting-item").length > 0)) await shot(a, "history.png");
	await a.evaluate(() => document.querySelector(".modal-close-button")?.click());

	}
	// 6. Admin-Oberfläche (dunkles Farbschema wie Obsidian)
	const br = await chromium();
	try {
		const base = server.url.replace("127.0.0.1", "localhost");
		const out = server.cli("admin", "setup", "alice");
		const code = /#setup=([0-9a-zA-Z]+)/.exec(out)[1];
		await br.go(`${base}/admin/`);
		const post = (p, body) =>
			`fetch("/admin/api${p}", { method: "POST", headers: { "Content-Type": "application/json", "X-Tandem-Admin": "1" }, body: ${JSON.stringify(JSON.stringify(body))} }).then((r) => r.json())`;
		const s = await br.evaluate(post("/setup/start", { code, password: "demo-passwort-1234" }));
		await br.evaluate(post("/setup/finish", { code, totp: totp(s.secret) }));
		// Die Seite hat vor der Anmeldung schon die Anmeldemaske gerendert → neu laden
		await br.cdp.send("Page.reload");
		await sleep(900);
		const api = (m, p, body) =>
			br.evaluate(`fetch("/admin/api${p}", { method: "${m}", headers: { "Content-Type": "application/json", "X-Tandem-Admin": "1" }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }).then((r) => r.json())`);
		await api("POST", "/backups", { label: "vor der Abgabe" });

		await br.go(`${base}/admin/#/`);
		await sleep(600);
		await br.shot("admin-overview.png");

		const files = await api("GET", "/spaces/gruppe/files");
		const list = Array.isArray(files) ? files : (files.files ?? files.entries ?? []);
		const entry = list.find((f) => f.path === doc);
		await br.go(`${base}/admin/#/vault/gruppe/${encodeURIComponent(entry?.id ?? "")}`);
		await sleep(900);
		await br.shot("admin-vault.png");

		await br.go(`${base}/admin/#/users`);
		await br.shot("admin-users.png");
		await br.go(`${base}/admin/#/stats`);
		await sleep(600);
		await br.shot("admin-stats.png");
		await br.go(`${base}/admin/#/backups`);
		await br.shot("admin-backups.png");
	} finally {
		await br.close();
	}
} finally {
	for (const h of handles) await h.close().catch(() => {});
	await server.close();
}
