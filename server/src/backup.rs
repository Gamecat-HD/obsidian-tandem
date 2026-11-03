//! Sicherungen der Datenbank: automatisch (täglich, Aufbewahrung nach Tag/Woche/Monat) und von Hand.
//!
//! Eine Sicherung ist eine konsistente Kopie der SQLite-Datenbank (`VACUUM INTO`). Anhänge liegen
//! unveränderlich nach Hash in `data/blobs/` und werden nie gelöscht – jede Sicherung passt daher zu ihnen.
//! Dateinamen: automatisch `tandem-JJJJ-MM-TT.db`, von Hand `manuell-JJJJ-MM-TT-hhmmss[-label].db`.

use crate::db::{Store, now};
use anyhow::{Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// automatische Sicherung an/aus
    pub auto: bool,
    pub keep_daily: u32,
    pub keep_weekly: u32,
    pub keep_monthly: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { auto: true, keep_daily: 7, keep_weekly: 4, keep_monthly: 6 }
    }
}

impl Settings {
    pub fn load(st: &Store) -> Self {
        st.setting("backup").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    pub fn save(&self, st: &Store) -> Result<()> {
        if self.keep_daily > 365 || self.keep_weekly > 260 || self.keep_monthly > 120 {
            bail!("Aufbewahrung zu groß");
        }
        if self.keep_daily + self.keep_weekly + self.keep_monthly == 0 && self.auto {
            bail!("Mindestens eine automatische Sicherung aufbewahren");
        }
        st.set_setting("backup", &serde_json::to_string(self)?)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub name: String,
    /// "auto" | "manual"
    pub kind: &'static str,
    pub created: i64,
    pub size: u64,
    pub label: Option<String>,
}

/// Tage seit 1970 → (Jahr, Monat, Tag) (Algorithmus von Howard Hinnant).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (Jahr, Monat, Tag) → Tage seit 1970.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Nur harmlose Dateinamen (kein Pfad).
pub fn valid_name(n: &str) -> bool {
    n.len() <= 120
        && n.ends_with(".db")
        && (n.starts_with("tandem-") || n.starts_with("manuell-"))
        && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && !n.contains("..")
}

fn parse(name: &str, size: u64, mtime: i64) -> Option<Info> {
    if !valid_name(name) {
        return None;
    }
    let stem = name.strip_suffix(".db")?;
    if let Some(date) = stem.strip_prefix("tandem-") {
        let (y, m, d) = parse_date(date)?;
        return Some(Info { name: name.into(), kind: "auto", created: days_from_civil(y, m, d) * 86400, size, label: None });
    }
    let rest = stem.strip_prefix("manuell-")?;
    let (date, rest) = (rest.get(..10)?, rest.get(10..)?);
    let (y, m, d) = parse_date(date)?;
    let rest = rest.strip_prefix('-')?;
    let (time, label) = (rest.get(..6)?, rest.get(6..).and_then(|l| l.strip_prefix('-')).filter(|l| !l.is_empty()));
    let t: i64 = time.parse().ok()?;
    let secs = (t / 10000) * 3600 + (t / 100 % 100) * 60 + t % 100;
    let created = days_from_civil(y, m, d) * 86400 + secs;
    let _ = mtime;
    Some(Info { name: name.into(), kind: "manual", created, size, label: label.map(|l| l.replace('_', " ")) })
}

fn parse_date(s: &str) -> Option<(i64, u32, u32)> {
    let mut it = s.split('-');
    let y = it.next()?.parse().ok()?;
    let m = it.next()?.parse().ok()?;
    let d = it.next()?.parse().ok()?;
    if it.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

pub fn list(dir: &Path) -> Vec<Info> {
    let mut v: Vec<Info> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            let mtime = md.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
            parse(e.file_name().to_str()?, md.len(), mtime)
        })
        .collect();
    v.sort_by(|a, b| b.created.cmp(&a.created).then(b.name.cmp(&a.name)));
    v
}

/// Label für Dateinamen säubern: a-z, 0-9, _ (max. 40 Zeichen).
fn clean_label(l: &str) -> String {
    let s: String = l
        .trim()
        .chars()
        .map(|c| match c {
            'ä' | 'Ä' => 'a',
            'ö' | 'Ö' => 'o',
            'ü' | 'Ü' => 'u',
            'ß' => 's',
            c if c.is_ascii_alphanumeric() => c.to_ascii_lowercase(),
            _ => '_',
        })
        .collect();
    s.trim_matches('_').chars().take(40).collect()
}

pub fn create_manual(st: &Store, dir: &Path, label: Option<&str>) -> Result<Info> {
    let raw_label = label;
    std::fs::create_dir_all(dir)?;
    let t = now();
    let (y, m, d) = civil_from_days(t.div_euclid(86400));
    let s = t.rem_euclid(86400);
    let label = label.map(clean_label).filter(|l| !l.is_empty());
    let base = format!("manuell-{y:04}-{m:02}-{d:02}-{:02}{:02}{:02}", s / 3600, s / 60 % 60, s % 60);
    let label = label.unwrap_or_default();
    // Gleiche Sekunde, gleiches Label: Zähler anhängen (wird Teil des Labels)
    let mut n = 1;
    let (name, path) = loop {
        let l = match (label.is_empty(), n) {
            (true, 1) => String::new(),
            (true, n) => format!("-{n}"),
            (false, 1) => format!("-{label}"),
            (false, n) => format!("-{label}_{n}"),
        };
        let name = format!("{base}{l}.db");
        let path = dir.join(&name);
        if !path.exists() {
            break (name, path);
        }
        n += 1;
        if n > 99 {
            bail!("Zu viele Sicherungen in derselben Sekunde");
        }
    };
    st.backup(&path)?;
    let size = std::fs::metadata(&path)?.len();
    let mut info = parse(&name, size, t).expect("eigener Name");
    // Bezeichnung unverfälscht merken (der Dateiname kennt nur a-z, 0-9, _)
    if let Some(raw) = raw_label.map(str::trim).filter(|l| !l.is_empty()) {
        let raw: String = raw.chars().filter(|c| !c.is_control()).take(80).collect();
        st.set_setting(&format!("backup-label:{name}"), &raw)?;
        info.label = Some(raw);
    }
    Ok(info)
}

/// Automatische Tagessicherung (falls heute noch keine) und Ausdünnen. Liefert den Pfad einer neuen Sicherung.
pub fn auto_backup(st: &Store, dir: &Path) -> Result<Option<PathBuf>> {
    let cfg = Settings::load(st);
    if !cfg.auto {
        return Ok(None);
    }
    std::fs::create_dir_all(dir)?;
    let (y, m, d) = civil_from_days(now().div_euclid(86400));
    let file = dir.join(format!("tandem-{y:04}-{m:02}-{d:02}.db"));
    let created = if file.exists() {
        None
    } else {
        st.backup(&file)?;
        Some(file)
    };
    prune(dir, &cfg)?;
    Ok(created)
}

/// Liste mit den gespeicherten (unverfälschten) Bezeichnungen.
pub fn list_labeled(st: &Store, dir: &Path) -> Vec<Info> {
    let mut v = list(dir);
    for i in &mut v {
        if let Some(l) = st.setting(&format!("backup-label:{}", i.name)) {
            i.label = Some(l);
        }
    }
    v
}

/// Automatische Sicherungen nach Großvater-Vater-Sohn ausdünnen: die neuesten `keep_daily`, dazu je Woche
/// bzw. Monat die neueste für die letzten `keep_weekly` Wochen und `keep_monthly` Monate. Manuelle bleiben.
pub fn prune(dir: &Path, cfg: &Settings) -> Result<Vec<String>> {
    // Ist die automatische Sicherung aus, bleiben vorhandene automatische Sicherungen unangetastet.
    if !cfg.auto {
        return Ok(Vec::new());
    }
    let autos: Vec<Info> = list(dir).into_iter().filter(|i| i.kind == "auto").collect(); // neueste zuerst
    let keep = to_keep(&autos, cfg);
    let mut gone = Vec::new();
    for i in autos {
        if !keep.contains(&i.name) {
            std::fs::remove_file(dir.join(&i.name))?;
            gone.push(i.name);
        }
    }
    Ok(gone)
}

fn to_keep(autos_newest_first: &[Info], cfg: &Settings) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut keep: HashSet<String> = HashSet::new();
    for i in autos_newest_first.iter().take(cfg.keep_daily as usize) {
        keep.insert(i.name.clone());
    }
    let mut weeks = HashSet::new();
    let mut months = HashSet::new();
    for i in autos_newest_first {
        let day = i.created.div_euclid(86400);
        let week = (day + 3).div_euclid(7); // Wochen ab Montag
        let (y, m, _) = civil_from_days(day);
        if weeks.len() < cfg.keep_weekly as usize && weeks.insert(week) {
            keep.insert(i.name.clone());
        }
        if months.len() < cfg.keep_monthly as usize && months.insert((y, m)) {
            keep.insert(i.name.clone());
        }
    }
    keep
}

