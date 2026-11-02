# Plan: Tandem – Echtzeit-Zusammenarbeit für Obsidian

Stand: 2026-11-02 · Status: **M0–M8 umgesetzt** – Umstieg siehe [UMSTIEG.md](UMSTIEG.md)

## 1. Ziel

Tandem soll Self-hosted LiveSync ablösen und dabei besser sein:

- **Sync** des ganzen Vaults zwischen eigenen Geräten und anderen Personen, auch offline mit späterem Abgleich (wie LiveSync).
- **Live-Zusammenarbeit wie in Google Docs:** Man sieht Zeichen für Zeichen, was jemand anderes tippt. Dazu den **Cursor und die Markierung** mit Name und Farbe und **wer gerade in welcher Notiz ist** (Avatare im Tab, Punkte im Dateibaum).
- **Ink Blocks kompatibel:** Handschrift wird synchronisiert. Ein Strich, der gerade entsteht, erscheint schon *während des Schreibens* bei den anderen.
- **Sparsam mit Ressourcen:** Der Server läuft nebenher auf dem 8-GB-Server. Ziel sind **unter 50 MB RAM im Leerlauf**. Auf dem Client dürfen Akku und Speicher auf Tablet und Handy nicht leiden.

**Nicht-Ziele für v1:** Ende-zu-Ende-Verschlüsselung (siehe §8), Rechte pro Ordner, Sync der Plugin-Einstellungen, Web-Editor ohne Obsidian.

## 2. Warum nicht LiveSync (oder ein bestehendes Plugin)?

| | LiveSync (heute) | Tandem |
|---|---|---|
| Grundlage | CouchDB-Replikation von Datei-Chunks | **CRDT (Yjs)** pro Notiz |
| Gleichzeitig dieselbe Notiz bearbeiten | Konflikte, Merge erst nach dem Speichern | Zusammenführung Zeichen für Zeichen, ohne Konflikte |
| Andere live sehen | nein | Cursor, Markierung, Präsenz |
| Server | CouchDB (Erlang, schwergewichtig) | eine kleine Binärdatei + SQLite |

