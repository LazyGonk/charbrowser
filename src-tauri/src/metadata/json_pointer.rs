//! RFC 6901 JSON Pointer resolution for the bulk `json_set_path` operation.
//!
//! Only the subset the bulk editor needs is implemented: writing a string
//! scalar into a container that already exists. Root replacement, implicit
//! parent creation, and array append (`-`) are rejected, so a mistyped path
//! can never invent structure in a character card.

use serde_json::Value;

/// Parses a JSON Pointer into unescaped reference tokens.
///
/// Rejects the empty pointer (root replacement is out of scope), pointers that
/// do not start with `/`, and `~` escapes other than `~0`/`~1`.
pub fn parse_json_pointer(pointer: &str) -> Result<Vec<String>, String> {
    if pointer.is_empty() {
        return Err(
            "An empty JSON Pointer targets the document root; root replacement is not supported."
                .to_string(),
        );
    }

    let body = match pointer.strip_prefix('/') {
        Some(body) => body,
        None => {
            return Err(format!(
                "Invalid JSON Pointer '{}': it must be empty or start with '/'.",
                pointer
            ))
        }
    };

    body.split('/').map(unescape_token).collect()
}

fn unescape_token(token: &str) -> Result<String, String> {
    if !token.contains('~') {
        return Ok(token.to_string());
    }

    let mut out = String::with_capacity(token.len());
    let mut chars = token.chars();
    while let Some(ch) = chars.next() {
        if ch != '~' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('0') => out.push('~'),
            Some('1') => out.push('/'),
            _ => {
                return Err(format!(
                    "Invalid JSON Pointer escape in '{}': only ~0 and ~1 are valid.",
                    token
                ))
            }
        }
    }
    Ok(out)
}

/// Writes a JSON string at `tokens`, returning the value it replaced.
///
/// Every intermediate token must already exist and address an object or array;
/// a missing key at the final token is allowed (it is an added field, not a
/// created parent). An array index must be canonical, in range, and cannot be
/// the `-` append token.
pub fn set_json_pointer_string(
    root: &mut Value,
    tokens: &[String],
    value: &str,
) -> Result<Option<Value>, String> {
    let (last, parents) = match tokens.split_last() {
        Some(split) => split,
        None => return Err(
            "An empty JSON Pointer targets the document root; root replacement is not supported."
                .to_string(),
        ),
    };

    let mut walked = String::new();
    let mut current = root;
    for token in parents {
        walked.push('/');
        walked.push_str(token);
        current = match current {
            Value::Object(map) => map
                .get_mut(token)
                .ok_or_else(|| format!("Missing parent '{}' in the JSON document.", walked))?,
            Value::Array(items) => {
                let index = parse_index_at(token, items.len(), &walked)?;
                &mut items[index]
            }
            _ => {
                return Err(format!(
                    "Parent '{}' is not a JSON object or array.",
                    walked
                ))
            }
        };
    }

    walked.push('/');
    walked.push_str(last);

    match current {
        Value::Object(map) => Ok(map.insert(last.clone(), Value::String(value.to_string()))),
        Value::Array(items) => {
            let index = parse_index_at(last, items.len(), &walked)?;
            Ok(Some(std::mem::replace(
                &mut items[index],
                Value::String(value.to_string()),
            )))
        }
        _ => Err(format!(
            "Parent '{}' is not a JSON object or array.",
            walked.trim_end_matches(last)
        )),
    }
}

