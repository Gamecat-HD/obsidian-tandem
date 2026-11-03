import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { createParams, SpaceKey, unlock } from "./e2ee";

const ITER = 100_000; // in Tests schneller als der Standard

describe("E2EE", () => {
	it("Passphrase: richtige entsperrt, falsche nicht", async () => {
		const { params, key } = await createParams("sp", "korrekt pferd batterie", ITER);
		expect(params.iter).toBe(ITER);
		const again = await unlock("sp", "korrekt pferd batterie", params);
		expect(again).not.toBeNull();
		expect(Array.from(again!.raw)).toEqual(Array.from(key.raw));
		expect(await unlock("sp", "falsch", params)).toBeNull();
		// anderer Space mit denselben Parametern → Prüfwert passt nicht (AAD)
		expect(await unlock("anders", "korrekt pferd batterie", params)).toBeNull();
	});

	it("Doc-Updates: Rundreise, an den Doc-Namen gebunden, manipulationssicher", async () => {
		const { key } = await createParams("sp", "pw", ITER);
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "geheim");
		const u = Y.encodeStateAsUpdate(doc);
		const c = await key.sealDoc("sp/a", u);
		expect(Buffer.from(c).includes(Buffer.from("geheim"))).toBe(false);
		expect(Array.from(await key.openDoc("sp/a", c))).toEqual(Array.from(u));
		await expect(key.openDoc("sp/b", c)).rejects.toThrow();
		const bad = c.slice();
		bad[20] ^= 1;
		await expect(key.openDoc("sp/a", bad)).rejects.toThrow();
		// Schlüssel aus dem Zwischenspeicher wiederherstellen
		const k2 = await SpaceKey.fromRaw("sp", key.raw);
		expect(Array.from(await k2.openDoc("sp/a", c))).toEqual(Array.from(u));
	});

	it("Awareness: Zustände verschlüsselt, null bleibt lesbar", async () => {
		const { key } = await createParams("sp", "pw", ITER);
		const a = new Awareness(new Y.Doc());
		a.setLocalState({ user: { name: "Alice" }, cursor: null });
		const raw = encodeAwarenessUpdate(a, [a.clientID]);
		const sealed = await key.sealAwareness("sp/_index", raw);
		expect(Buffer.from(sealed).includes(Buffer.from("Alice"))).toBe(false);
		const b = new Awareness(new Y.Doc());
		applyAwarenessUpdate(b, await key.openAwareness("sp/_index", sealed), "remote");
		expect(b.getStates().get(a.clientID)).toEqual({ user: { name: "Alice" }, cursor: null });
		a.setLocalState(null);
		const gone = await key.sealAwareness("sp/_index", encodeAwarenessUpdate(a, [a.clientID]));
		expect(Buffer.from(gone).includes(Buffer.from("null"))).toBe(true);
		applyAwarenessUpdate(b, await key.openAwareness("sp/_index", gone), "remote");
		expect(b.getStates().has(a.clientID)).toBe(false);
	});

	it("Anhänge: deterministisch (Dedupe), Adresse = SHA-256 des Chiffretexts", async () => {
		const { key } = await createParams("sp", "pw", ITER);
		const data = new TextEncoder().encode("%PDF-1.7 …");
		const x = await key.sealBlob(data, "abc");
		const y = await key.sealBlob(data, "abc");
		expect(x.ehash).toBe(y.ehash);
		expect(x.ehash).toMatch(/^[0-9a-f]{64}$/);
		expect(new TextDecoder().decode(await key.openBlob(x.data))).toBe("%PDF-1.7 …");
		const other = await key.sealBlob(data, "def");
		expect(other.ehash).not.toBe(x.ehash);
	});
});
