# HumChord Studio

HumChord Studio is a local humming-to-MIDI workstation. It records or imports a hummed melody, converts it into editable MIDI notes, can quantize the rhythm, snap notes to a key, generate simple chord accompaniment, preview the result with a local piano sound, and export a MIDI file.

The current recognition path uses Spotify Basic Pitch with ONNX Runtime, then refines humming pitch with a monophonic pYIN track. Everything runs locally on your computer; no audio is uploaded to a cloud service.

## Features

- Record humming in the browser or import an existing audio file.
- Use a metronome with custom BPM and time signature.
- Optional Space marker mode: press `Space` once for every syllable or note while recording.
- Convert audio to MIDI with Basic Pitch + pYIN pitch correction.
- Edit MIDI notes in a piano roll.
- Click or modify a note to preview it with the local piano sound.
- Move selected notes by semitone or octave.
- Quantize note starts and ends to `1/4`, `1/8`, `1/16`, or `1/32` grids.
- Detect a likely key and optionally force all out-of-key notes into the selected key.
- Generate simple chord accompaniment and manually change individual chords.
- Preview the melody and chord MIDI in the browser.
- Export the final MIDI file.

## Requirements

Windows is the currently tested platform.

You need:

- Python 3.12 or a compatible recent Python 3 version
- PowerShell
- A modern browser such as Chrome or Edge
- Internet access for the first dependency installation
- A microphone, audio interface, or imported audio file

The app is started through `localhost`, because browser microphone recording requires a secure local origin. Do not open `web/index.html` directly by double-clicking it.

## Download

Clone the repository:

```powershell
git clone https://github.com/chongwen122/HumChord-Studio.git
cd HumChord-Studio
```

Or download the repository as a ZIP from GitHub, unzip it, and open PowerShell in the extracted folder.

## First-Time Setup

Install the local recognition engine:

```powershell
.\web\install_engine.ps1
```

This creates or reuses `.venv`, then installs:

- Basic Pitch
- ONNX Runtime
- librosa
- pretty-midi
- scipy / scikit-learn
- other required audio packages

The script installs Basic Pitch without pulling an incompatible TensorFlow build on Python 3.12. This is intentional. The app uses the ONNX model instead.

If PowerShell blocks the script, run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Then run `.\web\install_engine.ps1` again.

## Start the App

Run:

```powershell
.\web\serve.ps1
```

Then open:

```text
http://localhost:8765/
```

Keep the PowerShell window open while using the app. To stop the app, press `Ctrl+C` in that window.

When the local engine is available, the page will show a Basic Pitch / ONNX status. If the local engine is unavailable, the web page can fall back to the built-in browser worker, but accuracy will usually be lower.

## Basic Workflow

1. Open `http://localhost:8765/`.
2. Choose BPM and time signature.
3. Leave key as `自动识别` for free key detection, or choose a fixed key before recording.
4. Record humming or import audio.
5. Click `生成 MIDI`.
6. Review the piano roll in `识别修音`.
7. Edit wrong notes manually if needed.
8. Click `按节拍量化` if the rhythm should lock to the selected grid.
9. Click `按调性修正` if you want all out-of-key notes snapped into the current key.
10. Open `和弦编配` to generate or edit chords.
11. Open `试听导出`, preview the result, then download the MIDI.

## Recording Tips

For best pitch recognition:

- Hum one clear melody line at a time.
- Avoid background music while recording.
- Stay close to the microphone but avoid clipping.
- Use the metronome if you care about rhythm alignment.
- Use Space marker mode for lyrics, syllables, or separated notes.
- Hold each note a little after pressing Space so the stable pitch can be analyzed.
- Avoid very breathy attacks when possible.

## Space Marker Mode

Space marker mode is enabled by default.

During recording, press `Space` once for each sung syllable or note. The app tries to keep one valid Space marker as one MIDI note.

If a marker window does not contain a stable pitch, the app creates a low-confidence placeholder note instead of dropping the marker. You can then fix that note in the piano roll.

Very close repeated Space presses within about `80ms` are treated as accidental double taps and filtered.

Useful settings:

- `音头跳过 ms`: skips the attack after pressing Space. Default is `80ms`.
- `采样窗口 ms`: the stable pitch window after the attack. Default is `420ms`.

