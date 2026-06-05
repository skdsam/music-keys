use crate::models::AnalysisResult;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::env;
use std::f32::consts::PI;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

const ESSENTIA_SIDECAR: &str = "binaries/essentia_streaming_extractor_music";

#[derive(Debug, thiserror::Error)]
pub enum AnalysisError {
    #[error("failed to read audio: {0}")]
    Decode(String),
    #[error("file does not exist")]
    MissingFile,
}

#[derive(Debug, Clone)]
struct DecodedAudio {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: usize,
}

#[derive(Debug, Clone)]
struct PitchEstimate {
    hz: Option<f32>,
    note: Option<String>,
    confidence: f32,
}

pub fn analyze_path(app: &AppHandle, path: &Path) -> Result<AnalysisResult, AnalysisError> {
    if !path.exists() {
        return Err(AnalysisError::MissingFile);
    }

    let decoded = decode_audio(path);

    match analyze_with_essentia(app, path) {
        Ok(mut essentia_result) => {
            if let Ok(audio) = decoded {
                attach_native_details(&mut essentia_result, &audio);
            } else {
                essentia_result.warnings.push(
                    "Native waveform and pitch fallback were unavailable for this file".to_string(),
                );
            }

            Ok(essentia_result)
        }
        Err(essentia_error) => {
            let audio = match decoded {
                Ok(audio) => audio,
                Err(error) => {
                    return Ok(unknown_result(vec![
                        format!("Essentia did not complete: {essentia_error}"),
                        error.to_string(),
                    ]))
                }
            };

            let mut result = analyze_natively(&audio);
            result.warnings.push(format!(
                "Essentia did not complete: {essentia_error}. Used the built-in analyzer fallback."
            ));
            Ok(result)
        }
    }
}

fn analyze_with_essentia(app: &AppHandle, path: &Path) -> Result<AnalysisResult, String> {
    let output_path =
        temporary_output_path(path).ok_or_else(|| "could not create output path".to_string())?;
    let mut errors = Vec::new();

    for executable in essentia_candidate_paths() {
        match run_standard_essentia(&executable, path, &output_path) {
            Ok(()) => return read_essentia_result(&output_path),
            Err(error) => errors.push(format!("{}: {error}", executable.display())),
        }
    }

    match run_sidecar_essentia(app, path, &output_path) {
        Ok(()) => return read_essentia_result(&output_path),
        Err(error) => errors.push(format!("sidecar {ESSENTIA_SIDECAR}: {error}")),
    }

    match run_standard_essentia(OsStr::new(platform_executable_name()), path, &output_path) {
        Ok(()) => return read_essentia_result(&output_path),
        Err(error) => errors.push(format!("PATH {}: {error}", platform_executable_name())),
    }

    Err(errors.join(" | "))
}

fn temporary_output_path(path: &Path) -> Option<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let stem = path
        .file_stem()?
        .to_string_lossy()
        .replace([' ', '.', '\\', '/', ':'], "_");

    Some(env::temp_dir().join(format!(
        "sample-key-studio-{stem}-{}-{timestamp}.json",
        std::process::id()
    )))
}

fn run_standard_essentia<S: AsRef<OsStr>>(
    executable: S,
    input_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let _ = fs::remove_file(output_path);
    let output = Command::new(executable)
        .arg(input_path)
        .arg(output_path)
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(
            format!("{:?}", output.status),
            &output.stderr,
            &output.stdout,
        ))
    }
}

fn run_sidecar_essentia(
    app: &AppHandle,
    input_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let _ = fs::remove_file(output_path);
    let command = app
        .shell()
        .sidecar(ESSENTIA_SIDECAR)
        .map_err(|error| error.to_string())?;

    let output = tauri::async_runtime::block_on(async {
        command
            .args([input_path.as_os_str(), output_path.as_os_str()])
            .output()
            .await
    })
    .map_err(|error| error.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(
            format!("{:?}", output.status),
            &output.stderr,
            &output.stdout,
        ))
    }
}

fn read_essentia_result(output_path: &Path) -> Result<AnalysisResult, String> {
    let json_text = fs::read_to_string(output_path).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(output_path);
    let json: Value = serde_json::from_str(&json_text).map_err(|error| error.to_string())?;

    Ok(normalize_essentia_json(json))
}

