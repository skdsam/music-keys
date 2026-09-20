use crate::models::{AnalysisResult, SampleRecord};
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub fn get_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to get app data directory: {err}"))?;

    fs::create_dir_all(&base_dir)
        .map_err(|err| format!("Failed to create app data directory: {err}"))?;

    Ok(base_dir.join("sample_library.db"))
}

pub fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = get_db_path(app)?;
    let conn = Connection::open(&db_path)
        .map_err(|err| format!("Failed to open SQLite database at {:?}: {err}", db_path))?;

    // Enable WAL mode for high concurrency and performance
    let _ = conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    );

    init_tables(&conn)?;
    Ok(conn)
}

fn init_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS samples (
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            file_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            folder TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            last_modified INTEGER,
            status TEXT NOT NULL,
            verified INTEGER DEFAULT 0,
            user_key TEXT,
            user_scale TEXT,
            user_bpm TEXT,
            user_pitch TEXT
        );

        CREATE TABLE IF NOT EXISTS analysis_cache (
            path TEXT PRIMARY KEY,
            file_size INTEGER NOT NULL,
            last_modified INTEGER,
            analysis_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_samples_path ON samples(path);
        CREATE INDEX IF NOT EXISTS idx_analysis_cache_path ON analysis_cache(path);",
    )
    .map_err(|err| format!("Failed to initialize database schema: {err}"))?;

    Ok(())
}

pub fn get_cached_analysis(
    conn: &Connection,
    path: &str,
    file_size: u64,
    last_modified: Option<u64>,
) -> Option<AnalysisResult> {
    let mut stmt = conn
        .prepare("SELECT file_size, last_modified, analysis_json FROM analysis_cache WHERE path = ?")
        .ok()?;

    let row = stmt
        .query_row(params![path], |row| {
            let cached_size: i64 = row.get(0)?;
            let cached_mtime: Option<i64> = row.get(1)?;
            let json_text: String = row.get(2)?;
            Ok((cached_size, cached_mtime, json_text))
        })
        .optional()
        .ok()??;

    let (cached_size, cached_mtime, json_text) = row;
    if cached_size as u64 != file_size {
        return None;
    }

    if let (Some(m1), Some(m2)) = (last_modified, cached_mtime) {
        if m1 as i64 != m2 {
            return None;
        }
    }

    serde_json::from_str::<AnalysisResult>(&json_text).ok()
}

pub fn save_analysis(
    conn: &Connection,
    path: &str,
    file_size: u64,
    last_modified: Option<u64>,
    analysis: &AnalysisResult,
) -> Result<(), String> {
    let json_text = serde_json::to_string(analysis)
        .map_err(|err| format!("Failed to serialize analysis: {err}"))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mtime_i64 = last_modified.map(|v| v as i64);

    conn.execute(
        "INSERT INTO analysis_cache (path, file_size, last_modified, analysis_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            file_size = excluded.file_size,
            last_modified = excluded.last_modified,
            analysis_json = excluded.analysis_json,
            updated_at = excluded.updated_at;",
        params![path, file_size as i64, mtime_i64, json_text, now],
    )
    .map_err(|err| format!("Failed to save analysis cache: {err}"))?;

    // Update sample status to 'done' in samples table if present
    let _ = conn.execute(
        "UPDATE samples SET status = 'done' WHERE path = ?;",
        params![path],
    );

    Ok(())
}

pub fn upsert_sample(conn: &Connection, sample: &SampleRecord) -> Result<(), String> {
    let mtime_i64 = sample.last_modified.map(|v| v as i64);
    let verified_int = if sample.verified.unwrap_or(false) { 1 } else { 0 };

    conn.execute(
        "INSERT INTO samples (
            id, path, file_name, extension, folder, file_size, last_modified,
            status, verified, user_key, user_scale, user_bpm, user_pitch
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(path) DO UPDATE SET
            file_size = excluded.file_size,
            last_modified = excluded.last_modified,
            status = excluded.status;",
        params![
            sample.id,
            sample.path,
            sample.file_name,
            sample.extension,
            sample.folder,
            sample.file_size as i64,
            mtime_i64,
            sample.status,
            verified_int,
            sample.user_key,
            sample.user_scale,
            sample.user_bpm,
            sample.user_pitch,
        ],
    )
    .map_err(|err| format!("Failed to upsert sample {}: {err}", sample.path))?;

    Ok(())
}

pub fn update_user_metadata(
    conn: &Connection,
    path: &str,
    user_key: Option<String>,
    user_scale: Option<String>,
    user_bpm: Option<String>,
    user_pitch: Option<String>,
    verified: bool,
) -> Result<(), String> {
    let verified_int = if verified { 1 } else { 0 };

    conn.execute(
        "UPDATE samples SET
            user_key = ?1,
            user_scale = ?2,
            user_bpm = ?3,
            user_pitch = ?4,
            verified = ?5
         WHERE path = ?6;",
        params![
            user_key,
            user_scale,
            user_bpm,
            user_pitch,
            verified_int,
            path
        ],
    )
    .map_err(|err| format!("Failed to update user metadata for {path}: {err}"))?;

    Ok(())
}

