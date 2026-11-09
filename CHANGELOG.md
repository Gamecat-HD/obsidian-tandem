# Änderungen

## 0.6.4

Nur das Plugin hat sich geändert; der Server muss nicht neu ausgerollt werden.

- **Bilder gehen beim Absturz nicht mehr mit kaputt:** Kleine Anhänge liefen bisher parallel zu einem großen. Beendete Android die App beim großen Download, starben die Bilder daneben mit, ohne dass Tandem es bemerkte. Jetzt läuft eine große Übertragung wirklich allein: Sie wartet auf laufende kleine, und neue kleine warten auf sie.
- **Abgebrochene Uploads werden nachgeholt:** Ein Upload wird jetzt vor dem Start als offen gespeichert, nicht erst bei einem Fehler. Stirbt die App mittendrin, lädt der nächste Abgleich die Datei erneut hoch. Vorher konnte ein geändertes Bild so ohne Meldung auf der alten Fassung hängen bleiben.
- **Halb geschriebene Downloads werden neu geladen:** Stirbt die App beim Schreiben eines Anhangs, galt die halbe Datei beim nächsten Start als lokale Änderung und konnte hochgeladen werden. Dann hätte sie die gute Fassung auf allen Geräten ersetzt. Jetzt merkt sich Tandem, welche Datei gerade geschrieben wird, und lädt sie nach einem Absturz neu, ohne Konfliktkopie.

## 0.6.3

Nur das Plugin hat sich geändert.

- **Cursor in Formeln und anderen gerenderten Blöcken:** Steht jemand mit dem Cursor in einer Formel (`$$ … $$` oder `$…$`), die bei dir gerendert ist, war der Cursor bisher unsichtbar. Jetzt wird die Formel in der Farbe der Person umrahmt, ihr Name steht darüber. Dasselbe gilt für alle anderen gerenderten Bereiche, etwa Callouts und Einbettungen. In Tabellen bleibt es beim genauen Cursor in der Zelle. Test `m18`.

## 0.6.2

Nur das Plugin hat sich geändert; der Server muss nicht neu ausgerollt werden.

- **Cursor in Tabellen:** Wer in der Live-Vorschau in einer Tabellenzelle tippt oder sich darin bewegt, wird bei den anderen jetzt an dieser Stelle angezeigt. Bisher blieb der Cursor an der letzten Position außerhalb der Tabelle stehen, weil Obsidian Zellen in einem eigenen Editor bearbeitet. Fremde Cursor erscheinen jetzt auch in der Zelle selbst. Vorher waren sie im Tabellen-Widget unsichtbar.
- **Gleichzeitig in einer Tabelle schreiben:** Beim Betreten einer Zelle schreibt Obsidian die ganze Tabelle neu. Tandem hat das bisher als „alles löschen und neu einfügen“ verschickt. Dadurch sprangen die Cursor anderer, und ihre gleichzeitigen Eingaben in der Tabelle konnten verloren gehen. Jetzt geht nur der echte Unterschied raus. Fremde Änderungen an der Trennzeile kommen so an, dass Obsidian den offenen Zell-Editor nicht mehr zerstört.
- API: `cursors(path)` liefert die Cursor der anderen als absolute Positionen. Test `m17`.

## 0.6.1

- **Keine Absturzschleife durch große Anhänge:** Auf Android beendete schon ein einzelner Download von über 50 MB die App, und beim nächsten Start ging es von vorn los. Anhänge ab 16 MiB werden jetzt einzeln übertragen. Wird die App dabei beendet, überspringt Tandem diese Fassung der Datei auf dem Gerät und meldet das. Erneut versuchen unter Einstellungen → Tandem. Der Download selbst bleibt dort bei dieser Größe noch unmöglich.
- **Uploads von Android:** Die Prüfung per HEAD wirft dort „IOException Stream closed“. Tandem lädt in dem Fall direkt hoch.

## 0.6.0

Ältere Plugins funktionieren weiter, nur die klare Meldung bei falschem Space braucht Plugin 0.6.0.

- **Geräte je Vault:** Ein Gerät gehört jetzt zu genau einem Vault. Zwei Vaults auf einem Rechner sind zwei Einträge, weil Anmeldung und Plugin-Einstellungen je Vault getrennt liegen. Neu in der Admin-Oberfläche: Tab **Geräte** im Vault, die Geräte einer Person nach Vault gruppiert, Einladungscodes für einen bestimmten Vault.
- **Weniger Rechte je Zugang:** Ein Token kommt nur noch an seinen Vault, nicht mehr an alle Vaults der Person. Bestehende Geräte binden sich beim nächsten Verbinden von selbst an den geöffneten Vault. Tokens, die nur die Lese-API nutzen, bleiben ungebunden, bis man sie zuordnet.
- **Vault löschen** entfernt auch seine Geräte und offenen Codes.
- **Gerätename:** Eine Änderung im Plugin erscheint jetzt auch in der Geräteliste des Admins.
- **Plugin:** Stimmt der eingetragene Space nicht mit dem Zugang überein, meldet Tandem das, statt „online“ zu zeigen und still nichts abzugleichen. Ein Code für einen anderen Space stellt den Vault nicht um.
- CLI: `invite <kennung> --space <vault>`, `token list` zeigt den Vault. Test `m16`.

## 0.5.0

**Plugin und Server müssen beide auf 0.5.0.** Ältere Plugins funktionieren mit Klartext-Vaults weiter, verschlüsselte Vaults lehnen sie ab.

- **Ende-zu-Ende-Verschlüsselung pro Vault:** Notizen, Dateinamen, Dateibaum, Anhänge, Cursor und Präsenz verlassen die Geräte nur verschlüsselt (AES-256-GCM, Schlüssel aus einer Passphrase per PBKDF2). Der Server sieht nur Chiffretext. Einrichten beim Anlegen des Vaults (Admin-Oberfläche oder `space add … --e2ee`), die Passphrase legt der Besitzer in Obsidian fest. Admin-Inhaltsansicht, Export und Lese-API gibt es für solche Vaults nicht. Siehe [docs/E2EE.md](docs/E2EE.md).
- **Update-Knopf:** Einstellungen → Tandem → Version prüft die GitHub-Releases, lädt `main.js`/`manifest.json`/`styles.css`, prüft sie gegen `SHA256SUMS` und lädt das Plugin neu. Einmal am Tag sucht Tandem still nach neuen Versionen.
- **Nur noch verschlüsselte Verbindungen:** Das Plugin lehnt `http://`-Serveradressen ab (außer `localhost`).
- **Admin-Anmeldung in zwei Schritten:** erst Kennung und Passwort, dann der 6-stellige Code oder ein **Passkey** (Fingerabdruck, Gesichtserkennung, Sicherheitsschlüssel). Passkeys lassen sich im Konto-Bereich hinzufügen.
- **Sicherheit:** Ein TOTP-Code kann auch bei zwei gleichzeitigen Anmeldungen nur einmal benutzt werden. Ein neuer Einrichtungslink löscht alte Passkeys.
- Neues Release-Skript `deploy/release.sh`, Tests `m14` (E2EE mit echten Obsidian-Instanzen) und `m15` (Admin-Anmeldung, Umgehungsversuche).
