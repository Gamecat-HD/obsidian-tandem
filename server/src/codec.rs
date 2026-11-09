//! lib0-Kodierung (varUint, varString, varBytes) und die Frames des Tandem-Protokolls v1.
//! Siehe docs/PROTOKOLL.md.

#[derive(Debug, PartialEq, Eq)]
pub struct DecodeError;

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    pub fn var_uint(&mut self) -> Result<u64, DecodeError> {
        let mut num: u64 = 0;
        let mut shift = 0u32;
        loop {
            let b = *self.buf.get(self.pos).ok_or(DecodeError)?;
            self.pos += 1;
            if shift >= 64 {
                return Err(DecodeError);
            }
            num |= ((b & 0x7f) as u64) << shift;
            if b < 0x80 {
                return Ok(num);
            }
            shift += 7;
        }
    }
    /// Alles gelesen? (Für optionale Felder am Frame-Ende.)
    pub fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }
    pub fn bytes(&mut self) -> Result<&'a [u8], DecodeError> {
        let len = self.var_uint()? as usize;
        let end = self.pos.checked_add(len).ok_or(DecodeError)?;
        let s = self.buf.get(self.pos..end).ok_or(DecodeError)?;
        self.pos = end;
        Ok(s)
    }
    pub fn string(&mut self) -> Result<&'a str, DecodeError> {
        std::str::from_utf8(self.bytes()?).map_err(|_| DecodeError)
    }
}

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn var_uint(&mut self, mut n: u64) -> &mut Self {
        while n >= 0x80 {
            self.buf.push((n as u8 & 0x7f) | 0x80);
            n >>= 7;
        }
        self.buf.push(n as u8);
        self
    }
    pub fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.var_uint(b.len() as u64);
        self.buf.extend_from_slice(b);
        self
    }
    pub fn string(&mut self, s: &str) -> &mut Self {
        self.bytes(s.as_bytes())
    }
    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
}

pub const HELLO: u64 = 0;
pub const WELCOME: u64 = 1;
pub const SYNC: u64 = 2;
pub const AWARENESS: u64 = 3;
pub const UNSUB: u64 = 4;
pub const ERROR: u64 = 5;
pub const CHANGES: u64 = 6;
pub const CATCHUP: u64 = 7;
pub const PING: u64 = 8;
pub const PONG: u64 = 9;
// Ende-zu-Ende-verschlüsselte Spaces (siehe docs/E2EE.md): der Server führt nur ein Log aus Chiffretext.
pub const ESUB: u64 = 10;
pub const ELOG: u64 = 11;
pub const EUPD: u64 = 12;
pub const EACK: u64 = 13;
pub const ECOMPACT: u64 = 14;

pub const STEP1: u64 = 0;
pub const STEP2: u64 = 1;
pub const UPDATE: u64 = 2;

