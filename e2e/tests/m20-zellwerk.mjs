// M20: Excel-Tabellen (Zellwerk) live gemeinsam bearbeiten über die Live-API.
//  - Eingaben erscheinen beim anderen sofort, Formeln rechnen dort nach
//  - Zellcursor der anderen sichtbar
//  - Zeile einfügen + gleichzeitig bearbeiten → beide gleich, richtige Zeile
//  - genau ein Gerät schreibt die Datei; keine Konfliktkopien
//  - Schließt der Schreiber, übernimmt der andere
//  - Änderung von außen (anderes Programm) wird in die offene Tabelle übernommen
import { readdir } from "node:fs/promises";
import { check, client, idle, startServer, waitFor } from "../lib.mjs";
import { ZW_ID, cells, openSheet, readXlsx, sessionInfo, typeIn, writeBinary, xlsxBase64, zw, zwPlugin } from "../lib-zellwerk.mjs";

const conflictFiles = async (h) => (await readdir(h.vault)).filter((f) => f.includes("Konflikt"));

export default async function () {
	const server = await startServer({ rust: true });
	const a = await client(server, "alice", { extraPlugins: [zwPlugin()] });
	const b = await client(server, "bob", { extraPlugins: [zwPlugin()] });
	try {
		for (const h of [a, b]) {
			await waitFor(() => h.evaluate((id) => !!app.plugins.plugins[id] && !!app.plugins.plugins.tandem.api.live, ZW_ID), { what: `${h.user}: Zellwerk + Live-API` });
		}
		const b64 = await xlsxBase64((ws) => {
			ws.getCell("A1").value = "Name";
			ws.getCell("B1").value = "Punkte";
			ws.getCell("A2").value = "Anna";
			ws.getCell("B2").value = 12;
			ws.getCell("B5").value = { formula: "SUM(B2:B4)", result: 12 };
		});
		await writeBinary(a, "Noten.xlsx", b64);
		await idle(a);
		await waitFor(() => b.evaluate(() => !!app.vault.getFileByPath("Noten.xlsx")), { what: "Datei bei Bob" });
		await idle(b);
		await openSheet(a, "Noten.xlsx");
		await openSheet(b, "Noten.xlsx");
		for (const h of [a, b]) await waitFor(async () => (await sessionInfo(h))?.linked, { what: `${h.user}: Tabelle live gekoppelt`, timeout: 20000 });
		await waitFor(async () => (await sessionInfo(a))?.peers === 1 && (await sessionInfo(b))?.peers === 1, { what: "beide sehen einander" });
		check(true, "beide Ansichten über Tandem gekoppelt und sehen einander");
		const sa = await sessionInfo(a);
		const sb = await sessionInfo(b);
		check(sa.writer !== sb.writer, `genau ein Gerät schreibt die Datei (${sa.writer ? "Alice" : "Bob"})`);

		// Live-Eingabe + Nachrechnen beim anderen
		const t0 = Date.now();
		await typeIn(a, 2, 0, "Ben");
		await typeIn(a, 2, 1, "7");
		await waitFor(async () => {
			const c = await cells(b);
			return c[2][0] === "Ben" && c[4][1] === "=SUM(B2:B4)=19";
		}, { interval: 20, what: "Eingabe + Formel bei Bob" }).catch(async (e) => {
			console.log("A", JSON.stringify(await cells(a, 6, 2)), "B", JSON.stringify(await cells(b, 6, 2)));
			console.log([...a.logs, "----", ...b.logs].filter((l) => /zellwerk|exception|error|warn/i.test(l)).slice(-14).join("\n"));
			throw e;
		});
		console.log(`    bei Bob sichtbar nach ${Date.now() - t0} ms`);
		check(true, "Alices Eingabe erscheint sofort bei Bob, Formel rechnet dort nach (19)");

		// Zellcursor
		await zw(b, (v) => v.api.workbook().setSelection([{ row: [2, 2], column: [1, 1] }]));
		await waitFor(async () => {
			const p = await zw(a, (v) => v.api.presences());
			return p?.some((x) => x.username === "Bob" && x.selection.r === 2 && x.selection.c === 1);
		}, { what: "Bobs Zellcursor bei Alice" });
		check(true, "Alice sieht Bobs Zellcursor (B3) mit Namen");
		await a.screenshot("m20-alice-cursor.png");

		// Gleichzeitig: Alice fügt oben eine Zeile ein, Bob schreibt unter „Ben“
		await Promise.all([
			zw(a, (v) => v.api.workbook().insertRowOrColumn("row", 0, 1, "lefttop")),
			typeIn(b, 3, 0, "Carla"),
		]);
		await waitFor(async () => JSON.stringify(await cells(a, 8, 3)) === JSON.stringify(await cells(b, 8, 3)) && (await cells(a))[4][0] === "Carla", { what: "gleicher Stand nach gleichzeitiger Änderung" }).catch(async (e) => {
			console.log("A", JSON.stringify(await cells(a, 8, 3)));
			console.log("B", JSON.stringify(await cells(b, 8, 3)));
			console.log("A-Doc", JSON.stringify(await zw(a, (v) => v.api.binding.axes.get(v.api.sheets()[0].id)?.rows.slice(0, 8))));
			console.log("B-Doc", JSON.stringify(await zw(b, (v) => v.api.binding.axes.get(v.api.sheets()[0].id)?.rows.slice(0, 8))));
			console.log([...a.logs, ...b.logs].filter((l) => /zellwerk|exception|error/i.test(l)).slice(-10).join("\n"));
			throw e;
		});
		const ca = await cells(a, 8, 3);
		check(ca[1][0] === "Name" && ca[3][0] === "Ben" && ca[4][0] === "Carla", "Zeile eingefügt + gleichzeitig geschrieben: beide gleich, Carla unter Ben");
		check(ca[5][1] === "=SUM(B3:B5)=19", `Formel wurde beim Einfügen angepasst und rechnet (${ca[5][1]})`);
		// Deutsche Zahleneingabe + Nachrechnen beim anderen
		await typeIn(b, 4, 1, "2,5");
		await waitFor(async () => (await cells(a))[5][1] === "=SUM(B3:B5)=21.5", { what: "„2,5“ als Zahl, Summe bei Alice 21,5" });
		check(true, "„2,5“ wird als Zahl übernommen, Summe rechnet bei Alice nach (21,5)");

		// Datei auf der Platte (Schreiber) und beim anderen (über Anhang-Sync)
		await a.sleep(1500);
		await idle(a);
		await idle(b);
		const wa = await readXlsx(`${a.vault}/Noten.xlsx`);
		const wbB = await readXlsx(`${b.vault}/Noten.xlsx`);
		const dump = (wb) => JSON.stringify(wb.getWorksheet("Noten").getSheetValues());
		await waitFor(async () => dump(await readXlsx(`${a.vault}/Noten.xlsx`)) === dump(await readXlsx(`${b.vault}/Noten.xlsx`)), { what: "Dateien gleich" });
		const ws = (await readXlsx(`${a.vault}/Noten.xlsx`)).getWorksheet("Noten");
		check(ws.getCell("A5").value === "Carla" && ws.getCell("B6").value?.formula === "SUM(B3:B5)", "Datei enthält den gemeinsamen Stand (bei beiden gleich)");
		check(!(await conflictFiles(a)).length && !(await conflictFiles(b)).length, "keine Konfliktkopien");
		void wa;
		void wbB;

		// Schreiber schließt → der andere übernimmt
		const writer = sa.writer ? a : b;
		const other = writer === a ? b : a;
		await writer.evaluate(() => app.workspace.getLeavesOfType("zellwerk-sheet").forEach((l) => l.detach()));
		await waitFor(async () => (await sessionInfo(other))?.writer, { what: "anderes Gerät wird Schreiber", timeout: 40000 });
		await typeIn(other, 0, 2, "Neu");
		await waitFor(async () => (await readXlsx(`${writer.vault}/Noten.xlsx`)).getWorksheet("Noten").getCell("C1").value === "Neu", { what: "Änderung kommt als Datei beim geschlossenen Gerät an", timeout: 20000 });
		check(true, `${writer.user} schließt die Tabelle → ${other.user} schreibt, Datei kommt bei ${writer.user} an`);

		// Änderung von außen (anderes Programm) beim Gerät ohne offene Tabelle
		const ext = await readXlsx(`${writer.vault}/Noten.xlsx`);
		ext.getWorksheet("Noten").getCell("D1").value = "Extern";
		await writeBinary(writer, "Noten.xlsx", Buffer.from(await ext.xlsx.writeBuffer()).toString("base64"));
		await idle(writer);
		await waitFor(async () => (await cells(other, 3, 5))[0][3] === "Extern", { what: "Fremdänderung in der offenen Tabelle", timeout: 20000 }).catch(async (e) => {
			const disk = (await readXlsx(`${other.vault}/Noten.xlsx`)).getWorksheet("Noten").getCell("D1").value;
			const disk2 = (await readXlsx(`${writer.vault}/Noten.xlsx`)).getWorksheet("Noten").getCell("D1").value;
			console.log("D1 auf Platte (offen/geschlossen):", disk, disk2, JSON.stringify(await cells(other, 3, 5)), JSON.stringify(await sessionInfo(other)));
			const st = (h) => h.evaluate(async () => {
				const s = app.plugins.plugins.tandem.sync;
				const id = s.index.idForPath("Noten.xlsx");
				const e = s.index.get(id);
				const f = app.vault.getFileByPath("Noten.xlsx");
				const buf = await app.vault.readBinary(f);
				const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
				return { idx: e.hash.slice(0, 8), parent: e.parent?.slice(0, 8), disk: h.slice(0, 8), pend: s.pending };
			});
			console.log("offen", JSON.stringify(await st(other)), "geschlossen", JSON.stringify(await st(writer)));
			console.log([...other.logs, "----", ...writer.logs].filter((l) => /zellwerk|tandem|exception|error/i.test(l) && !/Electron/.test(l)).slice(-16).join("\n"));
			throw e;
		});
		const co = await cells(other, 6, 3);
		check(co[4][0] === "Carla" && co[0][2] === "Neu", "Änderung von außen übernommen, eigener Stand bleibt erhalten");
		await idle(other);
		await other.sleep(1500);
		check(!(await conflictFiles(a)).length && !(await conflictFiles(b)).length, "weiterhin keine Konfliktkopien");
		await other.screenshot("m20-tabelle.png");

		// Inline: Tabelle in einer Notiz bearbeiten, der andere hat sie als Tab offen
		await writer.evaluate(async () => {
			const f = await app.vault.create("Notiz.md", "# Notiz\n\n![[Noten.xlsx]]\n");
			await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source", source: false } });
		});
		await writer.waitFor(() => writer.evaluate(() => !!document.querySelector(".zw-embed-edit")), { what: "Vorschau in der Notiz", timeout: 20000 });
		await writer.evaluate(() => document.querySelector(".zw-embed-edit").click());
		await writer.waitFor(() => writer.evaluate(() => [...app.plugins.plugins.zellwerk.embeds].some((e) => e.api?.sheets()[0]?.data && e.api.cellCenter(0, 0))), { what: "inline bearbeitbar", timeout: 20000 });
		const p = await writer.evaluate(() => [...app.plugins.plugins.zellwerk.embeds].find((e) => e.api).api.cellCenter(2, 3));
		await writer.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
		await writer.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
		await writer.sleep(100);
		for (const ch of "Inline") {
			await writer.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
			await writer.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
		}
		await writer.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
		await writer.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
		await waitFor(async () => (await cells(other, 3, 5))[2][3] === "Inline", { what: "Inline-Eingabe beim anderen", timeout: 10000 });
		check(true, `${writer.user} tippt inline in einer Notiz → erscheint live in ${other.user}s Tabelle`);
		check((await writer.evaluate(() => app.vault.read(app.vault.getFileByPath("Notiz.md")))) === "# Notiz\n\n![[Noten.xlsx]]\n", "Notiztext bleibt unverändert");

		const errs = [...a.logs, ...b.logs].filter((l) => /\[exception\]|zellwerk.*(fehlgeschlagen|error)/i.test(l));
		check(errs.length === 0, `keine Fehler im Log${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
	} finally {
		await a.close();
		await b.close();
		await server.close();
	}
}
