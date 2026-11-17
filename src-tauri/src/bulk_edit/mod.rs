//! Reusable bulk-edit plan/apply/journal engine.
//!
//! The engine is deliberately format agnostic: it owns validation, fingerprints,
//! deterministic planning, safe writes, partial-failure accounting and the audit
//! journal, while a [`BulkOperationImpl`] supplies the format-specific rewrite.
//! Stage 1 (PRIV-29) shipped the engine; stage 2 (PRIV-30) turned `exif_strip`
//! into a ready writer; stage 3 (PRIV-31) added `json_set_path` on top of the
//! PNG/JSON character-card helpers; stage 4 (PRIV-32) added
//! `fits_set_keyword` on top of the pure FITS card transform. There is no
//! dedicated author operation: `/data/creator` is an ordinary `json_set_path`
//! locator.
//!
//! See `plans/bulk-edit.md` for the cross-stage design.

pub mod apply;
pub mod journal;
pub mod plan;

#[cfg(test)]
pub mod test_support;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub use apply::{apply_plan, BulkApplyResult, FsWriter};
#[cfg(test)]
pub use journal::MemoryJournal;
pub use journal::{FileJournal, JournalEntry, JournalOutcome, JournalWriter};
pub use plan::{capabilities, plan_request, BulkCapabilityResponse};

/// Version of the serializable plan contract. Bumped whenever plan shape or
/// apply semantics change incompatibly; apply rejects any other version.
pub const PLAN_SCHEMA_VERSION: u32 = 1;

/// Maximum number of files accepted in one plan. Keeps a single batch bounded
/// so the UI progress surface and journal stay readable.
pub const MAX_PLAN_FILES: usize = 500;

/// Stable operation identifiers shared with the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    /// Lossless EXIF removal from JPEG/PNG/WebP containers (stage 2).
    ExifStrip,
    /// EXIF tag write on JPEG/TIFF/WebP (deferred past stage 2).
    ExifSetTag,
    /// JSON Pointer string set on a PNG or standalone JSON character card
    /// (stage 3).
    JsonSetPath,
    /// FITS header keyword write (stage 4).
    FitsSetKeyword,
}

impl OperationKind {
    pub fn key(self) -> &'static str {
        match self {
            OperationKind::ExifStrip => "exif_strip",
            OperationKind::ExifSetTag => "exif_set_tag",
            OperationKind::JsonSetPath => "json_set_path",
            OperationKind::FitsSetKeyword => "fits_set_keyword",
        }
    }

    /// Format group this operation writes into.
    ///
    /// `ExifStrip` spans the JPEG/WebP group and the PNG group; its writer
    /// narrows support per file through [`BulkOperationImpl::supports_file`].
    pub fn format(self) -> FileFormat {
        match self {
            OperationKind::ExifStrip | OperationKind::ExifSetTag => FileFormat::Exif,
            OperationKind::JsonSetPath => FileFormat::CardJson,
            OperationKind::FitsSetKeyword => FileFormat::Fits,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OperationKind::ExifStrip => "Strip EXIF metadata",
            OperationKind::ExifSetTag => "EXIF tag",
            OperationKind::JsonSetPath => "Character-card JSON field",
            OperationKind::FitsSetKeyword => "FITS header keyword",
        }
    }

    /// Stage of PRIV-18 that implements the mutation.
    pub fn stage(self) -> u8 {
        match self {
            OperationKind::ExifStrip => 2,
            OperationKind::ExifSetTag => 2,
            OperationKind::JsonSetPath => 3,
            OperationKind::FitsSetKeyword => 4,
        }
    }

    /// Whether the request needs the user to name a target field.
    pub fn requires_locator(self) -> bool {
        self != OperationKind::ExifStrip
    }

    /// Whether the request needs the user to supply a new value.
    pub fn requires_value(self) -> bool {
        !matches!(self, OperationKind::ExifStrip)
    }
}

/// Container family a file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileFormat {
    Exif,
    CardJson,
    Fits,
    Unknown,
}

impl FileFormat {
    pub fn id(self) -> &'static str {
        match self {
            FileFormat::Exif => "exif",
            FileFormat::CardJson => "card_json",
            FileFormat::Fits => "fits",
            FileFormat::Unknown => "unknown",
        }
    }
}

/// Maps a file extension onto the format group whose writer owns it.
pub fn detect_format(path: &Path) -> FileFormat {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "jpg" | "jpeg" | "tif" | "tiff" | "webp" => FileFormat::Exif,
        "png" | "mp3" | "flac" | "mp4" | "mov" => FileFormat::CardJson,
        "json" => FileFormat::CardJson,
        "fits" | "fit" => FileFormat::Fits,
        _ => FileFormat::Unknown,
    }
}

