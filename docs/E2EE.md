# Ende-zu-Ende-Verschlüsselung

Ein Vault (Space) kann **Ende-zu-Ende-verschlüsselt** sein. Dann verlassen Notizen, Dateinamen, der Dateibaum, Anhänge, Cursor und Präsenz die Geräte nur verschlüsselt. Der Server – und wer ihn betreibt – sieht nur Chiffretext. Die Verbindung selbst ist wie immer per HTTPS/WSS geschützt, das Plugin lehnt unverschlüsselte `http://`-Adressen ab (außer `localhost`).

Die Einstellung gilt pro Vault. Klartext-Vaults funktionieren unverändert weiter.

## Was dabei wegfällt

Der Server kann verschlüsselte Inhalte nicht lesen. Für einen verschlüsselten Vault gibt es deshalb nicht:

| Funktion | Stattdessen |
|---|---|
| Admin-Oberfläche: Dateien ansehen, bearbeiten, suchen, hochladen | in Obsidian |
| Export als tar, Sicherungen durchsuchen/wiederherstellen | Vault-Kopie aus Obsidian (Befehl „Sicherung des Vaults erstellen“). Die tägliche Server-Sicherung enthält den Vault weiterhin, nur eben verschlüsselt |
| Lese-API (`/api/files`, `/api/file`, z. B. für die Lernplattform) | antwortet mit `409` |
| Versionsgeschichte durch den Server | Fassungen entstehen, wenn ein Gerät die Notiz verdichtet (siehe unten), höchstens stündlich |

Mitglieder, Rollen, Geräte, Statistik und Online-Anzeige funktionieren normal. Der Server kennt weiterhin Nutzer, Geräte, die Zahl und Größe der Dokumente und Anhänge und wann sich etwas ändert.

## Einrichten

1. Vault anlegen und dabei „Ende-zu-Ende-verschlüsselt“ wählen: in der Admin-Oberfläche oder per `tandem-server space add <id> <name> --e2ee`.
2. Der Besitzer verbindet sich in Obsidian. Tandem fragt nach einer **Passphrase** (mindestens 12 Zeichen, am besten mehrere Wörter). Bis dahin wird nichts synchronisiert.
3. Alle anderen Geräte und Personen fragt Tandem beim ersten Verbinden nach derselben Passphrase. Eine falsche wird abgelehnt.

Ein bestehender, noch **leerer** Klartext-Vault lässt sich vom Besitzer unter Einstellungen → Tandem → Verschlüsselung umstellen. Ein Vault mit Inhalt lässt sich nicht umstellen (sonst lägen Klartext und Chiffretext gemischt im selben Vault). Dafür einen neuen Vault anlegen und den Ordner dorthin synchronisieren.

> **Ohne Passphrase sind die Daten verloren.** Niemand kann sie zurücksetzen, auch nicht der Server-Admin.

Die Passphrase selbst wird nirgends gespeichert. Jedes Gerät merkt sich nur den daraus abgeleiteten Schlüssel (Obsidian-localStorage, nicht im Vault, nicht in `data.json`). „Schlüssel auf diesem Gerät vergessen“ in den Einstellungen löscht ihn.

## Kryptografie

