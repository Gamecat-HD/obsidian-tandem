# Änderungen

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
