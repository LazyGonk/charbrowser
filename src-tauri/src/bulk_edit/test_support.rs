//! Test-only helpers shared by the bulk-edit unit tests.

use super::apply::BulkWriter;
use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Creates a unique temporary directory for one test.
pub fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("charbrowser-bulk-{}-{}-{}", tag, nanos, seq));
    fs::create_dir_all(&dir).expect("test directory should be creatable");
    dir
}

/// Writes a file inside `dir` and returns its absolute path as a string.
pub fn write_file(dir: &Path, name: &str, contents: &str) -> String {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent directory should be creatable");
    }
    fs::write(&path, contents).expect("test file should be writable");
    path.to_string_lossy().into_owned()
}

/// Removes a test directory and its contents.
pub fn cleanup_dir(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

/// Writes binary fixture bytes inside `dir` and returns the absolute path.
pub fn write_binary(dir: &Path, name: &str, contents: &[u8]) -> String {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent directory should be creatable");
    }
    fs::write(&path, contents).expect("test fixture should be writable");
    path.to_string_lossy().into_owned()
}

/// Minimal format writer operating on `key=value` lines. It exists only so the
/// engine's planning, apply, and journal paths can be exercised without any of
/// the deferred production format writers.
pub struct TextFieldOperation {
    kind: OperationKind,
}

impl BulkOperationImpl for TextFieldOperation {
    fn kind(&self) -> OperationKind {
        self.kind
    }

    fn supports_format(&self, format: FileFormat) -> bool {
        format == self.kind.format()
    }

    fn plan_file(
        &self,
        path: &Path,
        bytes: &[u8],
        params: &OperationParams,
    ) -> Result<FilePlanOutcome, String> {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.contains("-unsupported") {
            return Ok(FilePlanOutcome::Unsupported(
                "simulated deferred writer".to_string(),
            ));
        }

        let text = String::from_utf8(bytes.to_vec())
            .map_err(|e| format!("test file is not UTF-8: {}", e))?;
        let old_value = read_value(&text, &params.locator);
        Ok(FilePlanOutcome::Changes(vec![RawChange {
            locator: params.locator.clone(),
            old_value,
            new_value: Some(params.value.clone()),
        }]))
    }

    fn rewrite(
        &self,
        _path: &Path,
        bytes: &[u8],
        changes: &[BulkChange],
        _params: &OperationParams,
    ) -> Result<Vec<u8>, String> {
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|e| format!("test file is not UTF-8: {}", e))?;
        let mut lines: Vec<String> = text.lines().map(str::to_string).collect();

        for change in changes {
            let new_value = change.new_value.clone().unwrap_or_default();
            let prefix = format!("{}=", change.locator);
            match lines.iter_mut().find(|line| line.starts_with(&prefix)) {
                Some(line) => *line = format!("{}{}", prefix, new_value),
                None => lines.push(format!("{}{}", prefix, new_value)),
            }
        }

        Ok(format!("{}\n", lines.join("\n")).into_bytes())
    }
}

fn read_value(text: &str, locator: &str) -> Option<String> {
    let prefix = format!("{}=", locator);
    text.lines()
        .find(|line| line.starts_with(&prefix))
        .map(|line| line[prefix.len()..].to_string())
}

/// Builds a registry that only contains the text-field test operation.
pub fn registry_with(operation: Box<dyn BulkOperationImpl>) -> OperationRegistry {
    OperationRegistry::new(vec![operation])
}

/// Builds the standard text-field test operation for `kind`.
pub fn text_field_op(kind: OperationKind) -> Box<dyn BulkOperationImpl> {
    Box::new(TextFieldOperation { kind })
}

/// Plans a request through the normal entry point.
pub fn plan_for(
    paths: Vec<String>,
    params: OperationParams,
    registry: &OperationRegistry,
) -> BulkPlan {
    plan_request(&BulkPlanRequest { paths, params }, registry).expect("test plan should succeed")
}

/// Writer that corrupts a target file once and then reports failure, modelling
/// a partially written file. Later writes delegate to the real atomic writer.
pub struct FailOnceWriter {
    target: String,
    failed: std::cell::Cell<bool>,
}

impl FailOnceWriter {
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            failed: std::cell::Cell::new(false),
        }
    }
}

impl BulkWriter for FailOnceWriter {
    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        if path.to_string_lossy() == self.target && !self.failed.get() {
            self.failed.set(true);
            fs::write(path, b"corrupted-partial-write")
                .map_err(|e| format!("failed to corrupt target: {}", e))?;
            return Err("simulated write failure".to_string());
        }
        FsWriter.write_atomic(path, bytes)
    }
}