/// Sicherung nur lesend öffnen.
pub fn open(dir: &Path, name: &str) -> Result<Connection> {
    if !valid_name(name) {
        bail!("Name ungültig");
    }
    let path = dir.join(name);
    if !path.exists() {
        bail!("Sicherung nicht gefunden");
    }
    Ok(Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?)
}

/// Doc aus einer Sicherung zusammensetzen (None, wenn es dort keine Updates gibt).
pub fn load_doc(conn: &Connection, doc: &str) -> Result<Option<yrs::Doc>> {
    use yrs::Transact;
    use yrs::updates::decoder::Decode;
    let mut st = conn.prepare_cached("SELECT data FROM updates WHERE doc = ?1 ORDER BY id")?;
    let rows: Vec<Vec<u8>> = st.query_map([doc], |r| r.get(0))?.collect::<Result<_, _>>()?;
    if rows.is_empty() {
        return Ok(None);
    }
    let d = yrs::Doc::new();
    {
        let mut txn = d.transact_mut();
        for r in rows {
            if let Ok(u) = yrs::Update::decode_v1(&r) {
                let _ = txn.apply_update(u);
            }
        }
    }
    Ok(Some(d))
}

/// Vault aus einer Datenbank (laufende oder Sicherung, nur lesend) als tar schreiben – für die Kommandozeile.
/// Liefert die Zahl der Dateien. Bei Pfad-Doppelungen gewinnt wie im Plugin die kleinste docId.
pub fn export_tar(conn: &Connection, blob_dir: &Path, space: &str, out: &mut impl std::io::Write) -> Result<usize> {
    use crate::vault;
    if !spaces(conn)?.iter().any(|s| s.0 == space) {
        bail!("Vault {space} nicht gefunden");
    }
    if is_e2ee(conn, space) {
        bail!("Vault {space} ist Ende-zu-Ende-verschlüsselt – exportieren lässt er sich nur aus Obsidian heraus");
    }
    let entries = load_doc(conn, &format!("{space}/{}", vault::INDEX))?.map(|d| vault::read_index(&d)).unwrap_or_default();
    let mut winners: std::collections::BTreeMap<String, &vault::Entry> = std::collections::BTreeMap::new();
    for e in entries.iter().filter(|e| !e.del) {
        let w = winners.entry(e.path.clone()).or_insert(e);
        if e.id < w.id {
            *w = e;
        }
    }
    let mut n = 0;
    for (path, e) in winners {
        let mtime = (e.ts / 1000.0).max(0.0) as u64;
        let docname = format!("{space}/{}", e.id);
        let bytes: Option<Vec<u8>> = match e.kind.as_str() {
            "md" => load_doc(conn, &docname)?.map(|d| vault::read_text(&d).into_bytes()),
            "ink" => load_doc(conn, &docname)?.and_then(|d| crate::files_api::encode_ink(&d)).map(String::into_bytes),
            _ => None,
        };
        if let Some(b) = bytes {
            out.write_all(&crate::tar::file_header(&path, b.len() as u64, mtime))?;
            out.write_all(&b)?;
            out.write_all(&vec![0u8; crate::tar::padding(b.len() as u64)])?;
            n += 1;
        } else if e.kind == "blob" {
            let Some(h) = e.hash.as_deref().filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())) else { continue };
            let p = blob_dir.join(space).join(&h[..2]).join(h);
            let Ok(mut f) = std::fs::File::open(&p) else { continue };
            let size = f.metadata()?.len();
            out.write_all(&crate::tar::file_header(&path, size, mtime))?;
            let copied = std::io::copy(&mut (&mut f).take(size), out)?;
            if copied < size {
                out.write_all(&vec![0u8; (size - copied) as usize])?;
            }
            out.write_all(&vec![0u8; crate::tar::padding(size)])?;
            n += 1;
        }
    }
    out.write_all(&crate::tar::trailer())?;
    Ok(n)
}

