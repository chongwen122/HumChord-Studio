from __future__ import annotations

import argparse
import cgi
import contextlib
import json
import logging
import os
import sys
import tempfile
import threading
import time
import warnings
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 80 * 1024 * 1024

_MODEL = None
_MODEL_PATH = None
_MODEL_LOCK = threading.Lock()
_ENGINE_ERROR = ""


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def clamp_int(value: float, low: int, high: int) -> int:
    return int(round(clamp(value, low, high)))


def engine_probe(load_model: bool = False) -> dict[str, Any]:
    global _ENGINE_ERROR, _MODEL_PATH
    try:
        logging.getLogger().setLevel(logging.ERROR)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from basic_pitch import ICASSP_2022_MODEL_PATH

        _MODEL_PATH = str(ICASSP_2022_MODEL_PATH)
        if load_model:
            get_model()
        _ENGINE_ERROR = ""
        return {
            "available": True,
            "engine": "Basic Pitch",
            "runtime": "ONNX",
            "modelPath": _MODEL_PATH,
            "modelLoaded": _MODEL is not None,
            "python": sys.version.split()[0],
        }
    except Exception as exc:  # pragma: no cover - surfaced to the browser.
        _ENGINE_ERROR = f"{type(exc).__name__}: {exc}"
        return {
            "available": False,
            "engine": "Basic Pitch",
            "runtime": "unavailable",
            "error": _ENGINE_ERROR,
            "python": sys.version.split()[0],
        }


def get_model():
    global _MODEL, _ENGINE_ERROR
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        try:
            logging.getLogger().setLevel(logging.ERROR)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                from basic_pitch import ICASSP_2022_MODEL_PATH
                from basic_pitch.inference import Model

                _MODEL = Model(ICASSP_2022_MODEL_PATH)
            _ENGINE_ERROR = ""
            return _MODEL
        except Exception as exc:
            _ENGINE_ERROR = f"{type(exc).__name__}: {exc}"
            raise


def predict_notes(audio_path: Path, settings: dict[str, Any], duration: float) -> list[dict[str, Any]]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from basic_pitch.inference import predict

    manual_markers = cleaned_markers(settings.get("manualMarkers"), duration)
    min_note_ms = clamp(float(settings.get("minNoteMs") or 100), 45, 650)
    fmin = clamp(float(settings.get("fmin") or 75), 45, 500)
    fmax = clamp(float(settings.get("fmax") or 700), 180, 1800)
    tempo = clamp(float(settings.get("tempo") or 120), 40, 240)
    onset = 0.34 if manual_markers else 0.43
    frame = 0.22 if manual_markers else 0.27

    started = time.perf_counter()
    pitch_track = estimate_humming_pitch_track(audio_path, settings)
    _, _, note_events = predict(
        str(audio_path),
        get_model(),
        onset_threshold=onset,
        frame_threshold=frame,
        minimum_note_length=min_note_ms,
        minimum_frequency=fmin,
        maximum_frequency=fmax,
        multiple_pitch_bends=False,
        melodia_trick=True,
        midi_tempo=tempo,
    )
    notes = [event_to_note(event) for event in note_events]
    notes = [note for note in notes if note and note["end"] > note["start"]]
    notes.sort(key=lambda note: (note["start"], -note["confidence"], note["note"]))
    notes = merge_nearby_same_pitch(notes)
    if manual_markers:
        notes = notes_from_markers(notes, manual_markers, settings, duration, pitch_track)
    else:
        notes = monophonize(notes)
        notes = remove_isolated_artifacts(notes)
        notes = correct_notes_with_pitch_track(notes, pitch_track, settings)
        notes = merge_nearby_same_pitch(notes)
        notes = remove_isolated_artifacts(notes)
    for note in notes:
        note["engine"] = "basic-pitch+pyin" if pitch_track.get("available") else "basic-pitch"
    elapsed_ms = (time.perf_counter() - started) * 1000
    return notes, elapsed_ms, len(note_events)


