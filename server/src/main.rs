mod admin;
mod auth;
mod backup;
mod codec;
mod db;
mod files_api;
mod hub;
mod metrics;
mod server;
mod tar;
mod vault;
mod webauthn;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::time::Duration;
use tracing::info;

#[derive(Parser)]
#[command(name = "tandem-server", version, about = "Tandem: Echtzeit-Sync-Server für Obsidian")]
struct Cli {
    /// Datenverzeichnis (Datenbank + Anhänge)
    #[arg(long, env = "TANDEM_DATA", default_value = "./data", global = true)]
    data: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Server starten
    Serve {
        #[arg(long, env = "TANDEM_LISTEN", default_value = "127.0.0.1:8080")]
        listen: String,
    },
    /// Erste Einrichtung: Space + Besitzer anlegen und Einladungscode ausgeben
    Setup { space: String, user: String, name: String },
    /// Nutzer verwalten
    User {
        #[command(subcommand)]
        cmd: UserCmd,
    },
    /// Spaces verwalten
    Space {
        #[command(subcommand)]
        cmd: SpaceCmd,
    },
    /// Einladungscode für einen Nutzer erzeugen (ein neues Gerät anmelden)
    Invite {
        user: String,
        #[arg(long, default_value_t = 72)]
        hours: i64,
    },
    /// Noch nicht eingelösten Einladungscode einer anderen Person zuordnen
    InviteMove { code: String, user: String },
    /// Geräte-Tokens
    Token {
        #[command(subcommand)]
        cmd: TokenCmd,
    },
    /// Vault als tar exportieren (Notizen, Ink-Flächen, Anhänge) – auch bei laufendem Server, z. B. für ein Git-Repo
    Export {
        space: String,
        /// Zieldatei (sonst Standardausgabe)
        #[arg(long)]
        out: Option<PathBuf>,
        /// statt der laufenden Datenbank eine Sicherung (Dateiname in data/backups oder Pfad)
        #[arg(long)]
        from: Option<String>,
    },
    /// Admin-Oberfläche (/admin/): Zugänge verwalten
    Admin {
        #[command(subcommand)]
        cmd: AdminCmd,
    },
    /// Statistik
    Stats,
    /// Konsistente Sicherung der Datenbank (läuft auch bei laufendem Server)
    Backup { file: PathBuf },
    /// Gesundheitsprüfung für Docker (ruft /health des laufenden Servers ab)
    Healthcheck {
        #[arg(long, env = "TANDEM_LISTEN", default_value = "127.0.0.1:8080")]
        listen: String,
    },
}

#[derive(Subcommand)]
enum UserCmd {
    Add {
        id: String,
        name: String,
        #[arg(long)]
        color: Option<String>,
    },
    List,
    Remove { id: String },
}

#[derive(Subcommand)]
enum SpaceCmd {
    Add {
        id: String,
        name: String,
        /// Ende-zu-Ende-verschlüsselt: der Server sieht nur Chiffretext (Admin-Ansicht, Export und Lese-API entfallen)
        #[arg(long)]
        e2ee: bool,
    },
    List,
    /// Mitglied hinzufügen/Rolle ändern (owner, write, read)
    Member { space: String, user: String, role: String },
    /// Mitglied entfernen
    Kick { space: String, user: String },
}

#[derive(Subcommand)]
enum AdminCmd {
    /// Einmal-Link zum Einrichten bzw. Zurücksetzen (Passwort + 2FA) erzeugen, 30 min gültig
    Setup {
        user: String,
        /// Öffentliche Adresse des Servers, z. B. https://tandem.example.org
        #[arg(long, env = "TANDEM_PUBLIC_URL")]
        url: Option<String>,
    },
    /// Admins auflisten
    List,
    /// Admin-Rechte entziehen (Sitzungen enden sofort)
    Remove { user: String },
}

