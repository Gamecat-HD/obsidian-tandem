# Leistung

Alle Werte stammen aus reproduzierbaren Messungen im Repo. Gemessen am 2026-11-02 mit Tandem 0.4.0.

**Messrechner:** AMD Ryzen 7 5800X (8 Kerne / 16 Threads), 32 GB RAM, CachyOS, Obsidian 1.15.0 (Electron, headless), Rust 1.95, Node 22.
**Produktion:** VPS mit 4 vCPU / 8 GB, Docker, hinter Nginx Proxy Manager und Cloudflare.

## Auf einen Blick

| | Wert |
|---|---|
| Tastendruck von A bis im Editor von B (lokal) | **3,6 ms** Median, 4,5 ms p95 |
| Tastendruck bei 80 ms Netz-Rundlaufzeit | **83,9 ms** Median, also ~4 ms über der reinen Netzlaufzeit |
| Neue Notiz erscheint im Vault des anderen (lokal) | 3,4 ms Median |
| Anhang 5 MiB (lokal / 80 ms RTT) | 87 ms / 426 ms |
| Erstabgleich eines neuen Geräts, 1026 Dateien (lokal) | 1,8 s |
| Server-RAM in Produktion (echter Vault, ~4600 Dateien, 560 MB) | **5,9 MiB** |
| Server-RAM im Lasttest, 100 Clients × 200 Notizen | 47,7 MiB Spitze |
| Docker-Image | 11,5 MiB (`FROM scratch`, statischer musl-Binary) |
| Plugin `main.js` | 156 KB (49 KB gzip) |

Zum Vergleich: Die CouchDB von Self-hosted LiveSync, die Tandem ersetzt, belegte auf demselben Server **etwa 5,6 GB RAM**.

## Ende-zu-Ende-Latenz

Zwei echte Obsidian-Instanzen (A und B) mit dem Rust-Server. Gemessen wird nicht nur die Netzwerknachricht, sondern der ganze Weg: Eingabe bei A per Chrome DevTools Protocol → Yjs-Update → WebSocket → Server → WebSocket → Yjs → CodeMirror-Rendering bei B. Der Zeitstempel bei B kommt von einem `MutationObserver` auf dem Editor-DOM.

`latency-proxy.mjs` verzögert jedes Paket in beide Richtungen um den angegebenen Wert. „40 ms je Richtung“ entspricht etwa 80 ms Rundlaufzeit, also einer typischen Verbindung über Cloudflare mit Mobilfunk-Anteil.

| Messung | lokal (0 ms) | 40 ms je Richtung |
|---|---|---|
| Tastendruck A → im Editor von B (n=100) | Median **3,6 ms** · p95 4,5 ms · max 18,5 ms | Median **83,9 ms** · p95 86,1 ms |
| Neue Notiz A → Datei im Vault von B (n=20) | Median 3,4 ms · p95 11,3 ms | Median 164 ms · p95 220 ms |
| Anhang 5 MiB, zufällige Bytes (n=3) | Median 87 ms | Median 426 ms |
| Erstabgleich: neues Gerät mit leerem Vault holt 1026 Dateien (1000 Notizen + 15 MiB Anhänge) | 1,8 s | 28,4 s |
| Server-RSS nach dem Erstabgleich | 21,7 MiB | 19,3 MiB |

