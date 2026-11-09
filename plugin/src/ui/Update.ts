/**
 * Selbst-Update aus den GitHub-Releases: neueste Version abfragen, main.js/manifest.json/styles.css laden,
 * gegen SHA256SUMS des Releases prüfen, in den Plugin-Ordner schreiben und das Plugin neu laden.
 * Der Plugin-Ordner (.obsidian/) wird nicht synchronisiert – jedes Gerät aktualisiert sich selbst.
 */
import { apiVersion, requestUrl, type App, type PluginManifest } from "obsidian";
import { sha256Hex } from "../disk/diff";

export const UPDATE_REPO = "Gamecat-HD/obsidian-tandem";
const FILES = ["main.js", "manifest.json", "styles.css"] as const;

export interface Release {
	version: string;
	url: string;
	notes: string;
	assets: Record<string, string>;
}

/** Semver-Vergleich (nur Zahlen, Vorabversionen zählen als älter). */
export function newer(a: string, b: string): boolean {
	const parse = (v: string) => {
		const [main, pre] = v.replace(/^v/, "").split("-", 2);
		return { n: main.split(".").map((x) => parseInt(x, 10) || 0), pre: pre ?? "" };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
	return !x.pre && !!y.pre;
}

/** Neuestes Release – oder mit `version` genau dieses (passend zur Server-Version). */
export async function latestRelease(version?: string): Promise<Release> {
	const path = version ? `tags/${encodeURIComponent(version)}` : "latest";
	const r = await requestUrl({ url: `https://api.github.com/repos/${UPDATE_REPO}/releases/${path}`, headers: { Accept: "application/vnd.github+json" }, throw: false });
	if (r.status === 404 && version) throw new Error(`Kein Release ${version} auf GitHub`);
	if (r.status !== 200) throw new Error(r.status === 403 ? "GitHub-Abfragegrenze erreicht – später erneut versuchen" : `GitHub antwortet mit HTTP ${r.status}`);
	const j = r.json as { tag_name: string; html_url: string; body?: string; assets: { name: string; browser_download_url: string }[] };
	return { version: j.tag_name.replace(/^v/, ""), url: j.html_url, notes: j.body ?? "", assets: Object.fromEntries(j.assets.map((a) => [a.name, a.browser_download_url])) };
}

async function download(url: string): Promise<ArrayBuffer> {
	const r = await requestUrl({ url, throw: false });
	if (r.status !== 200) throw new Error(`Download fehlgeschlagen (HTTP ${r.status}): ${url.split("/").pop()}`);
	return r.arrayBuffer;
}

/** Release installieren. Schreibt erst, wenn alle Dateien geladen und geprüft sind. */
export async function installRelease(app: App, manifest: PluginManifest, rel: Release): Promise<void> {
	for (const f of [...FILES, "SHA256SUMS"]) if (!rel.assets[f]) throw new Error(`Im Release ${rel.version} fehlt ${f}`);
	const sums = new Map<string, string>();
	for (const line of new TextDecoder().decode(await download(rel.assets.SHA256SUMS)).split("\n")) {
		const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
		if (m) sums.set(m[2], m[1]);
	}
	const data: Record<string, ArrayBuffer> = {};
	for (const f of FILES) {
		const buf = await download(rel.assets[f]);
		const want = sums.get(f);
		if (!want) throw new Error(`${f} steht nicht in SHA256SUMS`);
		if ((await sha256Hex(buf)) !== want) throw new Error(`${f}: Prüfsumme stimmt nicht – Update abgebrochen`);
		data[f] = buf;
	}
	const m = JSON.parse(new TextDecoder().decode(data["manifest.json"])) as PluginManifest;
	if (m.id !== manifest.id) throw new Error(`Falsches Plugin im Release (${m.id})`);
	if (m.version !== rel.version) throw new Error(`Versionsangaben passen nicht (${m.version} ≠ ${rel.version})`);
	if (m.minAppVersion && newer(m.minAppVersion, apiVersion)) throw new Error(`Tandem ${m.version} braucht Obsidian ${m.minAppVersion} oder neuer`);
	const dir = manifest.dir ?? `${app.vault.configDir}/plugins/${manifest.id}`;
	const ad = app.vault.adapter;
	// Erst daneben schreiben, dann austauschen: Bricht etwas ab, bleibt die alte Fassung lauffähig.
	for (const f of FILES) await ad.writeBinary(`${dir}/${f}.update`, data[f]);
	for (const f of ["styles.css", "main.js", "manifest.json"]) {
		if (await ad.exists(`${dir}/${f}`)) await ad.remove(`${dir}/${f}`);
		await ad.rename(`${dir}/${f}.update`, `${dir}/${f}`);
	}
}

/** Plugin neu laden (lädt die gerade geschriebene main.js). */
export async function reloadPlugin(app: App, id: string): Promise<void> {
	// @ts-expect-error – interne API
	const plugins = app.plugins as { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> };
	await plugins.disablePlugin(id);
	await plugins.enablePlugin(id);
}