pub fn load_all_samples(conn: &Connection) -> Result<Vec<SampleRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT 
                s.id, s.path, s.file_name, s.extension, s.folder, s.file_size,
                s.last_modified, s.status, s.verified, s.user_key, s.user_scale,
                s.user_bpm, s.user_pitch, c.analysis_json
             FROM samples s
             LEFT JOIN analysis_cache c ON s.path = c.path
             ORDER BY LOWER(s.file_name) ASC;",
        )
        .map_err(|err| format!("Failed to prepare load_all_samples query: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let path: String = row.get(1)?;
            let file_name: String = row.get(2)?;
            let extension: String = row.get(3)?;
            let folder: String = row.get(4)?;
            let file_size: i64 = row.get(5)?;
            let last_modified: Option<i64> = row.get(6)?;
            let status: String = row.get(7)?;
            let verified_int: i64 = row.get(8)?;
            let user_key: Option<String> = row.get(9)?;
            let user_scale: Option<String> = row.get(10)?;
            let user_bpm: Option<String> = row.get(11)?;
            let user_pitch: Option<String> = row.get(12)?;
            let analysis_json: Option<String> = row.get(13)?;

            let analysis = analysis_json
                .as_deref()
                .and_then(|text| serde_json::from_str::<AnalysisResult>(text).ok());

            let final_status = if analysis.is_some() {
                "done".to_string()
            } else {
                status
            };

            Ok(SampleRecord {
                id,
                path,
                file_name,
                extension,
                folder,
                file_size: file_size as u64,
                last_modified: last_modified.map(|v| v as u64),
                status: final_status,
                analysis,
                verified: Some(verified_int == 1),
                user_key,
                user_scale,
                user_bpm,
                user_pitch,
            })
        })
        .map_err(|err| format!("Failed to execute query: {err}"))?;

    let mut samples = Vec::new();
    for row in rows {
        if let Ok(sample) = row {
            // Only include sample if it still exists on disk
            if Path::new(&sample.path).exists() {
                samples.push(sample);
            }
        }
    }

    Ok(samples)
}

pub fn clear_all(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM samples;
         DELETE FROM analysis_cache;",
    )
    .map_err(|err| format!("Failed to clear database: {err}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn test_save_and_get_cached_analysis() {
        let conn = in_memory_db();
        let path = "/test/audio/sample.wav";
        let size = 10240u64;
        let mtime = Some(1700000000u64);

        let analysis = AnalysisResult {
            bpm: Some(124.0),
            bpm_confidence: 0.85,
            bpm_candidates: vec![124.0, 62.0],
            key: Some("C".to_string()),
            scale: Some("major".to_string()),
            key_confidence: 0.9,
            key_candidates: vec!["C major".to_string()],
            pitch_hz: Some(261.63),
            pitch_note: Some("C4".to_string()),
            pitch_confidence: 0.88,
            sample_type: "melodic loop".to_string(),
            engine: "Test Engine".to_string(),
            duration_seconds: Some(4.0),
            sample_rate: Some(44100),
            channels: Some(2),
            waveform: vec![0.1, 0.5, 0.9],
            warnings: vec![],
        };

        save_analysis(&conn, path, size, mtime, &analysis).unwrap();

        // Exact match should return cached analysis
        let cached = get_cached_analysis(&conn, path, size, mtime);
        assert!(cached.is_some());
        let cached = cached.unwrap();
        assert_eq!(cached.bpm, Some(124.0));
        assert_eq!(cached.key.as_deref(), Some("C"));
        assert_eq!(cached.scale.as_deref(), Some("major"));

        // Changed size should invalidate cache
        let invalid_size = get_cached_analysis(&conn, path, 9999, mtime);
        assert!(invalid_size.is_none());

        // Changed mtime should invalidate cache
        let invalid_mtime = get_cached_analysis(&conn, path, size, Some(1700000999));
        assert!(invalid_mtime.is_none());
    }

    #[test]
    fn test_upsert_and_user_metadata() {
        let conn = in_memory_db();
        let sample = SampleRecord {
            id: "abc1234".to_string(),
            path: "/path/to/kick.wav".to_string(),
            file_name: "kick.wav".to_string(),
            extension: "wav".to_string(),
            folder: "Drums".to_string(),
            file_size: 5120,
            last_modified: Some(1690000000),
            status: "queued".to_string(),
            analysis: None,
            verified: Some(false),
            user_key: None,
            user_scale: None,
            user_bpm: None,
            user_pitch: None,
        };

        upsert_sample(&conn, &sample).unwrap();

        update_user_metadata(
            &conn,
            &sample.path,
            Some("F#".to_string()),
            Some("minor".to_string()),
            Some("130".to_string()),
            Some("F#1".to_string()),
            true,
        )
        .unwrap();

        let mut stmt = conn
            .prepare("SELECT user_key, user_scale, user_bpm, verified FROM samples WHERE path = ?")
            .unwrap();
        let (key, scale, bpm, verified): (String, String, String, i64) = stmt
            .query_row(params![sample.path], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap();

        assert_eq!(key, "F#");
        assert_eq!(scale, "minor");
        assert_eq!(bpm, "130");
        assert_eq!(verified, 1);
    }
}
