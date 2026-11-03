# Änderungen

## 0.5.0

**Plugin und Server müssen beide auf 0.5.0.** Ältere Plugins funktionieren mit Klartext-Vaults weiter, verschlüsselte Vaults lehnen sie ab.

- **Ende-zu-Ende-Verschlüsselung pro Vault:** Notizen, Dateinamen, Dateibaum, Anhänge, Cursor und Präsenz verlassen die Geräte nur verschlüsselt (AES-256-GCM, Schlüssel aus einer Passphrase per PBKDF2). Der Server sieht nur Chiffretext. Einrichten beim Anlegen des Vaults (Admin-Oberfläche oder `space add … --e2ee`), die Passphrase legt der Besitzer in Obsidian fest. Admin-Inhaltsansicht, Export und Lese-API gibt es für solche Vaults nicht. Siehe [docs/E2EE.md](docs/E2EE.md).
- **Update-Knopf:** Einstellungen → Tandem → Version prüft die GitHub-Releases, lädt `main.js`/`manifest.json`/`styles.css`, prüft sie gegen `SHA256SUMS` und lädt das Plugin neu. Einmal am Tag sucht Tandem still nach neuen Versionen.
- **Nur noch verschlüsselte Verbindungen:** Das Plugin lehnt `http://`-Serveradressen ab (außer `localhost`).
- **Admin-Anmeldung in zwei Schritten:** erst Kennung und Passwort, dann der 6-stellige Code oder ein **Passkey** (Fingerabdruck, Gesichtserkennung, Sicherheitsschlüssel). Passkeys lassen sich im Konto-Bereich hinzufügen.
- **Sicherheit:** Ein TOTP-Code kann auch bei zwei gleichzeitigen Anmeldungen nur einmal benutzt werden. Ein neuer Einrichtungslink löscht alte Passkeys.
- Neues Release-Skript `deploy/release.sh`, Tests `m14` (E2EE mit echten Obsidian-Instanzen) und `m15` (Admin-Anmeldung, Umgehungsversuche).
