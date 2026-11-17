//! Plan replay: validation, safe writes, per-file outcomes, journaling.
//!
//! Apply never re-plans. It replays the exact reviewed plan: the plan id must
//! match its own content, every path must appear once, and every file's bytes
//! must still hash to the fingerprint recorded at planning time. Only then is a
//! file rewritten.

use super::*;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Outcome of one file in an apply run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyStatus {
    Applied,
    Skipped,
    Failed,
}

/// Per-file result. Never collapsed into a single batch status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkFileResult {
    pub file: String,
    pub status: ApplyStatus,
    pub reason: Option<String>,
    pub changes: usize,
    pub before_fingerprint: Option<String>,
    pub after_fingerprint: Option<String>,
    pub journaled: bool,
}

/// Batch result preserving partial success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkApplyResult {
    pub plan_id: String,
    pub results: Vec<BulkFileResult>,
    pub applied: usize,
    pub skipped: usize,
    pub failed: usize,
    pub journal_path: Option<String>,
    pub journal_degraded: bool,
}

/// Replace-file sink. Tests inject their own to simulate write failures.
pub trait BulkWriter {
    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), String>;
}

/// Same-directory temporary write plus replacement.
pub struct FsWriter;

impl BulkWriter for FsWriter {
    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| format!("File has no parent directory: {}", path.to_string_lossy()))?;
        let file_name = path
            .file_name()
            .ok_or_else(|| format!("File has no name: {}", path.to_string_lossy()))?
            .to_string_lossy()
            .into_owned();

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let temp_path = parent.join(format!(
            ".{}.bulk-edit-{}-{}.tmp",
            file_name,
            std::process::id(),
            nanos
        ));

        let original_permissions = fs::metadata(path).ok().map(|meta| meta.permissions());

        let write_temp = || -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)
                .map_err(|e| format!("Failed to create temporary file: {}", e))?;
            file.write_all(bytes)
                .map_err(|e| format!("Failed to write temporary file: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to flush temporary file: {}", e))?;
            Ok(())
        };

        if let Err(error) = write_temp() {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }

        if let Some(permissions) = original_permissions {
            let _ = fs::set_permissions(&temp_path, permissions);
        }

        #[cfg(unix)]
        {
            if let Err(error) = fs::rename(&temp_path, path) {
                let _ = fs::remove_file(&temp_path);
                return Err(format!("Failed to replace file atomically: {}", error));
            }
        }

        // Documented fallback: Windows cannot atomically replace an existing
        // destination with std::fs::rename, so the destination is removed
        // first. Apply verifies the written bytes and restores the original
        // from memory if anything fails, so this window is recoverable.
        #[cfg(not(unix))]
        {
            if path.exists() {
                if let Err(error) = fs::remove_file(path) {
                    let _ = fs::remove_file(&temp_path);
                    return Err(format!("Failed to remove previous file: {}", error));
                }
            }
            if let Err(error) = fs::rename(&temp_path, path) {
                let _ = fs::remove_file(&temp_path);
                return Err(format!("Failed to move temporary file into place: {}", error));
            }
        }

        Ok(())
    }
}

