//! Nutzungs- und Geschwindigkeitsstatistik – ohne zusätzlichen Netzverkehr.
//!
//! Zähler laufen in Atomics mit; ein Takt pro Minute (im Server, kein Netz) schreibt eine Minute in einen
//! Ringpuffer (48 h im RAM) und sammelt die Stunde, die beim Stundenwechsel in SQLite landet (90 Tage).
//! Latenz je Gerät kommt aus den ohnehin alle 30 s gesendeten WebSocket-Pings (Pong-Laufzeit).

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

pub const MINUTES_KEPT: usize = 48 * 60;
pub const HOURS_KEPT_DAYS: i64 = 90;

/// Zähler je Verbindung (gehört dem Socket-Task, der Hub hält eine Referenz).
#[derive(Default)]
pub struct ConnStats {
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
    pub updates: AtomicU64,
    /// letzte Ping-Laufzeit in µs (0 = noch keine)
    pub rtt_us: AtomicU64,
    pub connected_at: AtomicU64,
}

#[derive(Default)]
struct Live {
    updates: AtomicU64,
    awareness: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
    blob_up: AtomicU64,
    blob_up_bytes: AtomicU64,
    blob_down: AtomicU64,
    blob_down_bytes: AtomicU64,
}

/// Eine Minute bzw. eine Stunde (gleiche Felder; `users`/`spaces` nur in Stunden).
#[derive(Clone, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub ts: i64,
    /// Dauer, die der Punkt abdeckt (s): 60 = Minute, 3600 = Stunde, mehr nach dem Zusammenfassen
    #[serde(default)]
    pub dur: i64,
    pub updates: u64,
    pub awareness: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub blob_up: u64,
    pub blob_up_bytes: u64,
    pub blob_down: u64,
    pub blob_down_bytes: u64,
    /// höchste Zahl gleichzeitiger Verbindungen
    pub conns: u64,
    /// höchster RAM-Bedarf (KiB)
    pub rss_kib: u64,
    /// Verarbeitungszeit eines Updates auf dem Server (µs)
    pub proc_p50_us: u64,
    pub proc_p95_us: u64,
    pub proc_max_us: u64,
    /// mittlere Ping-Laufzeit über alle Geräte (ms, 0 = keine Messung)
    pub rtt_ms: f64,
    /// Zahl der Minuten mit Latenzmessung (Gewicht für den Mittelwert)
    #[serde(default)]
    pub rtt_n: u64,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub users: HashMap<String, u64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub spaces: HashMap<String, u64>,
}

#[derive(Default)]
struct Window {
    proc: Vec<u32>,
    users: HashMap<String, u64>,
    spaces: HashMap<String, u64>,
}

pub struct Metrics {
    live: Live,
    win: Mutex<Window>,
    minutes: Mutex<VecDeque<Point>>,
    /// laufende Stunde (Summe der Minuten)
    hour: Mutex<Point>,
    pub started: i64,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            live: Live::default(),
            win: Mutex::default(),
            minutes: Mutex::new(VecDeque::new()),
            hour: Mutex::new(Point { ts: crate::db::now() / 3600 * 3600, ..Default::default() }),
            started: crate::db::now(),
        }
    }
}

impl Metrics {
    pub fn frame_in(&self, n: usize) {
        self.live.bytes_in.fetch_add(n as u64, Relaxed);
    }
    pub fn frame_out(&self, n: usize) {
        self.live.bytes_out.fetch_add(n as u64, Relaxed);
    }
    pub fn awareness(&self) {
        self.live.awareness.fetch_add(1, Relaxed);
    }
    pub fn blob_up(&self, bytes: u64) {
        self.live.blob_up.fetch_add(1, Relaxed);
        self.live.blob_up_bytes.fetch_add(bytes, Relaxed);
    }
    pub fn blob_down(&self, bytes: u64) {
        self.live.blob_down.fetch_add(1, Relaxed);
        self.live.blob_down_bytes.fetch_add(bytes, Relaxed);
    }

