//! Durable audit journal for bulk-edit mutations.
//!
//! Storage: one JSON object per line (JSONL) appended to a single file. The
//! command layer resolves that file under the app data directory; the engine
//! only receives a writer, so tests use an in-memory sink.
//!
//! Failure semantics: the journal is written *after* the mutation it records.
//! A crash between the write and the append loses that entry (the plan id and
//! the returned per-file result still identify the change). A failed append
//! never rolls the mutation back — the file is already correct and destroying
//! user data to keep an audit log would be worse; the result marks
//! `journaled: false` and the batch `journal_degraded: true`.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Schema version of one journal line. Readers reject anything else.
pub const JOURNAL_SCHEMA_VERSION: u32 = 1;

/// Final outcome recorded for one attempted mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalOutcome {
    Applied,
    Failed,
}

/// One journal line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub schema_version: u32,
    pub at_unix_ms: u64,
    pub plan_id: String,
    pub plan_schema_version: u32,
    pub operation: String,
    pub file: String,
    pub locator: String,
    pub change_count: usize,
    pub before_fingerprint: String,
    pub after_fingerprint: Option<String>,
    pub outcome: JournalOutcome,
    pub error: Option<String>,
}

impl JournalEntry {
    /// Builds an entry stamped with the current time.
    pub fn now(
        plan: &super::BulkPlan,
        file: &str,
        locator: String,
        change_count: usize,
        before_fingerprint: String,
        after_fingerprint: Option<String>,
        outcome: JournalOutcome,
        error: Option<String>,
    ) -> Self {
        Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            at_unix_ms: now_unix_ms(),
            plan_id: plan.id.clone(),
            plan_schema_version: plan.schema_version,
            operation: plan.params.operation.key().to_string(),
            file: file.to_string(),
            locator,
            change_count,
            before_fingerprint,
            after_fingerprint,
            outcome,
            error,
        }
    }

    /// Serializes one entry as a single JSONL line (without the newline).
    pub fn to_line(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("Failed to serialize journal entry: {}", e))
    }

    /// Parses one JSONL line and validates its schema version.
    #[cfg(test)]
    pub fn from_line(line: &str) -> Result<Self, String> {
        let entry: Self = serde_json::from_str(line)
            .map_err(|e| format!("Failed to parse journal entry: {}", e))?;
        if entry.schema_version != JOURNAL_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported journal schema version: {}",
                entry.schema_version
            ));
        }
        Ok(entry)
    }
}

/// Sink for journal entries.
pub trait JournalWriter {
    fn append(&mut self, entry: &JournalEntry) -> Result<(), String>;
    /// Human-readable destination surfaced in the UI, when it has one.
    fn location(&self) -> Option<String>;
    /// Reads every entry back. Used by journal round-trip tests and by the
    /// journal inspection surface a later stage adds.
    #[cfg(test)]
    fn read_all(&self) -> Result<Vec<JournalEntry>, String>;
}

/// Appends JSONL entries to a file on disk.
pub struct FileJournal {
    path: PathBuf,
}

impl FileJournal {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl JournalWriter for FileJournal {
    fn append(&mut self, entry: &JournalEntry) -> Result<(), String> {
        let line = entry.to_line()?;

        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create journal directory: {}", e))?;
            }
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("Failed to open journal file: {}", e))?;
        let mut payload = line.into_bytes();
        payload.push(b'\n');
        file.write_all(&payload)
            .map_err(|e| format!("Failed to append journal entry: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to flush journal entry: {}", e))?;
        Ok(())
    }

    fn location(&self) -> Option<String> {
        Some(self.path.to_string_lossy().into_owned())
    }

    #[cfg(test)]
    fn read_all(&self) -> Result<Vec<JournalEntry>, String> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.path)
            .map_err(|e| format!("Failed to read journal file: {}", e))?;
        raw.lines()
            .filter(|line| !line.trim().is_empty())
            .map(JournalEntry::from_line)
            .collect()
    }
}

/// In-memory sink used by unit tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryJournal {
    entries: Vec<JournalEntry>,
    /// When set, `append` fails so journal-degradation paths are testable.
    fail_appends: bool,
}

