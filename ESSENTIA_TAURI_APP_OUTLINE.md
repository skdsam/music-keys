# Essentia + Tauri Sample Analysis App Outline

## Goal

Build a native desktop application that can load folders of audio samples and estimate:

- BPM
- Musical key and scale
- Dominant pitch or note
- Sample type, such as loop, one-shot, drum, tonal, FX, or unknown
- Confidence scores and alternative candidates

The app should compile as a native application using Tauri, with a Rust backend and a clean web-based frontend.

## Recommended Stack

### Desktop Shell

- Tauri 2
- Rust backend
- TypeScript frontend
- Svelte, React, or Vue for UI

Tauri is preferred because it produces small native desktop apps while allowing a modern UI layer and native Rust commands.

### Audio Analysis

- Essentia for BPM, key, scale, tonal, rhythm, and spectral descriptors
- Symphonia for Rust-side audio decoding if needed
- Optional aubio later for lightweight pitch or beat fallback

Essentia should be treated as the main analysis engine because it already provides mature music information retrieval algorithms.

### Storage

- SQLite for local cache and editable metadata
- Optional sidecar JSON files for portability

### Export Formats

- CSV
- JSON
- Optional DAW/sample-manager friendly metadata exports later

## High-Level Architecture

```text
Tauri Native App
  Frontend
    Folder browser
    Sample table
    Waveform preview
    Playback controls
    Metadata editor
    Confidence review workflow

  Rust Backend
    Folder scanner
    Job queue
    Essentia runner
    Result parser
    Metadata cache
    Export service

  Analysis Engine
    Essentia CLI or bundled native library
```

## Native Compilation Strategy

There are two practical ways to use Essentia.

### Option A: Bundle Essentia CLI

The Rust backend calls an Essentia executable, such as `essentia_streaming_extractor_music`, as a child process.

Benefits:

- Fastest to build
- Keeps Rust integration simpler
- Easier to test outside the app
- Lower risk for first version

Tradeoffs:

- Need to package the Essentia binary with the app
- Need platform-specific binaries for Windows, macOS, and Linux
- Process execution and JSON parsing need careful error handling

This is the recommended MVP approach.

### Option B: Link Essentia as a Native Library

The Rust backend links to Essentia through FFI or a wrapper crate.

Benefits:

- Tighter native integration
- Potentially faster batch processing
- No child-process management

Tradeoffs:

- More complex build setup
- Harder cross-platform packaging
- More native dependency issues

This is better for a later version after the analysis workflow is proven.

## Recommended MVP Path

Start with Option A:

```text
Tauri frontend
  -> invoke Rust command
    -> scan folder
    -> queue audio files
    -> call Essentia CLI per file
    -> parse JSON result
    -> store normalized metadata in SQLite
    -> stream progress back to frontend
```

The app should compile into a native Tauri application. Essentia should be bundled as an external sidecar binary.

## Project Structure

```text
music-key-app/
  src/
    app/
    components/
    stores/
    styles/

  src-tauri/
    src/
      main.rs
      commands/
        scan.rs
        analyze.rs
        export.rs
        playback.rs
      analysis/
        essentia.rs
        normalize.rs
        confidence.rs
      db/
        mod.rs
        migrations.rs
      models/
        sample.rs
        analysis_result.rs
      jobs/
        queue.rs

    binaries/
      windows/
        essentia_streaming_extractor_music.exe
      macos/
        essentia_streaming_extractor_music
      linux/
        essentia_streaming_extractor_music

    tauri.conf.json
    Cargo.toml

  package.json
  README.md
```

## Core Data Model

### Sample

```text
id
path
file_name
extension
duration_seconds
sample_rate
channels
file_size
last_modified
hash
created_at
updated_at
```

### Analysis Result

```text
sample_id
bpm
bpm_confidence
bpm_candidates
key
scale
key_confidence
key_candidates
pitch_hz
pitch_note
pitch_confidence
sample_type
analysis_engine
analysis_version
is_user_verified
user_overrides
raw_result_json
analyzed_at
```