fn command_error(status: String, stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "no output".to_string()
    };

    format!("{status}; {detail}")
}

fn essentia_candidate_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("ESSENTIA_EXTRACTOR_PATH") {
        push_candidate(&mut candidates, PathBuf::from(path));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_binary_candidates(&mut candidates, &manifest_dir);

    if let Ok(current_dir) = env::current_dir() {
        push_binary_candidates(&mut candidates, &current_dir);
        push_binary_candidates(&mut candidates, &current_dir.join("src-tauri"));
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            push_binary_candidates(&mut candidates, parent);
            if let Some(grandparent) = parent.parent() {
                push_binary_candidates(&mut candidates, grandparent);
            }
        }
    }

    candidates
}

fn push_binary_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    let binary_dir = base.join("binaries");
    push_candidate(
        candidates,
        binary_dir.join(platform_sidecar_executable_name()),
    );
    push_candidate(candidates, binary_dir.join(platform_executable_name()));
}

fn push_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_file() && !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn platform_executable_name() -> &'static str {
    if cfg!(windows) {
        "essentia_streaming_extractor_music.exe"
    } else {
        "essentia_streaming_extractor_music"
    }
}

fn platform_sidecar_executable_name() -> String {
    let target_triple = option_env!("TAURI_ENV_TARGET_TRIPLE")
        .or(option_env!("TARGET"))
        .unwrap_or("");

    if target_triple.is_empty() {
        return platform_executable_name().to_string();
    }

    if cfg!(windows) {
        format!("essentia_streaming_extractor_music-{target_triple}.exe")
    } else {
        format!("essentia_streaming_extractor_music-{target_triple}")
    }
}

fn normalize_essentia_json(json: Value) -> AnalysisResult {
    let bpm = get_f32(&json, &["rhythm", "bpm"]);
    let mut bpm_candidates = Vec::new();
    push_optional(&mut bpm_candidates, bpm);
    push_optional(
        &mut bpm_candidates,
        get_f32(&json, &["rhythm", "bpm_histogram_first_peak_bpm"]),
    );
    push_optional(
        &mut bpm_candidates,
        get_f32(&json, &["rhythm", "bpm_histogram_second_peak_bpm"]),
    );
    dedupe_bpm(&mut bpm_candidates);

    let key_sources = [
        ["tonal", "key_edma"],
        ["tonal", "key_krumhansl"],
        ["tonal", "key_temperley"],
    ];

    let mut key_candidates = Vec::new();
    let mut best_key = None;
    let mut best_scale = None;
    let mut best_strength = 0.0;

    for source in key_sources {
        let key = get_string(&json, &[source[0], source[1], "key"]);
        let scale = get_string(&json, &[source[0], source[1], "scale"]);
        let strength = get_f32(&json, &[source[0], source[1], "strength"]).unwrap_or(0.0);

        if let Some(key_value) = key {
            let scale_value = scale.unwrap_or_else(|| "unknown".to_string());
            key_candidates.push(format!("{key_value} {}", scale_value));
            if strength >= best_strength {
                best_strength = strength;
                best_key = Some(key_value);
                best_scale = Some(scale_value);
            }
        }
    }

    let chords_key = get_string(&json, &["tonal", "chords_key"]);
    let chords_scale = get_string(&json, &["tonal", "chords_scale"]);
    if let Some(chord_key) = chords_key {
        let chord_scale = chords_scale.unwrap_or_else(|| "unknown".to_string());
        key_candidates.push(format!("{chord_key} {chord_scale}"));
        if best_key.is_none() {
            best_key = Some(chord_key);
            best_scale = Some(chord_scale);
        }
    }

    dedupe_strings(&mut key_candidates);
    let key_confidence = best_strength.clamp(0.0, 1.0);

    AnalysisResult {
        bpm,
        bpm_confidence: if bpm.is_some() { 0.72 } else { 0.0 },
        bpm_candidates,
        key: best_key,
        scale: best_scale,
        key_confidence,
        key_candidates,
        pitch_hz: None,
        pitch_note: None,
        pitch_confidence: 0.0,
        sample_type: "analyzed".to_string(),
        engine: "Essentia CLI".to_string(),
        duration_seconds: get_f32(&json, &["metadata", "audio_properties", "length"]),
        sample_rate: get_f32(&json, &["metadata", "audio_properties", "sample_rate"])
            .map(|value| value as u32),
        channels: None,
        waveform: Vec::new(),
        warnings: Vec::new(),
    }
}