Einordnung:
- Tippen ist praktisch nur durch das Netz begrenzt. Bei 80 ms RTT kommen ~4 ms Verarbeitung dazu, beide Plugins und der Server zusammen.
- Eine neue Notiz braucht zwei Wege (Index-Eintrag, dann Inhalt), daher etwa die doppelte Netzlaufzeit.
- Der Erstabgleich über eine langsame Leitung lud die Notizen damals weitgehend nacheinander (4 gleichzeitig). Seit dem 09.11. sind es 16, siehe [Optimierungen](#optimierungen-vom-2026-11-09-vorhernachher). Das betrifft nur die erste Verbindung eines neuen Geräts, danach werden nur Änderungen übertragen.

Ink Blocks (aus den E2E-Tests m06/m07): Ein fremder Strich ist schon **während des Schreibens** als „Geist“ mit Namensschild sichtbar. Der fertige Strich ersetzt den Geist ohne Wartezeit, mit älteren Ink-Blocks-Versionen (Stufe A) kommt er ~2 s nach dem Absetzen.

## Server unter Last

`protocol/loadtest.mjs` startet den echten Server und simuliert Clients direkt auf Protokollebene (ohne Obsidian). Jeder Client abonniert alle Notizen und bearbeitet alle 200 ms eine zufällige davon, dazu kommen Cursor-Updates (Awareness). Danach prüft der Test, ob alle Kopien identisch sind und ob ein frisch verbundener Client denselben Stand aus der Datenbank bekommt.

| Szenario | RSS Leerlauf | RSS nach Abonnieren | Bearbeitungen | RSS-Spitze | Konvergenz | RSS nach Entladen |
|---|---|---|---|---|---|---|
| 20 Clients × 50 Notizen, 30 s | 11,1 MiB | 14,6 MiB | 2980 (99/s) | **16,3 MiB** | ✓ 1000/1000 Kopien identisch | 13,9 MiB |
| 100 Clients × 200 Notizen, 30 s | 11,2 MiB | 27,2 MiB | 6800 (227/s) | **47,7 MiB** | ✓ 20 000/20 000 Kopien identisch | 34,8 MiB |

Bei 100 Clients verteilt der Server jede Bearbeitung an 99 andere, also rund 22 000 Nachrichten pro Sekunde. Der Lasttest-Client (ein einzelner Node-Prozess) war dabei der Engpass, nicht der Server.

Notizen, die niemand geöffnet hat, entlädt der Server nach 30 s aus dem RAM. Im Speicher liegt also nur, was gerade bearbeitet wird.

## Produktion

| | Wert |
|---|---|
| Vault | ~4600 Dateien, 560 MB (viele PDFs bis 57 MiB) |
| RAM des Containers | 5,9 MiB (davon 4,2 MiB anonym) |
| Container-Limit | `mem_limit: 128m` |
| Anhänge | werden gestreamt, nie ganz im RAM gepuffert (seit 0.3.1) |
| Admin-Oberfläche im Leerlauf | kein Datenverkehr (kein Polling, kein WebSocket) |

## Optimierungen vom 2026-11-09 (vorher/nachher)

Gemessen auf dem Entwickler-Laptop (nicht dem Messrechner oben, daher absolute Werte nicht mit den Tabellen oben
vergleichbar), jeweils derselbe Rechner, derselbe Server-Build, `node e2e/bench.mjs` mit dem alten
(`TANDEM_PLUGIN_DIR`) bzw. neuen Plugin-Build. Neu im Benchmark: Zeit für Anlegen + Hochladen, bis B alles hat,
Erstabgleich bis das neue Gerät C wirklich nichts mehr zu tun hat, und eine Inhaltsprüfung aller Notizen bei C.

| Messung (1000 Notizen) | vorher 0 ms | nachher 0 ms | vorher 40 ms je Richtung | nachher 40 ms je Richtung |
|---|---|---|---|---|
| A legt 1000 Notizen an, bis hochgeladen | 8,0 s | 5,9 s | 31,3 s | **8,3 s** |
| … bis B alle hat und fertig ist | 9,7 s | 6,1 s | 31,9 s | **8,9 s** |
| Erstabgleich neues Gerät (Dateien da) | 3,4 s | 2,5 s | 28,7 s | **6,2 s** |
| … bis C nichts mehr zu tun hat | 4,1 s | 2,7 s | **nie** (nach 600 s abgebrochen) | **6,3 s** |
| Inhalt aller Notizen bei C korrekt | ✓ | ✓ | – | ✓ |

| Messung (4000 Notizen, 0 ms, `NOTES=4000`) | vorher | nachher |
|---|---|---|
| A legt 4000 Notizen an, bis hochgeladen | 46,1 s | 34,3 s |
| … bis B alle hat und fertig ist | 58,4 s | 34,5 s |
| Erstabgleich neues Gerät (Dateien da) | 17,8 s | 11,4 s |
| … bis C nichts mehr zu tun hat | **nie** (nach 600 s abgebrochen) | 11,5 s |

Tastendruck, neue Einzelnotiz und Anhang sind unverändert (im Rahmen der Messstreuung).

**Endlosschleife beim Abgleich (Fehler, behoben):** Lud ein Abgleich ein Doc aus IndexedDB, meldete der DocManager
den gespeicherten Stand als Remote-Update; 250 ms später wurde derselbe Abgleich erneut eingeplant. Stand die
Warteschlange länger als die Nachlaufzeit (3 s) an, war das Doc bis dahin entladen und wurde wieder geladen – ohne
Ende. Diagnose mit 300 Notizen bei 40 ms je Richtung, gezählte Abos (Sync Step1) des neuen Geräts:

| | vorher | nachher |
|---|---|---|
| Abos nach dem Erstabgleich | wachsen um ~180 je 5 s, 60 s lang ohne Ende (488 → 2485) | 279, danach keine mehr |
| offene Hintergrundaufgaben | ~900 dauerhaft | 0 |

Das traf jedes Gerät, sobald viele Docs auf einmal abzugleichen waren (neues Gerät, viele Änderungen nach längerer
Offline-Zeit) und die Leitung langsam oder der Vault groß genug war: dauerhaft Netz- und Akkulast.

**Einzelmessungen (Node, `yjs` wie im Plugin):**

| | vorher | nachher |
|---|---|---|
| Vault-Index: 4600 Einträge einzeln von einem anderen Gerät empfangen, inkl. Konfliktprüfung je Änderung | 5228 ms | 721 ms (Rest = Yjs selbst) |
| Vault-Index: Scan mit 4600 unbekannten Dateien und 4600 Grabsteinen (Grabstein-Suche) | 1922 ms | 3 ms |
| Lokales Speichern des Index-Docs (4600 Einträge, ~1 MB): Kodieren je Speichervorgang | 17 ms, bis zu alle 400 ms | 17 ms, höchstens alle ~425 ms am PC; auf langsamen Geräten bis alle 4 s |

Was geändert wurde:
- **Vault-Index** führt Pfad → docId, Namenskonflikte und Grabsteine pro geändertem Schlüssel nach, statt bei jeder
  Änderung alles neu aufzubauen und linear zu suchen.
- **Abgleiche**: Notizen 16 gleichzeitig (warten fast nur aufs Netz), Anhänge weiter 4 (liegen ganz im Speicher).
  Ein schon wartender Abgleich desselben Docs wird nicht doppelt eingereiht.
- **Kein Selbst-Anstoßen**: Laden aus IndexedDB wird nicht erneut gespeichert; während eines Abgleichs lösen Laden und
  fremde Updates bis zum Arbeitsschritt keinen weiteren Abgleich aus (der Arbeitsschritt sieht sie ohnehin).
- **Scan** beim (Wieder-)Verbinden: Prüfung auf gespeicherte Grundlage parallel und nur einmal pro Sitzung je Doc
  (vorher bei jeder Rückkehr in die App ein IndexedDB-Zugriff je Notiz, nacheinander); neue Dateien parallel hashen.
- **Lokales Speichern** großer Docs seltener (Abstand = 25 × gemessene Kodierdauer, 400 ms bis 4 s); beim Wechsel in
  den Hintergrund wird sofort gespeichert.
- **Gelöschte Anhänge**: Verweisprüfung liest jede Notiz einmal pro Durchgang statt einmal je gelöschtem Anhang.

## Selbst messen

```bash
cd plugin && npm ci && npm run build && cd ..
node e2e/bench.mjs 0          # Ende-zu-Ende lokal          (KEYS=100 NOTES=1000 als Vorgabe)
node e2e/bench.mjs 40         # mit 40 ms Verzögerung je Richtung
NOTES=4000 KEYS=10 node e2e/bench.mjs 0   # großer Vault
TANDEM_PLUGIN_DIR=/pfad/zu/altem/build node e2e/bench.mjs 0   # Vergleich mit einem anderen Plugin-Build
node protocol/loadtest.mjs 20 50 30      # Clients, Notizen, Sekunden
node protocol/loadtest.mjs 100 200 30
```

`e2e/bench.mjs` braucht Obsidian unter `/usr/lib/obsidian/app.asar` und `electron43` (wie alle E2E-Tests). Die Ergebnisse landen zusätzlich als JSON in `e2e-out/bench-<ms>ms.json`.