#[derive(Debug, PartialEq)]
pub enum Frame<'a> {
    /// `client`: optionales Feld am Ende (ab 0.8.2), z. B. `tandem-plugin/0.6.4` oder `lernplattform`.
    /// Ältere Clients senden es nicht.
    Hello { version: u64, token: &'a str, device: &'a str, client: Option<&'a str> },
    Sync { doc: &'a str, sub: u64, data: &'a [u8] },
    Awareness { doc: &'a str, data: &'a [u8] },
    Unsub { doc: &'a str },
    Catchup { space: &'a str, since: u64 },
    Ping,
    /// Abo eines verschlüsselten Docs: alle Log-Zeilen nach `since` anfordern.
    ESub { doc: &'a str, since: u64 },
    /// Verschlüsseltes Update anhängen.
    EUpd { doc: &'a str, data: &'a [u8] },
    /// Log bis einschließlich Zeile `upto` durch einen verschlüsselten Gesamtstand ersetzen.
    ECompact { doc: &'a str, upto: u64, data: &'a [u8] },
}

/// Nur Frames, die ein Client senden darf.
pub fn decode_client(buf: &[u8]) -> Result<Frame<'_>, DecodeError> {
    let mut r = Reader::new(buf);
    let f = match r.var_uint()? {
        HELLO => Frame::Hello {
            version: r.var_uint()?,
            token: r.string()?,
            device: r.string()?,
            client: if r.done() { None } else { Some(r.string()?) },
        },
        SYNC => {
            let doc = r.string()?;
            let sub = r.var_uint()?;
            if sub > 2 {
                return Err(DecodeError);
            }
            Frame::Sync { doc, sub, data: r.bytes()? }
        }
        AWARENESS => Frame::Awareness { doc: r.string()?, data: r.bytes()? },
        UNSUB => Frame::Unsub { doc: r.string()? },
        CATCHUP => Frame::Catchup { space: r.string()?, since: r.var_uint()? },
        PING => Frame::Ping,
        ESUB => Frame::ESub { doc: r.string()?, since: r.var_uint()? },
        EUPD => Frame::EUpd { doc: r.string()?, data: r.bytes()? },
        ECOMPACT => Frame::ECompact { doc: r.string()?, upto: r.var_uint()?, data: r.bytes()? },
        _ => return Err(DecodeError),
    };
    Ok(f)
}

pub fn welcome(json: &str) -> Vec<u8> {
    Writer::new().var_uint(WELCOME).string(json).finish()
}
pub fn sync(doc: &str, sub: u64, data: &[u8]) -> Vec<u8> {
    Writer::new().var_uint(SYNC).string(doc).var_uint(sub).bytes(data).finish()
}
pub fn awareness(doc: &str, data: &[u8]) -> Vec<u8> {
    Writer::new().var_uint(AWARENESS).string(doc).bytes(data).finish()
}
pub fn error(code: u64, doc: &str, msg: &str) -> Vec<u8> {
    Writer::new().var_uint(ERROR).var_uint(code).string(doc).string(msg).finish()
}
pub fn changes(space: &str, seq: u64, docs: &[&str]) -> Vec<u8> {
    let mut w = Writer::new();
    w.var_uint(CHANGES).string(space).var_uint(seq).var_uint(docs.len() as u64);
    for d in docs {
        w.string(d);
    }
    w.finish()
}
pub fn pong() -> Vec<u8> {
    Writer::new().var_uint(PONG).finish()
}
/// Log eines verschlüsselten Docs: `total` = Zahl der gespeicherten Zeilen (Hinweis fürs Verdichten),
/// danach n × (Zeilen-ID, Chiffretext).
pub fn elog<'a>(doc: &str, total: u64, rows: impl ExactSizeIterator<Item = (u64, &'a [u8])>) -> Vec<u8> {
    let mut w = Writer::new();
    w.var_uint(ELOG).string(doc).var_uint(total).var_uint(rows.len() as u64);
    for (id, data) in rows {
        w.var_uint(id).bytes(data);
    }
    w.finish()
}
pub fn eupd(doc: &str, id: u64, data: &[u8]) -> Vec<u8> {
    Writer::new().var_uint(EUPD).string(doc).var_uint(id).bytes(data).finish()
}
pub fn eack(doc: &str, id: u64) -> Vec<u8> {
    Writer::new().var_uint(EACK).string(doc).var_uint(id).finish()
}

/// Ein Eintrag eines Awareness-Updates (y-protocols): clientID, clock, JSON-Zustand ("null" = entfernt).
#[derive(Debug, Clone, PartialEq)]
pub struct AwEntry {
    pub client: u64,
    pub clock: u64,
    pub state: String,
}

pub fn decode_awareness(buf: &[u8]) -> Result<Vec<AwEntry>, DecodeError> {
    let mut r = Reader::new(buf);
    let n = r.var_uint()? as usize;
    if n > 10_000 {
        return Err(DecodeError);
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        out.push(AwEntry { client: r.var_uint()?, clock: r.var_uint()?, state: r.string()?.to_string() });
    }
    Ok(out)
}

pub fn encode_awareness<'a>(entries: impl IntoIterator<Item = &'a AwEntry>) -> Vec<u8> {
    let v: Vec<&AwEntry> = entries.into_iter().collect();
    let mut w = Writer::new();
    w.var_uint(v.len() as u64);
    for e in v {
        w.var_uint(e.client).var_uint(e.clock).string(&e.state);
    }
    w.finish()
}

/// `<space>/<docId>` mit erlaubten Zeichen prüfen.
pub fn split_doc(name: &str) -> Option<(&str, &str)> {
    let (space, doc) = name.split_once('/')?;
    if valid_id(space) && valid_id(doc) { Some((space, doc)) } else { None }
}

