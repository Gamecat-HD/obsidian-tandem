//! Passkeys (WebAuthn Level 2) als zweiter Faktor für die Admin-Anmeldung – schlank und ohne OpenSSL.
//!
//! Unterstützt ES256 (fast alle Passkeys), EdDSA und RS256 (ältere Windows-Hello-Schlüssel).
//! Attestierung wird nicht geprüft ("none"): Es zählt nur, dass beim Anmelden derselbe Schlüssel signiert,
//! der beim Einrichten (in einer bereits angemeldeten Sitzung) hinterlegt wurde.

use anyhow::{Result, anyhow, bail, ensure};
use ciborium::Value;
use sha2::{Digest, Sha256};

pub const ES256: i64 = -7;
pub const EDDSA: i64 = -8;
pub const RS256: i64 = -257;

/// Erwartete Herkunft: Relying-Party-ID (Domain) und erlaubte Origins.
pub struct Rp {
    pub id: String,
    pub origins: Vec<String>,
}

impl Rp {
    /// Aus TANDEM_PUBLIC_URL (bevorzugt) oder dem Host-Header. Über http nur für localhost (Entwicklung).
    pub fn from(public_url: Option<&str>, host: &str) -> Self {
        let base = public_url.map(|u| u.trim_end_matches('/').to_string()).unwrap_or_else(|| format!("https://{host}"));
        let hostport = base.split("://").nth(1).unwrap_or(host).split('/').next().unwrap_or(host).to_string();
        let id = hostport.split(':').next().unwrap_or(&hostport).to_string();
        let mut origins = vec![format!("https://{hostport}")];
        if id == "localhost" || id == "127.0.0.1" {
            // Tests/Entwicklung ohne TLS (der Browser erlaubt WebAuthn auf localhost auch über http).
            origins.push(format!("http://{hostport}"));
            if public_url.is_none() || hostport != host {
                origins.push(format!("http://{host}"));
            }
        }
        Self { id, origins }
    }
}

// ── base64url ohne Padding ───────────────────────────────────────────

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64url(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 3);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            out.push(B64[(n >> (18 - 6 * i)) as usize & 63] as char);
        }
    }
    out
}

pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

pub fn challenge() -> Vec<u8> {
    let mut b = vec![0u8; 32];
    rand::fill(&mut b[..]);
    b
}

// ── Prüfungen ────────────────────────────────────────────────────────

fn check_client_data(raw: &[u8], typ: &str, challenge: &[u8], rp: &Rp) -> Result<()> {
    let v: serde_json::Value = serde_json::from_slice(raw).map_err(|_| anyhow!("clientDataJSON ungültig"))?;
    ensure!(v["type"] == typ, "falscher Vorgang");
    let got = v["challenge"].as_str().and_then(b64url_decode).ok_or_else(|| anyhow!("Challenge fehlt"))?;
    // Länge ist fest (32), Vergleich in konstanter Zeit nicht nötig – die Challenge ist kein Geheimnis.
    ensure!(got == challenge, "Challenge stimmt nicht (abgelaufen?)");
    let origin = v["origin"].as_str().unwrap_or("");
    ensure!(rp.origins.iter().any(|o| o == origin), "falsche Herkunft {origin}");
    ensure!(v["crossOrigin"].as_bool() != Some(true), "Aufruf aus fremdem Rahmen");
    Ok(())
}

struct AuthData<'a> {
    flags: u8,
    count: u32,
    rest: &'a [u8],
}

const UP: u8 = 0x01;
const UV: u8 = 0x04;
const AT: u8 = 0x40;

fn parse_auth_data<'a>(d: &'a [u8], rp: &Rp) -> Result<AuthData<'a>> {
    ensure!(d.len() >= 37, "authenticatorData zu kurz");
    ensure!(d[..32] == Sha256::digest(rp.id.as_bytes())[..], "Passkey gehört zu einer anderen Domain");
    let flags = d[32];
    ensure!(flags & UP != 0, "keine Nutzerbestätigung");
    ensure!(flags & UV != 0, "Passkey ohne Entsperren (PIN/Biometrie) – bitte mit Nutzerprüfung verwenden");
    Ok(AuthData { flags, count: u32::from_be_bytes([d[33], d[34], d[35], d[36]]), rest: &d[37..] })
}

