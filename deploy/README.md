# Deploy

Allgemeine Installation (Docker, Reverse-Proxy, erstes Konto): **[docs/INSTALL.md](../docs/INSTALL.md)**.
Diese Seite beschreibt nur die Skripte für Deploys über die **Portainer-API**.

## Einstellungen

```bash
cp deploy/local.env.example deploy/local.env     # steht in .gitignore
```

| Variable | Bedeutung |
|---|---|
| `PORTAINER_URL` | z. B. `https://portainer.example.com` |
| `PORTAINER_ENDPOINT` | ID der Docker-Umgebung in Portainer |
| `PORTAINER_TOKEN_FILE` | Datei mit dem API-Key (Standard `~/.config/portainer/token`) |
| `TANDEM_PUBLIC_URL` | öffentliche Adresse, z. B. `https://tandem.example.com` |
| `TANDEM_ADMIN_USER` | Standard-Kennung für `admin-setup.sh` |

Server-Adressen, IDs und Tokens gehören nur in `local.env`, nie ins Repo.

## Aktualisieren: `deploy/redeploy.sh`

1. baut den statischen Binary (`server/build-static.sh`, auf dem Server wird nichts kompiliert),
2. baut daraus per Docker-API das Image `tandem-server:<version>` und `:latest` (`Dockerfile.prebuilt`),
3. tauscht den Container `tandem` mit identischer Konfiguration aus (`inspect` → neu anlegen).

Wird der neue Container nicht innerhalb von 60 s „healthy“, kommt automatisch der alte zurück. Eine `flock`-Sperre verhindert gleichzeitige Deploys.

## Admin-Zugang: `deploy/admin-setup.sh [kennung]`

Führt `tandem-server admin setup <kennung>` über die Portainer-Exec-API im Container aus und gibt den Einmal-Link aus (30 min gültig). Das ist nötig, weil das Image keine Shell hat und die Portainer-Konsole deshalb nicht geht.

## Hinweise

- `deploy/Dockerfile` baut im Container (mehrstufig, 1–2 GB RAM beim Bauen), `deploy/Dockerfile.prebuilt` nimmt einen fertigen Binary.
- Die Portainer-API hinter Cloudflare lehnt Pythons `urllib` ab (Error 1010), deshalb nutzen die Skripte `curl`.
- `docker-compose.yml`: lauscht nur auf `127.0.0.1:8095`, `mem_limit 128m`, read-only, ohne Capabilities, unprivilegierter Nutzer. Daten im Volume `tandem-data` (`/data/tandem.db`, `/data/blobs/`, `/data/backups/`).
