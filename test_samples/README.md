# Sample Test Library

Use this folder with Sample Key Studio by opening:

```text
test_samples
```

The library has two groups:

- `generated_reference`: exact synthetic WAV files with known BPM, key, pitch, and type.
- `downloaded_open_audio`: openly licensed real-world audio from Wikimedia Commons, Incompetech, ibiblio, and Sample Pi.

For accuracy testing, treat `generated_reference` as the strict known-answer set. Treat `downloaded_open_audio` as realistic material for checking file scanning, codec support, confidence handling, and rough BPM/key behavior.

## Useful Filters

- Exact one-shot pitch: `generated_reference/one_shots`
- Exact BPM/key loops: `generated_reference/loops`
- Real CC0/CC music loops: `downloaded_open_audio/music_loops`
- Real full-ish music files: `downloaded_open_audio/music_full`
- Real drum/bass/guitar one-shots: `downloaded_open_audio/one_shots`

## Notes

- Some real files intentionally have incomplete metadata. The app should show low confidence or unknown rather than inventing a key or BPM.
- Filename-derived expectations are soft hints only.
- The manifest file contains the expected values and license/source notes.

## Sources

- Sample Pi samples are CC0/public domain according to the Sample Pi README.
- Wikimedia Commons files are included only when their file page states a free license such as CC0, CC BY, or CC BY-SA.
- Incompetech tracks are by Kevin MacLeod under Creative Commons Attribution licenses.
- The Chopin recording is from ibiblio's Pandora Music archive; the linked metadata identifies Op. 10 No. 12 as C minor.
