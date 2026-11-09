//! Räume (aktive Docs), Verbindungen, Verteilung von Updates/Awareness, Änderungsmeldungen.
//!
//! Speicherverhalten: Ein Doc liegt nur im RAM, solange jemand es abonniert hat (plus kurze Nachlaufzeit).
//! Persistiert wird jedes Update sofort (SQLite, WAL); beim Entladen bzw. nach vielen Updates wird verdichtet.

use crate::codec::{self, AwEntry};
use crate::db::{Store, User, now};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

pub type ConnId = u64;

pub enum Out {
    Frame(Vec<u8>),
    Close,
}

pub struct Config {
    /// Nachlaufzeit, bis ein Doc ohne Abonnenten entladen wird.
    pub unload_after: Duration,
    /// Ab so vielen gespeicherten Updates wird ein Doc verdichtet.
    pub compact_rows: i64,
    /// Mindestabstand zwischen zwei Snapshots eines Docs (Versionsgeschichte).
    pub snapshot_every: i64,
}

impl Default for Config {
    fn default() -> Self {
        Self { unload_after: Duration::from_secs(30), compact_rows: 200, snapshot_every: 3600 }
    }
}

struct Room {
    /// None bei Ende-zu-Ende-verschlüsselten Spaces: der Server kennt dort nur Chiffretext.
    doc: Option<Doc>,
    e2ee: bool,
    subs: HashSet<ConnId>,
    aw: HashMap<u64, (AwEntry, ConnId)>,
    idle_since: Option<Instant>,
    rows: i64,
    changed: bool,
    captured: Arc<Mutex<Option<Vec<u8>>>>,
}

pub struct ConnInfo {
    tx: mpsc::Sender<Out>,
    pub user: User,
    pub device: String,
    /// sha256 des Geräte-Tokens (zum Trennen nach dem Sperren)
    pub token: String,
    /// space → Rolle
    pub spaces: HashMap<String, String>,
    subs: HashSet<String>,
    pub stats: Arc<crate::metrics::ConnStats>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, Room>,
    conns: HashMap<ConnId, ConnInfo>,
    /// space → (seq, geänderte Docs) seit dem letzten Versand
    pending: HashMap<String, (u64, HashSet<String>)>,
    next_id: ConnId,
}

/// Änderungsmeldung für Leser ohne WebSocket (Lese-API, `GET /api/changes/<space>`): Space, Sequenz, Docs.
#[derive(Debug)]
pub struct SpaceChanges {
    pub space: String,
    pub seq: u64,
    pub docs: Vec<String>,
}

pub struct Hub {
    pub store: Mutex<Store>,
    inner: Mutex<Inner>,
    /// Gesammelte Änderungen je Takt an die Abonnenten der Lese-API (SSE)
    pub changes_tx: tokio::sync::broadcast::Sender<Arc<SpaceChanges>>,
    pub cfg: Config,
    pub metrics: crate::metrics::Metrics,
}

#[derive(Debug)]
pub enum HubError {
    Forbidden,
    /// Space ist Ende-zu-Ende-verschlüsselt – Klartext-Zugriff (Yjs-Sync, Admin, Lese-API) nicht möglich.
    E2ee,
    BadRequest(&'static str),
    Internal(String),
}

impl Hub {
    pub fn new(store: Store, cfg: Config) -> Arc<Self> {
        let (changes_tx, _) = tokio::sync::broadcast::channel(256);
        Arc::new(Self { store: Mutex::new(store), inner: Mutex::new(Inner::default()), changes_tx, cfg, metrics: Default::default() })
    }

    pub fn register(
        &self,
        tx: mpsc::Sender<Out>,
        user: User,
        device: String,
        token: String,
        spaces: HashMap<String, String>,
        stats: Arc<crate::metrics::ConnStats>,
    ) -> ConnId {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.next_id += 1;
        let id = g.next_id;
        g.conns.insert(id, ConnInfo { tx, user, device, token, spaces, subs: HashSet::new(), stats });
        id
    }

    /// Ungebundenes Gerät an den Vault binden, den es gerade öffnet; die Verbindung sieht danach nur noch diesen.
    /// false: Kein Zugriff auf den Space, die Bindung steht noch aus.
    pub fn bind_conn(&self, id: ConnId, space: &str) -> Result<bool, HubError> {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(c) = g.conns.get_mut(&id) else { return Ok(false) };
        if !c.spaces.contains_key(space) {
            return Ok(false);
        }
        let bound = self.store.lock().unwrap_or_else(|e| e.into_inner()).bind_token(&c.token, space).map_err(|e| HubError::Internal(e.to_string()))?;
        c.spaces.retain(|s, _| bound.as_deref() == Some(s));
        Ok(true)
    }

    pub fn unregister(&self, id: ConnId) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(c) = g.conns.remove(&id) else { return };
        // „Zuletzt gesehen“ = Ende der Verbindung (sonst bliebe der Verbindungsbeginn stehen)
        let _ = self.store.lock().unwrap_or_else(|e| e.into_inner()).touch_tokens(std::iter::once(&c.token));
        for doc in c.subs {
            Self::leave(&mut g, id, &doc);
        }
    }

