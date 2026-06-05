# Sample Key Studio

A native Tauri desktop app for scanning folders of audio samples and estimating BPM, musical key, dominant pitch, sample type, and confidence.

## Run In Development

```powershell
npm install
npm run tauri:dev
```

## Build Native App

```powershell
npm run tauri:build
```

Windows build outputs:

```text
src-tauri/target/release/sample-key-studio.exe
src-tauri/target/release/bundle/msi/Sample Key Studio_0.1.0_x64_en-US.msi
src-tauri/target/release/bundle/nsis/Sample Key Studio_0.1.0_x64-setup.exe
```

## Essentia Setup

Essentia is bundled as the default analyzer on Windows.

The bundled sidecar lives at:

```text
src-tauri/binaries/essentia_streaming_extractor_music-x86_64-pc-windows-msvc.exe
```

Analysis order:

1. Bundled Tauri sidecar
2. `ESSENTIA_EXTRACTOR_PATH` environment variable
3. Local `src-tauri/binaries/essentia_streaming_extractor_music.exe` if you add one
4. Local `binaries/essentia_streaming_extractor_music.exe` if you add one
5. System `PATH`
6. Native Rust fallback

If Essentia is unavailable, the app uses the native Rust fallback analyzer. The fallback is useful for testing and simple tonal/loop material, but Essentia should be used for better production accuracy.

The included Windows extractor is the official Essentia precompiled Windows extractor. It reports:

```text
Music extractor version 'music 2.0'
Essentia version v2.1_beta5-356-g673b6a14
```

## Current Features

- Recursive folder scanning
- WAV, AIFF, FLAC, MP3, OGG, M4A, and AAC file discovery
- Essentia CLI integration
- Native Rust fallback analysis using Symphonia decoding
- BPM, key, pitch, sample type, confidence, and candidates
- Waveform overview
- Audio preview through Tauri asset protocol
- Manual metadata correction
- Verified sample marking
- CSV and JSON export

## Verification

Validated locally with:

```powershell
npm run build
cargo check
cargo test
npm run tauri:build
```