    /// Ein gespeichertes Update (Client oder Admin): wer, wo, wie lange hat der Server gebraucht.
    pub fn update(&self, user: &str, space: &str, proc_us: Option<u64>) {
        self.live.updates.fetch_add(1, Relaxed);
        let mut w = self.win.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(us) = proc_us {
            if w.proc.len() < 5000 {
                w.proc.push(us.min(u32::MAX as u64) as u32);
            }
        }
        *w.users.entry(user.to_string()).or_default() += 1;
        *w.spaces.entry(space.to_string()).or_default() += 1;
    }

    /// Minutentakt: Zähler abholen, Minute ablegen, Stunde fortschreiben. Liefert eine fertige Stunde
    /// (zum Speichern), wenn eine neue begonnen hat.
    pub fn tick(&self, now: i64, conns: u64, rss_kib: u64, rtts_us: &[u64]) -> Option<Point> {
        let take = |a: &AtomicU64| a.swap(0, Relaxed);
        let (mut proc, users, spaces) = {
            let mut w = self.win.lock().unwrap_or_else(|e| e.into_inner());
            (std::mem::take(&mut w.proc), std::mem::take(&mut w.users), std::mem::take(&mut w.spaces))
        };
        proc.sort_unstable();
        let q = |p: f64| if proc.is_empty() { 0 } else { proc[((proc.len() - 1) as f64 * p).round() as usize] as u64 };
        let rtts: Vec<u64> = rtts_us.iter().copied().filter(|r| *r > 0).collect();
        let m = Point {
            ts: now / 60 * 60,
            dur: 60,
            updates: take(&self.live.updates),
            awareness: take(&self.live.awareness),
            bytes_in: take(&self.live.bytes_in),
            bytes_out: take(&self.live.bytes_out),
            blob_up: take(&self.live.blob_up),
            blob_up_bytes: take(&self.live.blob_up_bytes),
            blob_down: take(&self.live.blob_down),
            blob_down_bytes: take(&self.live.blob_down_bytes),
            conns,
            rss_kib,
            proc_p50_us: q(0.5),
            proc_p95_us: q(0.95),
            proc_max_us: proc.last().copied().unwrap_or(0) as u64,
            rtt_ms: if rtts.is_empty() { 0.0 } else { rtts.iter().sum::<u64>() as f64 / rtts.len() as f64 / 1000.0 },
            rtt_n: u64::from(!rtts.is_empty()),
            users: HashMap::new(),
            spaces: HashMap::new(),
        };
        {
            let mut ms = self.minutes.lock().unwrap_or_else(|e| e.into_inner());
            ms.push_back(m.clone());
            while ms.len() > MINUTES_KEPT {
                ms.pop_front();
            }
        }
        let mut h = self.hour.lock().unwrap_or_else(|e| e.into_inner());
        let hour_ts = now / 3600 * 3600;
        let done = if hour_ts != h.ts {
            let finished = std::mem::replace(&mut *h, Point { ts: hour_ts, ..Default::default() });
            let finished = Point { dur: 3600, ..finished };
            Some(finished)
        } else {
            None
        };
        merge(&mut h, &m);
        for (k, v) in users {
            *h.users.entry(k).or_default() += v;
        }
        for (k, v) in spaces {
            *h.spaces.entry(k).or_default() += v;
        }
        done
    }

    /// Nach einem Neustart: bereits gespeicherten Teil der laufenden Stunde übernehmen.
    pub fn resume_hour(&self, p: Point) {
        let mut h = self.hour.lock().unwrap_or_else(|e| e.into_inner());
        if p.ts == h.ts {
            let mut base = p;
            merge(&mut base, &h);
            *h = base;
        }
    }

