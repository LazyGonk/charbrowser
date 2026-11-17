//! Side-effect-free planning and the capability matrix.
//!
//! Planning only reads bytes and runs the format-specific pure transformation.
//! It never writes, touches mtimes, or creates temporary files, and the same
//! request over the same content always produces the same plan id.

use super::*;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// One operation exposed to the UI, with its stage and readiness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkOperationCapability {
    pub operation: String,
    pub label: String,
    pub stage: u8,
    pub ready: bool,
    pub reason: Option<String>,
    /// The modal only enables the locator input when this is true.
    pub requires_locator: bool,
    /// The modal only enables the value input when this is true.
    pub requires_value: bool,
}

/// One field that already exists in a selected file.
///
/// `operation` names the writer whose locator input accepts `locator`, so the
/// modal can offer the discovered path or keyword directly. Values are the
/// on-disk text form: FITS tokens keep their quotes, and JSON scalars use
/// `card_value_text` (strings verbatim, everything else compact JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkExistingField {
    pub operation: String,
    pub locator: String,
    pub value: String,
}

/// One file row of the capability matrix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkCapabilityRow {
    pub file: String,
    pub file_name: String,
    pub format: String,
    /// `supported` | `unsupported` | `noop` | `error`.
    pub status: String,
    pub reason: Option<String>,
    /// Operations whose format group owns this file type.
    pub operations: Vec<String>,
    /// Existing keywords/pointers with their current values. Empty when the
    /// file has none or discovery could not read it; `reason` then says why.
    pub existing_fields: Vec<BulkExistingField>,
}

/// Response of the capability command: matrix columns plus per-file rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkCapabilityResponse {
    pub plan_schema_version: u32,
    pub operations: Vec<BulkOperationCapability>,
    pub files: Vec<BulkCapabilityRow>,
}

/// Builds a plan from a request without mutating anything.
pub fn plan_request(
    request: &BulkPlanRequest,
    registry: &OperationRegistry,
) -> Result<BulkPlan, String> {
    if request.paths.is_empty() {
        return Err("Bulk edit planning requires at least one file path.".to_string());
    }
    if request.paths.len() > MAX_PLAN_FILES {
        return Err(format!(
            "Bulk edit is limited to {} files per plan.",
            MAX_PLAN_FILES
        ));
    }

    let operation = registry.get(request.params.operation).ok_or_else(|| {
        format!(
            "Bulk edit operation '{}' is not registered.",
            request.params.operation.key()
        )
    })?;

    let mut paths = request.paths.clone();
    paths.sort();
    for pair in paths.windows(2) {
        if pair[0] == pair[1] {
            return Err(format!(
                "Duplicate file path in bulk edit request: {}",
                pair[0]
            ));
        }
    }

    let files = paths
        .iter()
        .map(|file| plan_file_entry(file, &request.params, operation))
        .collect();

    let mut plan = BulkPlan {
        schema_version: PLAN_SCHEMA_VERSION,
        id: String::new(),
        params: request.params.clone(),
        files,
    };
    plan.id = plan.compute_id();
    Ok(plan)
}

fn plan_file_entry(
    file: &str,
    params: &OperationParams,
    operation: &dyn BulkOperationImpl,
) -> BulkPlannedFile {
    let path = Path::new(file);
    let format = detect_format(path);

    if format == FileFormat::Unknown {
        return BulkPlannedFile {
            file: file.to_string(),
            format: format.id().to_string(),
            status: PlanFileStatus::Error,
            fingerprint: None,
            changes: Vec::new(),
            reason: Some(format!(
                "Bulk metadata editing is not supported for this file type: {}",
                file
            )),
        };
    }

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return BulkPlannedFile {
                file: file.to_string(),
                format: format.id().to_string(),
                status: PlanFileStatus::Error,
                fingerprint: None,
                changes: Vec::new(),
                reason: Some(format!("Failed to read file before planning: {}", error)),
            };
        }
    };

    let fingerprint = Some(content_fingerprint(&bytes));
    let base = |status: PlanFileStatus, changes: Vec<BulkChange>, reason: Option<String>| {
        BulkPlannedFile {
            file: file.to_string(),
            format: format.id().to_string(),
            status,
            fingerprint: fingerprint.clone(),
            changes,
            reason,
        }
    };

    if !operation.supports_format(format) || !operation.supports_file(path) {
        return base(
            PlanFileStatus::Unsupported,
            Vec::new(),
            Some(format!(
                "{} does not apply to this file type: {}",
                params.operation.label(),
                file
            )),
        );
    }

    match operation.plan_file(path, &bytes, params) {
        Ok(FilePlanOutcome::Changes(raw_changes)) => {
            let changes: Vec<BulkChange> = raw_changes
                .into_iter()
                .map(|change| BulkChange {
                    file: file.to_string(),
                    locator: change.locator,
                    old_value: change.old_value,
                    new_value: change.new_value,
                })
                .collect();

            let unchanged = changes
                .iter()
                .all(|change| change.old_value == change.new_value);
            if changes.is_empty() || unchanged {
                return base(
                    PlanFileStatus::Noop,
                    changes,
                    Some("Requested values already match the file.".to_string()),
                );
            }
            base(PlanFileStatus::Changed, changes, None)
        }
        Ok(FilePlanOutcome::Unsupported(reason)) => {
            base(PlanFileStatus::Unsupported, Vec::new(), Some(reason))
        }
        Err(reason) => base(PlanFileStatus::Error, Vec::new(), Some(reason)),
    }
}