fn attach_native_details(result: &mut AnalysisResult, audio: &DecodedAudio) {
    let native = analyze_natively(audio);
    result.duration_seconds = result.duration_seconds.or(native.duration_seconds);
    result.sample_rate = result.sample_rate.or(native.sample_rate);
    result.channels = result.channels.or(native.channels);
    result.waveform = native.waveform;
    result.pitch_hz = native.pitch_hz;
    result.pitch_note = native.pitch_note;
    result.pitch_confidence = native.pitch_confidence;

    if result.sample_type == "analyzed" {
        result.sample_type = native.sample_type;
    }
}

fn analyze_natively(audio: &DecodedAudio) -> AnalysisResult {
    let duration_seconds = audio.samples.len() as f32 / audio.sample_rate as f32;
    let pitch = detect_pitch(&audio.samples, audio.sample_rate);
    let (bpm, bpm_confidence, bpm_candidates) =
        detect_bpm(&audio.samples, audio.sample_rate, duration_seconds);
    let (key, scale, key_confidence, key_candidates) =
        detect_key(&audio.samples, audio.sample_rate);
    let waveform = waveform_peaks(&audio.samples, 96);
    let sample_type = classify_sample(
        duration_seconds,
        bpm_confidence,
        pitch.confidence,
        key_confidence,
    );

    AnalysisResult {
        bpm,
        bpm_confidence,
        bpm_candidates,
        key,
        scale,
        key_confidence,
        key_candidates,
        pitch_hz: pitch.hz,
        pitch_note: pitch.note,
        pitch_confidence: pitch.confidence,
        sample_type,
        engine: "Native fallback".to_string(),
        duration_seconds: Some(duration_seconds),
        sample_rate: Some(audio.sample_rate),
        channels: Some(audio.channels),
        waveform,
        warnings: Vec::new(),
    }
}

fn decode_audio(path: &Path) -> Result<DecodedAudio, AnalysisError> {
    let file = File::open(path).map_err(|error| AnalysisError::Decode(error.to_string()))?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();

    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| AnalysisError::Decode(error.to_string()))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| AnalysisError::Decode("no supported audio track found".to_string()))?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| AnalysisError::Decode(error.to_string()))?;

    let mut mono = Vec::new();
    let mut detected_channels = 1usize;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(AnalysisError::Decode(error.to_string())),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(_)) => break,
            Err(error) => return Err(AnalysisError::Decode(error.to_string())),
        };

        let spec = *decoded.spec();
        detected_channels = spec.channels.count().max(1);
        let mut sample_buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sample_buffer.copy_interleaved_ref(decoded);

        for frame in sample_buffer.samples().chunks(detected_channels) {
            let value = frame.iter().sum::<f32>() / detected_channels as f32;
            mono.push(value.clamp(-1.0, 1.0));
        }
    }

    if mono.is_empty() {
        return Err(AnalysisError::Decode(
            "decoded audio contains no samples".to_string(),
        ));
    }

    Ok(DecodedAudio {
        samples: mono,
        sample_rate,
        channels: detected_channels,
    })
}

