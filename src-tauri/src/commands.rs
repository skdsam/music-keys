use crate::analysis;
use crate::models::{AnalysisResult, ExportSample, SampleRecord};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "wave", "aif", "aiff", "flac", "mp3", "ogg", "m4a", "aac",
];

#[tauri::command]
pub fn scan_folder(path: String) -> Result<Vec<SampleRecord>, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("Selected path is not a folder".to_string());
    }

    let mut samples = Vec::new();

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };

        let extension = extension.to_ascii_lowercase();
        if !AUDIO_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }

        if let Ok(record) = sample_record(path, &root, extension) {
            samples.push(record);
        }
    }

    samples.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    Ok(samples)
}

#[tauri::command]
pub fn analyze_sample(app: tauri::AppHandle, path: String) -> Result<AnalysisResult, String> {
    analysis::analyze_path(&app, Path::new(&path)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_results(
    path: String,
    format: String,
    samples: Vec<ExportSample>,
) -> Result<(), String> {
    let target = PathBuf::from(path);
    match format.as_str() {
        "json" => {
            let text = serde_json::to_string_pretty(&samples).map_err(|error| error.to_string())?;
            fs::write(target, text).map_err(|error| error.to_string())
        }
        "csv" => {
            let mut writer = csv::Writer::from_path(target).map_err(|error| error.to_string())?;
            writer
                .write_record([
                    "file_name",
                    "path",
                    "folder",
                    "extension",
                    "file_size",
                    "bpm",
                    "bpm_confidence",
                    "key",
                    "scale",
                    "key_confidence",
                    "pitch_note",
                    "pitch_hz",
                    "pitch_confidence",
                    "sample_type",
                    "engine",
                    "verified",
                ])
                .map_err(|error| error.to_string())?;

            for sample in samples {
                let analysis = sample.analysis;
                writer
                    .write_record([
                        sample.file_name,
                        sample.path,
                        sample.folder,
                        sample.extension,
                        sample.file_size.to_string(),
                        analysis
                            .as_ref()
                            .and_then(|a| a.bpm)
                            .map(format_float)
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .map(|a| format_float(a.bpm_confidence))
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .and_then(|a| a.key.clone())
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .and_then(|a| a.scale.clone())
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .map(|a| format_float(a.key_confidence))
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .and_then(|a| a.pitch_note.clone())
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .and_then(|a| a.pitch_hz)
                            .map(format_float)
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .map(|a| format_float(a.pitch_confidence))
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .map(|a| a.sample_type.clone())
                            .unwrap_or_default(),
                        analysis
                            .as_ref()
                            .map(|a| a.engine.clone())
                            .unwrap_or_default(),
                        sample.verified.to_string(),
                    ])
                    .map_err(|error| error.to_string())?;
            }

            writer.flush().map_err(|error| error.to_string())
        }
        _ => Err("Unsupported export format".to_string()),
    }
}

fn sample_record(
    path: &Path,
    root: &Path,
    extension: String,
) -> Result<SampleRecord, std::io::Error> {
    let metadata = fs::metadata(path)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());

    let path_string = path.to_string_lossy().to_string();
    let mut hasher = DefaultHasher::new();
    path_string.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);

    let folder = path
        .parent()
        .and_then(|parent| parent.strip_prefix(root).ok())
        .map(|relative| {
            let value = relative.to_string_lossy().to_string();
            if value.is_empty() {
                ".".to_string()
            } else {
                value
            }
        })
        .unwrap_or_else(|| ".".to_string());

    Ok(SampleRecord {
        id: format!("{:x}", hasher.finish()),
        path: path_string,
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Unknown")
            .to_string(),
        extension,
        folder,
        file_size: metadata.len(),
        last_modified: modified,
        status: "queued".to_string(),
    })
}

fn format_float(value: f32) -> String {
    if value.fract().abs() < 0.005 {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}