    fn send(g: &Inner, to: ConnId, frame: Vec<u8>) {
        if let Some(c) = g.conns.get(&to) {
            if c.tx.try_send(Out::Frame(frame)).is_err() {
                // Client kommt nicht hinterher (oder ist weg) → Verbindung schließen; er synchronisiert neu.
                let _ = c.tx.try_send(Out::Close);
            }
        }
    }

    pub fn send_to(&self, to: ConnId, frame: Vec<u8>) {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::send(&g, to, frame);
    }

    fn role<'a>(g: &'a Inner, conn: ConnId, space: &str) -> Option<&'a str> {
        g.conns.get(&conn)?.spaces.get(space).map(String::as_str)
    }

    fn load_room(&self, name: &str) -> Result<Room, HubError> {
        let (space, _) = codec::split_doc(name).ok_or(HubError::BadRequest("Doc-Name ungültig"))?;
        {
            let st = self.store.lock().unwrap_or_else(|e| e.into_inner());
            if st.space_e2ee(space).map_err(|e| HubError::Internal(e.to_string()))?.is_some() {
                // Nur Verwaltung (Abonnenten, Awareness) – Inhalte bleiben in der Datenbank.
                let rows = st.update_count(name).map_err(|e| HubError::Internal(e.to_string()))?;
                return Ok(Room { doc: None, e2ee: true, subs: HashSet::new(), aw: HashMap::new(), idle_since: None, rows, changed: false, captured: Arc::default() });
            }
        }
        let rows = self.store.lock().unwrap_or_else(|e| e.into_inner()).load_updates(name).map_err(|e| HubError::Internal(e.to_string()))?;
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            for r in &rows {
                match Update::decode_v1(r) {
                    Ok(u) => {
                        if let Err(e) = txn.apply_update(u) {
                            warn!(doc = name, "gespeichertes Update nicht anwendbar: {e}");
                        }
                    }
                    Err(e) => warn!(doc = name, "gespeichertes Update defekt: {e}"),
                }
            }
        }
        let captured: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
        let c = captured.clone();
        // Liefert das kanonische Update jeder Änderung – leer bei Wiederholungen (z. B. Step2 mit bekanntem Inhalt).
        doc.observe_update_v1("tandem", move |_, e| {
            let mut slot = c.lock().unwrap_or_else(|e| e.into_inner());
            *slot = Some(match slot.take() {
                Some(prev) => yrs::merge_updates_v1([prev.as_slice(), e.update.as_slice()]).unwrap_or_else(|_| e.update.clone()),
                None => e.update.clone(),
            });
        })
        .map_err(|e| HubError::Internal(e.to_string()))?;
        debug!(doc = name, rows = rows.len(), "Doc geladen");
        Ok(Room { doc: Some(doc), e2ee: false, subs: HashSet::new(), aw: HashMap::new(), idle_since: None, rows: rows.len() as i64, changed: false, captured })
    }

    /// SYNC-Frame eines Clients verarbeiten.
    pub fn on_sync(&self, conn: ConnId, name: &str, sub: u64, data: &[u8]) -> Result<(), HubError> {
        let t0 = Instant::now();
        let (space, _) = codec::split_doc(name).ok_or(HubError::BadRequest("Doc-Name ungültig"))?;
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let role = Self::role(&g, conn, space).ok_or(HubError::Forbidden)?.to_string();
        if !g.rooms.contains_key(name) {
            drop(g);
            let room = self.load_room(name)?;
            g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.rooms.entry(name.to_string()).or_insert(room);
        }
        if g.rooms.get(name).is_some_and(|r| r.e2ee) {
            return Err(HubError::E2ee);
        }
        match sub {
            codec::STEP1 => {
                let sv = StateVector::decode_v1(data).map_err(|_| HubError::BadRequest("State-Vector defekt"))?;
                let (diff, server_sv, aw) = {
                    let room = g.rooms.get_mut(name).unwrap();
                    room.subs.insert(conn);
                    room.idle_since = None;
                    let txn = room.doc.as_ref().ok_or(HubError::E2ee)?.transact();
                    let diff = txn.encode_state_as_update_v1(&sv);
                    let server_sv = txn.state_vector().encode_v1();
                    let aw = if room.aw.is_empty() { None } else { Some(codec::encode_awareness(room.aw.values().map(|(e, _)| e))) };
                    (diff, server_sv, aw)
                };
                if let Some(c) = g.conns.get_mut(&conn) {
                    c.subs.insert(name.to_string());
                }
                Self::send(&g, conn, codec::sync(name, codec::STEP2, &diff));
                if role != "read" {
                    Self::send(&g, conn, codec::sync(name, codec::STEP1, &server_sv));
                }
                if let Some(aw) = aw {
                    Self::send(&g, conn, codec::awareness(name, &aw));
                }
                Ok(())
            }
            codec::STEP2 | codec::UPDATE => {
                if role == "read" {
                    return Err(HubError::Forbidden);
                }
                let update = Update::decode_v1(data).map_err(|_| HubError::BadRequest("Update defekt"))?;
                if update.is_empty() {
                    return Ok(());
                }
                let room = g.rooms.get_mut(name).unwrap();
                let doc = room.doc.as_ref().ok_or(HubError::E2ee)?;
                {
                    let mut txn = doc.transact_mut();
                    txn.apply_update(update).map_err(|e| HubError::BadRequest(if e.to_string().is_empty() { "Update" } else { "Update nicht anwendbar" }))?;
                }
                let canonical = room.captured.lock().unwrap_or_else(|e| e.into_inner()).take();
                let Some(canonical) = canonical else {
                    // Nichts Neues (oder wartet auf fehlende Vorgänger – dann roh sichern, damit nichts verloren geht).
                    if doc.transact().has_missing_updates() {
                        let _ = self.store.lock().unwrap_or_else(|e| e.into_inner()).append_update(space, name, data);
                        room.rows += 1;
                    }
                    return Ok(());
                };
                room.rows += 1;
                room.changed = true;
                let subs: Vec<ConnId> = room.subs.iter().copied().filter(|c| *c != conn).collect();
                let rows = room.rows;
                let seq = self
                    .store
                    .lock()
                    .unwrap()
                    .append_update(space, name, &canonical)
                    .map_err(|e| HubError::Internal(e.to_string()))?;
                let frame = codec::sync(name, codec::UPDATE, &canonical);
                for s in subs {
                    Self::send(&g, s, frame.clone());
                }
                let p = g.pending.entry(space.to_string()).or_insert((0, HashSet::new()));
                p.0 = seq;
                p.1.insert(name.to_string());
                if rows >= self.cfg.compact_rows {
                    self.compact(&mut g, name);
                }
                if let Some(c) = g.conns.get(&conn) {
                    c.stats.updates.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    self.metrics.update(&c.user.id, space, Some(t0.elapsed().as_micros() as u64));
                }
                Ok(())
            }
            _ => Err(HubError::BadRequest("Sync-Typ")),
        }
    }

    fn compact(&self, g: &mut Inner, name: &str) {
        let Some(room) = g.rooms.get_mut(name) else { return };
        // Verschlüsselte Docs verdichtet ein Client (ECOMPACT), der Server kann es nicht.
        let Some(doc) = room.doc.as_ref() else { return };
        let state = doc.transact().encode_state_as_update_v1(&StateVector::default());
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = st.compact(name, &state) {
            warn!(doc = name, "Verdichten fehlgeschlagen: {e}");
            return;
        }
        room.rows = 1;
        if room.changed {
            let ts = now();
            let last = st.last_snapshot_ts(name).ok().flatten().unwrap_or(0);
            if ts - last >= self.cfg.snapshot_every {
                let _ = st.add_snapshot(name, ts, &state);
            }
        }
        debug!(doc = name, bytes = state.len(), "verdichtet");
    }

    /// Raum eines Docs sicherstellen (lädt bei Bedarf) und prüfen, dass der Space verschlüsselt ist.
    fn ensure_e2ee_room<'a>(&'a self, mut g: std::sync::MutexGuard<'a, Inner>, name: &str) -> Result<std::sync::MutexGuard<'a, Inner>, HubError> {
        if !g.rooms.contains_key(name) {
            drop(g);
            let room = self.load_room(name)?;
            g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.rooms.entry(name.to_string()).or_insert(room);
        }
        if !g.rooms.get(name).is_some_and(|r| r.e2ee) {
            return Err(HubError::BadRequest("Space ist nicht Ende-zu-Ende-verschlüsselt"));
        }
        Ok(g)
    }

    /// ESUB: verschlüsseltes Doc abonnieren und alle Log-Zeilen nach `since` schicken.
    /// Abo und Lesen geschehen unter derselben Sperre – spätere Zeilen kommen sicher per EUPD.
    pub fn on_esub(&self, conn: ConnId, name: &str, since: u64) -> Result<(), HubError> {
        let (space, _) = codec::split_doc(name).ok_or(HubError::BadRequest("Doc-Name ungültig"))?;
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::role(&g, conn, space).ok_or(HubError::Forbidden)?;
        let mut g = self.ensure_e2ee_room(g, name)?;
        let (rows, total) = {
            let st = self.store.lock().unwrap_or_else(|e| e.into_inner());
            let rows = st.load_updates_since(name, since).map_err(|e| HubError::Internal(e.to_string()))?;
            let total = st.update_count(name).map_err(|e| HubError::Internal(e.to_string()))?;
            (rows, total)
        };
        let aw = {
            let room = g.rooms.get_mut(name).unwrap();
            room.subs.insert(conn);
            room.idle_since = None;
            room.rows = total;
            if room.aw.is_empty() { None } else { Some(codec::encode_awareness(room.aw.values().map(|(e, _)| e))) }
        };
        if let Some(c) = g.conns.get_mut(&conn) {
            c.subs.insert(name.to_string());
        }
        Self::send(&g, conn, codec::elog(name, total as u64, rows.iter().map(|(id, d)| (*id, d.as_slice()))));
        if let Some(aw) = aw {
            Self::send(&g, conn, codec::awareness(name, &aw));
        }
        Ok(())
    }

    /// EUPD: verschlüsseltes Update unverändert anhängen, an die anderen Abonnenten verteilen, dem Absender
    /// die Zeilen-ID bestätigen (EACK).
    pub fn on_eupd(&self, conn: ConnId, name: &str, data: &[u8]) -> Result<(), HubError> {
        let t0 = Instant::now();
        let (space, _) = codec::split_doc(name).ok_or(HubError::BadRequest("Doc-Name ungültig"))?;
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if Self::role(&g, conn, space).ok_or(HubError::Forbidden)? == "read" {
            return Err(HubError::Forbidden);
        }
        if data.is_empty() {
            return Err(HubError::BadRequest("Update leer"));
        }
        let mut g = self.ensure_e2ee_room(g, name)?;
        let (id, seq) = self
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .append_update_id(space, name, data)
            .map_err(|e| HubError::Internal(e.to_string()))?;
        let subs: Vec<ConnId> = {
            let room = g.rooms.get_mut(name).unwrap();
            room.rows += 1;
            room.changed = true;
            if room.subs.is_empty() {
                room.idle_since = Some(Instant::now());
            }
            room.subs.iter().copied().filter(|c| *c != conn).collect()
        };
        let frame = codec::eupd(name, id, data);
        for s in subs {
            Self::send(&g, s, frame.clone());
        }
        Self::send(&g, conn, codec::eack(name, id));
        let p = g.pending.entry(space.to_string()).or_insert((0, HashSet::new()));
        p.0 = seq;
        p.1.insert(name.to_string());
        if let Some(c) = g.conns.get(&conn) {
            c.stats.updates.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.metrics.update(&c.user.id, space, Some(t0.elapsed().as_micros() as u64));
        }
        Ok(())
    }

    /// ECOMPACT: Ein Client hat alle Zeilen bis `upto` gelesen und schickt den verschlüsselten Gesamtstand.
    /// Ersetzt das Log bis dorthin; dient außerdem als Snapshot für die Versionsgeschichte.
    pub fn on_ecompact(&self, conn: ConnId, name: &str, upto: u64, data: &[u8]) -> Result<(), HubError> {
        let (space, _) = codec::split_doc(name).ok_or(HubError::BadRequest("Doc-Name ungültig"))?;
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if Self::role(&g, conn, space).ok_or(HubError::Forbidden)? == "read" {
            return Err(HubError::Forbidden);
        }
        if data.is_empty() {
            return Err(HubError::BadRequest("Stand leer"));
        }
        let mut g = self.ensure_e2ee_room(g, name)?;
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let n = st.compact_upto(name, upto, data).map_err(|_| HubError::BadRequest("Verdichten nicht möglich"))?;
        let ts = now();
        let last = st.last_snapshot_ts(name).ok().flatten().unwrap_or(0);
        if ts - last >= self.cfg.snapshot_every {
            let _ = st.add_snapshot(name, ts, data);
        }
        let rows = st.update_count(name).unwrap_or(1);
        drop(st);
        if let Some(room) = g.rooms.get_mut(name) {
            room.rows = rows;
        }
        debug!(doc = name, replaced = n, bytes = data.len(), "vom Client verdichtet");
        Ok(())
    }

    pub fn on_awareness(&self, conn: ConnId, name: &str, data: &[u8]) -> Result<(), HubError> {
        let (space, _) = codec::split_doc(name).ok_or(HubError::BadRequest("Doc-Name ungültig"))?;
        if data.len() > 64 * 1024 {
            return Err(HubError::BadRequest("Awareness zu groß"));
        }
        let entries = codec::decode_awareness(data).map_err(|_| HubError::BadRequest("Awareness defekt"))?;
        self.metrics.awareness();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::role(&g, conn, space).ok_or(HubError::Forbidden)?;
        let Some(room) = g.rooms.get_mut(name) else { return Ok(()) };
        if !room.subs.contains(&conn) {
            return Ok(());
        }
        for e in entries {
            if e.state == "null" {
                room.aw.remove(&e.client);
            } else {
                room.aw.insert(e.client, (e, conn));
            }
        }
        let subs: Vec<ConnId> = room.subs.iter().copied().filter(|c| *c != conn).collect();
        let frame = codec::awareness(name, data);
        for s in subs {
            Self::send(&g, s, frame.clone());
        }
        Ok(())
    }

    pub fn on_unsub(&self, conn: ConnId, name: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = g.conns.get_mut(&conn) {
            c.subs.remove(name);
        }
        Self::leave(&mut g, conn, name);
    }

    fn leave(g: &mut Inner, conn: ConnId, name: &str) {
        let Some(room) = g.rooms.get_mut(name) else { return };
        room.subs.remove(&conn);
        let gone: Vec<AwEntry> = room
            .aw
            .iter()
            .filter(|(_, (_, c))| *c == conn)
            .map(|(_, (e, _))| AwEntry { client: e.client, clock: e.clock + 1, state: "null".into() })
            .collect();
        for e in &gone {
            room.aw.remove(&e.client);
        }
        if room.subs.is_empty() {
            room.idle_since = Some(Instant::now());
        }
        if !gone.is_empty() {
            let frame = codec::awareness(name, &codec::encode_awareness(&gone));
            let subs: Vec<ConnId> = room.subs.iter().copied().collect();
            for s in subs {
                Self::send(g, s, frame.clone());
            }
        }
    }

    pub fn on_catchup(&self, conn: ConnId, space: &str, since: u64) -> Result<(), HubError> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::role(&g, conn, space).ok_or(HubError::Forbidden)?;
        let (seq, docs) = {
            let st = self.store.lock().unwrap_or_else(|e| e.into_inner());
            let seq = st.space_seq(space).map_err(|e| HubError::Internal(e.to_string()))?;
            // Client ist „aus der Zukunft“ (Server-DB zurückgesetzt) → alles melden.
            let since = if since > seq { 0 } else { since };
            (seq, st.changed_since(space, since).map_err(|e| HubError::Internal(e.to_string()))?)
        };
        // In Portionen, damit einzelne Frames klein bleiben.
        if docs.is_empty() {
            Self::send(&g, conn, codec::changes(space, seq, &[]));
        }
        for chunk in docs.chunks(500) {
            let refs: Vec<&str> = chunk.iter().map(String::as_str).collect();
            Self::send(&g, conn, codec::changes(space, seq, &refs));
        }
        Ok(())
    }

    /// Gesammelte Änderungsmeldungen verschicken (periodisch aufrufen).
    pub fn flush_changes(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.pending.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut g.pending);
        for (space, (seq, docs)) in pending {
            // Lese-API (SSE): nur senden, wenn jemand zuhört
            if self.changes_tx.receiver_count() > 0 {
                let mut list: Vec<String> = docs.iter().cloned().collect();
                list.sort();
                let _ = self.changes_tx.send(Arc::new(SpaceChanges { space: space.clone(), seq, docs: list }));
            }
            for (id, c) in &g.conns {
                if !c.spaces.contains_key(&space) {
                    continue;
                }
                let list: Vec<&str> = docs.iter().filter(|d| !c.subs.contains(*d)).map(String::as_str).collect();
                // Auch ohne Docs senden, damit der Client seine Sequenz nachzieht.
                Self::send(&g, *id, codec::changes(&space, seq, &list));
            }
        }
    }

    /// Unbenutzte Docs entladen (vorher verdichten), periodisch aufrufen.
    pub fn janitor(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let idle: Vec<String> = g
            .rooms
            .iter()
            .filter(|(_, r)| r.subs.is_empty() && r.idle_since.map(|t| now.duration_since(t) >= self.cfg.unload_after).unwrap_or(false))
            .map(|(k, _)| k.clone())
            .collect();
        for name in idle {
            let needs = g.rooms.get(&name).map(|r| r.rows > 20 || r.changed).unwrap_or(false);
            if needs {
                self.compact(&mut g, &name);
            }
            g.rooms.remove(&name);
            debug!(doc = name, "Doc entladen");
        }
    }

    /// Beim Beenden: alle geänderten Docs verdichten.
    pub fn shutdown(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let names: Vec<String> = g.rooms.iter().filter(|(_, r)| r.changed || r.rows > 20).map(|(k, _)| k.clone()).collect();
        for n in names {
            self.compact(&mut g, &n);
        }
        g.rooms.clear();
    }

    pub fn status(&self) -> serde_json::Value {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::json!({
            "connections": g.conns.len(),
            "rooms": g.rooms.len(),
            "users_online": g.conns.values().map(|c| c.user.id.clone()).collect::<HashSet<_>>().len(),
            "devices": g.conns.values().map(|c| format!("{} ({})", c.user.id, c.device)).collect::<Vec<_>>(),
        })
    }

    /// Doc lesen – aus dem RAM, falls geladen, sonst kurz aus der Datenbank (ohne es zu behalten).
    pub fn read_doc<R>(&self, name: &str, f: impl FnOnce(&Doc) -> R) -> Result<R, HubError> {
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(room) = g.rooms.get(name) {
                return Ok(f(room.doc.as_ref().ok_or(HubError::E2ee)?));
            }
        }
        let room = self.load_room(name)?;
        Ok(f(room.doc.as_ref().ok_or(HubError::E2ee)?))
    }

    /// Änderung durch den Server selbst (Admin-Oberfläche): wie ein Client-Update speichern,
    /// an alle Abonnenten verteilen und als CHANGES melden. Liefert das Ergebnis von `f`.
    pub fn edit_doc<R>(&self, name: &str, f: impl FnOnce(&Doc) -> R) -> Result<R, HubError> {
        let (space, _) = codec::split_doc(name).ok_or(HubError::BadRequest("Doc-Name ungültig"))?;
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !g.rooms.contains_key(name) {
            drop(g);
            let room = self.load_room(name)?;
            g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.rooms.entry(name.to_string()).or_insert(room);
        }
        let room = g.rooms.get_mut(name).unwrap();
        if room.subs.is_empty() {
            // Ohne Abonnenten nach der Nachlaufzeit wieder entladen.
            room.idle_since = Some(Instant::now());
        }
        let out = f(room.doc.as_ref().ok_or(HubError::E2ee)?);
        let canonical = room.captured.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(canonical) = canonical else { return Ok(out) };
        room.rows += 1;
        room.changed = true;
        let subs: Vec<ConnId> = room.subs.iter().copied().collect();
        let rows = room.rows;
        let seq = self
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .append_update(space, name, &canonical)
            .map_err(|e| HubError::Internal(e.to_string()))?;
        let frame = codec::sync(name, codec::UPDATE, &canonical);
        for s in subs {
            Self::send(&g, s, frame.clone());
        }
        let p = g.pending.entry(space.to_string()).or_insert((0, HashSet::new()));
        p.0 = seq;
        p.1.insert(name.to_string());
        if rows >= self.cfg.compact_rows {
            self.compact(&mut g, name);
        }
        self.metrics.update("admin-web", space, None);
        Ok(out)
    }

    /// Wer ist gerade verbunden – je Space: Nutzer, Gerät und abonnierte Docs.
    pub fn online(&self, space: Option<&str>) -> Vec<serde_json::Value> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.conns
            .values()
            .filter(|c| space.is_none_or(|s| c.spaces.contains_key(s)))
            .map(|c| {
                let docs: Vec<&str> = c.subs.iter().filter(|d| space.is_none_or(|s| d.starts_with(&format!("{s}/")))).map(String::as_str).collect();
                let s = &c.stats;
                let ld = |a: &std::sync::atomic::AtomicU64| a.load(std::sync::atomic::Ordering::Relaxed);
                let rtt = ld(&s.rtt_us);
                serde_json::json!({ "user": c.user.id, "name": c.user.name, "color": c.user.color, "device": c.device,
                    "token": &c.token[..12.min(c.token.len())], "deviceId": &c.token[..12.min(c.token.len())], "docs": docs,
                    "rttMs": if rtt > 0 { serde_json::json!((rtt as f64 / 100.0).round() / 10.0) } else { serde_json::Value::Null },
                    "bytesIn": ld(&s.bytes_in), "bytesOut": ld(&s.bytes_out), "updates": ld(&s.updates), "since": ld(&s.connected_at) })
            })
            .collect()
    }

    /// Verbindungen trennen, deren Nutzer bzw. Token passt (danach melden sich die Geräte neu an
    /// und bekommen ihre aktuellen Rechte – oder werden abgewiesen).
    pub fn kick_where(&self, pred: impl Fn(&ConnInfo) -> bool) -> usize {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut n = 0;
        for c in g.conns.values().filter(|c| pred(c)) {
            let _ = c.tx.try_send(Out::Close);
            n += 1;
        }
        n
    }

    /// sha256-Hashes aller verbundenen Geräte-Tokens.
    pub fn online_tokens(&self) -> HashSet<String> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.conns.values().map(|c| c.token.clone()).collect()
    }

    /// Für den Minutentakt: Zahl der Verbindungen und ihre letzten Ping-Laufzeiten (µs).
    pub fn conn_rtts(&self) -> (u64, Vec<u64>) {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        (g.conns.len() as u64, g.conns.values().map(|c| c.stats.rtt_us.load(std::sync::atomic::Ordering::Relaxed)).collect())
    }

    /// Alle geladenen Docs eines Space verwerfen (nach dem Löschen des Space).
    pub fn drop_space(&self, space: &str) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let prefix = format!("{space}/");
        g.rooms.retain(|k, _| !k.starts_with(&prefix));
        g.pending.remove(space);
    }

    /// Alle Verbindungen eines Nutzers schließen (z. B. nach Widerruf).
    pub fn kick_all(&self) {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for c in g.conns.values() {
            let _ = c.tx.try_send(Out::Close);
        }
        info!("alle Verbindungen geschlossen");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use yrs::{GetString, Text};

    fn hub() -> Arc<Hub> {
        let st = Store::open(Path::new(":memory:")).unwrap();
        st.add_user("a", "A", None).unwrap();
        st.add_space("sp", "Sp").unwrap();
        st.set_member("sp", "a", "write").unwrap();
        Hub::new(st, Config::default())
    }

    fn user() -> User {
        User { id: "a".into(), name: "A".into(), color: "#000".into() }
    }

    /// Ungebundenes Gerät: Der erste Zugriff legt den Vault fest, danach ist der andere Vault der Person tabu.
    #[test]
    fn device_binds_to_first_vault() {
        let h = hub();
        let token = {
            let st = h.store.lock().unwrap();
            st.add_space("zwei", "Zwei").unwrap();
            st.set_member("zwei", "a", "write").unwrap();
            crate::db::sha256_hex(st.issue_token("a", "d").unwrap().as_bytes())
        };
        let (tx, _rx) = mpsc::channel(100);
        let spaces = HashMap::from([("sp".to_string(), "write".to_string()), ("zwei".to_string(), "write".to_string())]);
        let c = h.register(tx, user(), "d".into(), token, spaces, Default::default());
        let step1 = StateVector::default().encode_v1();
        assert!(!h.bind_conn(c, "fremd").unwrap(), "ohne Zugriff keine Bindung");
        h.on_sync(c, "zwei/x", codec::STEP1, &step1).unwrap();
        assert!(h.bind_conn(c, "sp").unwrap());
        h.on_sync(c, "sp/x", codec::STEP1, &step1).unwrap();
        assert!(matches!(h.on_sync(c, "zwei/y", codec::STEP1, &step1), Err(HubError::Forbidden)));
        assert!(matches!(h.on_catchup(c, "zwei", 0), Err(HubError::Forbidden)));
        assert_eq!(h.online(Some("zwei")).len(), 0, "zählt nicht mehr als online im anderen Vault");
        assert_eq!(h.online(Some("sp")).len(), 1);
    }

    #[test]
    fn repeated_and_delete_only_updates() {
        let h = hub();
        let (tx, mut rx) = mpsc::channel(100);
        let spaces = HashMap::from([("sp".to_string(), "write".to_string())]);
        let c = h.register(tx, user(), "d".into(), "t".into(), spaces, Default::default());
        h.on_sync(c, "sp/x", codec::STEP1, &StateVector::default().encode_v1()).unwrap();

        let client = Doc::new();
        let t = client.get_or_insert_text("content");
        let u1 = {
            let mut txn = client.transact_mut();
            t.insert(&mut txn, 0, "hallo welt");
            txn.encode_update_v1()
        };
        h.on_sync(c, "sp/x", codec::UPDATE, &u1).unwrap();
        // Wiederholung: nichts Neues → keine neue Zeile
        h.on_sync(c, "sp/x", codec::STEP2, &u1).unwrap();
        assert_eq!(h.store.lock().unwrap_or_else(|e| e.into_inner()).update_count("sp/x").unwrap(), 1);
        // Reine Löschung ändert den State-Vector nicht, muss aber gespeichert werden
        let u2 = {
            let mut txn = client.transact_mut();
            t.remove_range(&mut txn, 5, 5);
            txn.encode_update_v1()
        };
        h.on_sync(c, "sp/x", codec::UPDATE, &u2).unwrap();
        assert_eq!(h.store.lock().unwrap_or_else(|e| e.into_inner()).update_count("sp/x").unwrap(), 2);

        // Nach Entladen + Neuladen ist der Text korrekt
        h.on_unsub(c, "sp/x");
        {
            let mut g = h.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.rooms.get_mut("sp/x").unwrap().idle_since = Some(Instant::now() - Duration::from_secs(60));
        }
        h.janitor();
        assert_eq!(h.status()["rooms"], 0);
        assert_eq!(h.store.lock().unwrap_or_else(|e| e.into_inner()).update_count("sp/x").unwrap(), 1, "beim Entladen verdichtet");
        while rx.try_recv().is_ok() {}
        h.on_sync(c, "sp/x", codec::STEP1, &StateVector::default().encode_v1()).unwrap();
        let Out::Frame(f) = rx.try_recv().unwrap() else { panic!() };
        let mut r = codec::Reader::new(&f);
        assert_eq!(r.var_uint().unwrap(), codec::SYNC);
        r.string().unwrap();
        assert_eq!(r.var_uint().unwrap(), codec::STEP2);
        let upd = r.bytes().unwrap();
        let d2 = Doc::new();
        let t2 = d2.get_or_insert_text("content");
        d2.transact_mut().apply_update(Update::decode_v1(upd).unwrap()).unwrap();
        assert_eq!(t2.get_string(&d2.transact()), "hallo");
    }

    #[test]
    fn reader_cannot_write() {
        let h = hub();
        let (tx, _rx) = mpsc::channel(100);
        let c = h.register(tx, user(), "d".into(), "t".into(), HashMap::from([("sp".to_string(), "read".to_string())]), Default::default());
        h.on_sync(c, "sp/x", codec::STEP1, &StateVector::default().encode_v1()).unwrap();
        let client = Doc::new();
        let t = client.get_or_insert_text("content");
        let u = {
            let mut txn = client.transact_mut();
            t.insert(&mut txn, 0, "x");
            txn.encode_update_v1()
        };
        assert!(matches!(h.on_sync(c, "sp/x", codec::UPDATE, &u), Err(HubError::Forbidden)));
        assert!(matches!(h.on_sync(c, "other/x", codec::STEP1, &[0]), Err(HubError::Forbidden)));
    }

    fn frames(rx: &mut mpsc::Receiver<Out>) -> Vec<Vec<u8>> {
        let mut v = Vec::new();
        while let Ok(Out::Frame(f)) = rx.try_recv() {
            v.push(f);
        }
        v
    }

    /// ELOG lesen → (total, [(id, data)])
    fn read_elog(f: &[u8]) -> (u64, Vec<(u64, Vec<u8>)>) {
        let mut r = codec::Reader::new(f);
        assert_eq!(r.var_uint().unwrap(), codec::ELOG);
        r.string().unwrap();
        let total = r.var_uint().unwrap();
        let n = r.var_uint().unwrap();
        (total, (0..n).map(|_| (r.var_uint().unwrap(), r.bytes().unwrap().to_vec())).collect())
    }

    #[test]
    fn e2ee_relay() {
        let h = hub();
        {
            let st = h.store.lock().unwrap();
            st.add_space("enc", "Enc").unwrap();
            st.set_member("enc", "a", "write").unwrap();
            st.set_space_e2ee("enc", Some(crate::db::E2EE_PENDING)).unwrap();
            st.set_space_e2ee("enc", Some("{\"v\":1}")).unwrap();
        }
        let spaces = HashMap::from([("enc".to_string(), "write".to_string())]);
        let (tx1, mut rx1) = mpsc::channel(100);
        let (tx2, mut rx2) = mpsc::channel(100);
        let c1 = h.register(tx1, user(), "d1".into(), "t1".into(), spaces.clone(), Default::default());
        let c2 = h.register(tx2, user(), "d2".into(), "t2".into(), spaces, Default::default());

        // Klartext-Yjs ist in verschlüsselten Spaces gesperrt, ebenso der Server-Lesezugriff
        assert!(matches!(h.on_sync(c1, "enc/x", codec::STEP1, &StateVector::default().encode_v1()), Err(HubError::E2ee)));
        assert!(matches!(h.read_doc("enc/x", |_| ()), Err(HubError::E2ee)));
        // …und umgekehrt keine E-Frames in Klartext-Spaces
        assert!(h.on_esub(c1, "sp/x", 0).is_err());

        h.on_esub(c1, "enc/x", 0).unwrap();
        h.on_esub(c2, "enc/x", 0).unwrap();
        assert_eq!(read_elog(&frames(&mut rx1)[0]), (0, vec![]));
        frames(&mut rx2);

        h.on_eupd(c1, "enc/x", b"chiffre-1").unwrap();
        h.on_eupd(c1, "enc/x", b"chiffre-2").unwrap();
        // Absender bekommt EACKs, der andere die Updates unverändert
        let f1 = frames(&mut rx1);
        assert_eq!(f1.len(), 2);
        let mut r = codec::Reader::new(&f1[1]);
        assert_eq!(r.var_uint().unwrap(), codec::EACK);
        r.string().unwrap();
        let id2 = r.var_uint().unwrap();
        let f2 = frames(&mut rx2);
        assert_eq!(f2.len(), 2);
        assert_eq!(f2[1], codec::eupd("enc/x", id2, b"chiffre-2"));

        // Nachladen ab 0 → beide Zeilen; ab id2 → nichts
        h.on_esub(c2, "enc/x", 0).unwrap();
        let (total, rows) = read_elog(&frames(&mut rx2)[0]);
        assert_eq!((total, rows.len()), (2, 2));
        assert_eq!(rows[1], (id2, b"chiffre-2".to_vec()));
        h.on_esub(c2, "enc/x", id2).unwrap();
        assert_eq!(read_elog(&frames(&mut rx2)[0]).1.len(), 0);

        // Verdichten durch den Client: Zeile behält die ID id2, Snapshot entsteht
        h.on_eupd(c1, "enc/x", b"chiffre-3").unwrap();
        h.on_ecompact(c1, "enc/x", id2, b"gesamt-1-2").unwrap();
        h.on_esub(c2, "enc/x", 0).unwrap();
        let (_, rows) = read_elog(frames(&mut rx2).last().unwrap());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], (id2, b"gesamt-1-2".to_vec()));
        assert_eq!(rows[1].1, b"chiffre-3".to_vec());
        assert_eq!(h.store.lock().unwrap().snapshots("enc/x").unwrap().len(), 1);
        // Fremde Zeilen-ID → abgelehnt
        assert!(h.on_ecompact(c1, "enc/x", 999_999, b"x").is_err());

        // Lesende dürfen nichts anhängen
        let (tx3, _rx3) = mpsc::channel(100);
        let c3 = h.register(tx3, user(), "d3".into(), "t3".into(), HashMap::from([("enc".to_string(), "read".to_string())]), Default::default());
        assert!(matches!(h.on_eupd(c3, "enc/x", b"x"), Err(HubError::Forbidden)));
        // Verschlüsselung lässt sich bei Inhalt nicht mehr umschalten
        assert!(h.store.lock().unwrap().set_space_e2ee("enc", None).is_err());
    }
}
