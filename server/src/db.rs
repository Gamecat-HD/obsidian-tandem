//! SQLite-Speicher: Nutzer, Tokens, Einladungen, Spaces, Doc-Updates, Snapshots, Blob-Metadaten.

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::fill(&mut b[..]);
    hex::encode(b)
}

/// Gut abtippbarer Einladungscode: XXXX-XXXX-XXXX (ohne 0/O/1/I).
pub fn invite_code() -> String {
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut b = [0u8; 12];
    rand::fill(&mut b[..]);
    let s: String = b.iter().map(|x| A[(*x as usize) % A.len()] as char).collect();
    format!("{}-{}-{}", &s[0..4], &s[4..8], &s[8..12])
}

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpaceRole {
    pub id: String,
    pub name: String,
    pub role: String,
}

pub struct Store {
    pub conn: Connection,
}

const COLORS: &[&str] = &["#e5534b", "#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#14b8a6", "#ec4899", "#6366f1"];

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let conn = Connection::open(path).with_context(|| format!("DB öffnen: {}", path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 device TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS members (space TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
                 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, PRIMARY KEY (space, user_id));
             CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, data BLOB NOT NULL, ts INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS updates_doc ON updates(doc, id);
             CREATE TABLE IF NOT EXISTS docs (doc TEXT PRIMARY KEY, space TEXT NOT NULL, seq INTEGER NOT NULL, updated INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS docs_space_seq ON docs(space, seq);
             CREATE TABLE IF NOT EXISTS snapshots (doc TEXT NOT NULL, ts INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (doc, ts));
             CREATE TABLE IF NOT EXISTS blobs (space TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (space, hash));
             CREATE TABLE IF NOT EXISTS admins (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, pw_hash TEXT NOT NULL,
                 totp_secret TEXT NOT NULL, totp_last INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
                 locked_until INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_login INTEGER);
             CREATE TABLE IF NOT EXISTS admin_setup (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 expires INTEGER NOT NULL, pw_hash TEXT, totp_secret TEXT, tries INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 created INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT NOT NULL, agent TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS metrics_hourly (ts INTEGER PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT NOT NULL,
                 ip TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);",
        )?;
        Ok(Self { conn })
    }

    // ── Nutzer & Spaces ──────────────────────────────────────────────

    pub fn add_user(&self, id: &str, name: &str, color: Option<&str>) -> Result<User> {
        if !crate::codec::valid_id(id) {
            bail!("Nutzer-ID nur a-z, 0-9, _ und - (max. 64 Zeichen)");
        }
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        let color = color.map(str::to_string).unwrap_or_else(|| COLORS[n as usize % COLORS.len()].to_string());
        self.conn
            .execute("INSERT INTO users (id, name, color, created) VALUES (?1, ?2, ?3, ?4)", params![id, name, color, now()])
            .context("Nutzer anlegen (existiert er schon?)")?;
        Ok(User { id: id.into(), name: name.into(), color })
    }

    pub fn user(&self, id: &str) -> Result<Option<User>> {
        Ok(self
            .conn
            .query_row("SELECT id, name, color FROM users WHERE id = ?1", [id], |r| {
                Ok(User { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? })
            })
            .optional()?)
    }

    pub fn users(&self) -> Result<Vec<User>> {
        let mut st = self.conn.prepare("SELECT id, name, color FROM users ORDER BY id")?;
        let v = st.query_map([], |r| Ok(User { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? }))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn delete_user(&self, id: &str) -> Result<()> {
        if self.conn.execute("DELETE FROM users WHERE id = ?1", [id])? == 0 {
            bail!("Nutzer {id} nicht gefunden");
        }
        Ok(())
    }

    pub fn add_space(&self, id: &str, name: &str) -> Result<()> {
        if !crate::codec::valid_id(id) {
            bail!("Vault-ID: nur a-z, 0-9, _ und - (max. 64 Zeichen)");
        }
        self.conn
            .execute("INSERT INTO spaces (id, name, created) VALUES (?1, ?2, ?3)", params![id, name, now()])
            .context("Vault anlegen (gibt es die ID schon?)")?;
        Ok(())
    }

    pub fn set_member(&self, space: &str, user: &str, role: &str) -> Result<()> {
        if !matches!(role, "owner" | "write" | "read") {
            bail!("Rolle muss owner, write oder read sein");
        }
        self.conn.execute(
            "INSERT INTO members (space, user_id, role) VALUES (?1, ?2, ?3) ON CONFLICT(space, user_id) DO UPDATE SET role = excluded.role",
            params![space, user, role],
        )?;
        Ok(())
    }

    pub fn remove_member(&self, space: &str, user: &str) -> Result<()> {
        self.conn.execute("DELETE FROM members WHERE space = ?1 AND user_id = ?2", params![space, user])?;
        Ok(())
    }

    pub fn spaces_of(&self, user: &str) -> Result<Vec<SpaceRole>> {
        let mut st = self.conn.prepare(
            "SELECT s.id, s.name, m.role FROM members m JOIN spaces s ON s.id = m.space WHERE m.user_id = ?1 ORDER BY s.id",
        )?;
        let v = st.query_map([user], |r| Ok(SpaceRole { id: r.get(0)?, name: r.get(1)?, role: r.get(2)? }))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn spaces(&self) -> Result<Vec<(String, String, i64, i64)>> {
        let mut st = self.conn.prepare(
            "SELECT s.id, s.name, s.seq, (SELECT COUNT(*) FROM members m WHERE m.space = s.id) FROM spaces s ORDER BY s.id",
        )?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    // ── Tokens & Einladungen ─────────────────────────────────────────

    pub fn create_invite(&self, user: &str, hours: i64) -> Result<String> {
        if self.user(user)?.is_none() {
            bail!("Nutzer {user} nicht gefunden");
        }
        let code = invite_code();
        self.conn.execute(
            "INSERT INTO invites (hash, user_id, expires) VALUES (?1, ?2, ?3)",
            params![sha256_hex(normalize_code(&code).as_bytes()), user, now() + hours * 3600],
        )?;
        Ok(code)
    }

    /// Einladung einlösen → neues Geräte-Token (Klartext nur hier sichtbar).
    pub fn redeem(&self, code: &str, device: &str) -> Result<(String, User)> {
        let hash = sha256_hex(normalize_code(code).as_bytes());
        let row: Option<(String, i64, i64)> = self
            .conn
            .query_row("SELECT user_id, expires, used FROM invites WHERE hash = ?1", [&hash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        let Some((user_id, expires, used)) = row else { bail!("Code ungültig") };
        if used != 0 || expires < now() {
            bail!("Code abgelaufen oder schon benutzt");
        }
        let token = random_token(32);
        let device: String = device.chars().take(64).collect();
        self.conn.execute("UPDATE invites SET used = 1 WHERE hash = ?1", [&hash])?;
        self.conn.execute(
            "INSERT INTO tokens (hash, user_id, device, created) VALUES (?1, ?2, ?3, ?4)",
            params![sha256_hex(token.as_bytes()), user_id, device, now()],
        )?;
        let user = self.user(&user_id)?.ok_or_else(|| anyhow!("Nutzer fehlt"))?;
        Ok((token, user))
    }

    /// Noch nicht eingelösten Einladungscode einer anderen Person zuordnen.
    pub fn move_invite(&self, code: &str, user: &str) -> Result<()> {
        if self.user(user)?.is_none() {
            bail!("Nutzer {user} nicht gefunden");
        }
        let n = self.conn.execute(
            "UPDATE invites SET user_id = ?2 WHERE hash = ?1 AND used = 0",
            params![sha256_hex(normalize_code(code).as_bytes()), user],
        )?;
        if n == 0 {
            bail!("Code unbekannt oder schon eingelöst");
        }
        Ok(())
    }

    /// Direkt ein Token ausstellen (CLI, Tests).
    pub fn issue_token(&self, user: &str, device: &str) -> Result<String> {
        if self.user(user)?.is_none() {
            bail!("Nutzer {user} nicht gefunden");
        }
        let token = random_token(32);
        self.conn.execute(
            "INSERT INTO tokens (hash, user_id, device, created) VALUES (?1, ?2, ?3, ?4)",
            params![sha256_hex(token.as_bytes()), user, device, now()],
        )?;
        Ok(token)
    }

    pub fn auth(&self, token: &str) -> Result<Option<User>> {
        if token.is_empty() || token.len() > 256 {
            return Ok(None);
        }
        let hash = sha256_hex(token.as_bytes());
        let uid: Option<String> = self
            .conn
            .query_row("SELECT user_id FROM tokens WHERE hash = ?1 AND revoked = 0", [&hash], |r| r.get(0))
            .optional()?;
        let Some(uid) = uid else { return Ok(None) };
        self.conn.execute("UPDATE tokens SET last_seen = ?1 WHERE hash = ?2", params![now(), hash])?;
        self.user(&uid)
    }

    pub fn tokens(&self) -> Result<Vec<(String, String, String, i64, Option<i64>, bool)>> {
        let mut st = self.conn.prepare("SELECT substr(hash,1,12), user_id, device, created, last_seen, revoked FROM tokens ORDER BY created")?;
        let v = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? != 0)))?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn revoke(&self, prefix: &str) -> Result<usize> {
        if prefix.len() < 6 {
            bail!("Mindestens 6 Zeichen der Token-Kennung angeben");
        }
        Ok(self.conn.execute("UPDATE tokens SET revoked = 1 WHERE hash LIKE ?1 || '%'", [prefix])?)
    }

    // ── Docs ─────────────────────────────────────────────────────────

    pub fn load_updates(&self, doc: &str) -> Result<Vec<Vec<u8>>> {
        let mut st = self.conn.prepare_cached("SELECT data FROM updates WHERE doc = ?1 ORDER BY id")?;
        let v = st.query_map([doc], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    /// Update speichern, Sequenznummer des Space erhöhen. Liefert die neue Sequenz.
    pub fn append_update(&mut self, space: &str, doc: &str, data: &[u8]) -> Result<u64> {
        let tx = self.conn.transaction()?;
        let ts = now();
        tx.execute("INSERT INTO updates (doc, data, ts) VALUES (?1, ?2, ?3)", params![doc, data, ts])?;
        tx.execute("UPDATE spaces SET seq = seq + 1 WHERE id = ?1", [space])?;
        let seq: i64 = tx.query_row("SELECT seq FROM spaces WHERE id = ?1", [space], |r| r.get(0))?;
        tx.execute(
            "INSERT INTO docs (doc, space, seq, updated, size) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(doc) DO UPDATE SET seq = excluded.seq, updated = excluded.updated, size = docs.size + excluded.size",
            params![doc, space, seq, ts, data.len() as i64],
        )?;
        tx.commit()?;
        Ok(seq as u64)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn update_count(&self, doc: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM updates WHERE doc = ?1", [doc], |r| r.get(0))?)
    }

    /// Alle Updates eines Docs durch ein verdichtetes ersetzen (nur Updates bis `max_id`).
    pub fn compact(&mut self, doc: &str, merged: &[u8]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let max_id: Option<i64> = tx.query_row("SELECT MAX(id) FROM updates WHERE doc = ?1", [doc], |r| r.get(0))?;
        if let Some(max_id) = max_id {
            tx.execute("DELETE FROM updates WHERE doc = ?1 AND id <= ?2", params![doc, max_id])?;
            tx.execute("INSERT INTO updates (doc, data, ts) VALUES (?1, ?2, ?3)", params![doc, merged, now()])?;
            tx.execute("UPDATE docs SET size = ?2 WHERE doc = ?1", params![doc, merged.len() as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn space_seq(&self, space: &str) -> Result<u64> {
        let s: Option<i64> = self.conn.query_row("SELECT seq FROM spaces WHERE id = ?1", [space], |r| r.get(0)).optional()?;
        Ok(s.unwrap_or(0) as u64)
    }

    pub fn changed_since(&self, space: &str, since: u64) -> Result<Vec<String>> {
        let mut st = self.conn.prepare_cached("SELECT doc FROM docs WHERE space = ?1 AND seq > ?2 ORDER BY seq")?;
        let v = st.query_map(params![space, since as i64], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    // ── Snapshots (Versionsgeschichte) ────────────────────────────────

    pub fn last_snapshot_ts(&self, doc: &str) -> Result<Option<i64>> {
        Ok(self.conn.query_row("SELECT MAX(ts) FROM snapshots WHERE doc = ?1", [doc], |r| r.get(0))?)
    }

    pub fn add_snapshot(&self, doc: &str, ts: i64, data: &[u8]) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO snapshots (doc, ts, data) VALUES (?1, ?2, ?3)", params![doc, ts, data])?;
        Ok(())
    }

    pub fn snapshots(&self, doc: &str) -> Result<Vec<(i64, i64)>> {
        let mut st = self.conn.prepare("SELECT ts, length(data) FROM snapshots WHERE doc = ?1 ORDER BY ts DESC")?;
        let v = st.query_map([doc], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn snapshot(&self, doc: &str, ts: i64) -> Result<Option<Vec<u8>>> {
        Ok(self.conn.query_row("SELECT data FROM snapshots WHERE doc = ?1 AND ts = ?2", params![doc, ts], |r| r.get(0)).optional()?)
    }

    /// Snapshots ausdünnen: 2 Tage alle (stündlich), bis 30 Tage einer pro Tag, bis 1 Jahr einer pro Woche.
    pub fn prune_snapshots(&self) -> Result<usize> {
        let t = now();
        let mut n = self.conn.execute("DELETE FROM snapshots WHERE ts < ?1", params![t - 365 * 86400])?;
        // Pro Doc und Zeitraum nur den neuesten behalten
        for (older_than, bucket) in [(2 * 86400, 86400), (30 * 86400, 7 * 86400)] {
            n += self.conn.execute(
                "DELETE FROM snapshots WHERE ts < ?1 AND rowid NOT IN (
                     SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY doc, ts / ?2 ORDER BY ts DESC) AS r
                     FROM snapshots WHERE ts < ?1) WHERE r = 1)",
                params![t - older_than, bucket],
            )?;
        }
        Ok(n)
    }

    // ── Blobs ────────────────────────────────────────────────────────

    pub fn add_blob(&self, space: &str, hash: &str, size: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO blobs (space, hash, size, created) VALUES (?1, ?2, ?3, ?4)",
            params![space, hash, size, now()],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn has_blob(&self, space: &str, hash: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT 1 FROM blobs WHERE space = ?1 AND hash = ?2", params![space, hash], |_| Ok(())).optional()?.is_some())
    }

    pub fn stats(&self) -> Result<serde_json::Value> {
        let q = |sql: &str| -> Result<i64> { Ok(self.conn.query_row(sql, [], |r| r.get(0))?) };
        Ok(serde_json::json!({
            "users": q("SELECT COUNT(*) FROM users")?,
            "spaces": q("SELECT COUNT(*) FROM spaces")?,
            "docs": q("SELECT COUNT(*) FROM docs")?,
            "update_rows": q("SELECT COUNT(*) FROM updates")?,
            "update_bytes": q("SELECT COALESCE(SUM(length(data)),0) FROM updates")?,
            "snapshots": q("SELECT COUNT(*) FROM snapshots")?,
            "blobs": q("SELECT COUNT(*) FROM blobs")?,
            "blob_bytes": q("SELECT COALESCE(SUM(size),0) FROM blobs")?,
        }))
    }

    pub fn backup(&self, to: &Path) -> Result<()> {
        if to.exists() {
            bail!("{} existiert schon", to.display());
        }
        self.conn.execute("VACUUM INTO ?1", [to.to_string_lossy()])?;
        Ok(())
    }

    /// Mitglieder eines Space mit ihren (nicht gesperrten) Geräten.
    pub fn members(&self, space: &str) -> Result<Vec<serde_json::Value>> {
        let mut st = self.conn.prepare(
            "SELECT u.id, u.name, u.color, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.space = ?1 ORDER BY u.name",
        )?;
        let rows: Vec<(String, String, String, String)> =
            st.query_map([space], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        let mut dev = self.conn.prepare("SELECT device, last_seen FROM tokens WHERE user_id = ?1 AND revoked = 0 ORDER BY created")?;
        let mut out = Vec::new();
        for (id, name, color, role) in rows {
            let devices: Vec<serde_json::Value> = dev
                .query_map([&id], |r| Ok(serde_json::json!({ "device": r.get::<_, String>(0)?, "lastSeen": r.get::<_, Option<i64>>(1)? })))?
                .collect::<Result<_, _>>()?;
            out.push(serde_json::json!({ "id": id, "name": name, "color": color, "role": role, "devices": devices }));
        }
        Ok(out)
    }

    pub fn role(&self, space: &str, user: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT role FROM members WHERE space = ?1 AND user_id = ?2", params![space, user], |r| r.get(0))
            .optional()?)
    }
}

/// Filter für das Protokoll.
#[derive(Default)]
pub struct AuditFilter {
    pub user: Option<String>,
    pub action: Option<String>,
    pub q: Option<String>,
    pub since: Option<i64>,
}

/// Admin-Zugang (Passwort-Hash + TOTP-Geheimnis) eines Nutzers.
pub struct AdminCred {
    pub user_id: String,
    pub pw_hash: String,
    pub totp_secret: String,
    pub totp_last: i64,
    pub locked_until: i64,
}

/// Sitzungsdauer: Leerlauf bzw. absolut (Sekunden).
pub const SESSION_IDLE: i64 = 30 * 60;
pub const SESSION_MAX: i64 = 12 * 3600;

impl Store {
    // ── Admin ────────────────────────────────────────────────────────

    /// Einmal-Code zum Einrichten (oder Zurücksetzen) des Admin-Zugangs, 30 min gültig.
    pub fn create_admin_setup(&self, user: &str) -> Result<String> {
        if self.user(user)?.is_none() {
            bail!("Nutzer {user} nicht gefunden");
        }
        self.conn.execute("DELETE FROM admin_setup WHERE user_id = ?1 OR expires < ?2", params![user, now()])?;
        let code = random_token(24);
        self.conn.execute(
            "INSERT INTO admin_setup (hash, user_id, expires) VALUES (?1, ?2, ?3)",
            params![sha256_hex(code.as_bytes()), user, now() + 1800],
        )?;
        Ok(code)
    }

    /// Einrichtung: (user, pw_hash, totp_secret, tries) zu einem gültigen Code.
    pub fn admin_setup(&self, code: &str) -> Result<Option<(String, Option<String>, Option<String>, i64)>> {
        if code.len() > 128 {
            return Ok(None);
        }
        Ok(self
            .conn
            .query_row(
                "SELECT user_id, pw_hash, totp_secret, tries FROM admin_setup WHERE hash = ?1 AND expires >= ?2",
                params![sha256_hex(code.as_bytes()), now()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?)
    }

    pub fn admin_setup_stage(&self, code: &str, pw_hash: &str, totp_secret: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE admin_setup SET pw_hash = ?2, totp_secret = ?3, tries = 0 WHERE hash = ?1",
            params![sha256_hex(code.as_bytes()), pw_hash, totp_secret],
        )?;
        Ok(())
    }

    /// Fehlversuch bei der Einrichtung zählen; nach 5 ist der Code verbraucht.
    pub fn admin_setup_fail(&self, code: &str) -> Result<()> {
        let h = sha256_hex(code.as_bytes());
        self.conn.execute("UPDATE admin_setup SET tries = tries + 1 WHERE hash = ?1", [&h])?;
        self.conn.execute("DELETE FROM admin_setup WHERE hash = ?1 AND tries >= 5", [&h])?;
        Ok(())
    }

    /// Einrichtung abschließen: Zugang speichern, Code verbrauchen, alte Sitzungen beenden.
    pub fn admin_setup_finish(&mut self, code: &str, totp_step: i64) -> Result<String> {
        let tx = self.conn.transaction()?;
        let h = sha256_hex(code.as_bytes());
        let (user, pw, secret): (String, Option<String>, Option<String>) =
            tx.query_row("SELECT user_id, pw_hash, totp_secret FROM admin_setup WHERE hash = ?1", [&h], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let (Some(pw), Some(secret)) = (pw, secret) else { bail!("Einrichtung unvollständig") };
        tx.execute(
            "INSERT INTO admins (user_id, pw_hash, totp_secret, totp_last, created, last_login) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(user_id) DO UPDATE SET pw_hash = excluded.pw_hash, totp_secret = excluded.totp_secret,
                 totp_last = excluded.totp_last, failed = 0, locked_until = 0, last_login = excluded.last_login",
            params![user, pw, secret, totp_step, now()],
        )?;
        tx.execute("DELETE FROM admin_setup WHERE hash = ?1", [&h])?;
        tx.execute("DELETE FROM admin_sessions WHERE user_id = ?1", [&user])?;
        tx.commit()?;
        Ok(user)
    }

    pub fn admin_cred(&self, user: &str) -> Result<Option<AdminCred>> {
        Ok(self
            .conn
            .query_row(
                "SELECT user_id, pw_hash, totp_secret, totp_last, locked_until FROM admins WHERE user_id = ?1",
                [user],
                |r| {
                    Ok(AdminCred {
                        user_id: r.get(0)?,
                        pw_hash: r.get(1)?,
                        totp_secret: r.get(2)?,
                        totp_last: r.get(3)?,
                        locked_until: r.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    /// Fehlversuch: ab 5 Fehlern Sperre, die sich mit jedem weiteren Fünferblock verdoppelt (max. 24 h).
    pub fn admin_login_failed(&self, user: &str) -> Result<()> {
        let failed: i64 = self.conn.query_row("UPDATE admins SET failed = failed + 1 WHERE user_id = ?1 RETURNING failed", [user], |r| r.get(0))?;
        if failed % 5 == 0 {
            let mins = (15i64 << ((failed / 5 - 1).min(7))).min(24 * 60);
            self.conn.execute("UPDATE admins SET locked_until = ?2 WHERE user_id = ?1", params![user, now() + mins * 60])?;
        }
        Ok(())
    }

    pub fn admin_login_ok(&self, user: &str, totp_step: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE admins SET failed = 0, locked_until = 0, totp_last = ?2, last_login = ?3 WHERE user_id = ?1",
            params![user, totp_step, now()],
        )?;
        Ok(())
    }

    pub fn admins(&self) -> Result<Vec<(String, i64, Option<i64>)>> {
        let mut st = self.conn.prepare("SELECT user_id, created, last_login FROM admins ORDER BY user_id")?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn remove_admin(&self, user: &str) -> Result<bool> {
        self.conn.execute("DELETE FROM admin_sessions WHERE user_id = ?1", [user])?;
        Ok(self.conn.execute("DELETE FROM admins WHERE user_id = ?1", [user])? > 0)
    }

    pub fn create_session(&self, user: &str, ip: &str, agent: &str) -> Result<String> {
        let token = random_token(32);
        let t = now();
        self.conn.execute("DELETE FROM admin_sessions WHERE last_seen < ?1 OR created < ?2", params![t - SESSION_IDLE, t - SESSION_MAX])?;
        let agent: String = agent.chars().take(160).collect();
        self.conn.execute(
            "INSERT INTO admin_sessions (hash, user_id, created, last_seen, ip, agent) VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![sha256_hex(token.as_bytes()), user, t, ip, agent],
        )?;
        Ok(token)
    }

    /// Sitzung prüfen (und Leerlauf-Zähler zurücksetzen). Liefert (Nutzer, Sitzungs-Kennung, Ablauf).
    /// Nur wer weiterhin Admin ist, kommt durch.
    pub fn session(&self, token: &str) -> Result<Option<(User, String, i64)>> {
        if token.len() != 64 {
            return Ok(None);
        }
        let h = sha256_hex(token.as_bytes());
        let t = now();
        let row: Option<(String, i64, i64)> = self
            .conn
            .query_row(
                "SELECT s.user_id, s.created, s.last_seen FROM admin_sessions s JOIN admins a ON a.user_id = s.user_id WHERE s.hash = ?1",
                [&h],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((uid, created, last)) = row else { return Ok(None) };
        if last < t - SESSION_IDLE || created < t - SESSION_MAX {
            self.conn.execute("DELETE FROM admin_sessions WHERE hash = ?1", [&h])?;
            return Ok(None);
        }
        if t - last >= 30 {
            self.conn.execute("UPDATE admin_sessions SET last_seen = ?2 WHERE hash = ?1", params![h, t])?;
        }
        let expires = (t + SESSION_IDLE).min(created + SESSION_MAX);
        Ok(self.user(&uid)?.map(|u| (u, h[..12].to_string(), expires)))
    }

    pub fn delete_session(&self, token: &str) -> Result<()> {
        self.conn.execute("DELETE FROM admin_sessions WHERE hash = ?1", [sha256_hex(token.as_bytes())])?;
        Ok(())
    }

    pub fn sessions(&self, user: &str) -> Result<Vec<serde_json::Value>> {
        let t = now();
        let mut st = self.conn.prepare(
            "SELECT substr(hash,1,12), created, last_seen, ip, agent FROM admin_sessions WHERE user_id = ?1 AND last_seen >= ?2 AND created >= ?3 ORDER BY last_seen DESC",
        )?;
        let v = st
            .query_map(params![user, t - SESSION_IDLE, t - SESSION_MAX], |r| {
                Ok(serde_json::json!({ "id": r.get::<_, String>(0)?, "created": r.get::<_, i64>(1)?, "lastSeen": r.get::<_, i64>(2)?,
                    "ip": r.get::<_, String>(3)?, "agent": r.get::<_, String>(4)? }))
            })?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    /// Alle Sitzungen eines Nutzers außer `keep` (Kennung = erste 12 Zeichen des Hashes) beenden.
    pub fn end_sessions(&self, user: &str, keep: Option<&str>) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM admin_sessions WHERE user_id = ?1 AND substr(hash,1,12) != ?2",
            params![user, keep.unwrap_or("")],
        )?)
    }

    pub fn audit(&self, user: &str, ip: &str, action: &str, detail: &str) {
        let detail: String = detail.chars().take(500).collect();
        let _ = self.conn.execute(
            "INSERT INTO audit (ts, user_id, ip, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now(), user, ip, action, detail],
        );
        // Protokoll begrenzen
        let _ = self.conn.execute("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 5000", []);
    }

    pub fn audit_log(&self, before: Option<i64>, limit: i64, f: &AuditFilter) -> Result<Vec<serde_json::Value>> {
        let mut st = self.conn.prepare(
            "SELECT id, ts, user_id, ip, action, detail FROM audit
             WHERE id < ?1 AND (?3 IS NULL OR user_id = ?3) AND (?4 IS NULL OR substr(action, 1, length(?4)) = ?4)
               AND (?5 IS NULL OR instr(lower(detail), lower(?5)) > 0) AND (?6 IS NULL OR ts >= ?6)
             ORDER BY id DESC LIMIT ?2",
        )?;
        let v = st
            .query_map(params![before.unwrap_or(i64::MAX), limit.clamp(1, 500), f.user, f.action, f.q, f.since], |r| {
                Ok(serde_json::json!({ "id": r.get::<_, i64>(0)?, "ts": r.get::<_, i64>(1)?, "user": r.get::<_, String>(2)?,
                    "ip": r.get::<_, String>(3)?, "action": r.get::<_, String>(4)?, "detail": r.get::<_, String>(5)? }))
            })?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    // ── Verwaltung (Admin-Oberfläche) ────────────────────────────────

    pub fn update_user(&self, id: &str, name: Option<&str>, color: Option<&str>) -> Result<()> {
        if let Some(n) = name {
            self.conn.execute("UPDATE users SET name = ?2 WHERE id = ?1", params![id, n])?;
        }
        if let Some(c) = color {
            self.conn.execute("UPDATE users SET color = ?2 WHERE id = ?1", params![id, c])?;
        }
        Ok(())
    }

    pub fn rename_space(&self, id: &str, name: &str) -> Result<()> {
        if self.conn.execute("UPDATE spaces SET name = ?2 WHERE id = ?1", params![id, name])? == 0 {
            bail!("Vault {id} nicht gefunden");
        }
        Ok(())
    }

    /// Space samt Docs, Verlauf und Blob-Metadaten löschen (die Blob-Dateien löscht der Aufrufer).
    pub fn delete_space(&mut self, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        let prefix = format!("{id}/");
        let n = prefix.chars().count() as i64;
        tx.execute("DELETE FROM updates WHERE substr(doc, 1, ?2) = ?1", params![prefix, n])?;
        tx.execute("DELETE FROM snapshots WHERE substr(doc, 1, ?2) = ?1", params![prefix, n])?;
        tx.execute("DELETE FROM docs WHERE space = ?1", [id])?;
        tx.execute("DELETE FROM blobs WHERE space = ?1", [id])?;
        if tx.execute("DELETE FROM spaces WHERE id = ?1", [id])? == 0 {
            bail!("Vault {id} nicht gefunden");
        }
        tx.commit()?;
        Ok(())
    }

    /// Kennzahlen je Space: (docs, Bytes in updates, blobs, Blob-Bytes).
    pub fn space_stats(&self, id: &str) -> Result<serde_json::Value> {
        let docs: i64 = self.conn.query_row("SELECT COUNT(*) FROM docs WHERE space = ?1", [id], |r| r.get(0))?;
        let bytes: i64 = self.conn.query_row("SELECT COALESCE(SUM(size),0) FROM docs WHERE space = ?1", [id], |r| r.get(0))?;
        let (blobs, blob_bytes): (i64, i64) =
            self.conn.query_row("SELECT COUNT(*), COALESCE(SUM(size),0) FROM blobs WHERE space = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let updated: Option<i64> = self.conn.query_row("SELECT MAX(updated) FROM docs WHERE space = ?1", [id], |r| r.get(0))?;
        Ok(serde_json::json!({ "docs": docs, "docBytes": bytes, "blobs": blobs, "blobBytes": blob_bytes, "updated": updated }))
    }

    /// Geräte (Tokens) eines Nutzers.
    pub fn devices(&self, user: &str) -> Result<Vec<serde_json::Value>> {
        let mut st = self.conn.prepare("SELECT substr(hash,1,12), device, created, last_seen, revoked FROM tokens WHERE user_id = ?1 ORDER BY created")?;
        let v = st
            .query_map([user], |r| {
                Ok(serde_json::json!({ "id": r.get::<_, String>(0)?, "device": r.get::<_, String>(1)?, "created": r.get::<_, i64>(2)?,
                    "lastSeen": r.get::<_, Option<i64>>(3)?, "revoked": r.get::<_, i64>(4)? != 0 }))
            })?
            .collect::<Result<_, _>>()?;
        Ok(v)
    }

    /// Genau ein Token über seine 12-stellige Kennung sperren; liefert den vollen Hash.
    pub fn revoke_one(&self, id: &str) -> Result<String> {
        if id.len() != 12 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Kennung ungültig");
        }
        let hashes: Vec<String> = {
            let mut st = self.conn.prepare("SELECT hash FROM tokens WHERE substr(hash,1,12) = ?1")?;
            st.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        if hashes.len() != 1 {
            bail!("Gerät nicht eindeutig gefunden");
        }
        self.conn.execute("UPDATE tokens SET revoked = 1 WHERE hash = ?1", [&hashes[0]])?;
        Ok(hashes[0].clone())
    }

    /// „Zuletzt gesehen“ für verbundene Geräte fortschreiben (Minutentakt, Trennen).
    pub fn touch_tokens<'a>(&self, hashes: impl IntoIterator<Item = &'a String>) -> Result<()> {
        let t = now();
        let mut st = self.conn.prepare_cached("UPDATE tokens SET last_seen = ?1 WHERE hash = ?2")?;
        for h in hashes {
            st.execute(params![t, h])?;
        }
        Ok(())
    }

    /// Gesperrtes Gerät wieder zulassen.
    pub fn unrevoke(&self, id: &str) -> Result<()> {
        if id.len() != 12 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Kennung ungültig");
        }
        if self.conn.execute("UPDATE tokens SET revoked = 0 WHERE substr(hash,1,12) = ?1", [id])? != 1 {
            bail!("Gerät nicht eindeutig gefunden");
        }
        Ok(())
    }

    /// Gerät endgültig entfernen (Token-Eintrag löschen). Liefert den vollen Hash zum Trennen.
    pub fn delete_device(&self, id: &str) -> Result<String> {
        if id.len() != 12 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Kennung ungültig");
        }
        let hashes: Vec<String> = {
            let mut st = self.conn.prepare("SELECT hash FROM tokens WHERE substr(hash,1,12) = ?1")?;
            st.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        if hashes.len() != 1 {
            bail!("Gerät nicht eindeutig gefunden");
        }
        self.conn.execute("DELETE FROM tokens WHERE hash = ?1", [&hashes[0]])?;
        Ok(hashes[0].clone())
    }

    /// Alte Geräte aufräumen: gesperrte und/oder seit `inactive_days` nicht mehr gesehene. Liefert die Hashes.
    /// `keep`: Hashes gerade verbundener Geräte – die bleiben (last_seen wird nur beim Verbinden gesetzt).
    pub fn cleanup_devices(&self, revoked: bool, inactive_days: Option<i64>, keep: &std::collections::HashSet<String>) -> Result<Vec<String>> {
        let cutoff = inactive_days.map(|d| now() - d.max(1) * 86400);
        let mut st = self.conn.prepare("SELECT hash, revoked, COALESCE(last_seen, created) FROM tokens")?;
        let rows: Vec<(String, i64, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        let mut gone = Vec::new();
        for (h, rev, seen) in rows {
            if keep.contains(&h) && rev == 0 {
                continue;
            }
            if (revoked && rev != 0) || cutoff.is_some_and(|c| seen < c) {
                self.conn.execute("DELETE FROM tokens WHERE hash = ?1", [&h])?;
                gone.push(h);
            }
        }
        Ok(gone)
    }

    // ── Statistik ─────────────────────────────────────────────────────

    pub fn save_metrics_hour(&self, p: &crate::metrics::Point) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO metrics_hourly (ts, data) VALUES (?1, ?2)",
            params![p.ts, serde_json::to_string(p)?],
        )?;
        self.conn.execute("DELETE FROM metrics_hourly WHERE ts < ?1", [now() - crate::metrics::HOURS_KEPT_DAYS * 86400])?;
        Ok(())
    }

    pub fn metrics_hours(&self, since: i64) -> Result<Vec<crate::metrics::Point>> {
        let mut st = self.conn.prepare("SELECT data FROM metrics_hourly WHERE ts >= ?1 ORDER BY ts")?;
        let v: Vec<String> = st.query_map([since], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(v
            .into_iter()
            .filter_map(|s| serde_json::from_str::<crate::metrics::Point>(&s).ok())
            .map(|p| crate::metrics::Point { dur: if p.dur > 0 { p.dur.min(3600) } else { 3600 }, ..p })
            .collect())
    }

    /// Zuletzt geänderte Docs (ohne Index): (space, doc, updated).
    pub fn recent_docs(&self, limit: i64) -> Result<Vec<(String, String, i64)>> {
        let mut st = self.conn.prepare("SELECT space, doc, updated FROM docs WHERE substr(doc, -7) != '/_index' ORDER BY updated DESC LIMIT ?1")?;
        let v = st.query_map([limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        Ok(v)
    }

    pub fn setting(&self, key: &str) -> Option<String> {
        self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_setting(&self, key: &str) -> Result<()> {
        self.conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }

    /// Anhänge insgesamt (Zahl, Bytes) – liegen außerhalb der Datenbank.
    pub fn blob_totals(&self) -> (i64, i64) {
        self.conn.query_row("SELECT COUNT(*), COALESCE(SUM(size),0) FROM blobs", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap_or((0, 0))
    }

    /// Hinweise für die Übersicht: Vaults ohne Mitglieder, Geräte lange nicht gesehen, gesperrte Geräte,
    /// fehlgeschlagene Anmeldungen (24 h).
    pub fn attention(&self) -> Result<serde_json::Value> {
        let t = now();
        let mut st = self.conn.prepare("SELECT id, name FROM spaces s WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.space = s.id) ORDER BY id")?;
        let empty: Vec<serde_json::Value> =
            st.query_map([], |r| Ok(serde_json::json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)? })))?.collect::<Result<_, _>>()?;
        let mut st = self.conn.prepare(
            "SELECT substr(t.hash,1,12), t.user_id, u.name, t.device, COALESCE(t.last_seen, t.created) FROM tokens t JOIN users u ON u.id = t.user_id
             WHERE t.revoked = 0 AND COALESCE(t.last_seen, t.created) < ?1 ORDER BY 5",
        )?;
        let stale: Vec<serde_json::Value> = st
            .query_map([t - 30 * 86400], |r| {
                Ok(serde_json::json!({ "id": r.get::<_, String>(0)?, "user": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?,
                    "device": r.get::<_, String>(3)?, "lastSeen": r.get::<_, i64>(4)? }))
            })?
            .collect::<Result<_, _>>()?;
        let revoked: i64 = self.conn.query_row("SELECT COUNT(*) FROM tokens WHERE revoked = 1", [], |r| r.get(0))?;
        let failed: i64 = self.conn.query_row("SELECT COUNT(*) FROM audit WHERE action = 'login.failed' AND ts >= ?1", [t - 86400], |r| r.get(0))?;
        Ok(serde_json::json!({ "vaultsWithoutMembers": empty, "staleDevices": stale, "revokedDevices": revoked, "failedLogins24h": failed }))
    }

    pub fn db_bytes(&self) -> i64 {
        self.conn.query_row("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()", [], |r| r.get(0)).unwrap_or(0)
    }
}

fn normalize_code(c: &str) -> String {
    c.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Store {
        Store::open(Path::new(":memory:")).unwrap()
    }

    #[test]
    fn invite_flow() {
        let s = mem();
        s.add_user("anna", "Anna", None).unwrap();
        s.add_space("schule", "Schule").unwrap();
        s.set_member("schule", "anna", "write").unwrap();
        let code = s.create_invite("anna", 1).unwrap();
        let (tok, u) = s.redeem(&code.to_lowercase(), "Laptop").unwrap();
        assert_eq!(u.id, "anna");
        assert!(s.redeem(&code, "x").is_err(), "Code nur einmal");
        s.add_user("nico", "Nico", None).unwrap();
        let c2 = s.create_invite("anna", 1).unwrap();
        s.move_invite(&c2, "nico").unwrap();
        assert_eq!(s.redeem(&c2, "Tablet").unwrap().1.id, "nico");
        assert!(s.move_invite(&c2, "anna").is_err(), "eingelöste Codes nicht umhängen");
        assert_eq!(s.auth(&tok).unwrap().unwrap().id, "anna");
        assert!(s.auth("falsch").unwrap().is_none());
        let prefix = sha256_hex(tok.as_bytes())[..12].to_string();
        assert_eq!(s.revoke(&prefix).unwrap(), 1);
        assert!(s.auth(&tok).unwrap().is_none());
        assert_eq!(s.spaces_of("anna").unwrap()[0].role, "write");
    }

    #[test]
    fn seq_and_changes() {
        let mut s = mem();
        s.add_space("sp", "Sp").unwrap();
        assert_eq!(s.append_update("sp", "sp/a", &[0, 0]).unwrap(), 1);
        assert_eq!(s.append_update("sp", "sp/b", &[0, 0]).unwrap(), 2);
        assert_eq!(s.append_update("sp", "sp/a", &[0, 0]).unwrap(), 3);
        assert_eq!(s.changed_since("sp", 2).unwrap(), vec!["sp/a"]);
        assert_eq!(s.changed_since("sp", 0).unwrap().len(), 2);
        s.compact("sp/a", &[0, 0]).unwrap();
        assert_eq!(s.update_count("sp/a").unwrap(), 1);
    }
}