fn detect_bpm(
    samples: &[f32],
    sample_rate: u32,
    duration_seconds: f32,
) -> (Option<f32>, f32, Vec<f32>) {
    if duration_seconds < 1.2 {
        return (None, 0.0, Vec::new());
    }

    let hop = 512usize;
    let frame = 1024usize;
    if samples.len() < frame * 4 {
        return (None, 0.0, Vec::new());
    }

    let max_samples = (sample_rate as usize * 60).min(samples.len());
    let mut energy = Vec::new();
    let mut index = 0usize;

    while index + frame <= max_samples {
        let sum = samples[index..index + frame]
            .iter()
            .map(|sample| sample * sample)
            .sum::<f32>();
        energy.push((sum / frame as f32).sqrt());
        index += hop;
    }

    if energy.len() < 16 {
        return (None, 0.0, Vec::new());
    }

    let mut onset = Vec::with_capacity(energy.len() - 1);
    for pair in energy.windows(2) {
        onset.push((pair[1] - pair[0]).max(0.0));
    }

    let mean = onset.iter().sum::<f32>() / onset.len() as f32;
    for value in &mut onset {
        *value = (*value - mean).max(0.0);
    }

    let hop_seconds = hop as f32 / sample_rate as f32;
    let min_lag = (60.0 / 200.0 / hop_seconds).round().max(2.0) as usize;
    let max_lag = (60.0 / 60.0 / hop_seconds).round() as usize;
    let max_lag = max_lag.min(onset.len().saturating_sub(2));

    if min_lag >= max_lag {
        return (None, 0.0, Vec::new());
    }

    let mut scored = Vec::new();
    for lag in min_lag..=max_lag {
        let mut numerator = 0.0;
        let mut left = 0.0;
        let mut right = 0.0;

        for i in lag..onset.len() {
            let a = onset[i];
            let b = onset[i - lag];
            numerator += a * b;
            left += a * a;
            right += b * b;
        }

        if left > 0.0 && right > 0.0 {
            let score = numerator / (left.sqrt() * right.sqrt());
            let bpm = 60.0 / (lag as f32 * hop_seconds);
            scored.push((bpm, score));
        }
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    let Some((best_bpm, best_score)) = scored.first().copied() else {
        return (None, 0.0, Vec::new());
    };

    let mut candidates = Vec::new();
    for (candidate, _) in scored.iter().take(12) {
        push_distinct_bpm(&mut candidates, normalize_bpm(*candidate));
    }

    let normalized_best = normalize_bpm(best_bpm);
    push_distinct_bpm(&mut candidates, normalize_bpm(normalized_best / 2.0));
    push_distinct_bpm(&mut candidates, normalize_bpm(normalized_best * 2.0));
    candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));

    let loop_boost = loop_duration_fit(duration_seconds, normalized_best);
    let confidence = ((best_score - 0.12) / 0.48 + loop_boost).clamp(0.0, 1.0);
    let bpm = if confidence > 0.18 {
        Some(round_one(normalized_best))
    } else {
        None
    };

    (
        bpm,
        confidence,
        candidates.into_iter().map(round_one).collect(),
    )
}

fn detect_pitch(samples: &[f32], sample_rate: u32) -> PitchEstimate {
    let Some((start, end)) = active_region(samples) else {
        return PitchEstimate {
            hz: None,
            note: None,
            confidence: 0.0,
        };
    };

    let region = &samples[start..end];
    let preferred_len = 8192usize.min(region.len());
    if preferred_len < 2048 {
        return PitchEstimate {
            hz: None,
            note: None,
            confidence: 0.0,
        };
    }

    let offset = region.len().saturating_sub(preferred_len) / 2;
    let segment = &region[offset..offset + preferred_len];
    let (hz, confidence) = pitch_from_segment(segment, sample_rate, 45.0, 1800.0);

    if confidence < 0.22 {
        return PitchEstimate {
            hz: None,
            note: None,
            confidence,
        };
    }

    PitchEstimate {
        hz: Some(hz),
        note: Some(note_from_frequency(hz)),
        confidence,
    }
}

fn pitch_from_segment(segment: &[f32], sample_rate: u32, min_hz: f32, max_hz: f32) -> (f32, f32) {
    let mean = segment.iter().sum::<f32>() / segment.len() as f32;
    let mut windowed = Vec::with_capacity(segment.len());
    let mut energy = 0.0;

    for (index, sample) in segment.iter().enumerate() {
        let window = 0.5 - 0.5 * (2.0 * PI * index as f32 / (segment.len() - 1) as f32).cos();
        let value = (*sample - mean) * window;
        energy += value * value;
        windowed.push(value);
    }

    if energy <= 0.000001 {
        return (0.0, 0.0);
    }

    let min_lag = (sample_rate as f32 / max_hz).round().max(2.0) as usize;
    let max_lag = (sample_rate as f32 / min_hz)
        .round()
        .min((windowed.len() / 2) as f32) as usize;

    let mut best_lag = min_lag;
    let mut best_score = 0.0;

    for lag in min_lag..=max_lag {
        let mut numerator = 0.0;
        let mut left = 0.0;
        let mut right = 0.0;
        let step = if lag > 512 { 2 } else { 1 };

        let mut i = 0usize;
        while i + lag < windowed.len() {
            let a = windowed[i];
            let b = windowed[i + lag];
            numerator += a * b;
            left += a * a;
            right += b * b;
            i += step;
        }

        if left > 0.0 && right > 0.0 {
            let score = numerator / (left.sqrt() * right.sqrt());
            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
        }
    }

    let hz = sample_rate as f32 / best_lag as f32;
    let confidence = ((best_score - 0.25) / 0.55).clamp(0.0, 1.0);
    (hz, confidence)
}