/// Computes the capability matrix for a set of selected files.
///
/// `ready` and per-file applicability come from the registered writers, so the
/// matrix cannot drift from the operations apply will actually run.
pub fn capabilities(
    paths: &[String],
    registry: &OperationRegistry,
) -> Result<BulkCapabilityResponse, String> {
    if paths.is_empty() {
        return Err("Bulk edit capabilities require at least one file path.".to_string());
    }

    let mut sorted = paths.to_vec();
    sorted.sort();
    sorted.dedup();

    let operations = all_operations()
        .into_iter()
        .map(|kind| {
            let ready = registry.get(kind).map(|op| op.ready()).unwrap_or(false);
            BulkOperationCapability {
                operation: kind.key().to_string(),
                label: kind.label().to_string(),
                stage: kind.stage(),
                ready,
                reason: if ready {
                    None
                } else {
                    Some(format!(
                        "Not implemented yet: lands in stage {} of the bulk-edit plan.",
                        kind.stage()
                    ))
                },
                requires_locator: kind.requires_locator(),
                requires_value: kind.requires_value(),
            }
        })
        .collect::<Vec<_>>();

    let files = sorted
        .iter()
        .map(|file| capability_row(file, &operations, registry))
        .collect();

    Ok(BulkCapabilityResponse {
        plan_schema_version: PLAN_SCHEMA_VERSION,
        operations,
        files,
    })
}

fn capability_row(
    file: &str,
    capabilities: &[BulkOperationCapability],
    registry: &OperationRegistry,
) -> BulkCapabilityRow {
    let path = Path::new(file);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| file.to_string());
    let format = detect_format(path);

    if format == FileFormat::Unknown {
        return BulkCapabilityRow {
            file: file.to_string(),
            file_name,
            format: format.id().to_string(),
            status: "error".to_string(),
            reason: Some(format!(
                "Bulk metadata editing is not supported for this file type: {}",
                file
            )),
            operations: Vec::new(),
            existing_fields: Vec::new(),
        };
    }

    if !path.is_file() {
        return BulkCapabilityRow {
            file: file.to_string(),
            file_name,
            format: format.id().to_string(),
            status: "error".to_string(),
            reason: Some("File does not exist or is not a regular file.".to_string()),
            operations: Vec::new(),
            existing_fields: Vec::new(),
        };
    }

    // Discovery is read-only. A failure only clears this row's field list and
    // reports the reason; the remaining selection is still discovered.
    let (existing_fields, discovery_error) = match discover_existing_fields(path, format) {
        Ok(fields) => (fields, None),
        Err(reason) => (Vec::new(), Some(reason)),
    };

    let applicable: Vec<String> = all_operations()
        .into_iter()
        .filter(|kind| {
            registry
                .get(*kind)
                .map(|op| op.supports_file(path))
                .unwrap_or(false)
        })
        .map(|kind| kind.key().to_string())
        .collect();

    let ready = applicable.iter().any(|key| {
        capabilities
            .iter()
            .any(|capability| capability.ready && &capability.operation == key)
    });

    BulkCapabilityRow {
        file: file.to_string(),
        file_name,
        format: format.id().to_string(),
        status: if ready { "supported" } else { "unsupported" }.to_string(),
        reason: discovery_error.or_else(|| {
            if ready {
                None
            } else {
                Some(format!(
                    "No bulk write is implemented for {} files yet.",
                    format.id()
                ))
            }
        }),
        operations: applicable,
        existing_fields,
    }
}