/// Validates the plan and replays it, mutating only reviewed changes.
///
/// `Err` means the whole plan was rejected before any mutation. Per-file
/// problems are returned in `results` and never abort the remaining files.
pub fn apply_plan(
    plan: &BulkPlan,
    registry: &OperationRegistry,
    writer: &dyn BulkWriter,
    journal: &mut dyn JournalWriter,
) -> Result<BulkApplyResult, String> {
    if plan.schema_version != PLAN_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported bulk edit plan version: {} (expected {}).",
            plan.schema_version, PLAN_SCHEMA_VERSION
        ));
    }

    let operation = registry.get(plan.params.operation).ok_or_else(|| {
        format!(
            "Bulk edit operation '{}' is not registered.",
            plan.params.operation.key()
        )
    })?;

    if plan.files.is_empty() {
        return Err("Bulk edit plan contains no files.".to_string());
    }
    if plan.files.len() > MAX_PLAN_FILES {
        return Err(format!(
            "Bulk edit is limited to {} files per plan.",
            MAX_PLAN_FILES
        ));
    }

    let mut seen = std::collections::HashSet::new();
    for planned in &plan.files {
        if !seen.insert(planned.file.as_str()) {
            return Err(format!(
                "Duplicate file path in bulk edit plan: {}",
                planned.file
            ));
        }
    }

    if plan.compute_id() != plan.id {
        return Err(
            "Bulk edit plan id does not match its content; the plan was modified after review."
                .to_string(),
        );
    }

    let mut results: Vec<BulkFileResult> = Vec::with_capacity(plan.files.len());
    let mut journal_degraded = false;

    for planned in &plan.files {
        match planned.status {
            PlanFileStatus::Changed => {
                let (mut result, entry) = apply_changed_file(plan, operation, planned, writer);
                if let Some(entry) = entry {
                    let journaled = journal.append(&entry).is_ok();
                    result.journaled = journaled;
                    if !journaled {
                        journal_degraded = true;
                    }
                }
                results.push(result);
            }
            PlanFileStatus::Noop => results.push(BulkFileResult {
                file: planned.file.clone(),
                status: ApplyStatus::Skipped,
                reason: Some(
                    planned
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Requested values already match the file.".to_string()),
                ),
                changes: 0,
                before_fingerprint: planned.fingerprint.clone(),
                after_fingerprint: None,
                journaled: false,
            }),
            PlanFileStatus::Unsupported | PlanFileStatus::Skipped => {
                let reason = planned
                    .reason
                    .clone()
                    .unwrap_or_else(|| "This file cannot be changed by the operation.".to_string());
                results.push(BulkFileResult {
                    file: planned.file.clone(),
                    status: ApplyStatus::Skipped,
                    reason: Some(reason),
                    changes: 0,
                    before_fingerprint: planned.fingerprint.clone(),
                    after_fingerprint: None,
                    journaled: false,
                });
            }
            PlanFileStatus::Error => results.push(BulkFileResult {
                file: planned.file.clone(),
                status: ApplyStatus::Failed,
                reason: Some(
                    planned
                        .reason
                        .clone()
                        .unwrap_or_else(|| "File could not be planned.".to_string()),
                ),
                changes: 0,
                before_fingerprint: planned.fingerprint.clone(),
                after_fingerprint: None,
                journaled: false,
            }),
        }
    }

    let applied = results
        .iter()
        .filter(|result| result.status == ApplyStatus::Applied)
        .count();
    let skipped = results
        .iter()
        .filter(|result| result.status == ApplyStatus::Skipped)
        .count();
    let failed = results
        .iter()
        .filter(|result| result.status == ApplyStatus::Failed)
        .count();

    Ok(BulkApplyResult {
        plan_id: plan.id.clone(),
        results,
        applied,
        skipped,
        failed,
        journal_path: journal.location(),
        journal_degraded,
    })
}