fn detect_key(
    samples: &[f32],
    sample_rate: u32,
) -> (Option<String>, Option<String>, f32, Vec<String>) {
    if samples.len() < sample_rate as usize {
        return (None, None, 0.0, Vec::new());
    }

    let frame = 4096usize;
    let max_duration = (sample_rate as usize * 24).min(samples.len());
    if max_duration < frame {
        return (None, None, 0.0, Vec::new());
    }

    let mut chroma = [0.0f32; 12];
    let max_frames = 72usize;
    let available = (max_duration - frame).max(1);
    let step = (available / max_frames.max(1)).max(frame);
    let mut offset = 0usize;
    let mut tonal_frames = 0usize;

    while offset + frame <= max_duration && tonal_frames < max_frames {
        let segment = &samples[offset..offset + frame];
        let (hz, confidence) = pitch_from_segment(segment, sample_rate, 65.0, 1600.0);
        if confidence > 0.28 && hz > 0.0 {
            let note = midi_note_float(hz).round() as i32;
            let class = note.rem_euclid(12) as usize;
            let energy = segment
                .iter()
                .map(|sample| sample * sample)
                .sum::<f32>()
                .sqrt();
            chroma[class] += energy * confidence;
            tonal_frames += 1;
        }
        offset += step;
    }

    let total = chroma.iter().sum::<f32>();
    if total <= 0.000001 || tonal_frames < 3 {
        return (None, None, 0.0, Vec::new());
    }

    for value in &mut chroma {
        *value /= total;
    }

    let major_profile = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    let minor_profile = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];
    let mut scores = Vec::new();

    for tonic in 0..12 {
        scores.push((
            tonic,
            "major",
            profile_score(&chroma, &major_profile, tonic),
        ));
        scores.push((
            tonic,
            "minor",
            profile_score(&chroma, &minor_profile, tonic),
        ));
    }

    scores.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(Ordering::Equal));
    let best = scores[0];
    let second = scores.get(1).copied().unwrap_or(best);
    let confidence = ((best.2 - second.2) * 2.6).clamp(0.0, 1.0);

    let candidates = scores
        .iter()
        .take(4)
        .map(|(tonic, scale, _)| format!("{} {}", NOTE_NAMES[*tonic], scale))
        .collect::<Vec<_>>();

    if confidence < 0.14 {
        return (None, None, confidence, candidates);
    }

    (
        Some(NOTE_NAMES[best.0].to_string()),
        Some(best.1.to_string()),
        confidence,
        candidates,
    )
}

fn profile_score(chroma: &[f32; 12], profile: &[f32; 12], tonic: usize) -> f32 {
    let profile_sum = profile.iter().sum::<f32>();
    let profile_mean = profile_sum / 12.0;
    let chroma_mean = chroma.iter().sum::<f32>() / 12.0;
    let mut numerator = 0.0;
    let mut chroma_norm = 0.0;
    let mut profile_norm = 0.0;

    for class in 0..12 {
        let c = chroma[class] - chroma_mean;
        let p = profile[(class + 12 - tonic) % 12] / profile_sum - profile_mean / profile_sum;
        numerator += c * p;
        chroma_norm += c * c;
        profile_norm += p * p;
    }

    if chroma_norm == 0.0 || profile_norm == 0.0 {
        0.0
    } else {
        numerator / (chroma_norm.sqrt() * profile_norm.sqrt())
    }
}

fn classify_sample(
    duration: f32,
    bpm_confidence: f32,
    pitch_confidence: f32,
    key_confidence: f32,
) -> String {
    if duration < 1.5 {
        if pitch_confidence > 0.35 {
            "one-shot tonal".to_string()
        } else {
            "one-shot drum/fx".to_string()
        }
    } else if bpm_confidence > 0.35 {
        if key_confidence > 0.18 || pitch_confidence > 0.35 {
            "melodic loop".to_string()
        } else {
            "drum loop".to_string()
        }
    } else if pitch_confidence > 0.35 {
        "tonal sample".to_string()
    } else {
        "unknown".to_string()
    }
}