fn map_get<'a>(m: &'a [(Value, Value)], key: i64) -> Option<&'a Value> {
    m.iter().find(|(k, _)| k.as_integer().map(i128::from) == Some(key as i128)).map(|(_, v)| v)
}

fn bytes(v: Option<&Value>) -> Result<&[u8]> {
    v.and_then(Value::as_bytes).map(Vec::as_slice).ok_or_else(|| anyhow!("COSE-Schlüssel unvollständig"))
}

/// Algorithmus eines COSE-Schlüssels (und prüfen, dass er sich verwenden lässt).
pub fn cose_alg(cose: &[u8]) -> Result<i64> {
    let v: Value = ciborium::de::from_reader(cose).map_err(|_| anyhow!("COSE-Schlüssel nicht lesbar"))?;
    let m = v.as_map().ok_or_else(|| anyhow!("COSE-Schlüssel ist keine Map"))?;
    let alg = map_get(m, 3).and_then(Value::as_integer).map(i128::from).ok_or_else(|| anyhow!("COSE: alg fehlt"))? as i64;
    // Probeweise einlesen
    verifier(m, alg)?;
    Ok(alg)
}

enum Key {
    Es256(p256::ecdsa::VerifyingKey),
    EdDsa(ed25519_dalek::VerifyingKey),
    Rs256(rsa::pkcs1v15::VerifyingKey<rsa::sha2::Sha256>),
}

fn verifier(m: &[(Value, Value)], alg: i64) -> Result<Key> {
    let kty = map_get(m, 1).and_then(Value::as_integer).map(i128::from);
    match alg {
        ES256 => {
            ensure!(kty == Some(2), "ES256 braucht kty=EC2");
            let (x, y) = (bytes(map_get(m, -2))?, bytes(map_get(m, -3))?);
            ensure!(x.len() == 32 && y.len() == 32, "P-256-Koordinaten ungültig");
            let mut sec1 = vec![0x04];
            sec1.extend_from_slice(x);
            sec1.extend_from_slice(y);
            Ok(Key::Es256(p256::ecdsa::VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| anyhow!("P-256-Schlüssel ungültig"))?))
        }
        EDDSA => {
            ensure!(kty == Some(1), "EdDSA braucht kty=OKP");
            let x: [u8; 32] = bytes(map_get(m, -2))?.try_into().map_err(|_| anyhow!("Ed25519-Schlüssel ungültig"))?;
            Ok(Key::EdDsa(ed25519_dalek::VerifyingKey::from_bytes(&x).map_err(|_| anyhow!("Ed25519-Schlüssel ungültig"))?))
        }
        RS256 => {
            ensure!(kty == Some(3), "RS256 braucht kty=RSA");
            let (n, e) = (bytes(map_get(m, -1))?, bytes(map_get(m, -2))?);
            ensure!(n.len() >= 256, "RSA-Schlüssel zu kurz");
            let pk = rsa::RsaPublicKey::new(rsa::BigUint::from_bytes_be(n), rsa::BigUint::from_bytes_be(e)).map_err(|_| anyhow!("RSA-Schlüssel ungültig"))?;
            Ok(Key::Rs256(rsa::pkcs1v15::VerifyingKey::new(pk)))
        }
        _ => bail!("Passkey-Algorithmus {alg} wird nicht unterstützt"),
    }
}

fn verify_sig(cose: &[u8], msg: &[u8], sig: &[u8]) -> Result<()> {
    let v: Value = ciborium::de::from_reader(cose).map_err(|_| anyhow!("COSE-Schlüssel nicht lesbar"))?;
    let m = v.as_map().ok_or_else(|| anyhow!("COSE-Schlüssel ist keine Map"))?;
    let alg = map_get(m, 3).and_then(Value::as_integer).map(i128::from).ok_or_else(|| anyhow!("COSE: alg fehlt"))? as i64;
    let ok = match verifier(m, alg)? {
        Key::Es256(k) => {
            use p256::ecdsa::signature::Verifier;
            let s = p256::ecdsa::Signature::from_der(sig).map_err(|_| anyhow!("Signatur ungültig"))?;
            k.verify(msg, &s).is_ok()
        }
        Key::EdDsa(k) => {
            let s = ed25519_dalek::Signature::from_slice(sig).map_err(|_| anyhow!("Signatur ungültig"))?;
            k.verify_strict(msg, &s).is_ok()
        }
        Key::Rs256(k) => {
            use rsa::signature::Verifier;
            let s = rsa::pkcs1v15::Signature::try_from(sig).map_err(|_| anyhow!("Signatur ungültig"))?;
            k.verify(msg, &s).is_ok()
        }
    };
    ensure!(ok, "Signatur stimmt nicht");
    Ok(())
}