def estimate_humming_pitch_track(audio_path: Path, settings: dict[str, Any]) -> dict[str, Any]:
    try:
        import librosa
        import numpy as np

        fmin = clamp(float(settings.get("fmin") or 75), 45, 500)
        fmax = clamp(float(settings.get("fmax") or 700), 180, 1800)
        sample_rate = 22050
        hop_length = 256
        frame_length = 2048
        y, sr = librosa.load(str(audio_path), sr=sample_rate, mono=True)
        if y.size < frame_length:
            return {"available": False, "error": "audio too short"}
        y = y.astype("float32", copy=False)
        y = y - float(np.mean(y))
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        if peak > 1e-6:
            y = y / max(peak, 1.0)
        f0, _, voiced_prob = librosa.pyin(
            y,
            fmin=fmin,
            fmax=fmax,
            sr=sr,
            frame_length=frame_length,
            hop_length=hop_length,
            fill_na=np.nan,
        )
        times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop_length)
        f0 = np.asarray(f0, dtype=float)
        prob = np.nan_to_num(np.asarray(voiced_prob, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
        midi = np.zeros_like(f0, dtype=float)
        valid = np.isfinite(f0) & (f0 > 0) & (prob > 0.02)
        midi[valid] = 69 + 12 * np.log2(f0[valid] / 440.0)
        return {
            "available": True,
            "times": times.astype(float).tolist(),
            "midi": midi.astype(float).tolist(),
            "prob": prob.astype(float).tolist(),
        }
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}


def event_to_note(event: Any) -> dict[str, Any] | None:
    try:
        start, end, pitch, amplitude, *_ = event
        start = float(start)
        end = float(end)
        pitch = clamp_int(float(pitch), 0, 127)
        confidence = clamp(float(amplitude or 0), 0, 1.5)
    except Exception:
        return None
    if end <= start:
        return None
    if confidence <= 1:
        velocity = clamp_int(44 + confidence * 66, 1, 127)
    else:
        velocity = clamp_int(confidence, 1, 127)
        confidence = velocity / 127
    return {
        "note": pitch,
        "start": max(0.0, start),
        "end": max(start + 0.02, end),
        "velocity": velocity,
        "confidence": confidence,
    }


def merge_nearby_same_pitch(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for note in notes:
        previous = merged[-1] if merged else None
        if previous and previous["note"] == note["note"] and note["start"] - previous["end"] <= 0.08:
            previous_duration = previous["end"] - previous["start"]
            next_duration = note["end"] - note["start"]
            total = max(0.001, previous_duration + next_duration)
            previous["end"] = max(previous["end"], note["end"])
            previous["velocity"] = max(previous["velocity"], note["velocity"])
            previous["confidence"] = (
                previous["confidence"] * previous_duration + note["confidence"] * next_duration
            ) / total
        else:
            merged.append(dict(note))
    return merged


def monophonize(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for note in notes:
        note = dict(note)
        while output and note["start"] < output[-1]["end"] - 0.025:
            previous = output[-1]
            overlap = min(previous["end"], note["end"]) - max(previous["start"], note["start"])
            if overlap <= 0:
                break
            previous_score = note_score(previous, output[-2] if len(output) > 1 else None)
            current_score = note_score(note, output[-2] if len(output) > 1 else None)
            overlap_ratio = overlap / max(0.001, min(previous["end"] - previous["start"], note["end"] - note["start"]))
            if overlap_ratio > 0.42:
                if current_score > previous_score + 0.04:
                    output.pop()
                    continue
                note["start"] = max(note["start"], previous["end"])
            else:
                previous["end"] = max(previous["start"] + 0.04, note["start"])
            break
        if note["end"] - note["start"] >= 0.045:
            output.append(note)
    return merge_nearby_same_pitch(output)


def remove_isolated_artifacts(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(notes) < 2:
        return notes
    output: list[dict[str, Any]] = []
    for index, note in enumerate(notes):
        previous = notes[index - 1] if index > 0 else None
        next_note = notes[index + 1] if index + 1 < len(notes) else None
        duration = note["end"] - note["start"]
        previous_gap = note["start"] - previous["end"] if previous else 999
        next_gap = next_note["start"] - note["end"] if next_note else 999
        confidence = float(note.get("confidence") or 0)
        weak = confidence < 0.43 or note["velocity"] < 70
        short = duration < 0.23
        isolated = previous_gap > 0.65 and next_gap > 0.65
        leading_noise = index == 0 and next_gap > 0.8 and (weak or note["note"] < 50)
        trailing_noise = index == len(notes) - 1 and previous_gap > 0.8 and weak and short
        if leading_noise or trailing_noise or (isolated and weak and short):
            continue
        output.append(note)
    return output


def correct_notes_with_pitch_track(
    notes: list[dict[str, Any]],
    pitch_track: dict[str, Any],
    settings: dict[str, Any],
) -> list[dict[str, Any]]:
    if not pitch_track.get("available") or not notes:
        return notes
    corrected: list[dict[str, Any]] = []
    for index, note in enumerate(notes):
        note = dict(note)
        duration = note["end"] - note["start"]
        if duration <= 0:
            continue
        attack = min(0.11, max(0.035, duration * 0.22))
        release = min(0.07, max(0.025, duration * 0.16))
        focus_start = note["start"] + attack
        focus_end = note["end"] - release
        if focus_end <= focus_start + 0.035:
            center = (note["start"] + note["end"]) * 0.5
            half = max(0.035, duration * 0.35)
            focus_start = max(note["start"], center - half)
            focus_end = min(note["end"], center + half)
        estimate = pitch_estimate_for_window(pitch_track, focus_start, focus_end)
        if estimate:
            current_confidence = float(note.get("confidence") or 0)
            difference = abs(estimate["note"] - note["note"])
            reliable = estimate["confidence"] >= 0.32 and estimate["support"] >= 3
            strong = estimate["confidence"] >= 0.48 and estimate["support"] >= 4
            if difference and (strong or (reliable and (difference <= 5 or current_confidence < 0.62))):
                note["rawBasicPitchNote"] = note["note"]
                note["note"] = estimate["note"]
            note["pyinMidi"] = estimate["midi"]
            note["pyinConfidence"] = estimate["confidence"]
            note["pyinSupport"] = estimate["support"]
        corrected.append(note)
    return smooth_short_pitch_fragments(corrected, settings)


def pitch_estimate_for_window(pitch_track: dict[str, Any], start: float, end: float) -> dict[str, Any] | None:
    times = pitch_track.get("times") or []
    midi_values = pitch_track.get("midi") or []
    probabilities = pitch_track.get("prob") or []
    samples: list[tuple[float, float]] = []
    for time_value, midi_value, probability in zip(times, midi_values, probabilities):
        midi = float(midi_value or 0)
        prob = float(probability or 0)
        if start <= float(time_value) <= end and midi > 0 and prob > 0.04:
            samples.append((midi, prob))
    if len(samples) < 2:
        return None

    median_midi = weighted_median(samples)
    inliers = [(midi, prob) for midi, prob in samples if abs(midi - median_midi) <= 1.2]
    if len(inliers) >= 2:
        median_midi = weighted_median(inliers)
        samples_for_confidence = inliers
    else:
        samples_for_confidence = samples

    total_weight = sum(prob for _, prob in samples)
    inlier_weight = sum(prob for _, prob in samples_for_confidence)
    mean_prob = inlier_weight / max(0.001, len(samples_for_confidence))
    stability = inlier_weight / max(0.001, total_weight)
    rounded = clamp_int(median_midi, 0, 127)
    cents_penalty = min(1.0, abs(median_midi - rounded) / 0.5)
    confidence = clamp(stability * 0.62 + mean_prob * 0.52 - cents_penalty * 0.16, 0.0, 1.0)
    return {
        "note": rounded,
        "midi": float(median_midi),
        "confidence": float(confidence),
        "support": len(samples_for_confidence),
    }


def weighted_median(samples: list[tuple[float, float]]) -> float:
    ordered = sorted(samples, key=lambda item: item[0])
    total = sum(max(0.0001, weight) for _, weight in ordered)
    midpoint = total * 0.5
    running = 0.0
    for value, weight in ordered:
        running += max(0.0001, weight)
        if running >= midpoint:
            return float(value)
    return float(ordered[-1][0])


def smooth_short_pitch_fragments(notes: list[dict[str, Any]], settings: dict[str, Any]) -> list[dict[str, Any]]:
    if len(notes) < 3:
        return notes
    output = [dict(note) for note in notes]
    min_note = max(0.08, clamp(float(settings.get("minNoteMs") or 100), 45, 650) / 1000)
    for index in range(1, len(output) - 1):
        previous = output[index - 1]
        note = output[index]
        next_note = output[index + 1]
        duration = note["end"] - note["start"]
        weak = float(note.get("confidence") or 0) < 0.58 and float(note.get("pyinConfidence") or 0) < 0.52
        short = duration <= max(0.18, min_note * 1.5)
        surrounded = previous["note"] == next_note["note"] and abs(note["note"] - previous["note"]) <= 2
        if short and weak and surrounded:
            note["rawBasicPitchNote"] = note.get("rawBasicPitchNote", note["note"])
            note["note"] = previous["note"]
    return output


def note_score(note: dict[str, Any], previous: dict[str, Any] | None) -> float:
    duration = note["end"] - note["start"]
    score = float(note.get("confidence") or 0) * 1.2 + min(duration, 1.0) * 0.28
    if note["note"] < 45 or note["note"] > 84:
        score -= 0.08
    if previous:
        interval = abs(note["note"] - previous["note"])
        if interval == 12:
            score -= 0.08
        elif interval > 12:
            score -= 0.04
    return score


def cleaned_markers(value: Any, duration: float) -> list[float]:
    if not isinstance(value, list):
        return []
    markers = []
    for item in value:
        try:
            marker = float(item)
        except (TypeError, ValueError):
            continue
        if 0 <= marker < max(0.001, duration):
            if not markers or marker - markers[-1] >= 0.07:
                markers.append(marker)
    return markers


def notes_from_markers(
    notes: list[dict[str, Any]],
    markers: list[float],
    settings: dict[str, Any],
    duration: float,
    pitch_track: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    attack = clamp(float(settings.get("manualPitchAttackMs") or 80), 0, 220) / 1000
    window = clamp(float(settings.get("manualPitchWindowMs") or 420), 120, 1200) / 1000
    fallback_window = clamp(float(settings.get("manualPitchFallbackWindowMs") or 760), 260, 1400) / 1000
    min_duration = max(0.06, clamp(float(settings.get("minNoteMs") or 100), 45, 650) / 1000)
    beat_seconds = 60 / clamp(float(settings.get("tempo") or 120), 40, 240)

    for index, marker in enumerate(markers):
        next_marker = markers[index + 1] if index + 1 < len(markers) else min(duration, marker + beat_seconds)
        focus_start = marker + attack
        focus_end = min(duration, max(focus_start + 0.08, min(next_marker, marker + window)))
        pitch_estimate = pitch_estimate_for_window(pitch_track or {}, focus_start, focus_end) if pitch_track else None
        if not pitch_estimate and pitch_track:
            wider_start = max(0.0, marker + min(attack * 0.45, 0.04))
            wider_end = min(duration, max(wider_start + 0.12, min(next_marker, marker + fallback_window)))
            pitch_estimate = pitch_estimate_for_window(pitch_track, wider_start, wider_end)
        best = None
        best_score = -1.0
        previous = output[-1] if output else None
        for note in notes:
            overlap = min(note["end"], focus_end) - max(note["start"], focus_start)
            if overlap <= 0:
                continue
            score = overlap * (0.75 + float(note.get("confidence") or 0))
            score += min(note["end"] - note["start"], window) * 0.08
            if previous:
                interval = abs(note["note"] - previous["note"])
                if interval == 12:
                    score -= 0.025
                elif interval > 14:
                    score -= 0.015
            if score > best_score:
                best = note
                best_score = score
        if not best:
            best = best_note_near_marker(notes, marker, next_marker, fallback_window)
        fallback = fallback_marker_note(notes, output, markers, index)
        if pitch_estimate and pitch_estimate["confidence"] >= 0.26:
            chosen_note = pitch_estimate["note"]
        elif best:
            chosen_note = best["note"]
        else:
            chosen_note = fallback["note"]
        chosen_velocity = best["velocity"] if best else fallback["velocity"]
        chosen_confidence = max(float(best.get("confidence", 0)) if best else fallback["confidence"], pitch_estimate["confidence"] if pitch_estimate else 0)
        end = max(marker + min_duration, next_marker)
        fallback_end = best["end"] if best else marker + beat_seconds * 0.5
        end = min(duration, end if index + 1 < len(markers) else max(fallback_end, marker + beat_seconds * 0.5))
        item = {
            "note": chosen_note,
            "start": marker,
            "end": max(marker + min_duration, end),
            "velocity": chosen_velocity,
            "confidence": chosen_confidence,
        }
        if not best and not pitch_estimate:
            item["markerFallback"] = True
        if best and best["note"] != chosen_note:
            item["rawBasicPitchNote"] = best["note"]
        if pitch_estimate:
            item["pyinMidi"] = pitch_estimate["midi"]
            item["pyinConfidence"] = pitch_estimate["confidence"]
            item["pyinSupport"] = pitch_estimate["support"]
        output.append(item)
    return output


def best_note_near_marker(
    notes: list[dict[str, Any]],
    marker: float,
    next_marker: float,
    fallback_window: float,
) -> dict[str, Any] | None:
    best = None
    best_score = -1.0
    start = max(0.0, marker - 0.08)
    end = max(start + 0.12, min(next_marker, marker + fallback_window))
    for note in notes:
        overlap = min(note["end"], end) - max(note["start"], start)
        distance = min(abs(note["start"] - marker), abs(note["end"] - marker))
        near_bonus = max(0.0, 0.16 - distance) * 0.35
        if overlap <= 0 and distance > 0.16:
            continue
        score = max(0.0, overlap) * (0.7 + float(note.get("confidence") or 0)) + near_bonus
        if score > best_score:
            best = note
            best_score = score
    return best


def fallback_marker_note(
    notes: list[dict[str, Any]],
    output: list[dict[str, Any]],
    markers: list[float],
    index: int,
) -> dict[str, Any]:
    marker = markers[index]
    if output:
        previous = output[-1]
        return {
            "note": previous["note"],
            "velocity": clamp_int((previous.get("velocity") or 82) * 0.9, 1, 127),
            "confidence": 0.08,
        }

    next_note = None
    next_distance = float("inf")
    for note in notes:
        distance = abs(note["start"] - marker)
        if distance < next_distance:
            next_note = note
            next_distance = distance
    if next_note:
        return {
            "note": next_note["note"],
            "velocity": clamp_int((next_note.get("velocity") or 82) * 0.86, 1, 127),
            "confidence": 0.08,
        }

    return {"note": 60, "velocity": 72, "confidence": 0.04}


class StudioHandler(SimpleHTTPRequestHandler):
    server_version = "HumPitchStudio/2.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), format % args))

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.write_json(engine_probe(load_model=False))
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/analyze":
            self.handle_analyze()
            return
        self.send_error(404, "Not found")

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        clean = unquote(parsed.path).lstrip("/")
        if clean == "":
            clean = "index.html"
        full = (ROOT / clean).resolve()
        if ROOT not in full.parents and full != ROOT:
            return str(ROOT / "index.html")
        return str(full)

    def handle_analyze(self) -> None:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.write_json({"ok": False, "error": "Audio upload is missing or too large."}, status=413)
            return

        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": str(length),
                },
            )
            audio_item = form["audio"] if "audio" in form else None
            if audio_item is None or not getattr(audio_item, "file", None):
                raise ValueError("No audio file was uploaded.")
            settings_text = form.getvalue("settings") or "{}"
            duration = float(form.getvalue("duration") or 0)
            settings = json.loads(settings_text)
            suffix = Path(getattr(audio_item, "filename", "") or "input.wav").suffix or ".wav"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                temp_path = Path(tmp.name)
                remaining = length
                while remaining > 0:
                    chunk = audio_item.file.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    tmp.write(chunk)
                    remaining -= len(chunk)
            try:
                notes, elapsed_ms, raw_count = predict_notes(temp_path, settings, duration)
            finally:
                with contextlib.suppress(OSError):
                    os.remove(temp_path)
            self.write_json(
                {
                    "ok": True,
                    "engine": "Basic Pitch + pYIN",
                    "runtime": "ONNX",
                    "notes": notes,
                    "rawCount": raw_count,
                    "duration": duration,
                    "elapsedMs": elapsed_ms,
                    "modelLoaded": _MODEL is not None,
                }
            )
        except Exception as exc:
            self.write_json(
                {
                    "ok": False,
                    "engine": "Basic Pitch",
                    "error": f"{type(exc).__name__}: {exc}",
                    "probe": engine_probe(load_model=False),
                },
                status=500,
            )

    def write_json(self, data: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    parser = argparse.ArgumentParser(description="Hum Pitch Studio local server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    probe = engine_probe(load_model=False)
    print("Hum Pitch Studio local server")
    print(f"URL: http://{args.host}:{args.port}/")
    print(f"Engine: {probe['engine']} / {probe.get('runtime')} / available={probe['available']}")
    if probe.get("error"):
        print(f"Engine error: {probe['error']}")
    print("Press Ctrl+C to stop.")

    server = ThreadingHTTPServer((args.host, args.port), StudioHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