/// Parameters of one bulk-edit batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationParams {
    pub operation: OperationKind,
    /// Operation-specific target: EXIF tag name, JSON path, or FITS keyword.
    pub locator: String,
    /// Requested new value, expressed as text.
    pub value: String,
}

/// Frontend-to-backend planning request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkPlanRequest {
    pub paths: Vec<String>,
    pub params: OperationParams,
}

/// One reviewed change: file + locator + old value + new value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkChange {
    pub file: String,
    pub locator: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
}

/// Per-file planning status. Errors and unsupported rows are explicit so a
/// mixed batch stays reviewable instead of becoming one opaque failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanFileStatus {
    Changed,
    Noop,
    Skipped,
    Unsupported,
    Error,
}

/// Per-file entry of a plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkPlannedFile {
    pub file: String,
    pub format: String,
    pub status: PlanFileStatus,
    /// SHA-256 of the exact bytes read while planning. `None` when unreadable.
    pub fingerprint: Option<String>,
    pub changes: Vec<BulkChange>,
    pub reason: Option<String>,
}

/// Serializable, deterministic plan. `id` is derived from the whole body
/// (excluding itself), so any edit invalidates it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkPlan {
    pub schema_version: u32,
    pub id: String,
    pub params: OperationParams,
    pub files: Vec<BulkPlannedFile>,
}

impl BulkPlan {
    /// Recomputes the plan id from the plan body.
    pub fn compute_id(&self) -> String {
        #[derive(Serialize)]
        struct PlanBody<'a> {
            schema_version: u32,
            params: &'a OperationParams,
            files: &'a [BulkPlannedFile],
        }

        let body = PlanBody {
            schema_version: self.schema_version,
            params: &self.params,
            files: &self.files,
        };
        let json = serde_json::to_vec(&body).unwrap_or_default();
        content_fingerprint(&json)
    }
}

/// SHA-256 hex digest used for content fingerprints and plan ids.
pub fn content_fingerprint(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

/// Result of one format-specific planning pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilePlanOutcome {
    /// Produced by each stage's writer when at least one card, tag, or payload
    /// would change (or already matches the request).
    Changes(Vec<RawChange>),
    Unsupported(String),
}

/// Format-level change before the engine stamps the file path on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawChange {
    pub locator: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
}

/// Format-specific implementation plugged into the engine.
pub trait BulkOperationImpl: Send + Sync {
    fn kind(&self) -> OperationKind;
    /// True when this operation owns the given format group.
    ///
    /// This is the coarse gate; an operation that spans groups narrows it per
    /// file through [`Self::supports_file`].
    fn supports_format(&self, format: FileFormat) -> bool;
    /// Authoritative per-file support check. Defaults to the format group.
    fn supports_file(&self, path: &Path) -> bool {
        self.supports_format(detect_format(path))
    }
    /// Whether this writer is implemented and may mutate files.
    fn ready(&self) -> bool {
        true
    }
    /// Reads values from `bytes` and returns the changes it would make.
    /// Must be side-effect free.
    fn plan_file(
        &self,
        path: &Path,
        bytes: &[u8],
        params: &OperationParams,
    ) -> Result<FilePlanOutcome, String>;
    /// Produces the rewritten bytes for a reviewed change set. Must not touch disk.
    fn rewrite(
        &self,
        path: &Path,
        bytes: &[u8],
        changes: &[BulkChange],
        params: &OperationParams,
    ) -> Result<Vec<u8>, String>;
}

/// Registry of the operations a plan/apply run may use.
pub struct OperationRegistry {
    ops: Vec<Box<dyn BulkOperationImpl>>,
}

impl OperationRegistry {
    pub fn new(ops: Vec<Box<dyn BulkOperationImpl>>) -> Self {
        Self { ops }
    }

    pub fn get(&self, kind: OperationKind) -> Option<&dyn BulkOperationImpl> {
        self.ops
            .iter()
            .find(|op| op.kind() == kind)
            .map(|op| op.as_ref())
    }
}

/// Registry used by the shipped commands.
///
/// `exif_strip` (stage 2), `json_set_path` (stage 3), and
/// `fits_set_keyword` (stage 4) are implemented. `exif_set_tag` is deferred
/// to stage 2b, so planning reports explicit unsupported rows for it and apply
/// mutates nothing. Tests build their own registries with an in-memory operation.
pub fn default_registry() -> OperationRegistry {
    OperationRegistry::new(vec![
        Box::new(ExifStripOperation),
        Box::new(DeferredOperation::new(OperationKind::ExifSetTag)),
        Box::new(CardJsonOperation),
        Box::new(FitsSetKeywordOperation),
    ])
}

