// Small shared filesystem helpers (improvement-6 7.8a). Before this, five call
// sites hand-rolled the temp-file+rename atomic write - each with a FIXED temp name
// (`path.with_extension("*.tmp")`) that two concurrent writers of the same file
// would collide on - and two more hand-rolled the one-generation JSONL rotation.
// Consolidated here so the atomic-write and rotation policy lives (and is fixed)
// once.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Process-local counter so two atomic writes of the same file never pick the same
/// temp name (the old fixed `.tmp` names could collide, corrupting one writer).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// The unique temp sibling for `path`: `.<name>.<pid>.<seq>.tmp` next to it (same
/// directory, so the final rename is atomic on-volume). Hidden-dotted so a crash
/// leaves an obviously-temporary file.
fn tmp_sibling(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.{}.{seq}.tmp", std::process::id()))
}

/// Atomically write `bytes` to `path`: write a unique temp sibling, then rename it
/// over `path`. A crash or a concurrent writer can never observe a half-written or
/// clobbered file. On a rename failure the temp file is cleaned up so it can't leak.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = tmp_sibling(path);
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// The rolled-generation path for `path`: `<path>.1` (append, not replace-extension,
/// so `june-runs.jsonl` -> `june-runs.jsonl.1` and `june.log` -> `june.log.1`).
pub(crate) fn rolled_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".1");
    PathBuf::from(s)
}

/// One-generation rotation: if `path` is larger than `max_bytes`, rename it to
/// `<path>.1` (dropping any prior `.1`). Best-effort - a failed rotate just means the
/// file keeps growing this once. Returns whether it rotated (a missing/unstattable
/// file is treated as size 0, so it doesn't rotate).
pub(crate) fn rotate_if_larger(path: &Path, max_bytes: u64) -> bool {
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > max_bytes {
        std::fs::rename(path, rolled_path(path)).is_ok()
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("june-fsutil-test-{}-{}", std::process::id(), name))
    }

    #[test]
    fn atomic_write_replaces_contents_and_leaves_no_temp() {
        let path = temp_path("atomic.txt");
        atomic_write(&path, b"first").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        atomic_write(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        // No temp sibling lingers next to the file.
        let dir = path.parent().unwrap();
        let leaked: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".atomic.txt.") && e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leaked.is_empty(), "atomic write leaked a temp file");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn tmp_siblings_are_unique_per_call() {
        let path = temp_path("unique.txt");
        assert_ne!(tmp_sibling(&path), tmp_sibling(&path));
    }

    #[test]
    fn rotate_only_when_over_the_cap() {
        let path = temp_path("rotate.jsonl");
        std::fs::write(&path, b"0123456789").unwrap();
        // Under the cap: no rotation.
        assert!(!rotate_if_larger(&path, 100));
        assert!(path.exists());
        // Over the cap: moves to <path>.1.
        assert!(rotate_if_larger(&path, 5));
        assert!(!path.exists());
        let rolled = rolled_path(&path);
        assert_eq!(std::fs::read_to_string(&rolled).unwrap(), "0123456789");
        std::fs::remove_file(&rolled).unwrap();
    }
}