/// Discovers the fields a supported writer can target in one file.
///
/// Only extensions with a format-aware reader are opened: FITS headers and
/// PNG/standalone-JSON character cards. Other card-group extensions (audio and
/// video) have no discovery contract, so they return an empty list rather than
/// a reason. Reads only; never writes, creates temp files, or touches mtimes.
fn discover_existing_fields(
    path: &Path,
    format: FileFormat,
) -> Result<Vec<BulkExistingField>, String> {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    let reader: fn(&[u8]) -> Result<Vec<(String, String)>, String> = match format {
        FileFormat::Fits => crate::metadata::fits::read_fits_keyword_cards,
        FileFormat::CardJson => match ext.as_str() {
            "png" => crate::metadata::embedded::read_png_card_json_pointers,
            "json" => crate::metadata::embedded::read_json_card_json_pointers,
            _ => return Ok(Vec::new()),
        },
        FileFormat::Exif | FileFormat::Unknown => return Ok(Vec::new()),
    };

    let bytes = fs::read(path)
        .map_err(|error| format!("Failed to read file for existing-value discovery: {}", error))?;
    let fields = reader(&bytes)?;

    let operation = match format {
        FileFormat::Fits => OperationKind::FitsSetKeyword,
        _ => OperationKind::JsonSetPath,
    };
    Ok(fields
        .into_iter()
        .map(|(locator, value)| BulkExistingField {
            operation: operation.key().to_string(),
            locator,
            value,
        })
        .collect())
}