    /// Minuten seit `since` (aus dem RAM).
    pub fn minutes_since(&self, since: i64) -> Vec<Point> {
        self.minutes.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|p| p.ts >= since).cloned().collect()
    }

    /// Die laufende (unfertige) Stunde.
    pub fn current_hour(&self) -> Point {
        self.hour.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// `b` in `a` einrechnen: Summen addieren, Spitzen maximal, Latenzen gewichtet bzw. maximal.
pub fn merge(a: &mut Point, b: &Point) {
    let n_a = a.updates;
    a.dur += b.dur;
    a.updates += b.updates;
    a.awareness += b.awareness;
    a.bytes_in += b.bytes_in;
    a.bytes_out += b.bytes_out;
    a.blob_up += b.blob_up;
    a.blob_up_bytes += b.blob_up_bytes;
    a.blob_down += b.blob_down;
    a.blob_down_bytes += b.blob_down_bytes;
    a.conns = a.conns.max(b.conns);
    a.rss_kib = a.rss_kib.max(b.rss_kib);
    // p50 gewichtet nach Updates (Näherung), p95/max als Maximum der Teilstücke
    if a.updates > 0 {
        a.proc_p50_us = (a.proc_p50_us * n_a + b.proc_p50_us * b.updates) / a.updates;
    }
    a.proc_p95_us = a.proc_p95_us.max(b.proc_p95_us);
    a.proc_max_us = a.proc_max_us.max(b.proc_max_us);
    // Latenz gewichtet nach Zahl der gemessenen Minuten (ältere Stundenwerte ohne rtt_n zählen einfach)
    let wb = if b.rtt_ms > 0.0 { b.rtt_n.max(1) } else { 0 };
    let wa = if a.rtt_ms > 0.0 { a.rtt_n.max(1) } else { 0 };
    if wb > 0 {
        a.rtt_ms = (a.rtt_ms * wa as f64 + b.rtt_ms * wb as f64) / (wa + wb) as f64;
        a.rtt_n = wa + wb;
    }
    for (k, v) in &b.users {
        *a.users.entry(k.clone()).or_default() += v;
    }
    for (k, v) in &b.spaces {
        *a.spaces.entry(k.clone()).or_default() += v;
    }
}

/// Punkte auf höchstens `max` zusammenfassen (für Diagramme).
pub fn downsample(points: Vec<Point>, max: usize) -> Vec<Point> {
    if points.len() <= max || max == 0 {
        return points;
    }
    let per = points.len().div_ceil(max);
    points
        .chunks(per)
        .map(|c| {
            let mut acc = Point { ts: c[0].ts, ..Default::default() };
            for p in c {
                merge(&mut acc, p);
            }
            acc
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_and_hours() {
        let m = Metrics::default();
        m.update("anna", "schule", Some(100));
        m.update("anna", "schule", Some(300));
        m.update("nico", "schule", Some(200));
        m.frame_in(1000);
        m.blob_up(5);
        let h0 = 1_800_000_000 / 3600 * 3600;
        let _ = m.tick(h0 + 60, 2, 9000, &[20_000, 40_000, 0]);
        let mins = m.minutes_since(0);
        let last = mins.last().unwrap();
        assert_eq!(last.updates, 3);
        assert_eq!(last.proc_p50_us, 200);
        assert_eq!(last.proc_max_us, 300);
        assert_eq!(last.bytes_in, 1000);
        assert!((last.rtt_ms - 30.0).abs() < 0.01);
        // Zähler sind zurückgesetzt
        assert!(m.tick(h0 + 120, 0, 0, &[]).is_none());
        assert_eq!(m.minutes_since(0).last().unwrap().updates, 0);
        // Stundenwechsel liefert die fertige Stunde mit Nutzern/Spaces
        let done = m.tick(h0 + 3600 + 60, 0, 0, &[]).expect("Stunde fertig");
        assert_eq!(done.users.get("anna"), Some(&2));
        assert_eq!(done.spaces.get("schule"), Some(&3));
        assert_eq!(done.updates, 3);
    }

    #[test]
    fn downsampling() {
        let pts: Vec<Point> = (0..1000).map(|i| Point { ts: i * 60, updates: 1, conns: (i % 7) as u64, ..Default::default() }).collect();
        let d = downsample(pts, 300);
        assert!(d.len() <= 300);
        assert_eq!(d.iter().map(|p| p.updates).sum::<u64>(), 1000);
        assert_eq!(d[0].conns, 3);
        // Latenz gewichtet: 3 Minuten à 10 ms + 1 Minute à 50 ms → 20 ms
        let mut acc = Point::default();
        for r in [10.0, 10.0, 10.0, 50.0] {
            merge(&mut acc, &Point { rtt_ms: r, rtt_n: 1, ..Default::default() });
        }
        assert!((acc.rtt_ms - 20.0).abs() < 1e-9 && acc.rtt_n == 4, "{}", acc.rtt_ms);
    }
}