Bestehende Projekte (Stand 11/2026):
- **[Relay](https://github.com/No-Instructions/Relay)** (System3) ist am ausgereiftesten. Es nutzt Yjs, und der Server ist ein Fork von y-sweet. Login, Rechte und Abrechnung laufen aber **immer über ihre proprietären Server**, auch wenn man den Server selbst hostet. Das scheidet für uns aus, ist aber eine gute Vorlage für die Architektur.
- **[Obsidian Live Share](https://github.com/mewski/obsidian-live-share)**, [Collab Notes](https://community.obsidian.md/plugins/collab-notes), [Synqra](https://community.obsidian.md/plugins/synqra) und [Team Collaboration](https://community.obsidian.md/plugins/team-collaboration) setzen ebenfalls auf Yjs und einen Relay-Server. Alle sind früh im Projekt, haben wenige Nutzer und teils nur eine Desktop-Version. Keines kennt Ink Blocks.

→ Das Grundprinzip (Yjs + CodeMirror-Binding + WebSocket-Server) hat sich bewährt. Was fehlt, ist eine **vollständig selbst gehostete, schlanke** Lösung, die **LiveSync ersetzt** (also den ganzen Vault synchronisiert, nicht nur geteilte Ordner) und **Ink Blocks unterstützt**.

## 3. Architektur im Überblick

```
┌──────────── Obsidian (Desktop / Mobil) ────────────┐
│  Tandem-Plugin                                       │
│   ├─ Editor-Binding: y-codemirror.next an CM6        │  ← Remote-Cursor, Markierungen, Undo pro Nutzer
│   ├─ DocManager: Y.Doc pro offener Notiz (lazy)      │
│   ├─ VaultIndex: ein Y.Doc „Dateibaum“               │  ← Pfad → docId, Typ, Hash; Umbenennen/Löschen
│   ├─ DiskBridge: Vault-Datei ⇄ Y.Doc (Diff-basiert)  │  ← fremde Schreiber: Claude Code, git, Ink Blocks
│   ├─ Offline-Cache: IndexedDB (Updates pro Doc)      │
│   ├─ Präsenz-UI: Avatare, Dateibaum-Punkte, Folgen   │
│   └─ InkBridge ⇄ Ink-Blocks-Plugin (API)             │  ← Striche als Y.Map, Live-Strich über Awareness
└──────────────── 1 WebSocket (multiplexed) ──────────┘
                         │  y-sync + awareness, Nachrichten mit docId als Präfix
┌──────────────── tandem-server (Rust) ───────────────┐
│  axum/tokio · yrs · SQLite (WAL)                     │
│   ├─ Auth: Geräte-Token (gehasht in SQLite)          │
│   ├─ Räume: nur Docs mit verbundenen Clients im RAM  │
│   ├─ Persistenz: Updates anhängen, später verdichten │
│   ├─ Sync ohne Laden: Diff direkt auf den Updates     │
│   └─ Blobs: Anhänge per HTTP, Ablage nach Hash        │
└──────────────── hinter Cloudflare + NPM ────────────┘
```

### 3.1 Datenmodell

- **Space** = ein synchronisierter Vault. Mehrere Nutzer können Mitglied sein.
- **Index-Doc** (eins pro Space): `Y.Map<docId, {path, kind: "md"|"ink"|"blob", hash?, deleted?}>`. Umbenennen ändert nur `path`. Die Notiz behält ihre ID, und die Historie bleibt erhalten. Gelöschte Einträge bleiben als Grabstein, damit Offline-Geräte die Datei nicht wieder anlegen.
- **Markdown-Doc**: ein `Y.Text("content")` mit dem kompletten Dateiinhalt.
- **Ink-Doc** (`.ink`): `Y.Map("meta")` (w, h, bg, space) und `Y.Map("strokes")` mit Stroke-ID → kodierter Strich als String im bestehenden Zeilenformat. Die Reihenfolge kommt aus einem `Y.Array` mit den IDs. Striche sind unveränderlich (siehe `mergeInk` in Ink Blocks), deshalb passt das genau. Den OCR-Zustand behandeln wir pro Gerät oder nach dem Prinzip „letzter gewinnt“.
- **Blobs** (PDF, Bilder, sonstiges): Sie werden nicht als CRDT gespeichert. Der Inhalt liegt nach SHA-256 adressiert auf dem Server, im Index steht nur der Hash. Bei gleichzeitigen Änderungen gewinnt die letzte, mit Konfliktkopie.

### 3.2 Wie Live-Tippen funktioniert

1. Öffnet man eine Notiz, abonniert das Plugin deren Doc über die bestehende WebSocket-Verbindung (Sync-Schritt 1/2 mit State-Vector, es gehen also nur fehlende Updates über die Leitung).
2. `yCollab()` von **y-codemirror.next** wird als Editor-Erweiterung in Obsidians CodeMirror 6 eingehängt (`registerEditorExtension`). Jeder Tastendruck wird zu einem Yjs-Update von wenigen Bytes und geht sofort raus. Updates werden nicht gesammelt, das sorgt für das Google-Docs-Gefühl.
3. **Awareness** (flüchtig, wird nicht gespeichert): `{user: {name, color}, cursor: {anchor, head} als RelativePosition}`. y-codemirror.next zeichnet daraus Cursor und Markierung. Eigenes Styling: Das Namensschild ist beim Tippen 2 s sichtbar, danach erscheint es nur beim Überfahren.
4. Präsenz im Vault: eine Awareness auf dem Index-Doc mit `{openDoc, mode}`. Daraus entstehen Avatare in der Tab-Leiste, farbige Punkte im Dateibaum und der Befehl „Folgen“, der zur Cursorposition einer Person springt.
5. Obsidian speichert die offene Notiz wie gewohnt selbst auf die Platte. Notizen, die nicht offen sind, schreibt die DiskBridge (§3.3).

### 3.3 DiskBridge: der heikle Teil

Die Dateien auf der Platte bleiben die Wahrheit für Obsidian, die Suche, Ink Blocks, Claude Code und git. Deshalb gilt:

- **Remote → Platte:** Für nicht offene Notizen wird `vault.process()` mit Debounce (ca. 300 ms) aufgerufen. Für offene Notizen übernimmt das der Editor.
- **Platte → Remote:** Ändert jemand anderes eine Datei (`vault.on("modify")`, der Inhalt weicht vom letzten eigenen Stand ab), berechnen wir den Diff alt→neu mit `fast-diff` und spielen ihn als minimale Einfüge- und Löschoperationen in das `Y.Text` ein. So bleiben gleichzeitige Remote-Änderungen erhalten. Die Datei wird *nicht* komplett ersetzt.
- **Echo-Schutz:** pro Datei den Hash des zuletzt selbst geschriebenen Inhalts merken. Ink Blocks macht das schon so (`lastWritten`).
- **Start oder Rückkehr aus dem Offline-Modus:** Platte, lokaler Yjs-Stand (IndexedDB) und Server werden über den State-Vector abgeglichen. Was offline auf der Platte geändert wurde, wird wie oben per Diff übernommen.
- Ignorierliste ab Werk: `.obsidian/workspace*.json`, `.trash/`, die Atomic-Write-Temp-Dateien von Claude Code (`\.tmp\.\d+\.[0-9a-f]+$`), `node_modules`.

### 3.4 Sparsamkeit (Server und Client)

**Server**
- **Rust + yrs** statt Node: eine Binärdatei, ein Docker-Image unter 20 MB, ohne GC-Spitzen. Richtwert: 5–20 MB RAM im Leerlauf, wird in M1 gemessen. Zum Vergleich: Hocuspocus (Node) braucht etwa 50–100 MB. CouchDB messen wir in M0 auf dem Server als Ausgangswert.
- **Nur aktive Docs im RAM:** Ein Doc wird erst geladen, wenn der erste Client es abonniert, und 30 s nach dem letzten wieder entladen. Das ist der bekannte Fehler bei y-websocket ohne Persistenz, wo Docs für immer im Speicher bleiben.
- **Hintergrund-Sync ohne Doc im Speicher:** Holt ein Gerät nach dem Start nur Änderungen nach, rechnet der Server den Diff *direkt auf den gespeicherten Updates* (`merge_updates`/`diff_updates` in yrs, beim Spike prüfen) und baut kein Y.Doc auf.
- **Persistenz:** Updates werden in SQLite angehängt (WAL). Ab N Updates oder bei Leerlauf werden sie zu einem Snapshot verdichtet. Für die Versionsgeschichte gibt es täglich einen Snapshot.
- Awareness-Nachrichten werden nur weitergeleitet und nie gespeichert. Gesendet wird höchstens alle 50 ms pro Client.
- Ein WebSocket pro Gerät mit Multiplexing über die docId. Das spart Verbindungen, gerade über Cloudflare. Ping alle 30 s, weil Cloudflare inaktive WebSockets nach 100 s trennt.

**Client**
- Nur offene Notizen und das Index-Doc liegen als Y.Doc im RAM. Alle anderen liegen nur als komprimierte Updates in IndexedDB.
- Mobil: Wird die App in den Hintergrund geschickt, wird die Verbindung getrennt. Beim Zurückkehren folgt ein State-Vector-Sync. Es gibt kein Polling.
- Beim ersten Import werden große Vaults in Portionen hochgeladen (z. B. 50 Dateien pro Durchgang), damit die UI flüssig bleibt.

### 3.5 Ink Blocks: Integration in zwei Stufen

**Stufe A: Funktioniert ohne Änderungen an Ink Blocks**
- `.ink`-Dateien werden als Ink-Doc (§3.1) synchronisiert. Die DiskBridge schreibt die Datei, und Ink Blocks lädt sie über seinen vorhandenen `vault.on("modify")`-Handler neu und führt sie per `mergeInk` zusammen. Striche erscheinen beim anderen also **nach dem Absetzen des Stifts**, etwa 0,3–1 s später (Debounce von Ink Blocks + Debounce der DiskBridge).
- Der ` ```ink `-Block in der Markdown-Datei (`file:`, `text:`) ist normaler Text im `Y.Text`.

**Stufe B: Live-Strich, braucht eine kleine API in Ink Blocks (eigenes Repo)**
- Ink Blocks stellt `plugin.api` bereit:
  - `onStrokeProgress(cb)` / `onStrokeCommit(cb)` / `onStrokeErase(cb)`: Ereignisse mit inkFile und Stroke,
  - `showRemoteStroke(inkFile, userId, color, points)` / `clearRemoteStroke(...)`: halbtransparenter „Geister-Strich“ mit Namensschild,
  - `applyRemote(inkFile, InkData)`: Übernahme ohne den Umweg über die Platte (Vorschlag), damit die Undo-Historie nicht verloren geht.
- Tandem schickt **Punkte während des Zeichnens über Awareness** (alle ~50 ms nur die neuen Punkte, flüchtig) und den fertigen Strich als CRDT-Eintrag. Ergebnis: Man sieht live, wie die andere Person schreibt.
- Ink Blocks bleibt ohne Tandem voll funktionsfähig. Die API ist optional, und Tandem fällt ohne sie auf Stufe A zurück.
- **OCR-Konflikt:** Erkennen zwei Geräte gleichzeitig dieselbe Fläche, schreiben beide `text:` in die Notiz. Regel: Nur das Gerät, das zuletzt Striche hinzugefügt hat, schreibt `text:`. Ink Blocks bekommt das über `api.isOcrLeader?.(inkFile)` von Tandem.

### 3.6 Nutzer, Anmeldung, Sicherheit

- Der Server legt per CLI an: `tandem-server user add anna`, `space add notizen`, `invite` → Einmal-Code. Das Plugin tauscht den Code gegen ein **Geräte-Token**, das serverseitig nur als Hash gespeichert und einzeln widerrufbar ist.
- Rechte pro Space: `owner` / `write` / `read`. Lesende bekommen Sync, aber ihre Updates werden abgelehnt.
- TLS kommt über Cloudflare/NPM wie bei Calibre-Web. Der Server selbst lauscht nur auf `127.0.0.1` oder im Docker-Netz.
- Größenlimits pro Nachricht und Blob, Rate-Limit beim Einlösen der Einladung.

## 4. Projektstruktur (Monorepo)

```
obsidian-tandem/
├─ plugin/                 Obsidian-Plugin (TypeScript, esbuild – wie Ink Blocks)
│  ├─ src/
│  │  ├─ main.ts           Lebenszyklus, Einstellungen, Befehle
│  │  ├─ net/              Connection (WebSocket, Reconnect, Multiplexing), Protokoll-Codec
│  │  ├─ docs/             DocManager, VaultIndex, Offline-Cache (IndexedDB)
│  │  ├─ disk/             DiskBridge, Diff→Y.Text, Echo-Schutz, Ignorierliste
│  │  ├─ editor/           yCollab-Einbindung, Cursor-Styling, Undo
│  │  ├─ presence/         Avatare, Dateibaum-Punkte, „Folgen“
│  │  ├─ ink/              InkBridge (Stufe A/B), Ink-Doc ⇄ InkData
│  │  ├─ blobs/            Anhänge hoch- und herunterladen
│  │  └─ ui/               Statusleiste, Einstellungen, Konflikt- und Verlaufsansicht
│  ├─ manifest.json · esbuild.config.mjs · package.json
├─ server/                 tandem-server (Rust, Cargo)
│  ├─ src/
│  │  ├─ main.rs           CLI (serve, user, space, invite, backup)
│  │  ├─ ws.rs             WebSocket, Multiplexing, Ping
│  │  ├─ room.rs           aktive Docs, Awareness-Weiterleitung, Entladen
│  │  ├─ store.rs          SQLite: Updates, Snapshots, Index, Blobs-Metadaten
│  │  ├─ auth.rs           Tokens, Einladungen, Rechte
│  │  └─ blobs.rs          HTTP-Upload/-Download nach Hash
│  └─ Cargo.toml
├─ protocol/               PROTOCOL.md + gemeinsame Testvektoren (Binärnachrichten), von beiden Seiten getestet
├─ deploy/                 Dockerfile (distroless/scratch), docker-compose.yml, NPM-/Cloudflare-Hinweise
├─ e2e/                    zwei echte Obsidian-Instanzen + lokaler Server (Muster aus Ink Blocks)
│  ├─ test-vault-a/ · test-vault-b/
│  └─ scenarios/           live-typing, offline-merge, rename, ink-live-stroke …
└─ docs/
   ├─ PLAN.md              dieses Dokument
   ├─ PROTOKOLL.md         Drahtformat
   └─ adr/                 Architekturentscheidungen (0001-yjs, 0002-rust-server, …)
```

**Warum ein Monorepo:** Plugin und Server teilen sich ein Protokoll, das zusammen versioniert werden muss. Testvektoren in `protocol/` erkennen Abweichungen zwischen Rust und TypeScript früh.

**Abhängigkeiten im Plugin** (bewusst wenige): `yjs`, `y-protocols` (Awareness), `y-codemirror.next`, `lib0`, `fast-diff`, `idb` oder direkt IndexedDB.
**Server:** `yrs`, `axum`, `tokio`, `rusqlite` (bundled), `argon2` oder `sha2` für die Tokens, `clap`.

## 5. Meilensteine

Jeder Meilenstein endet mit einem E2E-Test in echten Obsidian-Instanzen, so wie es sich bei Ink Blocks bewährt hat.

| # | Inhalt | Fertig, wenn … |
|---|---|---|
| **M0 Spike** | yCollab in Obsidians CM6 mit 2 Instanzen + Wegwerf-Server `y-websocket`. Prüfen: Cursor in Live Preview, Undo, Verhalten beim Selbstspeichern durch Obsidian und beim externen `modify`. Ausgangswert für RAM von CouchDB/LiveSync messen. | Zwei Fenster tippen gleichzeitig ohne Echo und ohne Zeichenverlust, Ergebnis als ADR. |
| **M1 Server-Kern** | Rust: WebSocket mit Multiplexing, Sync + Awareness, SQLite-Persistenz, Entladen, Token-Auth, CLI, Docker-Image. Testvektoren. | Zeitlich begrenzter Lasttest mit 20 simulierten Clients × 50 Docs. RAM gemessen und dokumentiert. |
| **M2 Live-Editor** | Plugin: Connection, DocManager, yCollab für offene Notizen, Cursor-Styling, Statusleiste. | Google-Docs-Gefühl zwischen Laptop und Tablet über den echten Server. |
| **M3 Vault-Sync** | Index-Doc, DiskBridge (beide Richtungen), Offline-Cache, Erstimport, Umbenennen/Löschen, Ignorierliste. | Offline auf beiden Geräten bearbeiten → nach dem Wiederverbinden ist alles ohne Verlust zusammengeführt. Claude-Code-Schreibvorgänge kommen sauber an. |
| **M4 Präsenz** | Avatare, Dateibaum-Punkte, „Folgen“, Liste „Wer ist online“. | Man sieht auf einen Blick, wer wo ist. |
| **M5 Anhänge** | Blobs nach Hash, Upload in Portionen, Konfliktkopien. | PDFs/Bilder werden synchronisiert, Arbeitsblätter von Ink Blocks funktionieren. |
| **M6 Ink Stufe A** | `.ink` als Ink-Doc, Zusammenspiel mit `mergeInk`/`onModify`. | Striche erscheinen nach dem Absetzen auf dem anderen Gerät, gleichzeitiges Schreiben auf einer Fläche geht nicht verloren. |
| **M7 Ink Stufe B** | API in Ink Blocks (eigenes Repo, eigener Meilenstein), Geister-Strich, OCR-Leader. | Live sehen, wie jemand schreibt. |
| **M8 Ablösung von LiveSync** | **Vault-Backup**, Import-Assistent, Versionsgeschichte und Wiederherstellen, Backup-Befehl, Feinschliff für Mobilgeräte, Doku. | Der Berufsschul-Vault läuft eine Woche nur mit Tandem. Danach wird CouchDB abgeschaltet. |

## 6. Risiken und offene Punkte

1. **Obsidian-Editor und Yjs:** Obsidian lädt Dateien bei externem `modify` neu und speichert selbst. Das kann zu doppelten Schreibvorgängen oder Cursorsprüngen führen. → Das ist der Hauptzweck von M0. Relay zeigt, dass es lösbar ist.
2. **Mehrere Ansichten derselben Notiz** (Split-Ansicht): Beide Editoren an dasselbe `Y.Text` binden. Das ist mit yCollab möglich, aber zu testen.
3. **Große Notizen und viele Dateien:** Index-Doc mit mehr als 5000 Einträgen und Erstimport. → Messen und den Index notfalls nach Ordner aufteilen.
4. **yrs-API für Diffs ohne Doc** (§3.4): beim Spike verifizieren. Fallback: Doc kurz laden und sofort wieder entladen.
5. **Nebeneinander mit LiveSync:** Beide dürfen **nie gleichzeitig** auf demselben Vault laufen. → Das Plugin warnt, wenn LiveSync aktiv ist. Umstieg erst in M8.
6. **Ende-zu-Ende-Verschlüsselung:** Mit Yjs ist das möglich (der Server speichert nur verschlüsselte Updates und leitet sie weiter), dann kann er aber nicht mehr verdichten oder Diffs rechnen. → Für v1 vertrauen wir dem eigenen Server. E2EE kommt optional später.
7. **Lizenzen:** yjs, y-codemirror.next, yrs und y-sweet stehen unter MIT. Relay-Code nur als Inspiration, nicht kopieren.

## 7. Entscheidungen (2026-11-02)

- **Mehrere Personen**, einige mit Obsidian auf dem **Tablet**, einige am **Notebook**. → Mobil (Android/iPad) ist ab M2 Pflicht und nicht erst Feinschliff. Jede Person bekommt ein eigenes Konto mit Name und Farbe. Rechte pro Space reichen erst einmal.
- **Server in Rust** (yrs, axum, SQLite). → [ADR 0001](adr/0001-yjs-crdt.md), [ADR 0002](adr/0002-rust-server.md)
- **Sicherheit v1: mindestens HTTPS** (TLS über NPM) plus Geräte-Tokens. Mehr kommt später.
- **Deploy auf dem eigenen VPS** (4 CPU / 8 GB). Dort läuft auch die CouchDB von LiveSync, das laut Server-Check vom 02.11. **etwa 5,6 GB RAM** belegt. Das ist ein starkes Argument für den Umstieg.
- **Vor jedem Eingriff in den echten Vault ein Backup** (tar mit Datum, außerhalb des Vaults, wird geprüft). Bis M8 laufen alle Tests nur auf Wegwerf-Vaults.
- Der Name „Tandem“ bleibt vorerst ein Arbeitstitel.

## 8. Quellen

- Relay: <https://github.com/No-Instructions/Relay> · Forum: <https://forum.obsidian.md/t/relay-multiplayer-plugin-for-obsidian-collaborative-editing-and-folder-sharing/87170>
- y-sweet (Rust, yrs): <https://docs.rs/crate/y-sweet/latest>
- Hocuspocus Multiplexing (v2+): <https://github.com/ueberdosis/hocuspocus/releases/tag/v2.0.0> · Skalierung: <https://tiptap.dev/hocuspocus/guides/scalability>
- Speicherverhalten von y-websocket: <https://discuss.yjs.dev/t/memory-issue-with-yjs/2568>
- Obsidian Live Share: <https://github.com/mewski/obsidian-live-share>