/// Ergebnis einer Registrierung.
pub struct NewCred {
    pub id: Vec<u8>,
    pub cose: Vec<u8>,
    pub count: u32,
    pub alg: i64,
}

/// `navigator.credentials.create()` auswerten.
pub fn register(client_data: &[u8], attestation_object: &[u8], challenge: &[u8], rp: &Rp) -> Result<NewCred> {
    check_client_data(client_data, "webauthn.create", challenge, rp)?;
    let att: Value = ciborium::de::from_reader(attestation_object).map_err(|_| anyhow!("attestationObject nicht lesbar"))?;
    let m = att.as_map().ok_or_else(|| anyhow!("attestationObject ungültig"))?;
    let auth = m
        .iter()
        .find(|(k, _)| k.as_text() == Some("authData"))
        .and_then(|(_, v)| v.as_bytes())
        .ok_or_else(|| anyhow!("authData fehlt"))?;
    let ad = parse_auth_data(auth, rp)?;
    ensure!(ad.flags & AT != 0, "keine Schlüsseldaten");
    let r = ad.rest;
    ensure!(r.len() >= 18, "Schlüsseldaten zu kurz");
    let len = u16::from_be_bytes([r[16], r[17]]) as usize;
    ensure!(len > 0 && len <= 1023 && r.len() >= 18 + len, "Credential-ID ungültig");
    let id = r[18..18 + len].to_vec();
    let mut rest = &r[18 + len..];
    let before = rest.len();
    let _: Value = ciborium::de::from_reader(&mut rest).map_err(|_| anyhow!("öffentlicher Schlüssel nicht lesbar"))?;
    let cose = r[18 + len..18 + len + (before - rest.len())].to_vec();
    let alg = cose_alg(&cose)?;
    Ok(NewCred { id, cose, count: ad.count, alg })
}

