//! Minimaler tar-Writer (POSIX pax/ustar) zum Streamen: Kopf erzeugen, Inhalt anhängen, auf 512 Byte auffüllen.
//! Pfade stehen immer zusätzlich in einem pax-Kopf (UTF-8, beliebige Länge).

const BLOCK: usize = 512;

fn octal(field: &mut [u8], v: u64) {
    // Feld: Ziffern mit führenden Nullen, letztes Byte NUL
    let s = format!("{:0width$o}", v, width = field.len() - 1);
    let b = s.as_bytes();
    let n = b.len().min(field.len() - 1);
    field[..n].copy_from_slice(&b[b.len() - n..]);
    field[field.len() - 1] = 0;
}

fn header(name: &str, size: u64, mtime: u64, typeflag: u8) -> [u8; BLOCK] {
    let mut h = [0u8; BLOCK];
    // ustar-Name nur als ASCII-Ersatz (der echte Pfad steht im pax-Kopf)
    let ascii: Vec<u8> = name.bytes().map(|b| if b.is_ascii_graphic() || b == b' ' { b } else { b'_' }).collect();
    let n = ascii.len().min(99);
    h[..n].copy_from_slice(&ascii[ascii.len() - n..]);
    octal(&mut h[100..108], 0o644);
    octal(&mut h[108..116], 0);
    octal(&mut h[116..124], 0);
    octal(&mut h[124..136], size);
    octal(&mut h[136..148], mtime);
    h[148..156].fill(b' ');
    h[156] = typeflag;
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    let sum: u32 = h.iter().map(|b| *b as u32).sum();
    let s = format!("{sum:06o}\0 ");
    h[148..156].copy_from_slice(s.as_bytes());
    h
}

fn pax_record(key: &str, value: &str) -> String {
    // "<len> <key>=<value>\n", len zählt sich selbst mit
    let body = format!(" {key}={value}\n");
    let mut len = body.len() + 1;
    loop {
        let total = len.to_string().len() + body.len();
        if total == len {
            return format!("{len}{body}");
        }
        len = total;
    }
}

/// Alles, was vor dem Inhalt einer Datei steht (pax-Kopf + ustar-Kopf).
pub fn file_header(path: &str, size: u64, mtime: u64) -> Vec<u8> {
    let rec = pax_record("path", path);
    let mut out = Vec::with_capacity(4 * BLOCK);
    out.extend_from_slice(&header("PaxHeader", rec.len() as u64, mtime, b'x'));
    out.extend_from_slice(rec.as_bytes());
    out.resize(out.len() + padding(rec.len() as u64), 0);
    out.extend_from_slice(&header(path, size, mtime, b'0'));
    out
}

/// Füllbytes nach einem Inhalt der Länge `size`.
pub fn padding(size: u64) -> usize {
    ((BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64) as usize
}

/// Ende des Archivs: zwei leere Blöcke.
pub fn trailer() -> Vec<u8> {
    vec![0u8; 2 * BLOCK]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn readable_by_tar() {
        let mut buf = Vec::new();
        let long_name = "Ä lange Überschrift – ".repeat(5) + ".md";
        for (path, data) in [(format!("Notizen/{long_name}"), b"hallo".to_vec()), ("x.bin".to_string(), vec![7u8; 1000])] {
            buf.extend(file_header(&path, data.len() as u64, 1_700_000_000));
            buf.extend(&data);
            buf.resize(buf.len() + padding(data.len() as u64), 0);
        }
        buf.extend(trailer());
        let dir = std::env::temp_dir().join(format!("tandem-tar-{}", crate::db::random_token(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.tar");
        std::fs::File::create(&file).unwrap().write_all(&buf).unwrap();
        let out = std::process::Command::new("tar").arg("-xf").arg(&file).current_dir(&dir).output();
        if let Ok(o) = out {
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            let long = dir.join("Notizen").join(&long_name);
            assert_eq!(std::fs::read(long).unwrap(), b"hallo");
            assert_eq!(std::fs::read(dir.join("x.bin")).unwrap().len(), 1000);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pax_length_counts_itself() {
        let r = pax_record("path", "a");
        assert_eq!(r, "9 path=a\n");
        assert_eq!(r.len(), 9);
        let long = pax_record("path", &"x".repeat(95));
        assert_eq!(long.len().to_string(), long.split(' ').next().unwrap());
    }
}
