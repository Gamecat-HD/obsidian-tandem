// „Tippt gerade“ endet nach TYPING_MS, auch wenn danach weiter Zeiger-/Strich-Updates (Awareness) eintreffen.
import { check, client, startServer, waitFor } from "../lib.mjs";

const peerTyping = (h) => h.evaluate(() => app.plugins.plugins.tandem.presence.peers.find((p) => p.user.id === "bob")?.typing ?? null);

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice");
	const b = await client(server, "bob");
	try {
		await waitFor(async () => (await peerTyping(a)) === false, { what: "Bob bei Alice sichtbar" });
		await b.evaluate(() => app.plugins.plugins.tandem.presence.publish(true));
		await waitFor(async () => (await peerTyping(a)) === true, { what: "Bob tippt (bei Alice)" });
		check(true, "„tippt gerade“ kommt an");
		// 6 s lang nur Zeiger bewegen (wie die InkBridge: Feld ptr, 10/s)
		const t0 = Date.now();
		while (Date.now() - t0 < 6000) {
			await b.evaluate((i) => app.plugins.plugins.tandem.presence.awareness.setLocalStateField("ptr", { file: "x.ink", x: i, y: i, k: "mouse" }), Date.now() - t0);
			await b.sleep(100);
		}
		check((await peerTyping(a)) === false, "Zeiger-Updates verlängern „tippt gerade“ nicht (nach 6 s aus)");
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