/// `navigator.credentials.get()` prüfen. Liefert den neuen Signaturzähler.
pub fn verify(cose: &[u8], prev_count: u32, client_data: &[u8], auth_data: &[u8], sig: &[u8], challenge: &[u8], rp: &Rp) -> Result<u32> {
    check_client_data(client_data, "webauthn.get", challenge, rp)?;
    let ad = parse_auth_data(auth_data, rp)?;
    // Zähler: Synchronisierte Passkeys melden immer 0; sonst muss er steigen (geklonter Schlüssel?).
    if ad.count != 0 || prev_count != 0 {
        ensure!(ad.count > prev_count, "Signaturzähler nicht gestiegen – Passkey möglicherweise kopiert");
    }
    let mut msg = auth_data.to_vec();
    msg.extend_from_slice(&Sha256::digest(client_data));
    verify_sig(cose, &msg, sig)?;
    Ok(ad.count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;

    fn rp() -> Rp {
        Rp::from(Some("https://tandem.example.org"), "tandem.example.org")
    }

    fn cose_es256(k: &p256::ecdsa::VerifyingKey) -> Vec<u8> {
        let p = k.to_sec1_point(false);
        let m = Value::Map(vec![
            (Value::Integer(1.into()), Value::Integer(2.into())),
            (Value::Integer(3.into()), Value::Integer((-7).into())),
            (Value::Integer((-1).into()), Value::Integer(1.into())),
            (Value::Integer((-2).into()), Value::Bytes(p.x().unwrap().to_vec())),
            (Value::Integer((-3).into()), Value::Bytes(p.y().unwrap().to_vec())),
        ]);
        let mut out = Vec::new();
        ciborium::ser::into_writer(&m, &mut out).unwrap();
        out
    }

    fn auth_data(rp: &str, flags: u8, count: u32, attested: Option<(&[u8], &[u8])>) -> Vec<u8> {
        let mut d = Sha256::digest(rp.as_bytes()).to_vec();
        d.push(flags);
        d.extend_from_slice(&count.to_be_bytes());
        if let Some((id, cose)) = attested {
            d.extend_from_slice(&[0u8; 16]);
            d.extend_from_slice(&(id.len() as u16).to_be_bytes());
            d.extend_from_slice(id);
            d.extend_from_slice(cose);
        }
        d
    }

    fn client_data(typ: &str, ch: &[u8], origin: &str) -> Vec<u8> {
        serde_json::json!({ "type": typ, "challenge": b64url(ch), "origin": origin, "crossOrigin": false }).to_string().into_bytes()
    }

    #[test]
    fn b64_roundtrip() {
        for n in 0..40 {
            let d: Vec<u8> = (0..n).map(|i| (i * 37) as u8).collect();
            assert_eq!(b64url_decode(&b64url(&d)).unwrap(), d);
        }
        assert_eq!(b64url(b"\xfb\xff"), "-_8");
    }

    #[test]
    fn register_and_login_es256() {
        let sk = p256::ecdsa::SigningKey::from_slice(&[7u8; 32]).unwrap();
        let cose = cose_es256(sk.verifying_key());
        let rp = rp();
        let ch = challenge();
        // Registrierung
        let ad = auth_data("tandem.example.org", UP | UV | AT, 0, Some((b"cred-1", &cose)));
        let att = Value::Map(vec![
            (Value::Text("fmt".into()), Value::Text("none".into())),
            (Value::Text("attStmt".into()), Value::Map(vec![])),
            (Value::Text("authData".into()), Value::Bytes(ad)),
        ]);
        let mut attb = Vec::new();
        ciborium::ser::into_writer(&att, &mut attb).unwrap();
        let cd = client_data("webauthn.create", &ch, "https://tandem.example.org");
        let c = register(&cd, &attb, &ch, &rp).unwrap();
        assert_eq!(c.id, b"cred-1");
        assert_eq!(c.alg, ES256);
        assert_eq!(c.cose, cose);
        // falsche Challenge / Herkunft
        assert!(register(&cd, &attb, &challenge(), &rp).is_err());
        let evil = client_data("webauthn.create", &ch, "https://evil.example");
        assert!(register(&evil, &attb, &ch, &rp).is_err());

        // Anmeldung
        let ch = challenge();
        let ad = auth_data("tandem.example.org", UP | UV, 5, None);
        let cd = client_data("webauthn.get", &ch, "https://tandem.example.org");
        let mut msg = ad.clone();
        msg.extend_from_slice(&Sha256::digest(&cd));
        let sig: p256::ecdsa::Signature = sk.sign(&msg);
        let der = sig.to_der();
        assert_eq!(verify(&c.cose, 0, &cd, &ad, der.as_bytes(), &ch, &rp).unwrap(), 5);
        // Zähler darf nicht zurückgehen, Challenge muss passen, Signatur muss zur Nachricht gehören
        assert!(verify(&c.cose, 5, &cd, &ad, der.as_bytes(), &ch, &rp).is_err());
        assert!(verify(&c.cose, 0, &cd, &ad, der.as_bytes(), &challenge(), &rp).is_err());
        let mut ad2 = ad.clone();
        ad2[32] = UP | UV | 0x08;
        assert!(verify(&c.cose, 0, &cd, &ad2, der.as_bytes(), &ch, &rp).is_err());
        // ohne Nutzerprüfung (UV) abgelehnt
        let ad3 = auth_data("tandem.example.org", UP, 6, None);
        let mut msg3 = ad3.clone();
        msg3.extend_from_slice(&Sha256::digest(&cd));
        let sig3: p256::ecdsa::Signature = sk.sign(&msg3);
        assert!(verify(&c.cose, 0, &cd, &ad3, sig3.to_der().as_bytes(), &ch, &rp).is_err());
        // andere Domain
        let ad4 = auth_data("evil.example", UP | UV, 7, None);
        assert!(verify(&c.cose, 0, &cd, &ad4, der.as_bytes(), &ch, &rp).is_err());
    }

    #[test]
    fn rp_from_env_or_host() {
        let r = Rp::from(Some("https://tandem.example.org/"), "x");
        assert_eq!(r.id, "tandem.example.org");
        assert_eq!(r.origins, vec!["https://tandem.example.org"]);
        let r = Rp::from(None, "localhost:8080");
        assert_eq!(r.id, "localhost");
        assert!(r.origins.contains(&"http://localhost:8080".to_string()));
    }
}
