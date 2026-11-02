// Einladen aus Obsidian heraus (ohne Konsole): nur Besitzer, legt Personen an, Code funktioniert.
import { check, client, startServer, status, waitFor } from "../lib.mjs";

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice"); // owner
	const b = await client(server, "bob"); // write
	const handles = [a, b];
	try {
		const r = await a.evaluate(() => app.plugins.plugins.tandem.api.invite("dave", "Dave", "write", 48));
		check(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.code) && r.user === "dave" && r.role === "write", `Besitzerin erzeugt Code für neue Person: ${r.code}`);
		const denied = await b.evaluate(() => app.plugins.plugins.tandem.api.invite("eve", "Eve").then(() => "ok", (e) => e.message));
		check(denied !== "ok", `Nicht-Besitzer darf nicht einladen (${denied})`);
		const self = await a.evaluate(() => app.plugins.plugins.tandem.api.invite("alice", ""));
		check(self.role === "owner", "Code fürs eigene Gerät behält die Rolle (owner)");

		// Dave löst ein
		const d = await client(server, "dave", { login: false });
		handles.push(d);
		const name = await d.evaluate(async (code) => {
			const p = app.plugins.plugins.tandem;
			const n = await p.redeem(code);
			await p.restart();
			return n;
		}, r.code);
		check(name === "Dave", "Dave ist angemeldet");
		await waitFor(async () => (await status(d)) === "online", { what: "Dave online" });
		const ms = await a.evaluate(() => app.plugins.plugins.tandem.api.members());
		const dave = ms.find((m) => m.id === "dave");
		check(dave?.devices.length === 1 && dave.role === "write", `Mitgliederliste zeigt Dave mit Gerät (${dave?.devices[0]?.device})`);

		// Einstellungen zeigen den Bereich (Tab direkt rendern und zum Ansehen einblenden)
		await a.evaluate(() => {
			const tab = app.setting.pluginTabs.find((t) => t.plugin?.manifest?.id === "tandem");
			tab.display();
			const el = tab.containerEl;
			el.id = "tandem-settings-test";
			Object.assign(el.style, { position: "fixed", inset: "40px 200px", zIndex: 999, background: "var(--background-primary)", overflow: "auto", padding: "16px" });
			document.body.appendChild(el);
		});
		await waitFor(() => a.evaluate(() => document.querySelectorAll("#tandem-settings-test .tandem-members .setting-item").length >= 4), { what: "Mitglieder in den Einstellungen" });
		await a.evaluate(() => {
			const s = [...document.querySelectorAll("#tandem-settings-test .setting-item")].find((e) => e.textContent.includes("Weiteres eigenes Gerät"));
			s.querySelector("button").click();
		});
		await waitFor(() => a.evaluate(() => !!document.querySelector("#tandem-settings-test .tandem-code")?.textContent), { what: "Code in den Einstellungen" });
		await a.screenshot("m09-einladen.png");
		check(true, "Code-Erzeugung per Knopf in den Einstellungen");
	} finally {
		for (const h of handles) await h.close();
		await server.close();
	}
}