fn waveform_peaks(samples: &[f32], buckets: usize) -> Vec<f32> {
    if samples.is_empty() || buckets == 0 {
        return Vec::new();
    }

    let max = samples
        .iter()
        .fold(0.0f32, |accumulator, sample| accumulator.max(sample.abs()))
        .max(0.000001);
    let chunk = (samples.len() as f32 / buckets as f32).ceil() as usize;

    (0..buckets)
        .map(|bucket| {
            let start = bucket * chunk;
            let end = ((bucket + 1) * chunk).min(samples.len());
            if start >= end {
                0.0
            } else {
                samples[start..end]
                    .iter()
                    .map(|sample| sample.abs())
                    .fold(0.0f32, f32::max)
                    / max
            }
        })
        .collect()
}

fn active_region(samples: &[f32]) -> Option<(usize, usize)> {
    let max = samples
        .iter()
        .fold(0.0f32, |acc, sample| acc.max(sample.abs()));
    if max <= 0.000001 {
        return None;
    }

    let threshold = max * 0.08;
    let start = samples
        .iter()
        .position(|sample| sample.abs() >= threshold)?;
    let end = samples
        .iter()
        .rposition(|sample| sample.abs() >= threshold)?;

    if end <= start {
        None
    } else {
        Some((start, end + 1))
    }
}

fn loop_duration_fit(duration: f32, bpm: f32) -> f32 {
    if duration < 1.0 || bpm <= 0.0 {
        return 0.0;
    }

    let beats = duration * bpm / 60.0;
    let expected_beats = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0];
    let best_error = expected_beats
        .iter()
        .map(|expected| ((beats - expected) / expected).abs())
        .fold(f32::MAX, f32::min);

    if best_error < 0.015 {
        0.22
    } else if best_error < 0.04 {
        0.1
    } else {
        0.0
    }
}

fn note_from_frequency(hz: f32) -> String {
    let midi = midi_note_float(hz).round() as i32;
    let class = midi.rem_euclid(12) as usize;
    let octave = midi / 12 - 1;
    format!("{}{}", NOTE_NAMES[class], octave)
}

fn midi_note_float(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

fn normalize_bpm(mut bpm: f32) -> f32 {
    while bpm < 60.0 {
        bpm *= 2.0;
    }
    while bpm > 200.0 {
        bpm /= 2.0;
    }
    bpm
}

fn round_one(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

fn push_optional(values: &mut Vec<f32>, value: Option<f32>) {
    if let Some(value) = value {
        push_distinct_bpm(values, value);
    }
}

fn push_distinct_bpm(values: &mut Vec<f32>, value: f32) {
    if value.is_finite()
        && !values
            .iter()
            .any(|existing| (*existing - value).abs() < 1.0)
    {
        values.push(value);
    }
}

fn dedupe_bpm(values: &mut Vec<f32>) {
    let mut output = Vec::new();
    for value in values.iter().copied() {
        push_distinct_bpm(&mut output, value);
    }
    *values = output;
}

fn dedupe_strings(values: &mut Vec<String>) {
    let mut seen = HashSet::new();
    values.retain(|value| seen.insert(value.clone()));
}

fn get_f32(json: &Value, path: &[&str]) -> Option<f32> {
    let mut value = json;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_f64().map(|number| number as f32)
}

fn get_string(json: &Value, path: &[&str]) -> Option<String> {
    let mut value = json;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_str().map(ToString::to_string)
}

fn unknown_result(warnings: Vec<String>) -> AnalysisResult {
    AnalysisResult {
        bpm: None,
        bpm_confidence: 0.0,
        bpm_candidates: Vec::new(),
        key: None,
        scale: None,
        key_confidence: 0.0,
        key_candidates: Vec::new(),
        pitch_hz: None,
        pitch_note: None,
        pitch_confidence: 0.0,
        sample_type: "unknown".to_string(),
        engine: "Unavailable".to_string(),
        duration_seconds: None,
        sample_rate: None,
        channels: None,
        waveform: Vec::new(),
        warnings,
    }
}

const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