#[cfg(test)]
impl MemoryJournal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn failing() -> Self {
        Self {
            entries: Vec::new(),
            fail_appends: true,
        }
    }

    pub fn entries(&self) -> &[JournalEntry] {
        &self.entries
    }
}

#[cfg(test)]
impl JournalWriter for MemoryJournal {
    fn append(&mut self, entry: &JournalEntry) -> Result<(), String> {
        if self.fail_appends {
            return Err("journal sink is unavailable".to_string());
        }
        self.entries.push(entry.clone());
        Ok(())
    }

    fn location(&self) -> Option<String> {
        None
    }

    #[cfg(test)]
    fn read_all(&self) -> Result<Vec<JournalEntry>, String> {
        Ok(self.entries.clone())
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bulk_edit::test_support::{cleanup_dir, unique_dir};
    use crate::bulk_edit::{OperationKind, OperationParams, PLAN_SCHEMA_VERSION};

    fn sample_plan(id: &str) -> super::super::BulkPlan {
        super::super::BulkPlan {
            schema_version: PLAN_SCHEMA_VERSION,
            id: id.to_string(),
            params: OperationParams {
                operation: OperationKind::FitsSetKeyword,
                locator: "OBJECT".to_string(),
                value: "M42".to_string(),
            },
            files: Vec::new(),
        }
    }

    fn sample_entry(outcome: JournalOutcome) -> JournalEntry {
        JournalEntry::now(
            &sample_plan("plan-1"),
            "/tmp/a.fits",
            "OBJECT".to_string(),
            1,
            "before".to_string(),
            Some("after".to_string()),
            outcome,
            None,
        )
    }

    #[test]
    fn journal_entry_round_trips_through_a_line() {
        let entry = sample_entry(JournalOutcome::Applied);
        let line = entry.to_line().expect("serialization should succeed");
        assert!(!line.contains('\n'), "a journal line must stay on one line");

        let parsed = JournalEntry::from_line(&line).expect("parse should succeed");
        assert_eq!(parsed, entry);
        assert_eq!(parsed.outcome, JournalOutcome::Applied);
        assert_eq!(parsed.before_fingerprint, "before");
        assert_eq!(parsed.after_fingerprint.as_deref(), Some("after"));
    }

    #[test]
    fn journal_entry_rejects_unknown_schema_version() {
        let mut entry = sample_entry(JournalOutcome::Failed);
        entry.schema_version = JOURNAL_SCHEMA_VERSION + 1;
        let line = serde_json::to_string(&entry).expect("serialize");

        let error = JournalEntry::from_line(&line).expect_err("version must be validated");
        assert!(error.contains("Unsupported journal schema version"), "unexpected: {}", error);
    }

    #[test]
    fn file_journal_appends_one_line_per_entry_and_reads_back() {
        let dir = unique_dir("journal");
        let path = dir.join("bulk-edit-journal.jsonl");
        let mut journal = FileJournal::new(path.clone());

        journal
            .append(&sample_entry(JournalOutcome::Applied))
            .expect("append should succeed");
        journal
            .append(&sample_entry(JournalOutcome::Failed))
            .expect("append should succeed");

        let raw = fs::read_to_string(&path).expect("journal file should exist");
        assert_eq!(raw.lines().count(), 2);

        let entries = journal.read_all().expect("read back should succeed");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].outcome, JournalOutcome::Applied);
        assert_eq!(entries[1].outcome, JournalOutcome::Failed);
        assert_eq!(
            journal.location().as_deref(),
            Some(path.to_string_lossy().into_owned().as_str())
        );

        cleanup_dir(&dir);
    }

    #[test]
    fn file_journal_creates_missing_directories() {
        let dir = unique_dir("journal-mkdir");
        let path = dir.join("nested").join("bulk-edit-journal.jsonl");
        let mut journal = FileJournal::new(path.clone());

        journal
            .append(&sample_entry(JournalOutcome::Applied))
            .expect("append should create directories");

        assert!(path.exists());
        cleanup_dir(&dir);
    }
}
