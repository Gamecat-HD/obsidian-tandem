// Bug 02.11.: Gleichzeitig auf derselben Fläche schreiben/radieren → Änderungen einer Seite gingen verloren.
// Beide zeichnen und radieren in schnellen Runden gleichzeitig; am Ende müssen beide exakt die erwarteten Striche haben.
import { check, client, idle, startServer, waitFor } from "../lib.mjs";
import { INK_ID, inkPlugin, surfaceRect } from "../lib-ink.mjs";
import { latencyProxy } from "../latency-proxy.mjs";

const ROUNDS = Number(process.env.ROUNDS ?? 8);

/** Striche der ersten Fläche als Liste „Zelle“ (aus dem ersten Punkt, Doc-Einheiten). */
const cells = (h) =>
	h.evaluate((id) => {
		const el = document.querySelector(".markdown-source-view .ink-surface");
		const e = app.plugins.plugins[id].store.entries.get(el.dataset.path);
		return e.doc.strokes.map((s) => `${Math.round(s.points[0] / 100)}:${Math.round(s.points[1] / 50)}`).sort();
	}, INK_ID);

const tool = (h, t) => h.evaluate(([id, t]) => (app.plugins.plugins[id].settings.tools.tool = t), [INK_ID, t]);

export default async function () {
	const real = await startServer({ rust: true });
	// ~80 ms pro Richtung wie über das Internet (Cloudflare)
	const proxy = await latencyProxy(real.url, Number(process.env.LATENCY ?? 80));
	const server = { ...real, url: proxy.url };
	const a = await client(server, "alice", { extraPlugins: [inkPlugin()] });
	const b = await client(server, "bob", { extraPlugins: [inkPlugin()] });
	try {
		// Langsames Tablet simulieren: Dateizugriffe bei Bob verzögern (wie langsamer Flash-Speicher)
		const slow = Number(process.env.SLOW_IO ?? 60);
		if (slow)
			await b.evaluate((ms) => {
				const ad = app.vault.adapter;
				for (const k of ["read", "write", "process"]) {
					const orig = ad[k]?.bind(ad);
					if (!orig) continue;
					ad[k] = async (...args) => {
						await new Promise((r) => setTimeout(r, ms));
						return orig(...args);
					};
				}
			}, slow);
		await a.evaluate(async () => {
			const f = await app.vault.create("Gleichzeitig.md", "# Gleichzeitig\n\nText davor\n\n");
			await app.workspace.getLeaf().openFile(f, { state: { mode: "source", source: false } });
		});
		await a.sleep(600);
		await a.evaluate(() => {
			app.workspace.activeEditor.editor.setCursor({ line: 3, ch: 0 });
			app.commands.executeCommandById("obsidian-ink-blocks:insert-notebook");
		});
		await waitFor(() => surfaceRect(a), { what: "Fläche bei Alice" });
		await idle(a);
		await waitFor(() => b.evaluate(() => app.vault.getFiles().some((f) => f.extension === "ink")), { what: ".ink bei Bob" });
		await b.evaluate(() => app.workspace.getLeaf().openFile(app.vault.getFileByPath("Gleichzeitig.md"), { state: { mode: "source", source: false } }));
		await waitFor(() => surfaceRect(b), { what: "Fläche bei Bob" });
		const ra = await surfaceRect(a);
		const rb = await surfaceRect(b);
		const scale = ra.w / 1000;
		// Strich in Zelle (cx, cy): kurze Welle ab Doc-Punkt (cx*100+20, cy*50) – Bildschirmkoordinaten je Instanz
		const stroke = (r, cx, cy) => Array.from({ length: 12 }, (_, i) => [r.x + (cx * 100 + 10 + i * 5) * scale, r.y + (cy * 50 + 6 * Math.sin(i)) * scale, 0.6]);
		// Radierer: senkrechter Strich quer durch die Zelle
		const erase = (r, cx, cy) => Array.from({ length: 10 }, (_, i) => [r.x + (cx * 100 + 40) * scale, r.y + (cy * 50 - 18 + i * 4) * scale, 0.6]);

		const expected = new Set();
		for (let k = 0; k < ROUNDS; k++) {
			const row = 1 + k;
			// gleichzeitig zeichnen: Alice links (Spalte 1), Bob rechts (Spalte 6)
			await Promise.all([
				(async () => {
					await a.draw(stroke(ra, 1, row), { pointerType: "pen", step: 4 });
					await a.draw(stroke(ra, 3, row), { pointerType: "pen", step: 4 });
				})(),
				(async () => {
					await b.draw(stroke(rb, 6, row), { pointerType: "pen", step: 4 });
					await b.draw(stroke(rb, 8, row), { pointerType: "pen", step: 4 });
				})(),
			]);
			expected.add(`1:${row}`).add(`6:${row}`).add(`3:${row}`).add(`8:${row}`);
			if (k >= 1 && k % 2 === 1) {
				// gleichzeitig radieren: Alice radiert Bobs Strich der Vorrunde, Bob radiert Alices Strich der Vorrunde.
				// Man radiert nur, was man sieht → warten, bis der Zielstrich auf der radierenden Seite angekommen ist.
				await waitFor(async () => (await cells(a)).includes(`6:${row - 1}`) && (await cells(b)).includes(`1:${row - 1}`), { what: "Zielstriche sichtbar" });
				await Promise.all([tool(a, "eraser"), tool(b, "eraser")]);
				await Promise.all([a.draw(erase(ra, 6, row - 1), { pointerType: "pen", step: 4 }), b.draw(erase(rb, 1, row - 1), { pointerType: "pen", step: 4 })]);
				await Promise.all([tool(a, "pen"), tool(b, "pen")]);
				expected.delete(`6:${row - 1}`);
				expected.delete(`1:${row - 1}`);
			}
		}
		const want = [...expected].sort();
		let lastA, lastB;
		try {
			await waitFor(
				async () => {
					lastA = await cells(a);
					lastB = await cells(b);
					return JSON.stringify(lastA) === JSON.stringify(want) && JSON.stringify(lastB) === JSON.stringify(want);
				},
				{ timeout: 15000, what: "erwartete Striche auf beiden Seiten" },
			);
		} catch (e) {
			console.log("    erwartet:", want.join(" "));
			console.log("    Alice:   ", lastA.join(" "));
			console.log("    Bob:     ", lastB.join(" "));
			throw e;
		}
		check(true, `${ROUNDS} Runden gleichzeitig zeichnen/radieren: beide haben genau die ${want.length} erwarteten Striche`);
		await idle(a);
		await idle(b);
		const file = (h) => h.evaluate(() => app.vault.read(app.vault.getFiles().find((f) => f.extension === "ink")));
		await waitFor(async () => (await file(a)) === (await file(b)), { what: ".ink identisch" });
		check(true, ".ink-Dateien identisch");
	} finally {
		await a.close();
		await b.close();
		await proxy.close();
		await real.close();
	}
}
