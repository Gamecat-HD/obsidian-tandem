//! Admin-Anmeldung: Argon2id-Passwörter und TOTP (RFC 6238, SHA-1, 6 Stellen, 30 s).

use anyhow::{Result, anyhow};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use hmac::{Hmac, Mac};
use std::sync::LazyLock;

/// OWASP-Empfehlung für Argon2id: 19 MiB, 2 Durchläufe. Hält den RAM-Bedarf im 128-MiB-Container klein.
fn argon() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(19 * 1024, 2, 1, None).expect("Argon2-Parameter"))
}

pub fn hash_password(pw: &str) -> Result<String> {
    let mut salt = [0u8; 16];
    rand::fill(&mut salt[..]);
    let salt = SaltString::encode_b64(&salt).map_err(|e| anyhow!("{e}"))?;
    Ok(argon().hash_password(pw.as_bytes(), &salt).map_err(|e| anyhow!("{e}"))?.to_string())
}

/// Ein fester Hash, gegen den bei unbekannten Nutzern geprüft wird (gleiche Laufzeit, keine Auskunft).
pub static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| hash_password("tandem-dummy-password").unwrap_or_default());

pub fn verify_password(pw: &str, hash: &str) -> bool {
    let Ok(h) = PasswordHash::new(hash) else { return false };
    argon().verify_password(pw.as_bytes(), &h).is_ok()
}

/// Passwortregeln: 12–256 Zeichen, nicht nur ein Zeichen wiederholt.
pub fn check_password_policy(pw: &str) -> Result<(), &'static str> {
    let n = pw.chars().count();
    if n < 12 {
        return Err("Passwort: mindestens 12 Zeichen");
    }
    if n > 256 {
        return Err("Passwort: höchstens 256 Zeichen");
    }
    let first = pw.chars().next().unwrap();
    if pw.chars().all(|c| c == first) {
        return Err("Passwort zu einfach");
    }
    Ok(())
}

// ── TOTP ──────────────────────────────────────────────────────────────

pub const STEP: i64 = 30;

pub fn new_totp_secret() -> String {
    let mut b = [0u8; 20];
    rand::fill(&mut b[..]);
    base32(&b)
}

fn base32(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in data {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(A[((buf >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(A[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.chars().filter(|c| *c != '=' && !c.is_whitespace()) {
        let v = match c.to_ascii_uppercase() {
            c @ 'A'..='Z' => c as u32 - 'A' as u32,
            c @ '2'..='7' => c as u32 - '2' as u32 + 26,
            _ => return None,
        };
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push((buf >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

fn hotp(key: &[u8], counter: u64) -> u32 {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(key).expect("HMAC");
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let o = (h[19] & 0x0f) as usize;
    let bin = ((h[o] as u32 & 0x7f) << 24) | ((h[o + 1] as u32) << 16) | ((h[o + 2] as u32) << 8) | h[o + 3] as u32;
    bin % 1_000_000
}

/// Code prüfen (±1 Schritt Toleranz). Liefert den Zeitschritt, der passte – er muss größer als
/// der zuletzt benutzte sein (`last`), sonst wäre es eine Wiederholung.
pub fn verify_totp(secret: &str, code: &str, last: i64, now: i64) -> Option<i64> {
    let code = code.trim().replace(' ', "");
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let want: u32 = code.parse().ok()?;
    let key = base32_decode(secret)?;
    let cur = now / STEP;
    let mut hit = None;
    for step in [cur - 1, cur, cur + 1] {
        // Alle drei prüfen, damit die Laufzeit nicht verrät, welcher Schritt passte.
        if step > last && hotp(&key, step as u64) == want {
            hit = Some(step);
        }
    }
    hit
}

pub fn otpauth_uri(secret: &str, user: &str, issuer: &str) -> String {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    };
    format!("otpauth://totp/{}:{}?secret={secret}&issuer={}&algorithm=SHA1&digits=6&period=30", enc(issuer), enc(user), enc(issuer))
}

pub fn qr_svg(data: &str) -> String {
    match qrcode::QrCode::new(data.as_bytes()) {
        Ok(q) => q.render::<qrcode::render::svg::Color>().min_dimensions(200, 200).quiet_zone(true).build(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_vectors() {
        // RFC 6238, Anhang B (SHA-1, Schlüssel "12345678901234567890"), letzte 6 Stellen
        let key = b"12345678901234567890";
        assert_eq!(hotp(key, 59 / 30), 287082);
        assert_eq!(hotp(key, 1111111109 / 30), 81804);
        assert_eq!(hotp(key, 1234567890 / 30), 5924);
        let secret = base32(key);
        assert_eq!(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert_eq!(base32_decode(&secret).unwrap(), key);
        assert_eq!(verify_totp(&secret, "287082", 0, 59), Some(1));
        assert_eq!(verify_totp(&secret, "287082", 1, 59), None, "Wiederholung");
        assert_eq!(verify_totp(&secret, "081804", 0, 1111111109), Some(1111111109 / 30));
        assert_eq!(verify_totp(&secret, "081804", 0, 1111111109 + 90), None, "zu alt");
        assert_eq!(verify_totp(&secret, "abcdef", 0, 59), None);
    }

    #[test]
    fn passwords() {
        let h = hash_password("richtig-langes-passwort").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("richtig-langes-passwort", &h));
        assert!(!verify_password("falsch", &h));
        assert!(!verify_password("x", "kein-hash"));
        assert!(check_password_policy("kurz").is_err());
        assert!(check_password_policy("aaaaaaaaaaaaaaaa").is_err());
        assert!(check_password_policy("lang genug, wirklich").is_ok());
    }

    #[test]
    fn uri_and_qr() {
        let u = otpauth_uri("ABC", "anna", "Tandem");
        assert_eq!(u, "otpauth://totp/Tandem:anna?secret=ABC&issuer=Tandem&algorithm=SHA1&digits=6&period=30");
        assert!(qr_svg(&u).contains("<svg"));
    }
}