fn parse_index_at(token: &str, len: usize, pointer: &str) -> Result<usize, String> {
    if token == "-" {
        return Err(format!(
            "Array append ('-') is not supported at '{}'.",
            pointer
        ));
    }
    if token.is_empty() {
        return Err(format!(
            "Invalid array index at '{}': an index is required.",
            pointer
        ));
    }
    if token.len() > 1 && token.starts_with('0') {
        return Err(format!(
            "Invalid array index '{}' at '{}': leading zeros are not allowed.",
            token, pointer
        ));
    }
    if !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "Invalid array index '{}' at '{}': expected decimal digits.",
            token, pointer
        ));
    }

    let index: usize = token
        .parse()
        .map_err(|_| format!("Invalid array index '{}' at '{}'.", token, pointer))?;
    if index >= len {
        return Err(format!(
            "Array index {} at '{}' is out of range (array has {} element(s)); appending is not supported.",
            index, pointer, len
        ));
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_path_unescapes_slash_and_tilde_tokens() {
        let tokens = parse_json_pointer("/a~1b/c~0d/~01").expect("pointer should parse");
        assert_eq!(tokens, vec!["a/b", "c~d", "~1"]);

        let mut document = json!({ "a/b": { "c~d": { "~1": "old" } } });
        let old = set_json_pointer_string(&mut document, &tokens, "new")
            .expect("escaped pointer should resolve");
        assert_eq!(old, Some(json!("old")));
        assert_eq!(document["a/b"]["c~d"]["~1"], "new");
    }

    #[test]
    fn json_path_rejects_invalid_pointers() {
        for pointer in ["", "data/creator", "/a~2b", "/~"] {
            let error = parse_json_pointer(pointer)
                .expect_err("invalid pointer must be rejected")
                .to_lowercase();
            assert!(
                error.contains("pointer") || error.contains("root"),
                "unexpected error for {:?}: {}",
                pointer,
                error
            );
        }
    }

    #[test]
    fn json_path_object_set_returns_old_value_or_none() {
        let tokens = parse_json_pointer("/data/creator").expect("pointer should parse");
        let mut document = json!({ "data": { "creator": "Old" } });

        let old = set_json_pointer_string(&mut document, &tokens, "New")
            .expect("existing key should be replaceable");
        assert_eq!(old, Some(json!("Old")));
        assert_eq!(document, json!({ "data": { "creator": "New" } }));

        let tokens = parse_json_pointer("/data/new_field").expect("pointer should parse");
        let old = set_json_pointer_string(&mut document, &tokens, "Value")
            .expect("missing leaf key should be creatable");
        assert_eq!(old, None);
        assert_eq!(
            document,
            json!({ "data": { "creator": "New", "new_field": "Value" } })
        );
    }

    #[test]
    fn json_path_rejects_missing_parents_and_scalar_parents() {
        let mut document = json!({ "data": { "creator": "Old" }, "name": "Card" });

        let tokens = parse_json_pointer("/missing/creator").expect("pointer should parse");
        let error = set_json_pointer_string(&mut document, &tokens, "New")
            .expect_err("missing parent must be rejected");
        assert!(
            error.contains("Missing parent"),
            "unexpected error: {}",
            error
        );

        let tokens = parse_json_pointer("/name/first").expect("pointer should parse");
        let error = set_json_pointer_string(&mut document, &tokens, "New")
            .expect_err("scalar parent must be rejected");
        assert!(
            error.contains("not a JSON object or array"),
            "unexpected error: {}",
            error
        );
        assert_eq!(
            document,
            json!({ "data": { "creator": "Old" }, "name": "Card" })
        );
    }

    #[test]
    fn json_path_array_indexes_are_exact_and_never_append() {
        let mut document = json!({ "data": { "tags": ["a", "b"] } });

        let tokens = parse_json_pointer("/data/tags/1").expect("pointer should parse");
        let old = set_json_pointer_string(&mut document, &tokens, "B")
            .expect("in-range index should be replaceable");
        assert_eq!(old, Some(json!("b")));
        assert_eq!(document, json!({ "data": { "tags": ["a", "B"] } }));

        for pointer in [
            "/data/tags/2",
            "/data/tags/-",
            "/data/tags/01",
            "/data/tags/x",
        ] {
            let tokens = parse_json_pointer(pointer).expect("pointer should parse");
            let error = set_json_pointer_string(&mut document, &tokens, "C")
                .expect_err("invalid array index must be rejected");
            assert!(
                error.contains("index") || error.contains("append"),
                "unexpected error for {:?}: {}",
                pointer,
                error
            );
        }
        assert_eq!(document, json!({ "data": { "tags": ["a", "B"] } }));
    }
}
