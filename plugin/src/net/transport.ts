/**
 * Transport absichern: Token und Inhalte nur über TLS (https/wss) schicken.
 * Ausnahme: der eigene Rechner (Entwicklung, Tests) – dort verlässt nichts das Gerät.
 */
export function checkTransport(serverUrl: string): { ok: true } | { ok: false; reason: string } {
	let u: URL;
	try {
		u = new URL(serverUrl.trim());
	} catch {
		return { ok: false, reason: "Server-Adresse ist ungültig (Beispiel: https://tandem.example.org)." };
	}
	if (u.protocol === "https:" || u.protocol === "wss:") return { ok: true };
	if ((u.protocol === "http:" || u.protocol === "ws:") && isLocal(u.hostname)) return { ok: true };
	return {
		ok: false,
		reason: `Unverschlüsselte Verbindung (${u.protocol}//) abgelehnt – Anmeldedaten und Notizen würden im Klartext übertragen. Bitte die https://-Adresse des Servers eintragen.`,
	};
}

function isLocal(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}