## Essentia Output To Use

Use Essentia MusicExtractor or StreamingExtractor output where possible.

Useful fields include:

```text
rhythm.bpm
rhythm.beats_position
rhythm.bpm_histogram
tonal.key_edma.key
tonal.key_edma.scale
tonal.key_edma.strength
tonal.key_krumhansl.key
tonal.key_krumhansl.scale
tonal.key_krumhansl.strength
tonal.chords_key
tonal.chords_scale
tonal.tuning_frequency
lowlevel.spectral_centroid
lowlevel.spectral_complexity
lowlevel.pitch_salience
```

Exact field names may vary depending on the Essentia extractor profile and version, so the Rust parser should tolerate missing fields.

## Analysis Pipeline

### 1. Folder Loading

- User chooses a folder from the UI
- Rust scans recursively
- Include common audio extensions:
  - wav
  - aiff
  - aif
  - flac
  - mp3
  - ogg
  - m4a

### 2. File Fingerprinting

Create a stable identity for each file using:

```text
absolute path
file size
last modified time
optional content hash
```

Use this to avoid re-analyzing unchanged files.

### 3. Queue Analysis

- Run analysis in a background job queue
- Limit concurrency to avoid CPU overload
- Emit progress events to the frontend
- Allow pause, cancel, and re-analyze

### 4. Pre-Classification

Before trusting key or BPM results, classify the sample:

```text
drum_loop
melodic_loop
bass_loop
one_shot_tonal
one_shot_drum
fx
unknown
```

This can start simple:

- Very short files are probably one-shots
- High onset density with weak pitch salience may be drum/percussion
- Strong pitch salience suggests tonal material
- Beat confidence plus duration suggests a loop

### 5. BPM Detection

Use Essentia rhythm BPM as the primary result.

Then apply validation:

- Check half-time and double-time variants
- Compare against duration-based loop estimates
- Prefer common musical BPM ranges, such as 60 to 200
- If confidence is low, present alternatives

Example:

```text
Detected BPM: 128
Candidates: 64, 128, 256
Confidence: High
```

### 6. Key Detection

Use Essentia tonal key estimators.

Recommended behavior:

- Do not assign a key to drum-only samples
- Prefer key results with stronger tonal confidence
- Compare multiple key algorithms where available
- Treat relative major/minor ambiguity as lower confidence
- Store alternatives for manual review

Example:

```text
Detected key: A minor
Candidates: A minor, C major, E minor
Confidence: Medium
```

### 7. Pitch Detection

For one-shots and monophonic samples:

- Estimate dominant pitch
- Convert frequency to note name
- Ignore attack transient where possible
- Analyze the stable body of the sample

For polyphonic loops:

- Report key instead of exact pitch
- Pitch can be blank or marked as low confidence

### 8. Confidence Scoring

Every generated value should have a confidence score:

```text
0.00 to 1.00
```

Use labels in the UI:

```text
High
Medium
Low
Unknown
```

Confidence should consider:

- Essentia strength values
- Agreement between algorithms
- Sample duration
- Tonal strength
- Percussive/noisy classification
- BPM candidate ambiguity
- Whether loop duration supports the BPM

## UI Layout

The first screen should be the actual tool, not a marketing page.

```text
Top Toolbar
  Open Folder
  Re-analyze
  Export
  Settings

Left Sidebar
  Folder tree
  Filters
    All
    Unanalyzed
    Low confidence
    Needs review
    Loops
    One-shots
    Drums
    Tonal

Main Table
  File
  Type
  Key
  Pitch
  BPM
  Length
  Confidence
  Status

Inspector Panel
  Waveform
  Playback controls
  Key editor
  Pitch editor
  BPM editor
  Candidate results
  Raw analysis details
```

## UI Principles