#[derive(Subcommand)]
enum TokenCmd {
    /// Token direkt ausstellen (für Tests/Automatisierung)
    Issue { user: String, device: String },
    List,
    /// Token sperren (Kennung aus `token list`)
    Revoke { prefix: String },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "tandem_server=info".into()))
        .with_target(false)
        .init();
    let cli = Cli::parse();
    if let Cmd::Healthcheck { listen } = &cli.cmd {
        return healthcheck(listen);
    }
    if let Cmd::Export { space, out, from } = &cli.cmd {
        let db = match from {
            Some(f) if std::path::Path::new(f).exists() => PathBuf::from(f),
            Some(f) => cli.data.join("backups").join(f),
            None => cli.data.join("tandem.db"),
        };
        let conn = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let n = match out {
            Some(p) => {
                let tmp = p.with_extension("tar.part");
                let mut w = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
                let n = backup::export_tar(&conn, &cli.data.join("blobs"), space, &mut w)?;
                std::io::Write::flush(&mut w)?;
                std::fs::rename(&tmp, p)?;
                n
            }
            None => backup::export_tar(&conn, &cli.data.join("blobs"), space, &mut std::io::BufWriter::new(std::io::stdout().lock()))?,
        };
        eprintln!("{n} Dateien exportiert");
        return Ok(());
    }
    std::fs::create_dir_all(&cli.data)?;
    let db_path = cli.data.join("tandem.db");
    let store = db::Store::open(&db_path)?;

    match cli.cmd {
        Cmd::Serve { listen } => {
            // Zwei Worker genügen; hält den Speicherbedarf klein.
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
            rt.block_on(serve(store, cli.data, listen))?;
        }
        Cmd::Setup { space, user, name } => {
            if store.user(&user)?.is_none() {
                store.add_user(&user, &name, None)?;
            }
            if !store.spaces()?.iter().any(|s| s.0 == space) {
                store.add_space(&space, &space)?;
            }
            store.set_member(&space, &user, "owner")?;
            let code = store.create_invite(&user, 72)?;
            println!("Space „{space}“ mit Besitzer {user} eingerichtet.\nEinladungscode (72 h gültig): {code}");
        }
        Cmd::User { cmd } => match cmd {
            UserCmd::Add { id, name, color } => {
                let u = store.add_user(&id, &name, color.as_deref())?;
                println!("Nutzer {} ({}) angelegt, Farbe {}", u.id, u.name, u.color);
            }
            UserCmd::List => {
                for u in store.users()? {
                    let spaces: Vec<String> = store.spaces_of(&u.id)?.into_iter().map(|s| format!("{}:{}", s.id, s.role)).collect();
                    println!("{:<16} {:<24} {}  {}", u.id, u.name, u.color, spaces.join(" "));
                }
            }
            UserCmd::Remove { id } => {
                store.delete_user(&id)?;
                println!("Nutzer {id} gelöscht (Tokens gesperrt)");
            }
        },
        Cmd::Space { cmd } => match cmd {
            SpaceCmd::Add { id, name, e2ee } => {
                store.add_space(&id, &name)?;
                if e2ee {
                    store.set_space_e2ee(&id, Some(db::E2EE_PENDING))?;
                    println!("Space {id} angelegt (Ende-zu-Ende-verschlüsselt – der Besitzer legt die Passphrase in Obsidian fest)");
                } else {
                    println!("Space {id} angelegt");
                }
            }
            SpaceCmd::List => {
                for (id, name, seq, members) in store.spaces()? {
                    println!("{id:<16} {name:<24} seq={seq} mitglieder={members}");
                }
            }
            SpaceCmd::Member { space, user, role } => {
                store.set_member(&space, &user, &role)?;
                println!("{user} ist jetzt {role} in {space}");
            }
            SpaceCmd::Kick { space, user } => {
                store.remove_member(&space, &user)?;
                println!("{user} aus {space} entfernt");
            }
        },
        Cmd::Invite { user, hours } => {
            let code = store.create_invite(&user, hours)?;
            println!("{code}");
        }
        Cmd::InviteMove { code, user } => {
            store.move_invite(&code, &user)?;
            println!("Code {code} gehört jetzt {user}");
        }
        Cmd::Token { cmd } => match cmd {
            TokenCmd::Issue { user, device } => println!("{}", store.issue_token(&user, &device)?),
            TokenCmd::List => {
                for (id, user, device, created, last, revoked) in store.tokens()? {
                    println!(
                        "{id}  {user:<16} {device:<20} erstellt={created} zuletzt={} {}",
                        last.map(|l| l.to_string()).unwrap_or("-".into()),
                        if revoked { "GESPERRT" } else { "" }
                    );
                }
            }
            TokenCmd::Revoke { prefix } => println!("{} Token(s) gesperrt", store.revoke(&prefix)?),
        },
        Cmd::Admin { cmd } => match cmd {
            AdminCmd::Setup { user, url } => {
                let code = store.create_admin_setup(&user)?;
                let base = url.as_deref().unwrap_or("").trim_end_matches('/');
                println!("Einrichtungs-Link für {user} (30 min gültig, einmalig):\n{base}/admin/#setup={code}");
            }
            AdminCmd::List => {
                for (u, created, last) in store.admins()? {
                    println!("{u:<16} seit={created} zuletzt={}", last.map(|l| l.to_string()).unwrap_or("-".into()));
                }
            }
            AdminCmd::Remove { user } => {
                if store.remove_admin(&user)? {
                    println!("{user} ist kein Admin mehr");
                } else {
                    println!("{user} war kein Admin");
                }
            }
        },
        Cmd::Stats => println!("{}", serde_json::to_string_pretty(&store.stats()?)?),
        Cmd::Backup { file } => {
            store.backup(&file)?;
            println!("Gesichert nach {}", file.display());
        }
        Cmd::Healthcheck { .. } | Cmd::Export { .. } => unreachable!(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn dates() {
        assert_eq!(crate::backup::civil_from_days(0), (1970, 1, 1));
        assert_eq!(crate::backup::civil_from_days(20759), (2026, 11, 2));
    }
}

fn healthcheck(listen: &str) -> Result<()> {
    use std::io::{Read, Write};
    let addr = listen.replace("0.0.0.0", "127.0.0.1");
    let mut s = std::net::TcpStream::connect_timeout(&addr.parse()?, Duration::from_secs(3))?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    s.write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
    let mut buf = String::new();
    s.read_to_string(&mut buf)?;
    if buf.starts_with("HTTP/1.0 200") || buf.starts_with("HTTP/1.1 200") {
        Ok(())
    } else {
        anyhow::bail!("unerwartete Antwort: {}", buf.lines().next().unwrap_or(""))
    }
}

async fn serve(store: db::Store, data: PathBuf, listen: String) -> Result<()> {
    let hub = hub::Hub::new(store, hub::Config::default());
    // Bereits gespeicherten Teil der laufenden Stunde übernehmen (Neustart mitten in der Stunde).
    {
        let st = hub.store.lock().unwrap_or_else(|e| e.into_inner());
        let h = db::now() / 3600 * 3600;
        if let Some(p) = st.metrics_hours(h).ok().and_then(|v| v.into_iter().find(|p| p.ts == h)) {
            hub.metrics.resume_hour(p);
        }
    }
    let app = server::App::new(hub.clone(), data.join("blobs"));
    {
        // Statistik: jede Minute (nur im Prozess, kein Netzverkehr); fertige Stunden in die Datenbank.
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_secs(60));
            t.tick().await;
            loop {
                t.tick().await;
                let (conns, rtts) = hub.conn_rtts();
                {
                    let online = hub.online_tokens();
                    let _ = hub.store.lock().unwrap_or_else(|e| e.into_inner()).touch_tokens(&online);
                }
                let rss = server::rss_kib().unwrap_or(0);
                if let Some(done) = hub.metrics.tick(db::now(), conns, rss, &rtts) {
                    let _ = hub.store.lock().unwrap_or_else(|e| e.into_inner()).save_metrics_hour(&done);
                }
            }
        });
    }
    let backup_dir = data.join("backups");
    {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_millis(300));
            loop {
                t.tick().await;
                hub.flush_changes();
            }
        });
    }
    {
        let hub = hub.clone();
        let backup_dir = backup_dir.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_secs(10));
            let mut n: u64 = 0;
            loop {
                t.tick().await;
                hub.janitor();
                // Kurz nach dem Start und dann stündlich: fehlt die heutige Sicherung, wird sie angelegt
                // (also einmal am Tag, kurz nach Mitternacht UTC); täglich Snapshots ausdünnen.
                if n % 360 == 30 {
                    let st = hub.store.lock().unwrap_or_else(|e| e.into_inner());
                    if n % 8640 == 30 {
                        let _ = st.prune_snapshots();
                    }
                    match backup::auto_backup(&st, &backup_dir) {
                        Ok(Some(p)) => info!("Sicherung: {}", p.display()),
                        Ok(None) => {}
                        Err(e) => tracing::warn!("Sicherung fehlgeschlagen: {e}"),
                    }
                }
                n += 1;
            }
        });
    }
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    info!("tandem-server {} lauscht auf {listen}", env!("CARGO_PKG_VERSION"));
    axum::serve(listener, server::router(app))
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = term.recv() => {},
            }
            info!("wird beendet …");
        })
        .await?;
    hub.kick_all();
    hub.shutdown();
    // Laufende Stunde sichern, damit ein Neustart (Deploy) keine Statistik verliert.
    let _ = hub.store.lock().unwrap_or_else(|e| e.into_inner()).save_metrics_hour(&hub.metrics.current_hour());
    info!("beendet");
    Ok(())
}