/// Ist der Space in dieser Datenbank Ende-zu-Ende-verschlüsselt? (Ältere Sicherungen haben die Spalte nicht.)
pub fn is_e2ee(conn: &Connection, space: &str) -> bool {
    conn.query_row("SELECT e2ee FROM spaces WHERE id = ?1", [space], |r| r.get::<_, Option<String>>(0)).ok().flatten().is_some()
}

/// Spaces einer Sicherung.
pub fn spaces(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut st = conn.prepare("SELECT id, name FROM spaces ORDER BY id")?;
    let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(name: &str) -> Info {
        parse(name, 1, 0).unwrap()
    }

    #[test]
    fn names() {
        assert!(valid_name("tandem-2026-11-02.db"));
        assert!(valid_name("manuell-2026-11-02-171501-vor_umbau.db"));
        for bad in ["../x.db", "tandem-2026.db/..", "x.db", "tandem-2026-11-02.sqlite", "manuell-a/b.db"] {
            assert!(!valid_name(bad) || parse(bad, 0, 0).is_none(), "{bad}");
        }
        let m = info("manuell-2026-11-02-171501-vor_umbau.db");
        assert_eq!(m.kind, "manual");
        assert_eq!(m.label.as_deref(), Some("vor umbau"));
        assert_eq!(m.created, days_from_civil(2026, 11, 2) * 86400 + 17 * 3600 + 15 * 60 + 1);
        assert_eq!(info("tandem-2026-11-02.db").created, days_from_civil(2026, 11, 2) * 86400);
        assert_eq!(clean_label("Vor dem Umbau! (Größe)"), "vor_dem_umbau___grose");
        for d in [0, 20759, 11016, -1] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
    }

    #[test]
    fn gfs_retention() {
        // 120 Tage täglich, neueste zuerst
        let start = days_from_civil(2026, 11, 2);
        let autos: Vec<Info> = (0..120)
            .map(|i| {
                let (y, m, d) = civil_from_days(start - i);
                info(&format!("tandem-{y:04}-{m:02}-{d:02}.db"))
            })
            .collect();
        let keep = to_keep(&autos, &Settings { auto: true, keep_daily: 7, keep_weekly: 4, keep_monthly: 3 });
        // 7 tägliche; Wochen 1–4 enthalten die neueste (schon gezählt) bzw. je eine ältere; Monate: Nov/Okt/Sep
        assert!(keep.contains("tandem-2026-11-02.db") && keep.contains("tandem-2026-10-27.db"));
        assert!(!keep.contains("tandem-2026-10-26.db") || keep.len() <= 7 + 4 + 3);
        assert!(keep.contains("tandem-2026-09-30.db"), "neueste im September");
        assert!(!keep.iter().any(|k| k.starts_with("tandem-2026-08")), "August liegt außerhalb von 3 Monaten");
        assert!(keep.len() <= 14);
    }
}