- **Schlüsselableitung:** PBKDF2-SHA256 mit 600 000 Runden und 16 Byte zufälligem Salz → 256-Bit-Hauptschlüssel. Daraus per HKDF-SHA256 getrennte Schlüssel für Dokumente, Anhänge und die Anhang-IV. Nur WebCrypto, läuft also auch auf Android und iOS.
- **Parameter auf dem Server:** `{v:1, kdf:"pbkdf2-sha256", iter, salt, check}`. `check` ist ein mit dem Schlüssel verschlüsselter fester Text. Damit erkennt ein Gerät, ob die eingegebene Passphrase stimmt. Wer `check` kennt, kann damit offline Passphrasen raten (wie bei jeder passwortbasierten Verschlüsselung). Deshalb die hohe Rundenzahl und die Mindestlänge.
- **Format jedes Chiffretexts:** `0x01 | IV (12 Byte) | AES-256-GCM(Daten) + Tag (16 Byte)`.
- **Bindung an den Ort (AAD):** Updates `doc:<space>/<docId>`, Awareness `aw:<space>/<docId>`, Anhänge `blob:<space>`, Prüfwert `check:<space>`. Der Server kann keine Updates zwischen Dokumenten oder Vaults vertauschen, ohne dass die Entschlüsselung fehlschlägt.
- **Anhänge:** Die IV ist `HMAC(Schlüssel, space:Klartext-Hash)`. Gleicher Inhalt ergibt also gleichen Chiffretext. Der Server kann weiter deduplizieren und prüft wie bisher den SHA-256 dessen, was er speichert. Im (verschlüsselten) Index steht neben dem Klartext-Hash `hash` die Server-Adresse `ehash` = SHA-256 des Chiffretexts. Preis der Deduplizierung: Der Server sieht, wenn zwei Anhänge identisch sind.
- **Awareness:** Jeder Zustand wird einzeln verschlüsselt, als JSON-String `"e1:<base64>"`. Nur `null` (Eintrag entfernt) bleibt lesbar, damit der Server verlassene Cursor aufräumen kann.

## Protokoll

Verschlüsselte Spaces benutzen statt SYNC (Yjs-Sync mit State-Vectors, die der Server auswerten müsste) eigene Frames. Der Server führt pro Dokument nur ein Log aus Chiffretext-Zeilen mit fortlaufender ID:

| type | Name | Richtung | Felder |
|---|---|---|---|
| 10 | ESUB | C→S | `varString doc`, `varUint since` – abonnieren, alle Zeilen nach `since` anfordern |
| 11 | ELOG | S→C | `varString doc`, `varUint total` (Zeilen insgesamt), `varUint n`, n × (`varUint id`, `varBytes data`) |
| 12 | EUPD | C→S | `varString doc`, `varBytes data` – verschlüsseltes Update anhängen |
| 12 | EUPD | S→C | `varString doc`, `varUint id`, `varBytes data` – Update eines anderen Geräts |
| 13 | EACK | S→C | `varString doc`, `varUint id` – eigenes Update gespeichert unter `id` |
| 14 | ECOMPACT | C→S | `varString doc`, `varUint upto`, `varBytes data` – Zeilen bis `upto` durch verschlüsselten Gesamtstand ersetzen |

AWARENESS, UNSUB, CHANGES, CATCHUP, PING bleiben gleich. In verschlüsselten Spaces beantwortet der Server SYNC mit `ERROR 426` (älteres Plugin). In Klartext-Spaces lehnt er E-Frames ab.

**Ablauf im Plugin:** Jedes Dokument merkt sich lokal (IndexedDB) seinen `cursor` (letzte gelesene Zeile) und die noch nicht bestätigten eigenen Updates (`pending`). Abo = ESUB ab `cursor`. Nach dem ELOG schickt das Plugin alle `pending` gesammelt als ein EUPD. Ein EACK entfernt sie. Offline entstandene Änderungen überleben so auch einen Neustart.

**Verdichten:** Meldet ELOG 64 oder mehr Zeilen, verschlüsselt das Gerät seinen Gesamtstand und schickt ihn per ECOMPACT. Der Server ersetzt die Zeilen bis `upto` durch eine Zeile mit derselben ID `upto`. Wer schon weiter gelesen hat, lädt nichts doppelt. Diese Gesamtstände dienen zugleich als Fassungen der Versionsgeschichte (höchstens eine pro Stunde und Dokument).

**Einrichten:** `POST /api/e2ee/<space>` mit den Parametern (Bearer-Token, nur Besitzer). Erlaubt, solange der Space leer ist oder auf die Passphrase wartet. Danach trennt der Server alle Verbindungen des Space, und die Geräte melden sich mit den neuen Parametern im WELCOME neu an (`spaces[].e2ee`: fehlt = Klartext, `"pending"`, oder die Parameter).
