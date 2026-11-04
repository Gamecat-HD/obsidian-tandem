# Admin-Oberfläche

Web-Verwaltung unter `https://<host>/admin/`. Sie wird vom `tandem-server` selbst ausgeliefert, die Dateien liegen in `server/admin-ui/` und werden mit `include_str!` in den Binary eingebettet.

## Grundsätze

- **Kein Datenverkehr im Leerlauf:** Die Seite fragt nichts im Hintergrund ab, also kein Polling, kein WebSocket, keine Timer mit Netzwerkzugriff. Daten werden nur bei einer Aktion geladen (Navigation, Klick auf „Aktualisieren“, Speichern). Statische Dateien laufen über ETag, ein erneuter Aufruf kostet dann nur ein 304.
- **Sicherer Zugriff:**
  - **Anmeldung:** Kennung, Passwort (Argon2id) und TOTP-Code (Authenticator-App). Einrichten bzw. Zurücksetzen nur per Einmal-Link von der Server-Konsole.
  - **Sitzung:** Cookie `__Host-tandem-admin` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`). Sie läuft nach 30 min ohne Anfrage oder spätestens nach 12 h ab und liegt serverseitig nur als Hash vor.
  - **CSRF-Schutz:** Jede Anfrage außer GET/HEAD an `/admin/api/*` braucht den Header `X-Tandem-Admin: 1`. Zusätzlich muss `Origin` (falls gesendet) zum Host passen.
  - **Bremsen:** Fehlversuche pro IP und pro Konto, ab 5 Fehlern eine Sperre, die sich verdoppelt. TOTP-Codes sind nur einmal gültig.
  - **Header:** strenge CSP (`script-src 'self'`, keine Inline-Skripte oder -Styles, `frame-ancestors 'none'`), `nosniff`, `no-referrer`. API-Antworten mit `no-store`.
  - **Audit-Log:** jede Änderung und jede Anmeldung.
  - **Abschalten:** `TANDEM_ADMIN=off` blendet `/admin` komplett aus.

## Einrichten

```bash
docker exec tandem /tandem-server admin setup alice
# → https://tandem.example.com/admin/#setup=<code>   (30 min gültig, einmalig)
```

Der Link öffnet die Einrichtung: Passwort festlegen, QR-Code mit der Authenticator-App scannen, Code bestätigen. Derselbe Befehl setzt den Zugang zurück (neues Passwort, neues Handy). Dabei werden alle Sitzungen beendet.
`admin list` zeigt die Admins, `admin remove <user>` entzieht die Rechte.

## API

Alle Antworten sind JSON, Fehler haben die Form `{"error": "Meldung auf Deutsch"}`. Zeiten sind Unix-Sekunden, nur `ts` im Vault-Index ist in Millisekunden (Plugin-Format).
`401` heißt: nicht (mehr) angemeldet, also Anmeldemaske zeigen.

### Anmeldung

| Methode | Pfad | Body → Antwort |
|---|---|---|
| GET | `/admin/api/me` | → `{user:{id,name,color}, session, expires}` oder 401 |
| POST | `/admin/api/login` | Schritt 1: `{user, password}` → `{ticket, methods:["passkey"?,"totp"], passkey: null \| PublicKeyCredentialRequestOptions (base64url)}`; 401 / 429. **Noch keine Sitzung.** Das Ticket gilt 5 min für höchstens 5 Versuche |
| POST | `/admin/api/login/totp` | Schritt 2: `{ticket, code}` → wie `me` (setzt Cookie); 401 (Code falsch/benutzt, Ticket abgelaufen) / 429 |
| POST | `/admin/api/login/passkey` | Schritt 2: `{ticket, credential:{id, response:{clientDataJSON, authenticatorData, signature}}}` (base64url) → wie `me` (setzt Cookie); 401 / 429 |
| GET | `/admin/api/passkeys` | → `[{id, name, created, lastUsed}]` |
| POST | `/admin/api/passkeys/options` | → PublicKeyCredentialCreationOptions (base64url, Challenge 5 min an die Sitzung gebunden) |
| POST | `/admin/api/passkeys` | `{name, credential:{response:{clientDataJSON, attestationObject}}}` → `{id, name}` |
| DELETE | `/admin/api/passkeys/<id>` | → 204 |
| POST | `/admin/api/logout` | → 204 |
| POST | `/admin/api/setup/start` | `{code, password}` → `{user, secret, uri, qr}` (`qr` = SVG-Text, nur als `<img src="data:image/svg+xml;charset=utf-8,…">` einbinden) |
| POST | `/admin/api/setup/check` | `{code}` → `{user, staged}` (Link vorab prüfen; 400 = ungültig/abgelaufen; `staged` = Schritt 1 schon erledigt, das Geheimnis bleibt beim erneuten `start` gleich) |
| POST | `/admin/api/setup/finish` | `{code, totp}` → wie `me` (setzt Cookie) |
| GET | `/admin/api/sessions` | → `[{id, created, lastSeen, ip, agent, current}]` |
| POST | `/admin/api/sessions/end-others` | → `{ended}` |

### Übersicht, Protokoll

| Methode | Pfad | Antwort |
|---|---|---|
| GET | `/admin/api/overview` | `{version, rssKib, dbBytes, store:{users,spaces,docs,update_rows,update_bytes,snapshots,blobs,blob_bytes}, online:[Online], admins:[{user,created,lastLogin}]}` |
| GET | `/admin/api/audit?before=<id>&user=&action=&q=&since=` | `[{id, ts, user, ip, action, detail}]` (neueste zuerst, 100 pro Seite). Filter: `user` (exakt), `action` (Präfix, z. B. `file.` oder `login.failed`), `q` (Text in `detail`, ohne Groß/klein), `since` (Unix-s). Aktionen: `login`, `login.failed` (`user` = eingegebene Kennung, nicht unbedingt eine echte Person), `logout`, `admin.setup`, `sessions.end`, `user.add/edit/delete`, `invite`, `device.revoke/unrevoke/assign/delete/cleanup`, `space.add/rename/delete`, `member.set/remove`, `file.create/edit/upload/move/delete/undelete/restore`, `backup.create/delete/settings/download/restore`, `export` |

`Online` = `{user, name, color, device, token, deviceId, docs:["space/docId", …], files:[{space, doc, path}] (geöffnete Dateien ohne den Index; path null, wenn gelöscht), rttMs, bytesIn, bytesOut, updates, since}`

`overview` liefert zusätzlich `startedAt`, `backup: {auto, count, last: Backup|null, lastAuto: Backup|null}` und `attention: {vaultsWithoutMembers:[{id,name}], staleDevices:[{id, user, name, device, lastSeen}] (nicht gesperrt, > 30 Tage nicht gesehen), revokedDevices, failedLogins24h}`.

### Statistik

`GET /admin/api/stats?range=1h|6h|24h|48h|7d|30d|90d` →
```
{ range, step (60 = Minuten, 3600 = Stunden), now, startedAt, rssKib,
  series: [Point], total: Point,                 // Zeitreihe (max. 360 Punkte) und Summe über den Zeitraum
  users: [{id, updates}], spaces: [{id, updates}], // Nutzung im Zeitraum, absteigend ("admin-web" = Admin-Oberfläche)
  devices: [Online],                              // verbundene Geräte mit rttMs, bytesIn, bytesOut, updates, since
  recent: [{space, doc, path, updated}] }         // zuletzt geänderte Dateien (updated in Unix-Sekunden)
Point = { ts, dur (abgedeckte Sekunden: 60 = Minute, 3600 = Stunde; nach dem Zusammenfassen mehr – Punkte können unterschiedlich lang sein:
          bis 48 h stammen Zeiten vor dem letzten Neustart aus Stundenwerten), updates, awareness, bytesIn, bytesOut, blobUp, blobUpBytes, blobDown, blobDownBytes,
          conns (Spitze), rssKib (Spitze), procP50Us, procP95Us, procMaxUs (Server-Verarbeitung je Update),
          rttMs (mittlere Ping-Laufzeit der Geräte, 0 = keine Messung), rttN (Zahl der Minuten mit Messung; Gewicht) }
Stundenpunkte (aus der Datenbank) enthalten zusätzlich `users: {id: updates}` und `spaces: {id: updates}`. Minutenpunkte haben das nicht. Zusammengefasste Punkte decken unterschiedlich lange Zeiträume ab, maßgeblich ist `dur`.
procP95Us/procMaxUs sind in zusammengefassten Punkten und in `total` Spitzenwerte (Maximum der Teilstücke).
```
Erfasst wird ohne zusätzlichen Netzverkehr: Die Zähler laufen im Server mit. Die Latenz misst er über die ohnehin alle 30 s gesendeten WebSocket-Pings. Minuten liegen 48 h im RAM, Stunden 90 Tage in SQLite. `devices[].lastSeen` = zuletzt verbunden (läuft bei verbundenen Geräten minütlich mit, beim Trennen gesetzt; null = nie verbunden). `Online` enthält zusätzlich `deviceId` (= `token`, 12 Zeichen wie `devices[].id`), `rttMs` (null = noch keine Messung), `bytesIn`, `bytesOut`, `updates` und `since` (Unix-Sekunden).

### Sicherungen (Backups) und Export

Eine Sicherung ist eine konsistente Kopie der Datenbank (`data/backups/*.db`). Anhänge liegen unveränderlich nach Hash im Blob-Speicher und werden nie gelöscht, also passt jede Sicherung zu ihnen.
- **Automatisch:** stündliche Prüfung, ob die heutige fehlt (also einmal täglich kurz nach 0 Uhr UTC), Name `tandem-JJJJ-MM-TT.db`. Aufbewahrung nach Großvater-Vater-Sohn: die neuesten `keepDaily`, dazu je Woche bzw. Monat die neueste für die letzten `keepWeekly` Wochen und `keepMonthly` Monate.
- **Von Hand:** `manuell-JJJJ-MM-TT-hhmmss[-label].db`, wird nie automatisch gelöscht. Vor jedem Wiederherstellen legt der Server selbst eine an (Label „vor wiederherstellung“).

`Backup` = `{name, kind: "auto"|"manual", created (Unix-s), size (Bytes), label|null}`

| Methode | Pfad | Body → Antwort |
|---|---|---|
| GET | `/admin/api/backups` | → `{backups:[Backup] (neueste zuerst), settings:{auto, keepDaily, keepWeekly, keepMonthly}, nextAuto (Unix-s, null wenn aus), dbBytes, blobs:{count, bytes}}` |
| POST | `/admin/api/backups` | `{label?}` → Backup (jetzt sichern) |
| PUT | `/admin/api/backups/settings` | `{auto, keepDaily, keepWeekly, keepMonthly}` → `{settings, pruned:[name]}` (dünnt sofort aus; 400, wenn automatisch an und alles 0) |
| DELETE | `/admin/api/backups/{name}` | → 204 |
| GET | `/admin/api/backups/{name}/download` | Datenbank-Datei (SQLite) als Download |
| GET | `/admin/api/backups/{name}/spaces` | → `[{id, name, files}]` (Vaults in der Sicherung) |
| GET | `/admin/api/backups/{name}/spaces/{space}/files` | → `{files:[Entry + status + livePath?], added:[Entry]}`; `status` vergleicht mit heute: `same` \| `changed` (Inhalt anders) \| `moved` (gleicher Inhalt, heute unter `livePath`) \| `missing` (heute gelöscht/nicht da); `added` = heute vorhandene Dateien, die es in der Sicherung nicht gab |
| GET | `/admin/api/backups/{name}/spaces/{space}/docs/{doc}` | → md `{id, path, kind, text}`; ink `{…, head, strokes, lines}`; blob `{…, hash, size}` (Stand in der Sicherung, für Vergleich/Vorschau) |
| POST | `/admin/api/backups/{name}/restore` | `{space, docs?:[docId], all?:bool, prune?:bool}` → `{restored, skipped:[{path, reason}], trashed, safety}`; stellt einzelne Dateien bzw. alle Dateien des Vaults auf den Stand der Sicherung zurück (Inhalt, Pfad, gelöschte zurückholen); `prune` (nur mit `all`) legt heute neue Dateien in den Papierkorb; `safety` = Name der vorher angelegten Sicherheitskopie |
| GET | `/admin/api/backups/{name}/spaces/{space}/export` | Vault im Stand der Sicherung als `.tar` (Notizen, Ink-Flächen, Anhänge) |
| GET | `/admin/api/spaces/{space}/export` | Vault im heutigen Stand als `.tar` |

`GET /admin/api/backups/{name}/spaces/{space}/raw/{doc}`: Datei im Stand der Sicherung (Notiz als Text, Anhang aus dem Blob-Speicher, für Vorschauen). Bezeichnungen manueller Sicherungen werden unverfälscht gespeichert, der Dateiname enthält nur eine ASCII-Form. Ist die automatische Sicherung aus, bleiben vorhandene automatische Sicherungen liegen. Beim Löschen eines Vaults bleiben seine Anhänge erhalten, damit ältere Sicherungen vollständig bleiben. Antwort von `restore`: `{restored (tatsächlich geändert), unchanged, skipped, trashed, safety}`.

**Kommandozeile (z. B. nächtlich per Cron in ein Git-Repo):**
```bash
docker exec tandem /tandem-server export notizen > notizen.tar          # laufender Stand
docker exec tandem /tandem-server export notizen --from tandem-2026-11-01.db > alt.tar
mkdir -p vault-git && tar -xf notizen.tar -C vault-git && git -C vault-git add -A && git -C vault-git commit -qm "Stand $(date +%F)"
```

Die Wiederherstellung läuft wie jede Admin-Änderung über den Hub. Verbundene Geräte übernehmen sie sofort. Eine ganze Datenbank-Sicherung zurückspielen (Notfall) geht nur auf dem Server: Container stoppen, `.db` nach `/data/tandem.db` kopieren, starten.

### Personen und Geräte

Ein Gerät (Token) gehört zu genau einem Vault, weil Anmeldung und Plugin-Einstellungen in Obsidian je Vault getrennt liegen. Zwei Vaults auf einem Rechner sind also zwei Einträge. Verwaltet werden sie im Vault unter „Geräte“ oder bei der Person, dort nach Vault gruppiert. Das Token kommt nur an seinen Vault (WebSocket und HTTP), Vault-Mitgliedschaft der Person vorausgesetzt.

Ein Token ohne Vault (vor 0.6 ausgestellt oder per `token issue`) bindet sich beim ersten Zugriff über den WebSocket an den geöffneten Vault. Rein über die Lese-API genutzte Tokens bleiben ungebunden und gelten für alle Vaults der Person, bis sie von Hand zugeordnet werden. Wird ein Vault gelöscht, verschwinden seine Geräte und offenen Einladungscodes mit.

| Methode | Pfad | Body → Antwort |
|---|---|---|
| GET | `/admin/api/users` | → `[{id, name, color, admin, spaces:[{id,name,role}], devices:[{id, device, space, created, lastSeen, revoked, online, rttMs}]}]` (`space` = Vault des Geräts, null = noch keiner) |
| POST | `/admin/api/users` | `{id, name, color?}` → User (409, wenn es die Kennung schon gibt) |
| PATCH | `/admin/api/users/{id}` | `{name?, color?}` → 204 |
| DELETE | `/admin/api/users/{id}` | → 204 (nicht sich selbst) |
| POST | `/admin/api/users/{id}/invite` | `{hours?, space?}` → `{code, hours, space}` (mit `space` gilt das Gerät nur für diesen Vault; 400 ohne Zugriff der Person) |
| POST | `/admin/api/devices/{deviceId}/revoke` | → 204 (Gerät wird sofort getrennt) |
| POST | `/admin/api/devices/{deviceId}/unrevoke` | → 204 (Sperre aufheben) |
| POST | `/admin/api/devices/{deviceId}/space` | `{space}` → 204 (Gerät einem Vault zuordnen, verbindet sich neu; 400 ohne Zugriff der Person) |
| DELETE | `/admin/api/devices/{deviceId}` | → 204 (Gerät endgültig entfernen, wird sofort getrennt) |
| POST | `/admin/api/devices/cleanup` | `{revoked?: bool, inactiveDays?: n}` → `{removed}` (gesperrte und/oder seit n Tagen ungenutzte Geräte entfernen; gerade verbundene, nicht gesperrte bleiben) |

### Spaces (Vaults)

| Methode | Pfad | Body → Antwort |
|---|---|---|
| GET | `/admin/api/spaces` | → `[{id, name, seq, members:[{id,name,color,role}], stats:{docs,docBytes,blobs,blobBytes,updated}, online}]` |
| POST | `/admin/api/spaces` | `{id, name}` → 204 (409, wenn es die ID schon gibt) |
| PATCH | `/admin/api/spaces/{id}` | `{name}` → 204 |
| DELETE | `/admin/api/spaces/{id}` | `{confirm: "<id>"}` → 204 (löscht alles, auch Verlauf und Anhänge) |
| PUT | `/admin/api/spaces/{id}/members/{user}` | `{role: owner\|write\|read}` → 204 |
| DELETE | `/admin/api/spaces/{id}/members/{user}` | → 204 |

Rollen- und Mitgliedsänderungen trennen die betroffenen Geräte. Sie verbinden sich neu und bekommen dabei ihre neuen Rechte.

### Vault-Inhalte

`Entry` = `{id, path, kind: "md"|"ink"|"blob", hash?, size?, del, by, ts}`

| Methode | Pfad | Body → Antwort |
|---|---|---|
| GET | `/admin/api/spaces/{id}/files` | → `{files:[Entry], online:[Online]}` (auch gelöschte, `del: true`) |
| GET | `/admin/api/spaces/{id}/docs/{doc}` | → md: `{id, path, kind, text, version}`; ink: `{id, path, kind, head, strokes, lines}` |
| PUT | `/admin/api/spaces/{id}/docs/{doc}` | `{text, version, base?}` → `{version, merged, text?}`. Hat sich die Notiz seit `version` geändert und ist `base` (der Text zu `version`) dabei, überträgt der Server die eigenen Änderungen per 3-Wege-Merge auf den aktuellen Stand (`merged: true`, `text` = Ergebnis, das die UI übernehmen muss). **409** `{error, text, version}` nur, wenn sich die Änderungen überschneiden bzw. ohne `base`. Unveränderter Text erzeugt keinen Protokolleintrag. |
| POST | `/admin/api/spaces/{id}/files` | `{path, text?}` → `{id}` (nur `.md`/`.txt`; 409, wenn der Pfad belegt ist) |
| POST | `/admin/api/spaces/{id}/upload?path=<pfad>` | Rohdaten (max. 100 MiB) → `{id, hash, size}` (ersetzt einen vorhandenen Anhang) |
| POST | `/admin/api/spaces/{id}/move` | `{from, to}` → `{moved}` (Datei oder ganzer Ordner) |
| POST | `/admin/api/spaces/{id}/delete` | `{path}` → `{deleted}` (Datei oder ganzer Ordner, landet im Papierkorb = `del`) |
| POST | `/admin/api/spaces/{id}/undelete` | `{doc, path?}` → 204 (409, wenn der Pfad wieder belegt ist; mit `path` unter anderem Namen wiederherstellen, Endung muss zur Art passen) |
| GET | `/admin/api/spaces/{id}/raw/{doc}[?download=1]` | Inhalt einer Datei (Bilder/PDF inline, sonst Download) |
| GET | `/admin/api/spaces/{id}/search?q=<text>` | → `[{id, path, line, text}]` (Volltext in md, max. 200 Treffer) |
| GET | `/admin/api/spaces/{id}/history/{doc}` | → `[{ts, size}]` (Snapshots, neueste zuerst) |
| GET | `/admin/api/spaces/{id}/history/{doc}/{ts}` | → md: `{text}`; ink: `{strokes, lines}` |
| POST | `/admin/api/spaces/{id}/history/{doc}/{ts}/restore` | → `{version}` (nur md; als Diff, offene Editoren sehen es live) |

Alle Schreibzugriffe laufen über den Hub wie Updates eines Clients. Verbundene Obsidian-Instanzen sehen Änderungen sofort, und offene Editoren übernehmen sie live per CRDT.

## Grenzen

- Ink-Flächen (`.ink`) sind in der Oberfläche nur lesbar. Wiederherstellen aus dem Verlauf geht nur für Notizen, Ink-Flächen stellt man in Obsidian wieder her.
- Snapshots für den Verlauf entstehen höchstens stündlich beim Verdichten. Eine frisch angelegte Notiz hat daher noch keinen Verlauf.
- Die IP für die Fehlversuchs-Bremse kommt aus `CF-Connecting-IP` / `X-Real-IP`. Wer den Server unter Umgehung von Cloudflare erreicht, kann sie fälschen. Die Sperre pro Konto (ab 5 Fehlern) greift trotzdem.
- Die TOTP-Geheimnisse liegen in der Datenbank (`admins`) und damit auch in den täglichen Sicherungen.

## Entwickeln

```bash
cd server && cargo build
TANDEM_ADMIN_UI_DIR=$PWD/admin-ui ./target/debug/tandem-server --data /tmp/t serve   # UI-Dateien live von der Platte
```
Tests: `cargo test` (TOTP-Vektoren aus RFC 6238, Passwörter, Diff, Index) und `TANDEM_SERVER=rust node e2e/run.mjs m12` (Admin-Änderungen in echten Obsidian-Instanzen).

## Anmeldung: wie sie abgesichert ist

- **Zwei Schritte:** Kennung + Passwort (Argon2id) ergeben nur ein Ticket. Eine Sitzung gibt es erst mit dem zweiten Faktor: dem 6-stelligen Code (TOTP) oder einem **Passkey** (WebAuthn, ES256/EdDSA/RS256, Nutzerprüfung per PIN/Biometrie Pflicht). Passkeys richtet man angemeldet unter „Konto“ ein. Der Code bleibt als Rückfallweg.
- **Passkeys** sind an die Domain gebunden (`TANDEM_PUBLIC_URL` bzw. Host). Eine Phishing-Seite bekommt keine gültige Antwort. Der Signaturzähler erkennt kopierte Schlüssel. Ein neuer Einrichtungslink (`admin setup`) löscht alle Passkeys des Zugangs.
- **Codes** gelten nur einmal, auch bei zwei gleichzeitigen Anmeldungen (bedingtes Speichern des Zeitschritts).
- **Fehlversuche:** pro Konto ab 5 Fehlern Sperre ab 15 min, die sich je weitere 5 verdoppelt (max. 24 h). Pro IP höchstens 10 Fehlversuche in 15 min. Die IP stammt aus `CF-Connecting-IP`/`X-Real-IP`/`X-Forwarded-For`. Ist der Server an Cloudflare/dem Proxy vorbei direkt erreichbar, lässt sich die IP fälschen. Deshalb den Ursprungsserver per Firewall nur für den Proxy öffnen. Die Kontosperre gilt unabhängig davon.
- **Sitzung:** Cookie `__Host-…; Secure; HttpOnly; SameSite=Strict`, 30 min Leerlauf, höchstens 12 h. Schreibende Anfragen brauchen den Header `X-Tandem-Admin: 1` und eine passende `Origin` (CSRF).
- Geprüft durch `node e2e/run.mjs m15` (u. a. alle Routen ohne Sitzung, Replay, Phishing-Origin, Passkey ohne Passwort-Schritt).