- Make the table dense but readable
- Use confidence badges
- Make manual correction fast
- Allow sorting by BPM, key, confidence, type, and folder
- Keep playback controls always available
- Show low-confidence files clearly
- Avoid forcing key or BPM on unsuitable samples

## Review Workflow

The user should be able to quickly review uncertain results.

```text
Filter: Low confidence
Select sample
Play sample
See detected candidates
Choose correct value
Mark verified
Move to next sample
```

Verified user values should always override automatic values.

## Accuracy Strategy

The app should not promise perfect detection. It should promise reliable analysis with transparent confidence.

### BPM Accuracy

Improve BPM correctness by combining:

- Essentia beat tracking
- Duration-based loop checks
- Half/double-time candidate generation
- User correction cache

### Key Accuracy

Improve key correctness by combining:

- Multiple key profiles
- Tuning frequency estimation
- Tonal confidence scoring
- Sample type detection
- Alternatives instead of single forced output

### Pitch Accuracy

Improve pitch correctness by:

- Using only stable regions of one-shots
- Ignoring noisy attack transients
- Skipping pitch for drums and FX
- Reporting confidence

## Database Tables

Minimum useful tables:

```text
folders
samples
analysis_results
user_overrides
analysis_jobs
app_settings
```

## Tauri Commands

Recommended command surface:

```text
select_folder()
scan_folder(path)
start_analysis(folder_id)
pause_analysis()
cancel_analysis()
reanalyze_sample(sample_id)
reanalyze_folder(folder_id)
get_samples(filters)
get_sample_detail(sample_id)
update_sample_metadata(sample_id, values)
mark_sample_verified(sample_id)
export_results(format, filters)
open_sample_in_file_explorer(sample_id)
```

## Frontend Events

Rust should emit events to the frontend:

```text
scan_started
scan_progress
scan_finished
analysis_started
analysis_progress
sample_analyzed
analysis_error
analysis_finished
```

## Packaging Notes

The final app should package:

- Tauri native executable
- Frontend assets
- SQLite migrations
- Essentia sidecar binary for the target platform
- Optional extractor profile files

For each platform, verify:

- Essentia binary exists
- Essentia binary can execute
- App can access selected folders
- File paths with spaces work
- Unicode file paths work
- Long folder paths work

## Build Targets

Start with:

```text
Windows x64
```

Then add:

```text
macOS arm64
macOS x64
Linux x64
```

Each platform should have its own Essentia binary and packaging check.

## Testing Plan

Create a known-answer test library:

```text
test_samples/
  bpm/
    60/
    90/
    120/
    128/
    140/
    174/
  key/
    major/
    minor/
  pitch/
    one_shots/
  difficult/
    half_time/
    double_time/
    swing/
    noisy/
    drum_only/
```

Measure:

- BPM exact match
- BPM half/double-time acceptable match
- Key exact match
- Key relative major/minor confusion
- Pitch semitone error
- Correct unknown classification
- Analysis time per file
- Batch performance

## Definition Of Done For MVP

The MVP is complete when:

- The app compiles as a native Tauri application
- A user can select a folder
- Audio files are scanned recursively
- Samples are analyzed with Essentia
- BPM, key, pitch, type, and confidence are shown
- Low-confidence files can be filtered
- User can manually edit values
- Results are stored locally
- Results can be exported as CSV and JSON
- The app handles missing Essentia binary gracefully

## Future Improvements

- Waveform peak cache
- Audio auditioning
- Drag and drop folder loading
- Batch metadata editing
- Rekordbox, Serato, Ableton, or DAW export
- Filename hint parser
- Duplicate sample detection
- ML-based sample classification
- Embedded native Essentia library instead of CLI sidecar
- Plugin system for analysis engines

## Key Product Principle

The app should be honest.

Audio analysis is probabilistic. The best user experience is not pretending the result is always correct, but making the result easy to trust, inspect, correct, and export.