pub fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varuint_roundtrip() {
        for n in [0u64, 1, 127, 128, 300, 16384, u32::MAX as u64, u64::MAX >> 1] {
            let b = Writer::new().var_uint(n).finish();
            assert_eq!(Reader::new(&b).var_uint().unwrap(), n);
        }
    }

    #[test]
    fn frames() {
        let hello = Writer::new().var_uint(HELLO).var_uint(1).string("tok").string("Laptop").finish();
        assert_eq!(decode_client(&hello).unwrap(), Frame::Hello { version: 1, token: "tok", device: "Laptop", client: None });
        let s = sync("a/b", STEP1, &[0]);
        assert_eq!(decode_client(&s).unwrap(), Frame::Sync { doc: "a/b", sub: STEP1, data: &[0] });
        assert!(decode_client(&[99]).is_err());
        assert!(decode_client(&[2, 5, b'a']).is_err());
    }

    #[test]
    fn awareness_roundtrip() {
        let e = vec![AwEntry { client: 42, clock: 3, state: "{\"user\":1}".into() }];
        assert_eq!(decode_awareness(&encode_awareness(&e)).unwrap(), e);
    }

    /// Gemeinsame Testvektoren mit dem Plugin (protocol/vectors.json, erzeugt von plugin/src/net/protocol.test.ts).
    #[test]
    fn shared_vectors() {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../protocol/vectors.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let get = |k: &str| hex::decode(v[k].as_str().unwrap()).unwrap();
        assert_eq!(decode_client(&get("hello")).unwrap(), Frame::Hello { version: 1, token: "abc123", device: "iPad Pro ✏️", client: None });
        assert_eq!(
            decode_client(&get("hello-client")).unwrap(),
            Frame::Hello { version: 1, token: "abc123", device: "iPad Pro ✏️", client: Some("tandem-plugin/0.6.4") }
        );
        assert_eq!(decode_client(&get("sync-step1")).unwrap(), Frame::Sync { doc: "space/_index", sub: STEP1, data: &[0] });
        let upd: Vec<u8> = (0..300).map(|i| (i % 256) as u8).collect();
        assert_eq!(decode_client(&get("sync-update")).unwrap(), Frame::Sync { doc: "space/abc", sub: UPDATE, data: &upd });
        assert_eq!(decode_client(&get("awareness")).unwrap(), Frame::Awareness { doc: "space/abc", data: &[1, 200, 1, 3, 2, 123, 125] });
        assert_eq!(decode_client(&get("unsub")).unwrap(), Frame::Unsub { doc: "space/abc" });
        assert_eq!(decode_client(&get("catchup")).unwrap(), Frame::Catchup { space: "space", since: 129 });
        assert_eq!(decode_client(&get("ping")).unwrap(), Frame::Ping);
        // Server → Client byte-gleich
        assert_eq!(sync("space/abc", UPDATE, &upd), get("sync-update"));
        assert_eq!(awareness("space/abc", &[1, 200, 1, 3, 2, 123, 125]), get("awareness"));
        assert_eq!(error(403, "space/abc", "kein Zugriff"), get("error"));
        assert_eq!(changes("space", 70000, &["space/a", "space/b"]), get("changes"));
        assert_eq!(pong(), get("pong"));
        // Verschlüsselte Spaces
        assert_eq!(decode_client(&get("esub")).unwrap(), Frame::ESub { doc: "space/abc", since: 300 });
        assert_eq!(decode_client(&get("eupd-client")).unwrap(), Frame::EUpd { doc: "space/abc", data: &[9, 8, 7] });
        assert_eq!(decode_client(&get("ecompact")).unwrap(), Frame::ECompact { doc: "space/abc", upto: 300, data: &[5, 6] });
        assert_eq!(eupd("space/abc", 300, &[9, 8, 7]), get("eupd-server"));
        assert_eq!(eack("space/abc", 300), get("eack"));
        assert_eq!(elog("space/abc", 3, [(7u64, &[1u8, 2][..]), (300, &[3][..])].into_iter()), get("elog"));
        let w = get("welcome");
        let mut r = Reader::new(&w);
        assert_eq!(r.var_uint().unwrap(), WELCOME);
        assert_eq!(welcome(r.string().unwrap()), w);
    }

    #[test]
    fn doc_names() {
        assert_eq!(split_doc("space1/_index"), Some(("space1", "_index")));
        assert_eq!(split_doc("x/../y"), None);
        assert_eq!(split_doc("noslash"), None);
    }
}
