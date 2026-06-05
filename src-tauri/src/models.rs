use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleRecord {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub folder: String,
    pub file_size: u64,
    pub last_modified: Option<u64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub bpm: Option<f32>,
    pub bpm_confidence: f32,
    pub bpm_candidates: Vec<f32>,
    pub key: Option<String>,
    pub scale: Option<String>,
    pub key_confidence: f32,
    pub key_candidates: Vec<String>,
    pub pitch_hz: Option<f32>,
    pub pitch_note: Option<String>,
    pub pitch_confidence: f32,
    pub sample_type: String,
    pub engine: String,
    pub duration_seconds: Option<f32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<usize>,
    pub waveform: Vec<f32>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSample {
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub folder: String,
    pub file_size: u64,
    pub analysis: Option<AnalysisResult>,
    pub verified: bool,
}
