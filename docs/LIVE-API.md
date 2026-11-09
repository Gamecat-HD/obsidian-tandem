# Live-API für Partner-Plugins

Ab Tandem 0.7 unter `app.plugins.plugins.tandem.api.live` (`version: 1`). Erster Nutzer: [Zellwerk](https://github.com/Gamecat-HD/obsidian-zellwerk).

## Idee

Dateien, die Tandem als **Anhang** synchronisiert (alles außer `.md`/`.txt`/`.ink`), bekommen auf Wunsch ein
**Begleit-Dokument** (`<docId>-live`, ein normales Yjs-Doc im selben Space – auch Ende-zu-Ende-verschlüsselt).
Das Partner-Plugin legt dort seinen Inhalt in eigener Struktur ab und bekommt Präsenz (Awareness) dazu.

Die Datei selbst bleibt ein Anhang. Dadurch:

- bekommen Geräte ohne Partner-Plugin und ältere Tandem-Versionen die Datei unverändert,
- muss der Server nichts Neues können,
- ist das Partner-Plugin dafür zuständig, dass nur **ein** Gerät die Datei aus dem Dokument schreibt.

Ausgetauscht werden nur **Bytes** (Yjs-Updates). Jede Seite behält ihre eigene Yjs-Kopie – Yjs-Objekte über
Plugin-Grenzen zu reichen bricht dessen `instanceof`-Prüfungen.

## Schnittstelle

```ts
interface TandemLiveApi {
	version: number; // 1
	/** Kanal zum Begleit-Dokument; null, wenn die Datei (noch) nicht als Anhang im Index steht. */
	open(path: string): Promise<LiveChannel | null>;
	/** Für Dateiendung: Steckt dieser lokale Stand (SHA-256) schon im Begleit-Dokument? */
	registerFileType(ext: string, handler: { represented(path: string, hash: string): boolean }): () => void;
}

interface LiveChannel {
	readonly clientId: number;               // = Awareness-ID
	readonly role: "read" | "write" | "owner";
	readonly user: { id: string; name: string; color: string };
	state(): Uint8Array;                      // kompletter Stand (Y.encodeStateAsUpdate)
	whenSynced(timeoutMs?: number): Promise<boolean>; // false = offline/Zeitüberschreitung
	push(update: Uint8Array): void;          // eigene Änderung (bei Nur-Lesen ignoriert)
	onUpdate(fn: (u: Uint8Array) => void): () => void; // alles, was nicht von push stammt
	setPresence(state: Record<string, unknown> | null): void;
	onPresence(fn: (peers: { clientId: number; user: LiveUser; state: Record<string, unknown> | null }[]) => void): () => void;
	fileStale(hash: string): boolean;        // lokaler Stand = überholte, unveränderte Fassung (Download steht aus)
	onClose(fn: () => void): () => void;      // Tandem trennt (Abmelden, Neustart) → später neu öffnen
	close(): void;
}
```

## Regeln für Partner

1. **Erst abgleichen, dann einlesen:** `await ch.whenSynced()`, dann `ch.state()` anwenden. Ist das Dokument leer,
   aus der Datei füllen – mit deterministischen IDs (z. B. aus dem Datei-Hash), damit zwei Geräte, die gleichzeitig
   dieselbe Datei einlesen, denselben Inhalt erzeugen.
2. **Offline und leer → nicht koppeln.** Zwei unabhängig eingelesene Stände lassen sich nicht sinnvoll mischen.
3. **Ein Schreiber:** Präsenz veröffentlichen (z. B. `{ open: true, write: true }`), die kleinste `clientId` unter den
   Schreibenden schreibt die Datei. Jede geschriebene Fassung (Hash) im Dokument vermerken – so erkennen die anderen
   eingehende Dateien als „eigene“ und nicht als Änderung von außen.
4. **Änderungen von außen** (Datei-Hash unbekannt und nicht `fileStale`) ins Dokument übernehmen.
5. **`represented`** nur für Hashes melden, die geschrieben wurden, während das Gerät gekoppelt war – sonst würde eine
   Konfliktkopie unterdrückt, deren Inhalt nirgends sonst steckt.

Test: `e2e/tests/m20-zellwerk.mjs` (zwei Obsidian-Instanzen, echter Server, echtes Tippen).