## Key Detection and Key Correction

The app first detects pitch freely, then estimates a likely key from the whole melody.

Key detection gives more weight to:

- longer notes
- phrase endings
- stable pYIN pitch
- notes with higher confidence

Short transition notes and noisy fragments have less influence.

`按调性修正` forces every out-of-key note into the current key. It does not only fix weak notes. The correction first checks the original-audio pYIN pitch for that note, then snaps to the nearest in-key MIDI note. If no pYIN pitch is available, it uses the current MIDI pitch.

Use `撤销调性修正` if the chosen key is wrong or if you want to keep chromatic passing notes.

## Rhythm Quantization

The quantize button snaps each note start and end to the nearest selected grid:

- `1/4`
- `1/8`
- `1/16`
- `1/32`

This is based on the selected BPM, time signature, and recorded beat offset. It is most useful when you recorded with the built-in metronome.

## Manual MIDI Editing

In the piano roll:

- Click a note block to select and preview it.
- Change pitch from the pitch selector.
- Change start beat, duration, or velocity.
- Use semitone and octave buttons for quick pitch edits.
- Delete wrong notes.

Every edit refreshes the MIDI preview and download link.

## Chord Generation

`智能配和弦` generates a simple chord track from the detected melody and key.

The current chord engine is rule-based and focuses on practical triad accompaniment. It scores candidate chords with:

- melody note fit
- strong beat and long note emphasis
- phrase ending support
- simple voice leading
- common borrowed or secondary-dominant style candidates

You can choose chord rhythm:

- one chord per bar
- one chord per half bar

After generation, click a chord chip and choose a different chord manually.

## MIDI Preview and Export

The app includes a small local piano sound module in `web/piano.js`. It does not download an online SoundFont.

Use `试听 MIDI` to hear the generated melody and chord track. Use `下载 MIDI` to export the final `.mid` file for your DAW.

## Audio Interface and Voicemeeter Notes

If you use an external audio interface:

- Select the correct input in `麦克风输入`.
- Click `刷新` if the device was plugged in after the page opened.
- Make sure the browser has microphone permission.

If you use Voicemeeter:

- In the web app, choose `VoiceMeeter Output` or `VoiceMeeter Aux Output` as the microphone input.
- In Voicemeeter, route the real microphone channel to `B1`.
- `A1` is usually for physical monitor output, not browser recording input.

If the interface is ASIO-only, the browser may not see the ASIO input directly. Route the input through Voicemeeter or a WDM/MME device that the browser can access.

## Troubleshooting

### The page opens, but recording does not work

- Use `http://localhost:8765/`, not a direct file path.
- Check browser microphone permission.
- Click `刷新` beside the input selector.
- Close other apps that may be holding the microphone.
- Try the system default input first.

### The local engine is not available

Run:

```powershell
.\web\install_engine.ps1
.\web\serve.ps1
```

If dependency installation fails, make sure Python is installed and available from PowerShell:

```powershell
python --version
```

### Recognition has too many notes

- Enable Space marker mode.
- Increase `最短 ms`.
- Use `按节拍量化`.
- Delete obvious short fragments in the editor.

### Recognition has too few notes

- Use Space marker mode and press once per syllable/note.
- Lower `最短 ms`.
- Sing notes slightly longer.
- Increase microphone input level.

### The key is wrong

- Manually choose the key before clicking `按调性修正`.
- Use `撤销调性修正` if the automatic key estimate was wrong.
- For songs with many borrowed notes, avoid forcing key correction too early.

### MIDI playback is silent

- Click the page once so the browser can start audio.
- Try `试听 MIDI` again.
- Check system output volume.

## Repository Contents

```text
README.md
web/
  index.html
  app.js
  worker.js
  studio_server.py
  piano.js
  styles.css
  serve.ps1
  install_engine.ps1
```

Ignored local files include:

- `.venv/`
- `dist/`
- `test/`
- generated MIDI / WAV / ZIP files

## License Notes

HumChord Studio uses Basic Pitch as the local recognition model. Basic Pitch is an open-source project from Spotify under the Apache-2.0 license.

Project page:

```text
https://github.com/spotify/basic-pitch
```

This repository does not include Melodyne, does not bypass any Melodyne authorization, and does not depend on Melodyne.
