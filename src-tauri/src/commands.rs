use crate::analysis;
use crate::db;
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
pub fn scan_folder(app: tauri::AppHandle, path: String) -> Result<Vec<SampleRecord>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Selected path is not a folder".to_string());
    }

    let conn = db::open_db(&app).ok();
    let mut samples = Vec::new();

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let file_path = entry.path();
        let Some(extension) = file_path.extension().and_then(|value| value.to_str()) else {
            continue;
        };

        let extension = extension.to_ascii_lowercase();
        if !AUDIO_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }

        if let Ok(mut record) = sample_record(file_path, &root, extension) {
            if let Some(ref db_conn) = conn {
                if let Some(cached) = db::get_cached_analysis(
                    db_conn,
                    &record.path,
                    record.file_size,
                    record.last_modified,
                ) {
                    record.analysis = Some(cached);
                    record.status = "done".to_string();
                }
                let _ = db::upsert_sample(db_conn, &record);
            }
            samples.push(record);
        }
    }

    samples.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    Ok(samples)
}

#[tauri::command]
pub fn scan_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<SampleRecord>, String> {
    let conn = db::open_db(&app).ok();
    let mut samples = Vec::new();

    for path_str in paths {
        let file_path = Path::new(&path_str);
        if !file_path.is_file() {
            continue;
        }

        let Some(extension) = file_path.extension().and_then(|value| value.to_str()) else {
            continue;
        };

        let extension = extension.to_ascii_lowercase();
        if !AUDIO_EXTENSIONS.contains(&extension.as_str()) {
            continue;
        }

        let parent_dir = file_path.parent().unwrap_or(file_path);
        if let Ok(mut record) = sample_record(file_path, parent_dir, extension) {
            if let Some(ref db_conn) = conn {
                if let Some(cached) = db::get_cached_analysis(
                    db_conn,
                    &record.path,
                    record.file_size,
                    record.last_modified,
                ) {
                    record.analysis = Some(cached);
                    record.status = "done".to_string();
                }
                let _ = db::upsert_sample(db_conn, &record);
            }
            samples.push(record);
        }
    }

    samples.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    Ok(samples)
}

#[tauri::command]
pub fn load_library(app: tauri::AppHandle) -> Result<Vec<SampleRecord>, String> {
    let conn = db::open_db(&app)?;
    db::load_all_samples(&conn)
}

#[tauri::command]
pub fn clear_library(app: tauri::AppHandle) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    db::clear_all(&conn)
}

#[tauri::command]
pub fn save_sample_metadata(
    app: tauri::AppHandle,
    path: String,
    user_key: Option<String>,
    user_scale: Option<String>,
    user_bpm: Option<String>,
    user_pitch: Option<String>,
    verified: bool,
) -> Result<(), String> {
    let conn = db::open_db(&app)?;
    db::update_user_metadata(
        &conn,
        &path,
        user_key,
        user_scale,
        user_bpm,
        user_pitch,
        verified,
    )
}

#[tauri::command]
pub async fn analyze_sample(app: tauri::AppHandle, path: String) -> Result<AnalysisResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result =
            analysis::analyze_path(&app, Path::new(&path)).map_err(|error| error.to_string())?;

        // Cache analysis result in SQLite database
        if let Ok(metadata) = fs::metadata(&path) {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs());

            if let Ok(conn) = db::open_db(&app) {
                let _ = db::save_analysis(&conn, &path, metadata.len(), modified, &result);
            }
        }

        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
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
        .unwrap_or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or(".")
                .to_string()
        });

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
        analysis: None,
        verified: Some(false),
        user_key: None,
        user_scale: None,
        user_bpm: None,
        user_pitch: None,
    })
}

fn format_float(value: f32) -> String {
    if value.fract().abs() < 0.005 {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}
