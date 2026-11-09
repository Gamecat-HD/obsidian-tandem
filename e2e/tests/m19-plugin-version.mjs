// Der Server bedient nur das Plugin mit genau seiner eigenen Version: Ein anderes Plugin wird beim HELLO
// abgelehnt, verbindet sich nicht ständig neu und bietet das passende Release an; die Plugin-Routen per HTTP
// verlangen dieselbe Kennung. Andere Clients (Lernplattform) melden sich mit eigener Kennung. Rust-Server.
import { cp, mkdtemp, readFile as readFs, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { CLIENT, ROOT, check, client, sleep, startServer, status, waitFor } from "../lib.mjs";

const require = createRequire(resolve(ROOT, "plugin/package.json"));
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const WebSocket = require("ws");

/** Rohes HELLO (optional mit Kennung) → erste Antwort {type, code?, msg?}. */
function hello(url, token, client) {
	return new Promise((ok, fail) => {
		const ws = new WebSocket(url.replace("http", "ws") + "/ws");
		ws.binaryType = "arraybuffer";
		ws.on("open", () => {
			const e = encoding.createEncoder();
			encoding.writeVarUint(e, 0);
			encoding.writeVarUint(e, 1);
			encoding.writeVarString(e, token);
			encoding.writeVarString(e, "roh");
			if (client !== undefined) encoding.writeVarString(e, client);
			ws.send(encoding.toUint8Array(e));
		});
		ws.on("error", fail);
		ws.on("message", (raw) => {
			const d = decoding.createDecoder(new Uint8Array(raw));
			const type = decoding.readVarUint(d);
			const out = type === 5 ? { type, code: decoding.readVarUint(d), doc: decoding.readVarString(d), msg: decoding.readVarString(d) } : { type };
			ws.close();
			ok(out);
		});
	});
}

export default async function () {
	const server = await startServer({ rust: true });
	const version = CLIENT.split("/")[1];
	const old = await mkdtemp(join(tmpdir(), "tandem-altes-plugin-"));
	const handles = [];
	try {
		// 1. Protokoll: nur passendes Plugin, Lernplattform frei, ohne Kennung = altes Plugin
		const tok = server.tokens.alice;
		check((await hello(server.url, tok, CLIENT)).type === 1, "passendes Plugin bekommt WELCOME");
		check((await hello(server.url, tok, "lernplattform")).type === 1, "andere Clients (Lernplattform) werden bedient");
		const none = await hello(server.url, tok);
		check(none.type === 5 && none.code === 505 && none.doc === "", `Plugin ohne Kennung (vor 0.8.2) abgelehnt: ${none.msg}`);
		const other = await hello(server.url, tok, "tandem-plugin/0.0.1");
		check(other.code === 505 && other.msg.includes(`Tandem-Server ${version}`) && other.msg.includes("0.0.1"), "falsche Plugin-Version abgelehnt, Meldung nennt beide Versionen");
		const badTok = await hello(server.url, "falsch", "tandem-plugin/0.0.1");
		check(badTok.code === 505, "Versionsprüfung vor der Anmeldung (verrät nichts über Tokens)");

		// 2. HTTP: Plugin-Routen nur mit passender Kennung, Lese-API der Lernplattform ohne
		const get = (p, h = {}) => fetch(`${server.url}${p}`, { headers: { Authorization: `Bearer ${tok}`, ...h } });
		check((await get("/api/members/test")).status === 426, "Plugin-Route ohne Kennung → 426");
		check((await get("/api/members/test", { "X-Tandem-Client": "tandem-plugin/0.0.1" })).status === 426, "Plugin-Route mit falscher Version → 426");
		check((await get("/api/members/test", { "X-Tandem-Client": CLIENT })).status === 200, "Plugin-Route mit passender Version → 200");
		check((await get("/api/files/test")).status === 200, "Lese-API (Lernplattform) braucht keine Kennung");

		// 3. Echtes Obsidian mit Plugin 0.0.1
		for (const f of ["main.js", "manifest.json", "styles.css"]) await cp(join(ROOT, "plugin", f), join(old, f));
		const m = JSON.parse(await readFs(join(old, "manifest.json"), "utf8"));
		await writeFile(join(old, "manifest.json"), JSON.stringify({ ...m, version: "0.0.1" }));
		const a = await client(server, "alice", { pluginFrom: old, expectOnline: false });
		handles.push(a);
		await waitFor(async () => (await status(a)) === "outdated", { what: "Status „outdated“" });
		check(true, "Plugin 0.0.1 wird abgelehnt");
		await waitFor(() => a.evaluate(() => !!document.querySelector(".notice")), { what: "Hinweis" });
		const info = await a.evaluate(() => ({
			server: app.plugins.plugins.tandem.serverVersion,
			bar: document.querySelector(".tandem-status")?.textContent ?? "",
			notice: [...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | "),
		}));
		check(info.server === version, `Plugin kennt die Server-Version (${info.server})`);
		check(info.bar.includes("Plugin-Version passt nicht"), `Statusleiste: ${info.bar.trim()}`);
		check(info.notice.includes(`Tandem-Server ${version}`), "Hinweis nennt die Server-Version");
		await sleep(3000);
		check((await status(a)) === "outdated", "kein Wiederverbinden in Schleife");

		// 4. Passendes Plugin läuft normal
		const b = await client(server, "bob");
		handles.push(b);
		check((await status(b)) === "online", `Plugin ${version} ist online`);
	} finally {
		for (const h of handles) await h.close().catch(() => {});
		await rm(old, { recursive: true, force: true });
		await server.close();
	}
}
