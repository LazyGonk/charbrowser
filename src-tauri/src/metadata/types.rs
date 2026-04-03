use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct EmbeddedJsonEntry {
    pub id: usize,
    pub chunk_type: String,
    pub label: String,
    pub base64: String,
    pub payload: String,
    pub payload_format: String,
    pub decoded_json: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TextEntry {
    pub id: usize,
    pub chunk_type: String,
    pub label: String,
    pub text: String,
}

#[derive(Clone, Copy)]
pub enum Base64Encoding {
    Standard,
    StandardNoPad,
    UrlSafe,
    UrlSafeNoPad,
}

pub struct PngChunk {
    pub chunk_type: [u8; 4],
    pub data: Vec<u8>,
}

pub struct EmbeddedJsonMatch {
    pub id: usize,
    pub chunk_index: usize,
    pub data_start: usize,
    pub data_end: usize,
    pub chunk_type: String,
    pub label: String,
    pub payload: String,
    pub decoded_json: serde_json::Value,
    pub encoding: JsonPayloadEncoding,
}

pub struct Mp3JsonMatch {
    pub id: usize,
    pub label: String,
    pub payload: String,
    pub decoded_json: serde_json::Value,
    pub encoding: JsonPayloadEncoding,
    pub frame_kind: Mp3FrameKind,
}

pub struct VideoJsonMatch {
    pub id: usize,
    pub start: usize,
    pub end: usize,
    pub label: String,
    pub payload: String,
    pub decoded_json: serde_json::Value,
    pub encoding: JsonPayloadEncoding,
    pub atom_path: Vec<usize>,
}

#[derive(Clone, Copy)]
pub enum Mp4AtomSizeKind {
    Fixed32(u32),
    Extended64(u64),
    ToEof,
}

pub struct Mp4Atom {
    pub start: usize,
    pub end: usize,
    pub data_start: usize,
    pub atom_type: [u8; 4],
    pub size_kind: Mp4AtomSizeKind,
    pub parent: Option<usize>,
}

pub enum Mp3FrameKind {
    Text { frame_id: String },
    ExtendedText { description: String },
    Comment { lang: String, description: String },
    Lyrics { lang: String, description: String },
}

pub struct FlacJsonMatch {
    pub id: usize,
    pub label: String,
    pub payload: String,
    pub decoded_json: serde_json::Value,
    pub encoding: JsonPayloadEncoding,
}

pub enum JsonPayloadEncoding {
    Base64(Base64Encoding),
    PlainText,
    ZtxtCompressed,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileMetadata {
    pub file_name: String,
    pub file_path: String,
    pub file_size: u64,
    pub modified_timestamp: Option<i64>,
    pub file_type: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub bit_rate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub format_specific: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileFilterInfo {
    pub file_name: String,
    pub file_path: String,
    pub file_size: u64,
    pub modified_timestamp: Option<i64>,
    pub file_kind: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub has_exif: Option<bool>,
    pub search_text: String,
}

pub struct FlacVorbisComment {
    pub name: String,
    pub value: Vec<u8>,
}