fn all_operations() -> [OperationKind; 4] {
    [
        OperationKind::ExifStrip,
        OperationKind::ExifSetTag,
        OperationKind::JsonSetPath,
        OperationKind::FitsSetKeyword,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bulk_edit::test_support::{
        cleanup_dir, registry_with, text_field_op, unique_dir, write_file,
    };

    fn params(locator: &str, value: &str) -> OperationParams {
        OperationParams {
            operation: OperationKind::ExifSetTag,
            locator: locator.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn plan_is_side_effect_free_and_deterministic() {
        let dir = unique_dir("plan-pure");
        let first = write_file(&dir, "a.jpg", "Artist=Original\n");
        let second = write_file(&dir, "b.jpg", "Artist=Original\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let request = BulkPlanRequest {
            paths: vec![second.clone(), first.clone()],
            params: params("Artist", "New"),
        };

        let plan_a = plan_request(&request, &registry).expect("plan should succeed");
        let before = fs::read(&first).expect("file readable");
        let plan_b = plan_request(&request, &registry).expect("plan should succeed again");

        assert_eq!(plan_a, plan_b, "identical requests must produce identical plans");
        assert_eq!(plan_a.id, plan_b.id);
        assert_eq!(fs::read(&first).expect("file readable"), before);
        assert_eq!(
            fs::read_dir(&dir).expect("dir readable").count(),
            2,
            "planning must not create files"
        );

        cleanup_dir(&dir);
    }

    #[test]
    fn plan_orders_paths_deterministically() {
        let dir = unique_dir("plan-order");
        let b = write_file(&dir, "b.jpg", "Artist=Old\n");
        let a = write_file(&dir, "a.jpg", "Artist=Old\n");
        let c = write_file(&dir, "c.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let request = BulkPlanRequest {
            paths: vec![c.clone(), a.clone(), b.clone()],
            params: params("Artist", "New"),
        };

        let plan = plan_request(&request, &registry).expect("plan should succeed");
        let ordered: Vec<&str> = plan.files.iter().map(|file| file.file.as_str()).collect();
        assert_eq!(ordered, vec![a.as_str(), b.as_str(), c.as_str()]);
        assert!(plan.files.iter().all(|file| file.status == PlanFileStatus::Changed));
        assert!(plan.files[0].fingerprint.is_some());
        assert_eq!(plan.files[0].changes.len(), 1);
        assert_eq!(plan.files[0].changes[0].old_value.as_deref(), Some("Old"));
        assert_eq!(plan.files[0].changes[0].new_value.as_deref(), Some("New"));

        cleanup_dir(&dir);
    }

    #[test]
    fn plan_marks_noop_rows_without_failing_the_batch() {
        let dir = unique_dir("plan-noop");
        let same = write_file(&dir, "same.jpg", "Artist=Same\n");
        let differs = write_file(&dir, "differs.jpg", "Artist=Old\n");

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let request = BulkPlanRequest {
            paths: vec![same.clone(), differs.clone()],
            params: params("Artist", "Same"),
        };

        let plan = plan_request(&request, &registry).expect("plan should succeed");
        let by_file = |path: &str| {
            plan.files
                .iter()
                .find(|file| file.file == path)
                .expect("plan should contain the file")
        };
        assert_eq!(by_file(&same).status, PlanFileStatus::Noop);
        assert_eq!(by_file(&differs).status, PlanFileStatus::Changed);

        cleanup_dir(&dir);
    }

    #[test]
    fn plan_keeps_unsupported_and_error_rows_reviewable() {
        let dir = unique_dir("plan-mixed");
        let supported = write_file(&dir, "supported.jpg", "Artist=Old\n");
        let deferred = write_file(&dir, "deferred-unsupported.jpg", "Artist=Old\n");
        let unknown = write_file(&dir, "notes.txt", "hello\n");
        let missing = dir.join("missing.jpg").to_string_lossy().into_owned();

        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));
        let request = BulkPlanRequest {
            paths: vec![
                supported.clone(),
                deferred.clone(),
                unknown.clone(),
                missing.clone(),
            ],
            params: params("Artist", "New"),
        };

        let plan = plan_request(&request, &registry).expect("plan should succeed");
        let status = |path: &str| {
            plan.files
                .iter()
                .find(|file| file.file == path)
                .expect("plan should contain the file")
                .status
        };
        assert_eq!(status(&supported), PlanFileStatus::Changed);
        assert_eq!(status(&deferred), PlanFileStatus::Unsupported);
        assert_eq!(status(&unknown), PlanFileStatus::Error);
        assert_eq!(status(&missing), PlanFileStatus::Error);
        // The supported file stays reviewable in a mixed batch.
        assert_eq!(plan.files.len(), 4);

        cleanup_dir(&dir);
    }

    #[test]
    fn plan_rejects_duplicate_paths() {
        let dir = unique_dir("plan-duplicate");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");
        let registry = registry_with(text_field_op(OperationKind::ExifSetTag));

        let request = BulkPlanRequest {
            paths: vec![file.clone(), file.clone()],
            params: params("Artist", "New"),
        };
        let error = plan_request(&request, &registry).expect_err("duplicates must be rejected");
        assert!(error.contains("Duplicate file path"), "unexpected error: {}", error);

        cleanup_dir(&dir);
    }

    #[test]
    fn plan_rejects_empty_path_list_and_unregistered_operation() {
        let registry = OperationRegistry::new(Vec::new());
        let request = BulkPlanRequest {
            paths: Vec::new(),
            params: params("Artist", "New"),
        };
        assert!(plan_request(&request, &registry).is_err());

        let dir = unique_dir("plan-unregistered");
        let file = write_file(&dir, "a.jpg", "Artist=Old\n");
        let request = BulkPlanRequest {
            paths: vec![file],
            params: params("Artist", "New"),
        };
        let error = plan_request(&request, &registry).expect_err("unregistered op must fail");
        assert!(error.contains("not registered"), "unexpected error: {}", error);

        cleanup_dir(&dir);
    }

    #[test]
    fn capabilities_classify_formats_and_report_ready_operations() {
        let dir = unique_dir("capabilities");
        let exif = write_file(&dir, "photo.jpg", "x");
        let card = write_file(&dir, "card.png", "x");
        let webp = write_file(&dir, "anim.webp", "x");
        let tiff = write_file(&dir, "scan.tiff", "x");
        let fits = write_file(&dir, "frame.fits", "x");
        let json = write_file(&dir, "card.json", "{}");
        let other = write_file(&dir, "notes.txt", "x");
        let missing = dir.join("missing.jpg").to_string_lossy().into_owned();

        let response = capabilities(
            &[
                other.clone(),
                fits.clone(),
                tiff.clone(),
                webp.clone(),
                card.clone(),
                json.clone(),
                exif.clone(),
                missing.clone(),
            ],
            &default_registry(),
        )
        .expect("capabilities should succeed");

        assert_eq!(response.plan_schema_version, PLAN_SCHEMA_VERSION);
        assert_eq!(response.operations.len(), 4);
        assert!(
            response
                .operations
                .iter()
                .all(|operation| operation.operation != "card_author"),
            "card_author must not be exposed"
        );
        let operation = |key: &str| {
            response
                .operations
                .iter()
                .find(|operation| operation.operation == key)
                .expect("operation should be listed")
        };
        assert!(operation("exif_strip").ready);
        assert!(!operation("exif_strip").requires_locator);
        assert!(!operation("exif_strip").requires_value);
        assert!(!operation("exif_set_tag").ready);
        assert!(operation("exif_set_tag").requires_locator);
        assert!(operation("json_set_path").ready);
        assert!(operation("json_set_path").requires_locator);
        assert!(operation("json_set_path").requires_value);
        assert!(operation("fits_set_keyword").ready);
        assert!(operation("fits_set_keyword").requires_locator);
        assert!(operation("fits_set_keyword").requires_value);

        let row = |path: &str| {
            response
                .files
                .iter()
                .find(|file| file.file == path)
                .expect("row should exist")
        };
        assert_eq!(row(&exif).format, "exif");
        assert_eq!(row(&exif).status, "supported");
        assert_eq!(
            row(&exif).operations,
            vec!["exif_strip".to_string(), "exif_set_tag".to_string()]
        );
        assert_eq!(row(&card).format, "card_json");
        assert_eq!(row(&card).status, "supported");
        assert_eq!(
            row(&card).operations,
            vec!["exif_strip".to_string(), "json_set_path".to_string()]
        );
        // Standalone card JSON is routed to the same card group, without the
        // PNG-only EXIF strip writer.
        assert_eq!(row(&json).format, "card_json");
        assert_eq!(row(&json).status, "supported");
        assert_eq!(row(&json).operations, vec!["json_set_path".to_string()]);
        assert_eq!(row(&webp).status, "supported");
        // TIFF has no EXIF strip writer yet, so the row stays unsupported.
        assert_eq!(row(&tiff).status, "unsupported");
        assert_eq!(row(&tiff).operations, vec!["exif_set_tag".to_string()]);
        assert_eq!(row(&fits).format, "fits");
        assert_eq!(row(&fits).status, "supported");
        assert_eq!(row(&fits).operations, vec!["fits_set_keyword".to_string()]);
        assert_eq!(row(&other).status, "error");
        assert!(row(&other).operations.is_empty());
        assert_eq!(row(&missing).status, "error");

        cleanup_dir(&dir);
    }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    use crate::bulk_edit::test_support::{cleanup_dir, unique_dir, write_binary, write_file};
    use crate::metadata::types::{Base64Encoding, PngChunk};
    use std::time::SystemTime;

    fn fits_card(text: &str) -> Vec<u8> {
        assert!(text.len() <= 80, "fixture card too long: {:?}", text);
        let mut out = vec![b' '; 80];
        out[..text.len()].copy_from_slice(text.as_bytes());
        out
    }

    fn fits_file(cards: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for card in cards {
            out.extend_from_slice(&fits_card(card));
        }
        out.extend_from_slice(&fits_card("END"));
        while out.len() % 2880 != 0 {
            out.push(b' ');
        }
        out
    }

    fn png_card(keyword: &str, card: &serde_json::Value) -> Vec<u8> {
        let text = serde_json::to_string(card).expect("card should serialize");
        let payload =
            crate::metadata::embedded::encode_base64_with_encoding(&text, Base64Encoding::Standard);
        let mut data = keyword.as_bytes().to_vec();
        data.push(0);
        data.extend_from_slice(payload.as_bytes());
        crate::metadata::image::build_png_bytes(&[
            PngChunk {
                chunk_type: *b"IHDR",
                data: vec![0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0],
            },
            PngChunk {
                chunk_type: *b"tEXt",
                data,
            },
            PngChunk {
                chunk_type: *b"IEND",
                data: vec![],
            },
        ])
    }

    fn v2_card(creator: &str) -> serde_json::Value {
        serde_json::json!({
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": { "name": "Card", "creator": creator, "tags": ["a"] }
        })
    }

    fn field(operation: &str, locator: &str, value: &str) -> BulkExistingField {
        BulkExistingField {
            operation: operation.to_string(),
            locator: locator.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn capabilities_discover_existing_fields_without_writing() {
        let dir = unique_dir("capabilities-discovery");
        let fits = write_binary(
            &dir,
            "frame.fits",
            &fits_file(&[
                "SIMPLE  =                    T",
                "BITPIX  =                   16",
                "OBJECT  = 'M31'                / target",
                "OBSERVER= 'nick'",
            ]),
        );
        let png = write_binary(
            &dir,
            "card.png",
            &png_card("chara", &v2_card("Old")),
        );
        let json = write_file(
            &dir,
            "card.json",
            &serde_json::to_string_pretty(&v2_card("Writer")).expect("card should serialize"),
        );
        let v1 = write_binary(
            &dir,
            "v1.png",
            &png_card(
                "chara",
                &serde_json::json!({ "spec": "chara_card_v1", "creator": "Legacy" }),
            ),
        );
        let truncated = write_binary(&dir, "truncated.fits", &fits_card("OBJECT  = 'M31'"));
        let broken = write_binary(&dir, "broken.png", b"not a png");

        let mtime = |path: &str| {
            fs::metadata(path)
                .expect("fixture metadata")
                .modified()
                .expect("mtime")
        };
        let before: Vec<SystemTime> = [&fits, &png, &json].iter().map(|p| mtime(p)).collect();
        let file_count = fs::read_dir(&dir).expect("dir readable").count();

        let response = capabilities(
            &[
                fits.clone(),
                png.clone(),
                json.clone(),
                v1.clone(),
                truncated.clone(),
                broken.clone(),
            ],
            &default_registry(),
        )
        .expect("discovery must not abort the response");

        let row = |path: &str| {
            response
                .files
                .iter()
                .find(|file| file.file == path)
                .expect("row should exist")
        };

        assert_eq!(
            row(&fits).existing_fields,
            vec![
                field("fits_set_keyword", "OBJECT", "'M31'"),
                field("fits_set_keyword", "OBSERVER", "'nick'"),
            ]
        );
        let png_creator = row(&png)
            .existing_fields
            .iter()
            .find(|existing| existing.locator == "/data/creator")
            .expect("/data/creator should be discovered");
        assert_eq!(png_creator.operation, "json_set_path");
        assert_eq!(png_creator.value, "Old");
        assert!(row(&png)
            .existing_fields
            .iter()
            .any(|existing| existing.locator == "/data/tags/0"));

        let json_creator = row(&json)
            .existing_fields
            .iter()
            .find(|existing| existing.locator == "/data/creator")
            .expect("/data/creator should be discovered in a standalone card");
        assert_eq!(json_creator.operation, "json_set_path");
        assert_eq!(json_creator.value, "Writer");

        // Unsupported/unreadable files report a reason, carry no fields, and do
        // not stop discovery for the rest of the selection.
        for (path, needle) in [
            (&v1, "v1"),
            (&truncated, "truncated"),
            (&broken, "Not a valid PNG"),
        ] {
            assert!(
                row(path).existing_fields.is_empty(),
                "{} must not yield fields",
                path
            );
            assert!(
                row(path).reason.as_deref().unwrap_or("").contains(needle),
                "{} reason: {:?}",
                path,
                row(path).reason
            );
            assert_eq!(row(path).status, "supported");
        }

        let after: Vec<SystemTime> = [&fits, &png, &json].iter().map(|p| mtime(p)).collect();
        assert_eq!(before, after, "discovery must not change mtimes");
        assert_eq!(
            fs::read_dir(&dir).expect("dir readable").count(),
            file_count,
            "discovery must not create files"
        );

        cleanup_dir(&dir);
    }

    #[test]
    fn json_pointer_edits_the_author_after_card_author_removal() {
        let dir = unique_dir("author-json-pointer");
        let path = write_file(
            &dir,
            "card.json",
            &serde_json::to_string(&v2_card("Old")).expect("card should serialize"),
        );

        let registry = default_registry();
        let request = BulkPlanRequest {
            paths: vec![path.clone()],
            params: OperationParams {
                operation: OperationKind::JsonSetPath,
                locator: "/data/creator".to_string(),
                value: "New".to_string(),
            },
        };
        let plan = plan_request(&request, &registry).expect("plan should succeed");
        assert_eq!(plan.files[0].status, PlanFileStatus::Changed);
        assert_eq!(plan.files[0].changes[0].locator, "/data/creator");

        cleanup_dir(&dir);
    }
}