/// Revalidates one reviewed file and mutates it. Returns the per-file result
/// and, when a write was attempted, the journal entry for that attempt.
fn apply_changed_file(
    plan: &BulkPlan,
    operation: &dyn BulkOperationImpl,
    planned: &BulkPlannedFile,
    writer: &dyn BulkWriter,
) -> (BulkFileResult, Option<JournalEntry>) {
    let path = Path::new(&planned.file);
    let failed = |reason: String, before: Option<String>| {
        (
            BulkFileResult {
                file: planned.file.clone(),
                status: ApplyStatus::Failed,
                reason: Some(reason),
                changes: 0,
                before_fingerprint: before,
                after_fingerprint: None,
                journaled: false,
            },
            None,
        )
    };

    if planned.changes.is_empty() {
        return failed(
            "Plan marked this file as changed but recorded no changes.".to_string(),
            planned.fingerprint.clone(),
        );
    }

    let original = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return failed(
                format!("file_unavailable: {}", error),
                planned.fingerprint.clone(),
            );
        }
    };

    let before_fingerprint = content_fingerprint(&original);
    let planned_fingerprint = match &planned.fingerprint {
        Some(fingerprint) => fingerprint,
        None => {
            return failed(
                "Plan has no content fingerprint for this file.".to_string(),
                None,
            );
        }
    };
    if &before_fingerprint != planned_fingerprint {
        return failed(
            "stale_content: file content changed since the plan was reviewed.".to_string(),
            Some(before_fingerprint),
        );
    }

    let new_bytes = match operation.rewrite(path, &original, &planned.changes, &plan.params) {
        Ok(bytes) => bytes,
        Err(error) => {
            return failed(
                format!("rewrite_failed: {}", error),
                Some(before_fingerprint),
            );
        }
    };

    if new_bytes == original {
        return (
            BulkFileResult {
                file: planned.file.clone(),
                status: ApplyStatus::Skipped,
                reason: Some("noop: rewrite produced identical bytes.".to_string()),
                changes: 0,
                before_fingerprint: Some(before_fingerprint),
                after_fingerprint: None,
                journaled: false,
            },
            None,
        );
    }

    let after_fingerprint = content_fingerprint(&new_bytes);
    let locator = planned
        .changes
        .first()
        .map(|change| change.locator.clone())
        .unwrap_or_else(|| plan.params.locator.clone());

    let write_error = match writer.write_atomic(path, &new_bytes) {
        Ok(()) => match fs::read(path) {
            Ok(current) if current == new_bytes => None,
            Ok(_) => Some(
                "post_write_verification_failed: file content does not match the planned result."
                    .to_string(),
            ),
            Err(error) => Some(format!(
                "post_write_verification_failed: {}",
                error
            )),
        },
        Err(error) => Some(format!("write_failed: {}", error)),
    };

    if let Some(error) = write_error {
        let restored = writer.write_atomic(path, &original).is_ok()
            && fs::read(path)
                .map(|current| current == original)
                .unwrap_or(false);

        let error_note = if restored {
            "original bytes restored"
        } else {
            "restore failed: file may hold partial content"
        };

        let entry = JournalEntry::now(
            plan,
            &planned.file,
            locator,
            planned.changes.len(),
            before_fingerprint.clone(),
            None,
            JournalOutcome::Failed,
            Some(format!("{} ({})", error, error_note)),
        );

        let (result, _) = failed(error, Some(before_fingerprint));
        return (result, Some(entry));
    }

    let entry = JournalEntry::now(
        plan,
        &planned.file,
        locator,
        planned.changes.len(),
        before_fingerprint.clone(),
        Some(after_fingerprint.clone()),
        JournalOutcome::Applied,
        None,
    );

    (
        BulkFileResult {
            file: planned.file.clone(),
            status: ApplyStatus::Applied,
            reason: None,
            changes: planned.changes.len(),
            before_fingerprint: Some(before_fingerprint),
            after_fingerprint: Some(after_fingerprint),
            journaled: false,
        },
        Some(entry),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bulk_edit::test_support::{
        cleanup_dir, plan_for, registry_with, text_field_op, unique_dir, write_file, FailOnceWriter,
    };

    fn params(locator: &str, value: &str) -> OperationParams {
        OperationParams {
            operation: OperationKind::ExifSetTag,
            locator: locator.to_string(),
            value: value.to_string(),
        }
    }

    fn read(path: &str) -> String {
        fs::read_to_string(path).expect("file should be readable")
    }

    #[test]
    fn apply_writes_reviewed_plan_and_journals_each_attempt() {
        let dir = unique_dir("apply-ok");
        let first = write_file(&dir, "a.jpg", "Artist=Old\n");
        let second = write_file(&dir, "b.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(vec![first.clone(), second.clone()], params("Artist", "New"), &registry);

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal)
            .expect("apply should succeed");

        assert_eq!(result.applied, 2);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.plan_id, plan.id);
        assert!(!result.journal_degraded);
        assert_eq!(read(&first), "Artist=New\n");
        assert_eq!(read(&second), "Artist=New\n");

        let entries = journal.entries();
        assert_eq!(entries.len(), 2, "one entry per attempted mutation");
        assert_eq!(entries[0].plan_id, plan.id);
        assert_eq!(entries[0].file, first);
        assert_eq!(entries[0].outcome, JournalOutcome::Applied);
        assert_eq!(entries[0].operation, "exif_set_tag");
        assert_eq!(
            entries[0].before_fingerprint,
            content_fingerprint(b"Artist=Old\n")
        );
        assert_eq!(
            entries[0].after_fingerprint.as_deref(),
            Some(content_fingerprint(b"Artist=New\n").as_str())
        );
        assert_eq!(entries[0].change_count, 1);

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_preserves_partial_success_when_one_file_is_stale() {
        let dir = unique_dir("apply-partial");
        let first = write_file(&dir, "a.jpg", "Artist=Old\n");
        let stale = write_file(&dir, "b.jpg", "Artist=Old\n");
        let third = write_file(&dir, "c.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(
            vec![first.clone(), stale.clone(), third.clone()],
            params("Artist", "New"),
            &registry,
        );

        // The user (or another process) edits one file after review.
        fs::write(&stale, "Artist=Edited downstream\n").expect("stale write");

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal)
            .expect("apply should return per-file results");

        assert_eq!(result.applied, 2);
        assert_eq!(result.failed, 1);
        assert_eq!(result.skipped, 0);

        let stale_result = result
            .results
            .iter()
            .find(|entry| entry.file == stale)
            .expect("stale result should exist");
        assert_eq!(stale_result.status, ApplyStatus::Failed);
        assert!(stale_result
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("stale_content"));

        assert_eq!(read(&first), "Artist=New\n");
        assert_eq!(read(&third), "Artist=New\n");
        assert_eq!(read(&stale), "Artist=Edited downstream\n", "stale file must not be touched");
        assert_eq!(journal.entries().len(), 2, "only attempted mutations are journaled");

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_rejects_stale_content_before_mutation() {
        let dir = unique_dir("apply-stale");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(vec![file.clone()], params("Artist", "New"), &registry);

        fs::write(&file, "Artist=Changed\n").expect("stale write");

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal).expect("apply runs");

        assert_eq!(result.failed, 1);
        assert_eq!(result.applied, 0);
        assert!(result.results[0]
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("stale_content"));
        assert_eq!(read(&file), "Artist=Changed\n");
        assert!(journal.entries().is_empty());

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_rejects_plan_tampered_after_review() {
        let dir = unique_dir("apply-tamper");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let mut plan = plan_for(vec![file.clone()], params("Artist", "New"), &registry);
        plan.files[0].fingerprint = Some("0".repeat(64));

        let mut journal = MemoryJournal::new();
        let error = apply_plan(&plan, &registry, &FsWriter, &mut journal)
            .expect_err("tampered plan must be rejected");
        assert!(error.contains("does not match its content"), "unexpected: {}", error);
        assert_eq!(read(&file), "Artist=Old\n");
        assert!(journal.entries().is_empty());

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_rejects_duplicate_paths() {
        let dir = unique_dir("apply-duplicate");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let mut plan = plan_for(vec![file.clone()], params("Artist", "New"), &registry);
        let duplicated = plan.files[0].clone();
        plan.files.push(duplicated);
        plan.id = plan.compute_id();

        let mut journal = MemoryJournal::new();
        let error = apply_plan(&plan, &registry, &FsWriter, &mut journal)
            .expect_err("duplicate paths must be rejected");
        assert!(error.contains("Duplicate file path"), "unexpected: {}", error);
        assert_eq!(read(&file), "Artist=Old\n");

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_rejects_unsupported_plan_version() {
        let dir = unique_dir("apply-version");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let mut plan = plan_for(vec![file.clone()], params("Artist", "New"), &registry);
        plan.schema_version = PLAN_SCHEMA_VERSION + 1;

        let mut journal = MemoryJournal::new();
        let error = apply_plan(&plan, &registry, &FsWriter, &mut journal)
            .expect_err("unknown version must be rejected");
        assert!(error.contains("Unsupported bulk edit plan version"), "unexpected: {}", error);

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_rejects_unregistered_operation() {
        let dir = unique_dir("apply-unregistered");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(vec![file.clone()], params("Artist", "New"), &registry);

        let empty_registry = OperationRegistry::new(Vec::new());
        let mut journal = MemoryJournal::new();
        let error = apply_plan(&plan, &empty_registry, &FsWriter, &mut journal)
            .expect_err("unregistered operation must be rejected");
        assert!(error.contains("not registered"), "unexpected: {}", error);
        assert_eq!(read(&file), "Artist=Old\n");

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_skips_noop_and_unsupported_rows_without_journal_entries() {
        let dir = unique_dir("apply-skip");
        let already = write_file(&dir, "same.jpg", "Artist=Same\n");
        let deferred = write_file(&dir, "deferred-unsupported.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(
            vec![already.clone(), deferred.clone()],
            params("Artist", "Same"),
            &registry,
        );

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal).expect("apply runs");

        assert_eq!(result.applied, 0);
        assert_eq!(result.skipped, 2);
        assert_eq!(result.failed, 0);
        assert!(journal.entries().is_empty(), "no-ops must not journal");
        assert_eq!(read(&already), "Artist=Same\n");
        assert_eq!(read(&deferred), "Artist=Old\n");

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_restores_original_bytes_when_a_write_fails() {
        let dir = unique_dir("apply-restore");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(vec![file.clone()], params("Artist", "New"), &registry);

        let writer = FailOnceWriter::new(file.clone());
        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &writer, &mut journal).expect("apply runs");

        assert_eq!(result.failed, 1);
        assert_eq!(result.applied, 0);
        assert_eq!(
            read(&file),
            "Artist=Old\n",
            "failed write must restore the original bytes"
        );

        let entries = journal.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].outcome, JournalOutcome::Failed);
        let error = entries[0].error.clone().unwrap_or_default();
        assert!(error.contains("original bytes restored"), "unexpected: {}", error);

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_keeps_mutation_when_journaling_fails() {
        let dir = unique_dir("apply-journal-fail");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(vec![file.clone()], params("Artist", "New"), &registry);

        let mut journal = MemoryJournal::failing();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal).expect("apply runs");

        assert_eq!(result.applied, 1);
        assert!(result.journal_degraded);
        assert!(!result.results[0].journaled);
        assert_eq!(read(&file), "Artist=New\n", "journal failure must not roll back");

        cleanup_dir(&dir);
    }

    #[test]
    fn apply_reports_missing_files_as_failures() {
        let dir = unique_dir("apply-missing");
        let keep = write_file(&dir, "a.jpg", "Artist=Old\n");
        let gone = write_file(&dir, "b.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let plan = plan_for(vec![keep.clone(), gone.clone()], params("Artist", "New"), &registry);

        fs::remove_file(&gone).expect("remove planned file");

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal).expect("apply runs");

        assert_eq!(result.applied, 1);
        assert_eq!(result.failed, 1);
        let missing = result.results.iter().find(|entry| entry.file == gone).unwrap();
        assert!(missing.reason.as_deref().unwrap_or_default().contains("file_unavailable"));
        assert_eq!(read(&keep), "Artist=New\n");

        cleanup_dir(&dir);
    }

    #[test]
    fn default_registry_plans_unsupported_rows_and_mutates_nothing() {
        let dir = unique_dir("apply-default-registry");
        let jpeg = write_file(&dir, "photo.jpg", "not really a jpeg\n");
        let png = write_file(&dir, "card.png", "not really a png\n");
        let fits = write_file(&dir, "frame.fits", "not really fits\n");

        let registry = default_registry();
        let plan = plan_for(
            vec![jpeg.clone(), png.clone(), fits.clone()],
            OperationParams {
                operation: OperationKind::ExifSetTag,
                locator: "Artist".to_string(),
                value: "New".to_string(),
            },
            &registry,
        );

        // Stage 1: EXIF applies to the JPEG only; the other formats are explicit
        // unsupported rows in the same batch.
        assert_eq!(plan.files.len(), 3);
        assert!(plan.files.iter().all(|file| file.status == PlanFileStatus::Unsupported));
        assert!(plan.files.iter().all(|file| file.reason.is_some()));

        let mut journal = MemoryJournal::new();
        let result = apply_plan(&plan, &registry, &FsWriter, &mut journal)
            .expect("apply must accept a stage-1 plan");

        assert_eq!(result.applied, 0);
        assert_eq!(result.skipped, 3);
        assert_eq!(result.failed, 0);
        assert!(journal.entries().is_empty());
        assert_eq!(read(&jpeg), "not really a jpeg\n");
        assert_eq!(read(&png), "not really a png\n");
        assert_eq!(read(&fits), "not really fits\n");

        cleanup_dir(&dir);
    }

    #[test]
    fn fs_writer_replaces_contents_and_leaves_no_temp_files() {
        let dir = unique_dir("writer");
        let file = write_file(&dir, "a.bin", "old");

        FsWriter
            .write_atomic(Path::new(&file), b"new")
            .expect("writer should succeed");

        assert_eq!(read(&file), "new");
        let names: Vec<String> = fs::read_dir(&dir)
            .expect("dir readable")
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.bin".to_string()], "no temp files may remain");

        cleanup_dir(&dir);
    }
}