/// Lossless EXIF removal for JPEG, PNG, and WebP.
///
/// The container rewrite lives in [`crate::metadata::exif`]; this type adapts it
/// to the bulk-edit engine so planning and apply share one transformation.
struct ExifStripOperation;

impl BulkOperationImpl for ExifStripOperation {
    fn kind(&self) -> OperationKind {
        OperationKind::ExifStrip
    }

    fn supports_format(&self, format: FileFormat) -> bool {
        matches!(format, FileFormat::Exif | FileFormat::CardJson)
    }

    fn supports_file(&self, path: &Path) -> bool {
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase();
        matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp")
    }

    fn plan_file(
        &self,
        _path: &Path,
        bytes: &[u8],
        _params: &OperationParams,
    ) -> Result<FilePlanOutcome, String> {
        let outcome = crate::metadata::exif::strip_exif(bytes)?;
        let changes = outcome
            .entries
            .into_iter()
            .map(|entry| RawChange {
                locator: entry.locator,
                old_value: Some(entry.summary),
                new_value: None,
            })
            .collect();
        Ok(FilePlanOutcome::Changes(changes))
    }

    fn rewrite(
        &self,
        _path: &Path,
        bytes: &[u8],
        _changes: &[BulkChange],
        _params: &OperationParams,
    ) -> Result<Vec<u8>, String> {
        crate::metadata::exif::strip_exif(bytes)?
            .stripped
            .ok_or_else(|| "No EXIF metadata found; nothing to strip.".to_string())
    }
}

/// Character-card JSON writes on PNG files and standalone `.json` cards.
///
/// `json_set_path` takes the user-supplied JSON Pointer from the request, so
/// `/data/creator` edits the author exactly like any other discovered field.
/// Writes a JSON string into v2/v3 cards, keep each payload's original
/// encoding, and reuse `metadata::embedded` for chunk discovery and re-encoding.
struct CardJsonOperation;

impl CardJsonOperation {
    fn edit(
        &self,
        path: &Path,
        bytes: &[u8],
        params: &OperationParams,
    ) -> Result<crate::metadata::embedded::CardJsonEdit, crate::metadata::embedded::CardJsonEditError>
    {
        let pointer = params.locator.trim();
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase();

        if ext == "png" {
            crate::metadata::embedded::set_png_card_json_pointer(bytes, pointer, &params.value)
        } else {
            crate::metadata::embedded::set_json_card_json_pointer(bytes, pointer, &params.value)
        }
    }
}

/// Change locator shown in review: `<payload>:<pointer>` for PNG payloads,
/// the bare pointer for a standalone JSON file.
fn card_change_locator(payload: &str, pointer: &str) -> String {
    if payload == "json" {
        pointer.to_string()
    } else {
        format!("{}:{}", payload, pointer)
    }
}

impl BulkOperationImpl for CardJsonOperation {
    fn kind(&self) -> OperationKind {
        OperationKind::JsonSetPath
    }

    fn supports_format(&self, format: FileFormat) -> bool {
        format == FileFormat::CardJson
    }

    fn supports_file(&self, path: &Path) -> bool {
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase();
        matches!(ext.as_str(), "png" | "json")
    }

    fn plan_file(
        &self,
        path: &Path,
        bytes: &[u8],
        params: &OperationParams,
    ) -> Result<FilePlanOutcome, String> {
        let pointer = params.locator.trim();
        match self.edit(path, bytes, params) {
            Ok(edit) => {
                let changes = edit
                    .changes
                    .into_iter()
                    .map(|change| RawChange {
                        locator: card_change_locator(&change.payload, pointer),
                        old_value: change.old_value,
                        new_value: Some(params.value.clone()),
                    })
                    .collect();
                Ok(FilePlanOutcome::Changes(changes))
            }
            Err(crate::metadata::embedded::CardJsonEditError::Unsupported(reason)) => {
                Ok(FilePlanOutcome::Unsupported(reason))
            }
            Err(error) => Err(error.message().to_string()),
        }
    }

    fn rewrite(
        &self,
        path: &Path,
        bytes: &[u8],
        _changes: &[BulkChange],
        params: &OperationParams,
    ) -> Result<Vec<u8>, String> {
        self.edit(path, bytes, params)
            .map(|edit| edit.bytes)
            .map_err(|error| error.message().to_string())
    }
}

/// FITS header keyword writes on `.fits`/`.fit` files.
///
/// The pure transformation lives in
/// [`crate::metadata::fits::update_fits_keyword_cards`]; this adapter maps its
/// distinct outcomes (updated, unchanged, missing, structural, malformed) onto
/// the engine's plan statuses. Only existing cards in the primary HDU are
/// touched, so data blocks and extension HDUs keep their offsets and bytes.
struct FitsSetKeywordOperation;

/// Review locator: `<KEYWORD>@<byte offset of the card in the primary HDU>`.
fn fits_change_locator(keyword: &str, offset: usize) -> String {
    format!("{}@{}", keyword, offset)
}

fn fits_keyword(params: &OperationParams) -> Result<&str, String> {
    let keyword = params.locator.trim();
    if keyword.is_empty() {
        return Err("A FITS keyword is required to plan a header update.".to_string());
    }
    Ok(keyword)
}

impl BulkOperationImpl for FitsSetKeywordOperation {
    fn kind(&self) -> OperationKind {
        OperationKind::FitsSetKeyword
    }

    fn supports_format(&self, format: FileFormat) -> bool {
        format == FileFormat::Fits
    }

    fn supports_file(&self, path: &Path) -> bool {
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_lowercase();
        matches!(ext.as_str(), "fits" | "fit")
    }

    fn plan_file(
        &self,
        _path: &Path,
        bytes: &[u8],
        params: &OperationParams,
    ) -> Result<FilePlanOutcome, String> {
        let keyword = fits_keyword(params)?;
        let report = crate::metadata::fits::update_fits_keyword_cards(
            bytes,
            &[crate::metadata::fits::FitsKeywordUpdate {
                keyword: keyword.to_string(),
                value: params.value.clone(),
            }],
        )?;

        let mut changes = Vec::new();
        for outcome in report.outcomes {
            match outcome {
                crate::metadata::fits::FitsKeywordOutcome::Updated {
                    keyword,
                    offset,
                    old_value,
                    new_value,
                } => changes.push(RawChange {
                    locator: fits_change_locator(&keyword, offset),
                    old_value: Some(old_value),
                    new_value: Some(new_value),
                }),
                crate::metadata::fits::FitsKeywordOutcome::Unchanged {
                    keyword,
                    offset,
                    value,
                } => changes.push(RawChange {
                    locator: fits_change_locator(&keyword, offset),
                    old_value: Some(value.clone()),
                    new_value: Some(value),
                }),
                crate::metadata::fits::FitsKeywordOutcome::ReadOnly { keyword } => {
                    return Err(format!(
                        "{} is a structural FITS keyword and is read-only.",
                        keyword
                    ));
                }
                crate::metadata::fits::FitsKeywordOutcome::Missing { keyword } => {
                    return Err(format!(
                        "FITS keyword {} was not found in the primary header; this operation updates existing cards only.",
                        keyword
                    ));
                }
                crate::metadata::fits::FitsKeywordOutcome::Malformed { reason, .. } => {
                    return Err(reason);
                }
            }
        }

        Ok(FilePlanOutcome::Changes(changes))
    }

    fn rewrite(
        &self,
        _path: &Path,
        bytes: &[u8],
        _changes: &[BulkChange],
        params: &OperationParams,
    ) -> Result<Vec<u8>, String> {
        let keyword = fits_keyword(params)?;
        let report = crate::metadata::fits::update_fits_keyword_cards(
            bytes,
            &[crate::metadata::fits::FitsKeywordUpdate {
                keyword: keyword.to_string(),
                value: params.value.clone(),
            }],
        )?;

        if report.applied == 0 {
            return Err(format!(
                "FITS keyword {} already carries the requested value.",
                keyword.trim().to_uppercase()
            ));
        }

        Ok(report.bytes)
    }
}

/// Placeholder writer for operations whose stage has not landed yet.
struct DeferredOperation {
    kind: OperationKind,
}

impl DeferredOperation {
    fn new(kind: OperationKind) -> Self {
        Self { kind }
    }

    fn deferred_reason(&self) -> String {
        format!(
            "{} writes are not implemented yet: this capability lands in stage {} of the bulk-edit plan.",
            self.kind.label(),
            self.kind.stage()
        )
    }
}

impl BulkOperationImpl for DeferredOperation {
    fn kind(&self) -> OperationKind {
        self.kind
    }

    fn supports_format(&self, format: FileFormat) -> bool {
        format == self.kind.format()
    }

    fn ready(&self) -> bool {
        false
    }

    fn plan_file(
        &self,
        _path: &Path,
        _bytes: &[u8],
        _params: &OperationParams,
    ) -> Result<FilePlanOutcome, String> {
        Ok(FilePlanOutcome::Unsupported(self.deferred_reason()))
    }

    fn rewrite(
        &self,
        _path: &Path,
        _bytes: &[u8],
        _changes: &[BulkChange],
        _params: &OperationParams,
    ) -> Result<Vec<u8>, String> {
        Err(self.deferred_reason())
    }
}
