const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR_SCALE = new Set([0, 2, 4, 5, 7, 9, 11]);
const MINOR_SCALE = new Set([0, 2, 3, 5, 7, 8, 10]);
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || !["analyze", "harmonize"].includes(message.type)) {
    return;
  }

  const startedAt = performance.now();
  try {
    const settings = message.settings;
    const result = message.type === "harmonize"
      ? harmonizeImportedNotes(message.notes || [], message.duration || 0, settings)
      : analyzeAudio(new Float32Array(message.audioData), message.sampleRate, message.duration, settings);
    const midiBytes = writeMidi(result.notes, settings, result.chords);
    self.postMessage(
      {
        type: "done",
        jobId: message.jobId,
        notes: result.notes,
        chords: result.chords,
        key: result.key,
        suggestedKey: result.suggestedKey,
        duration: result.duration || message.duration || 0,
        midiBytes: midiBytes.buffer,
        elapsedMs: performance.now() - startedAt,
      },
      [midiBytes.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      jobId: message.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

function analyzeAudio(input, sampleRate, duration, settings) {
  const resampled = resampleLinear(input, sampleRate, settings.targetSampleRate);
  const data = preprocessAudio(resampled, settings.targetSampleRate, settings);
  const windows = settings.manualMarkers.length ? markerAnalysisWindows(settings.manualMarkers, duration) : null;
  const pitchTrack = estimatePitchTrack(data, settings.targetSampleRate, settings, windows);
  const manualMode = settings.manualMarkers.length > 0;
  const lockedKey = lockedKeyFromSettings(settings);
  let notes = manualMode
    ? markersToNotes(pitchTrack.pitches, pitchTrack.rms, duration, settings, null, pitchTrack)
    : pitchTrackToNotes(pitchTrack.pitches, pitchTrack.rms, settings, pitchTrack);

  let key = lockedKey || null;
  let suggestedKey = lockedKey ? null : detectKey(notes);
  const autoKeySnap = settings.autoKeySnap === true;
  let polishKey = lockedKey || (autoKeySnap ? reliableKeyForSnapping(suggestedKey, notes, settings) : null);
  if (manualMode && settings.manualScaleSnap !== false) {
    const scaleKey = lockedKey || (autoKeySnap ? polishKey : null);
    const allowed = allowedPitchClasses(scaleKey);
    if (allowed) {
      const scaleNotes = markersToNotes(pitchTrack.pitches, pitchTrack.rms, duration, settings, allowed, pitchTrack);
      if (scaleNotes.length) {
        notes = scaleNotes;
        suggestedKey = lockedKey ? null : detectKey(notes) || suggestedKey;
        polishKey = lockedKey || (autoKeySnap ? reliableKeyForSnapping(suggestedKey, notes, settings) : null);
      }
    }
  }
  if (lockedKey) {
    notes = snapNotesToKey(notes, lockedKey);
    key = lockedKey;
    suggestedKey = null;
    polishKey = lockedKey;
  }
  if (settings.polish) {
    notes = polishNotes(notes, polishKey, settings, manualMode);
    if (lockedKey) {
      key = lockedKey;
    } else {
      suggestedKey = detectKey(notes) || suggestedKey;
    }
  }
  const harmonyKey = lockedKey || (settings.useSuggestedKeyForHarmony === true ? suggestedKey : null);
  const chords = settings.harmony && harmonyKey ? generateChords(notes, harmonyKey, settings, duration) : [];
  return { notes, key, suggestedKey, chords };
}

function harmonizeImportedNotes(inputNotes, duration, settings) {
  const lockedKey = lockedKeyFromSettings(settings);
  const preserveCount = Array.isArray(settings.manualMarkers) && settings.manualMarkers.length > 0;
  let notes = sanitizeImportedNotes(inputNotes);
  if (lockedKey) {
    notes = snapNotesToKey(notes, lockedKey);
  }
  if (settings.polish) {
    notes = polishNotes(notes, lockedKey || null, settings, preserveCount);
  } else {
    if (settings.quantize) {
      notes = quantizeTiming(notes, settings);
    }
    notes = enforceOrder(notes, settings);
    if (!settings.quantize) {
      notes = applyLegato(notes, settings);
    }
    notes = smoothVelocities(notes);
  }
  const key = lockedKey || null;
  const suggestedKey = lockedKey ? null : detectKey(notes) || inferKeyFromMelody(notes);
  const endTime = Math.max(duration || 0, ...notes.map((note) => note.end), 0);
  const harmonyKey = lockedKey || (settings.useSuggestedKeyForHarmony === true ? suggestedKey : null);
  const chords = settings.harmony && harmonyKey ? generateChords(notes, harmonyKey, settings, endTime) : [];
  return { notes, key, suggestedKey, chords, duration: endTime };
}

function sanitizeImportedNotes(inputNotes) {
  if (!Array.isArray(inputNotes)) {
    return [];
  }
  return inputNotes
    .map((note) => {
      const start = Math.max(0, Number(note.start) || 0);
      const end = Math.max(start + 0.03, Number(note.end) || start + 0.18);
      const markerStart = note.markerStart == null ? null : Number(note.markerStart);
      const markerIndex = note.markerIndex == null ? null : Number(note.markerIndex);
      return {
        note: noteMidiValue(note),
        start,
        end,
        velocity: clampInt(note.velocity || 86, 1, 127),
        confidence: Number(note.confidence) || 0,
        pyinMidi: Number.isFinite(Number(note.pyinMidi)) ? Number(note.pyinMidi) : null,
        pyinConfidence: Number(note.pyinConfidence) || 0,
        rawBasicPitchNote: Number.isFinite(Number(note.rawBasicPitchNote)) ? Number(note.rawBasicPitchNote) : null,
        markerStart: Number.isFinite(markerStart) ? markerStart : null,
        markerIndex: Number.isFinite(markerIndex) ? Math.round(markerIndex) : null,
        manualMarker: note.manualMarker === true || Number.isFinite(markerStart),
        audioConfidence: Math.max(Number(note.confidence) || 0, Number(note.pyinConfidence) || 0),
        audioAgreement: Number(note.pyinConfidence) || Number(note.confidence) || 0,
        audioOctaveSupport: Number(note.pyinConfidence) || Number(note.confidence) || 0,
        rawNote: Number.isFinite(note.rawBasicPitchNote) ? note.rawBasicPitchNote : note.note,
      };
    })
    .filter((note) => note.end - note.start >= 0.025)
    .sort((a, b) => a.start - b.start || a.note - b.note);
}

function lockedKeyFromSettings(settings) {
  const key = settings.lockedKey;
  if (!key || !Number.isFinite(key.tonic)) {
    return null;
  }
  const mode = key.mode === "minor" ? "minor" : "major";
  const tonic = ((Math.round(key.tonic) % 12) + 12) % 12;
  return {
    tonic,
    mode,
    score: Number.POSITIVE_INFINITY,
    name: `${NOTE_NAMES[tonic]} ${mode}`,
  };
}

function snapNotesToKey(notes, key) {
  const allowed = allowedPitchClasses(key);
  if (!allowed) {
    return notes;
  }
  return snapAllOutOfKeyToAllowed(notes, allowed);
}

function snapAllOutOfKeyToAllowed(notes, allowed) {
  return notes.map((note) => {
    const noteValue = noteMidiValue(note);
    if (allowed.has(noteValue % 12)) {
      return { ...note, note: noteValue };
    }
    const audioMidi = noteAudioMidiForKeySnap(note);
    return {
      ...note,
      note: nearestAllowedMidi(audioMidi, allowed),
      keySnapSourceMidi: audioMidi,
    };
  });
}

function noteAudioMidiForKeySnap(note) {
  const candidates = [
    Number(note.pyinMidi),
    Number(note.rawNote),
    Number(note.rawBasicPitchNote),
    Number(note.note),
  ];
  const found = candidates.find((value) => Number.isFinite(value) && value >= 0 && value <= 127);
  return found ?? 60;
}

function nearestAllowedMidi(midi, allowed) {
  let best = clampInt(midi, 0, 127);
  let bestDistance = Infinity;
  const start = Math.max(0, Math.floor(midi - 6));
  const end = Math.min(127, Math.ceil(midi + 6));
  for (let candidate = start; candidate <= end; candidate += 1) {
    if (!allowed.has(candidate % 12)) continue;
    const distance = Math.abs(candidate - midi);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function reliableKeyForSnapping(key, notes, settings) {
  if (!key || !notes.length) {
    return null;
  }
  if (!Number.isFinite(key.score)) {
    return key;
  }
  const scoreThreshold = clampNumber(settings.autoKeySnapScore ?? 0.58, 0.2, 0.95);
  const confidenceThreshold = clampNumber(settings.autoKeySnapConfidence ?? 0.08, 0, 0.5);
  const confidence = Number.isFinite(key.confidence) ? key.confidence : 0;
  return key.score >= scoreThreshold && confidence >= confidenceThreshold ? key : null;
}

function preprocessAudio(data, sampleRate, settings) {
  if (!data.length) {
    return data;
  }
  const output = new Float32Array(data.length);
  let mean = 0;
  for (let i = 0; i < data.length; i += 1) {
    mean += data[i];
  }
  mean /= data.length;
  for (let i = 0; i < data.length; i += 1) {
    output[i] = data[i] - mean;
  }

  const highCut = Math.max(35, Math.min(settings.fmin * 0.45, 120));
  const lowCut = Math.min(sampleRate * 0.45, Math.max(settings.fmax * 3, 1800));
  highPassInPlace(output, sampleRate, highCut);
  lowPassInPlace(output, sampleRate, lowCut);
  normalizeInPlace(output, 0.9, 8);
  return output;
}

function highPassInPlace(data, sampleRate, cutoff) {
  if (!cutoff || cutoff <= 0 || !data.length) {
    return;
  }
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoff);
  const alpha = rc / (rc + dt);
  let previousInput = data[0];
  let previousOutput = 0;
  for (let i = 0; i < data.length; i += 1) {
    const input = data[i];
    const output = alpha * (previousOutput + input - previousInput);
    data[i] = output;
    previousInput = input;
    previousOutput = output;
  }
}

function lowPassInPlace(data, sampleRate, cutoff) {
  if (!cutoff || cutoff <= 0 || cutoff >= sampleRate * 0.49 || !data.length) {
    return;
  }
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoff);
  const alpha = dt / (rc + dt);
  let output = data[0];
  for (let i = 0; i < data.length; i += 1) {
    output += alpha * (data[i] - output);
    data[i] = output;
  }
}

function normalizeInPlace(data, targetPeak, maxGain) {
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak < 1e-5 || peak >= targetPeak) {
    return;
  }
  const gain = Math.min(maxGain, targetPeak / peak);
  for (let i = 0; i < data.length; i += 1) {
    data[i] *= gain;
  }
}

function markerAnalysisWindows(markers, duration) {
  const windows = [];
  for (let index = 0; index < markers.length; index += 1) {
    const next = markers[index + 1] ?? duration;
    const start = Math.max(0, markers[index] - 0.08);
    const end = Math.min(duration, Math.min(next, markers[index] + 0.74) + 0.08);
    if (end > start) {
      windows.push({ start, end });
    }
  }
  windows.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function estimatePitchTrack(data, sampleRate, settings, windows) {
  const frameSize = Math.max(64, Math.round(sampleRate * settings.frameMs / 1000));
  const hopSize = Math.max(32, Math.round(sampleRate * settings.hopMs / 1000));
  const minLag = Math.max(1, Math.floor(sampleRate / settings.fmax));
  const maxLag = Math.min(frameSize - 2, Math.ceil(sampleRate / settings.fmin));
  const frameCount = Math.max(1, Math.floor((data.length + frameSize) / hopSize));
  const rms = new Float32Array(frameCount);
  const window = hannWindow(frameSize);
  const frameBuffer = new Float32Array(frameSize);
  const yinBuffer = new Float32Array(Math.max(1, maxLag + 1));
  const candidatesByFrame = Array.from({ length: frameCount }, () => []);
  const activeRanges = frameRangesForWindows(windows, frameCount, hopSize, frameSize, sampleRate);

  for (const range of activeRanges) {
    for (let frameIndex = range.start; frameIndex < range.end; frameIndex += 1) {
      const start = frameIndex * hopSize - Math.floor(frameSize / 2);
      rms[frameIndex] = frameRms(data, start, frameSize);
    }
  }

  const startNoise = estimateStartNoise(data, sampleRate, frameSize, hopSize, settings);
  const threshold = estimateVoicingThreshold(rms, activeRanges, settings, startNoise);
  for (const range of activeRanges) {
    for (let frameIndex = range.start; frameIndex < range.end; frameIndex += 1) {
      if (rms[frameIndex] < threshold) {
        continue;
      }
      const start = frameIndex * hopSize - Math.floor(frameSize / 2);
      candidatesByFrame[frameIndex] = estimateFramePitchCandidates(
        data,
        start,
        frameSize,
        window,
        sampleRate,
        minLag,
        maxLag,
        settings,
        frameBuffer,
        yinBuffer,
      );
    }
  }

  const tracked = trackPitchCandidates(candidatesByFrame, activeRanges, settings);
  const rawMidi = pitchesToMidiArray(tracked.pitches);
  const smoothed = smoothPitches(tracked.pitches, activeRanges);
  return {
    pitches: stabilizePitchTrack(smoothed, activeRanges, tracked),
    rawMidi,
    rms,
    scores: tracked.scores,
    octavePenalties: tracked.octavePenalties,
  };
}

function frameRangesForWindows(windows, frameCount, hopSize, frameSize, sampleRate) {
  if (!windows || !windows.length) {
    return [{ start: 0, end: frameCount }];
  }

  const ranges = [];
  for (const window of windows) {
    const startFrame = Math.max(
      0,
      Math.floor((window.start * sampleRate - frameSize) / hopSize),
    );
    const endFrame = Math.min(
      frameCount,
      Math.ceil((window.end * sampleRate + frameSize) / hopSize),
    );
    if (endFrame > startFrame) {
      ranges.push({ start: startFrame, end: endFrame });
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function estimateFramePitchCandidates(data, start, frameSize, window, sampleRate, minLag, maxLag, settings, frame, yin) {
  let mean = 0;
  for (let i = 0; i < frameSize; i += 1) {
    const value = data[start + i] || 0;
    frame[i] = value;
    mean += value;
  }
  mean /= frameSize;
  for (let i = 0; i < frameSize; i += 1) {
    frame[i] = (frame[i] - mean) * window[i];
  }

  let runningSum = 0;
  let bestTau = 0;
  let bestValue = Infinity;
  yin[0] = 1;
  for (let tau = 1; tau <= maxLag; tau += 1) {
    let sum = 0;
    const length = frameSize - tau;
    for (let i = 0; i < length; i += 1) {
      const difference = frame[i] - frame[i + tau];
      sum += difference * difference;
    }
    runningSum += sum;
    const value = runningSum > 1e-12 ? (sum * tau) / runningSum : 1;
    yin[tau] = value;
    if (tau >= minLag && value < bestValue) {
      bestValue = value;
      bestTau = tau;
    }
  }

  let chosenTau = 0;
  const threshold = settings.yinThreshold ?? 0.14;
  for (let tau = minLag; tau <= maxLag; tau += 1) {
    if (yin[tau] < threshold) {
      while (tau + 1 <= maxLag && yin[tau + 1] < yin[tau]) {
        tau += 1;
      }
      chosenTau = tau;
      break;
    }
  }
  if (!chosenTau && bestValue <= Math.max(0.28, threshold * 1.9)) {
    chosenTau = bestTau;
  }
  return collectPitchCandidates(frame, yin, chosenTau || bestTau, minLag, maxLag, sampleRate, settings);
}

function estimateFramePitch(data, start, frameSize, window, sampleRate, minLag, maxLag, settings, frame, yin) {
  const candidates = estimateFramePitchCandidates(
    data,
    start,
    frameSize,
    window,
    sampleRate,
    minLag,
    maxLag,
    settings,
    frame,
    yin,
  );
  const candidate = candidates[0];
  if (!candidate) {
    return 0;
  }
  return candidate.freq;
}

function choosePitchCandidate(frame, yin, primaryTau, minLag, maxLag, sampleRate, settings) {
  return collectPitchCandidates(frame, yin, primaryTau, minLag, maxLag, sampleRate, settings)[0] || null;
}

function collectPitchCandidates(frame, yin, primaryTau, minLag, maxLag, sampleRate, settings) {
  const candidates = new Map();
  const addCandidate = (tau, sourceBonus = 0) => {
    const rounded = Math.round(tau);
    if (rounded < minLag || rounded > maxLag || candidates.has(rounded)) {
      return;
    }
    const value = yin[rounded] ?? 1;
    const corr = normalizedCorrelation(frame, rounded);
    if (corr < 0.055 || value > 0.82) {
      return;
    }
    const refinedTau = refineTau(yin, rounded, minLag, maxLag);
    const freq = sampleRate / refinedTau;
    if (freq < settings.fmin || freq > settings.fmax) {
      return;
    }
    const midi = 69 + 12 * Math.log2(freq / 440);
    const dipScore = Math.max(0, 1 - value);
    const corrScore = Math.max(0, corr);
    const voicePrior = 1 - Math.max(0, freq - 760) / 1200;
    const fundamentalBias = Math.min(0.13, Math.log2(Math.max(1, rounded / minLag)) * 0.026);
    const localBonus = isLocalMinimum(yin, rounded, minLag, maxLag) ? 0.04 : 0;
    const centerPenalty = Math.min(0.08, Math.abs(midi - Math.round(midi)) * 0.045);
    const octaveEvidence = octaveAmbiguityEvidence(frame, yin, rounded, minLag, maxLag, corr, value);
    const score = dipScore * 0.56
      + corrScore * 0.44
      + fundamentalBias
      + localBonus
      + sourceBonus
      + voicePrior * 0.025
      - centerPenalty
      - octaveEvidence.penalty;
    candidates.set(rounded, {
      tau: rounded,
      refinedTau,
      freq,
      midi,
      value,
      corr,
      score,
      octavePenalty: octaveEvidence.penalty,
    });
  };

  if (primaryTau) {
    addCandidate(primaryTau, 0.07);
    addCandidate(primaryTau * 2, 0.025);
    addCandidate(primaryTau / 2, -0.09);
    addCandidate(primaryTau * 3, -0.035);
    addCandidate(primaryTau * 4, -0.075);
  }

  const threshold = settings.yinThreshold ?? 0.14;
  for (let tau = minLag; tau <= maxLag; tau += 1) {
    const value = yin[tau] ?? 1;
    if (value < Math.max(0.48, threshold * 3.25) && isLocalMinimum(yin, tau, minLag, maxLag)) {
      addCandidate(tau, value < threshold ? 0.055 : 0);
      addCandidate(tau * 2, value < threshold ? 0.035 : 0.005);
      addCandidate(tau * 4, value < threshold ? -0.025 : -0.055);
    }
  }

  const values = [...candidates.values()];
  if (!values.length) {
    return [];
  }

  const sorted = values.sort((a, b) => b.score - a.score);
  const bestScore = sorted[0].score;
  return sorted
    .filter((candidate) => candidate.score >= Math.max(0.26, bestScore - 0.32))
    .slice(0, 7);
}

function trackPitchCandidates(candidatesByFrame, ranges, settings) {
  const output = {
    pitches: new Float32Array(candidatesByFrame.length),
    scores: new Float32Array(candidatesByFrame.length),
    octavePenalties: new Float32Array(candidatesByFrame.length),
  };
  const maxGapFrames = Math.max(2, Math.round(70 / settings.hopMs));
  for (const range of ranges) {
    let segment = [];
    let lastFrame = -Infinity;
    for (let frame = range.start; frame < range.end; frame += 1) {
      const candidates = candidatesByFrame[frame] || [];
      if (!candidates.length) {
        continue;
      }
      if (segment.length && frame - lastFrame > maxGapFrames) {
        writeTrackedSegment(output, segment, settings);
        segment = [];
      }
      segment.push({ frame, candidates });
      lastFrame = frame;
    }
    if (segment.length) {
      writeTrackedSegment(output, segment, settings);
    }
  }
  return output;
}

function writeTrackedSegment(output, segment, settings) {
  if (!segment.length) {
    return;
  }
  const statesByStep = [];
  for (let step = 0; step < segment.length; step += 1) {
    const { frame, candidates } = segment[step];
    const previousStates = statesByStep[step - 1] || [];
    const states = candidates.map((candidate) => {
      const emission = candidateEmissionCost(candidate);
      if (!previousStates.length) {
        return { candidate, frame, cost: emission, previous: null };
      }
      let bestPrevious = null;
      let bestCost = Infinity;
      for (const previous of previousStates) {
        const gap = Math.max(1, frame - previous.frame);
        const transition = candidateTransitionCost(previous.candidate, candidate, gap, settings);
        const cost = previous.cost + transition;
        if (cost < bestCost) {
          bestPrevious = previous;
          bestCost = cost;
        }
      }
      return { candidate, frame, cost: bestCost + emission, previous: bestPrevious };
    });
    statesByStep.push(states);
  }

  let best = null;
  const lastStates = statesByStep[statesByStep.length - 1] || [];
  for (const state of lastStates) {
    if (!best || state.cost < best.cost) {
      best = state;
    }
  }
  if (!best) {
    return;
  }
  const selected = [];
  let cursor = best;
  while (cursor) {
    selected.push(cursor);
    cursor = cursor.previous;
  }
  selected.reverse();
  for (let index = 0; index < selected.length; index += 1) {
    const state = selected[index];
    output.pitches[state.frame] = state.candidate.freq;
    output.scores[state.frame] = state.candidate.score;
    output.octavePenalties[state.frame] = state.candidate.octavePenalty || 0;
    const next = selected[index + 1];
    if (next && next.frame - state.frame > 1 && next.frame - state.frame <= 4) {
      const distance = Math.abs(next.candidate.midi - state.candidate.midi);
      if (distance <= 1.2) {
        for (let frame = state.frame + 1; frame < next.frame; frame += 1) {
          const ratio = (frame - state.frame) / (next.frame - state.frame);
          const midi = lerp(state.candidate.midi, next.candidate.midi, ratio);
          output.pitches[frame] = 440 * 2 ** ((midi - 69) / 12);
          output.scores[frame] = Math.min(state.candidate.score, next.candidate.score) * 0.92;
          output.octavePenalties[frame] = Math.max(
            state.candidate.octavePenalty || 0,
            next.candidate.octavePenalty || 0,
          );
        }
      }
    }
  }
}

function candidateEmissionCost(candidate) {
  const confidence = clampNumber(candidate.score, 0, 1.35);
  const tuningPenalty = Math.abs(candidate.midi - Math.round(candidate.midi)) * 0.16;
  const weakDipPenalty = Math.max(0, candidate.value - 0.18) * 0.45;
  return Math.max(0.02, 1.12 - confidence) + tuningPenalty + weakDipPenalty;
}

function candidateTransitionCost(previous, current, gap, settings) {
  const interval = Math.abs(current.midi - previous.midi);
  const seconds = gap * settings.hopMs / 1000;
  const glideAllowance = seconds > 0.08 ? 7 : 4.5;
  let cost = 0.05 * gap + interval * 0.035 + Math.max(0, interval - glideAllowance) ** 1.28 * 0.12;
  const octaveLike = Math.min(
    Math.abs(interval - 12),
    Math.abs(interval - 24),
  );
  if (octaveLike < 1.2 && interval > 9) {
    const confidentLeap = Math.min(previous.score, current.score) > 0.86
      && (previous.octavePenalty || 0) < 0.09
      && (current.octavePenalty || 0) < 0.09;
    cost += confidentLeap ? 0.48 - octaveLike * 0.16 : 1.35 - octaveLike * 0.35;
  }
  const confidentSpan = Math.min(previous.score, current.score) > 0.9
    && (previous.octavePenalty || 0) < 0.08
    && (current.octavePenalty || 0) < 0.08;
  if (confidentSpan && interval > 7) {
    cost -= Math.min(0.38, (interval - 7) * 0.055);
  }
  const directionFlipPenalty = previous.score > current.score + 0.16 && interval > 7 ? 0.25 : 0;
  return cost + directionFlipPenalty;
}

function normalizedCorrelation(frame, tau) {
  let sum = 0;
  let energyA = 0;
  let energyB = 0;
  const length = frame.length - tau;
  if (length <= 8) {
    return 0;
  }
  for (let i = 0; i < length; i += 1) {
    const a = frame[i];
    const b = frame[i + tau];
    sum += a * b;
    energyA += a * a;
    energyB += b * b;
  }
  return sum / Math.sqrt(Math.max(energyA * energyB, 1e-12));
}

function octaveAmbiguityEvidence(frame, yin, tau, minLag, maxLag, corr, value) {
  const dip = Math.max(0, 1 - value);
  const lower = periodEvidence(frame, yin, tau * 2, minLag, maxLag);
  const higher = periodEvidence(frame, yin, tau / 2, minLag, maxLag);
  let penalty = 0;

  if (lower && lower.corr > 0.08 && lower.value < 0.78) {
    const dipGain = lower.dip - dip;
    const corrGain = lower.corr - corr;
    if (dipGain > 0.11 && corrGain > 0.035) {
      penalty += 0.2;
    } else if (lower.local && dipGain > 0.07 && lower.corr >= corr * 0.98) {
      penalty += 0.11;
    }
  }

  if (higher && higher.corr > 0.08 && higher.value < 0.78) {
    const dipGain = higher.dip - dip;
    const corrGain = higher.corr - corr;
    if (dipGain > 0.14 && corrGain > 0.05) {
      penalty += 0.14;
    } else if (higher.local && dipGain > 0.09 && higher.corr >= corr + 0.025) {
      penalty += 0.08;
    }
  }

  return { penalty: Math.min(0.28, penalty) };
}

function periodEvidence(frame, yin, tau, minLag, maxLag) {
  const rounded = Math.round(tau);
  if (rounded < minLag || rounded > maxLag) {
    return null;
  }
  const value = yin[rounded] ?? 1;
  return {
    tau: rounded,
    value,
    dip: Math.max(0, 1 - value),
    corr: normalizedCorrelation(frame, rounded),
    local: isLocalMinimum(yin, rounded, minLag, maxLag),
  };
}

function isLocalMinimum(values, index, minIndex, maxIndex) {
  const center = values[index] ?? 1;
  const left = values[Math.max(minIndex, index - 1)] ?? 1;
  const right = values[Math.min(maxIndex, index + 1)] ?? 1;
  return center <= left && center <= right;
}

function refineTau(yin, tau, minTau, maxTau) {
  if (tau <= minTau || tau >= maxTau) {
    return tau;
  }
  const left = yin[tau - 1];
  const center = yin[tau];
  const right = yin[tau + 1];
  const denominator = left - 2 * center + right;
  if (Math.abs(denominator) < 1e-9) {
    return tau;
  }
  const offset = 0.5 * (left - right) / denominator;
  return tau + Math.max(-0.5, Math.min(0.5, offset));
}

function pitchTrackToNotes(pitches, rms, settings, evidence = null) {
  const hopSeconds = settings.hopMs / 1000;
  const rawMidi = evidence?.rawMidi || pitchesToMidiArray(pitches);
  const midi = new Int16Array(pitches.length);
  for (let i = 0; i < pitches.length; i += 1) {
    if (pitches[i] > 0) {
      midi[i] = Math.round(69 + 12 * Math.log2(pitches[i] / 440));
    }
  }
  flattenVibratoRegions(midi, settings);
  fillShortGaps(midi, Math.round(90 / settings.hopMs));
  modeFilter(midi, 5);
  flattenVibratoRegions(midi, settings);
  removeUnstableRuns(midi, Math.max(2, Math.ceil(settings.minNoteMs / settings.hopMs)));
  fillShortGaps(midi, Math.round(90 / settings.hopMs));

  const notes = [];
  let current = 0;
  let startFrame = 0;
  let velocitySum = 0;
  let velocityCount = 0;
  for (let frame = 0; frame < midi.length; frame += 1) {
    const note = midi[frame];
    if (note === current) {
      if (note) {
        velocitySum += rms[frame];
        velocityCount += 1;
      }
      continue;
    }
    if (current) {
      notes.push(makeNote(
        current,
        startFrame * hopSeconds,
        frame * hopSeconds,
        velocitySum,
        velocityCount,
        summarizeAudioOctaveEvidence(rawMidi, evidence, startFrame, frame, current),
      ));
    }
    current = note;
    startFrame = frame;
    velocitySum = note ? rms[frame] : 0;
    velocityCount = note ? 1 : 0;
  }
  if (current) {
    notes.push(makeNote(
      current,
      startFrame * hopSeconds,
      midi.length * hopSeconds,
      velocitySum,
      velocityCount,
      summarizeAudioOctaveEvidence(rawMidi, evidence, startFrame, midi.length, current),
    ));
  }
  const minDuration = settings.minNoteMs / 1000;
  return mergeAdjacent(notes.filter((note) => note.end - note.start >= minDuration), 0.09);
}

function markersToNotes(pitches, rms, duration, settings, allowed = null, evidence = null) {
  const markers = settings.manualMarkers;
  const hopSeconds = settings.hopMs / 1000;
  const minDuration = Math.max(settings.minNoteMs / 1000, 0.12);
  const slots = [];
  let previousNote = null;
  for (let i = 0; i < markers.length; i += 1) {
    const start = markers[i];
    const next = i + 1 < markers.length ? markers[i + 1] : null;
    const end = next ?? estimateLastMarkerEnd(pitches, start, duration, hopSeconds, minDuration);
    const window = manualMarkerPitchWindow(start, next, duration, settings, false);
    const note = noteFromWindow(pitches, rms, window.start, window.end, hopSeconds, settings, allowed, previousNote, evidence);
    if (!note) {
      const fallbackWindow = manualMarkerPitchWindow(start, next, duration, settings, true);
      const fallback = noteFromWindow(
        pitches,
        rms,
        fallbackWindow.start,
        fallbackWindow.end,
        hopSeconds,
        settings,
        allowed,
        previousNote,
        evidence,
      );
      slots.push({
        note: fallback?.note ?? null,
        velocity: fallback?.velocity ?? null,
        audioConfidence: fallback?.audioConfidence ?? 0,
        octaveAmbiguity: fallback?.octaveAmbiguity ?? 1,
        audioAgreement: fallback?.audioAgreement ?? 0,
        audioOctaveSupport: fallback?.audioOctaveSupport ?? 0,
        start,
        end: Math.max(start + minDuration, end),
        markerStart: start,
        markerIndex: i,
      });
      if (fallback) {
        previousNote = fallback.note;
      }
    } else {
      slots.push({ ...note, start, end: Math.max(start + minDuration, end), markerStart: start, markerIndex: i });
      previousNote = note.note;
    }
  }
  const notes = completeManualNoteSlots(slots, allowed);
  return enforceOrder(notes, settings);
}

function manualMarkerPitchWindow(start, next, duration, settings, fallback) {
  const attack = (fallback ? -55 : clampNumber(settings.manualPitchAttackMs ?? 80, 0, 180)) / 1000;
  const preferredLength = clampNumber(settings.manualPitchWindowMs ?? 420, 160, 900) / 1000;
  const fallbackLength = clampNumber(settings.manualPitchFallbackWindowMs ?? 680, 260, 1100) / 1000;
  const maxLength = fallback ? fallbackLength : preferredLength;
  const nextLimit = next == null ? duration : Math.max(start + 0.08, next - 0.035);
  const windowStart = Math.max(0, start + attack);
  let windowEnd = Math.min(duration, nextLimit, start + maxLength);
  if (windowEnd - windowStart < 0.08) {
    windowEnd = Math.min(duration, Math.max(windowStart + 0.08, start + Math.min(maxLength, 0.22)));
  }
  return { start: windowStart, end: Math.max(windowStart + 0.04, windowEnd) };
}

function noteFromWindow(pitches, rms, start, end, hopSeconds, settings, allowed = null, previousNote = null, evidence = null) {
  const startFrame = Math.max(0, Math.floor(start / hopSeconds));
  const endFrame = Math.min(pitches.length, Math.max(startFrame + 1, Math.ceil(end / hopSeconds) + 1));
  const frames = [];
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    if (pitches[frame] > 0) {
      frames.push({
        frame,
        time: frame * hopSeconds,
        midiFloat: 69 + 12 * Math.log2(pitches[frame] / 440),
        rms: rms[frame],
      });
    }
  }
  if (!frames.length) {
    return null;
  }
  const chosen = chooseStableManualPitch(frames, start, end, settings, allowed, previousNote);
  return {
    note: chosen.note,
    velocity: rmsToVelocity(chosen.velocitySum, chosen.velocityCount),
    ...summarizeAudioOctaveEvidence(evidence?.rawMidi || pitchesToMidiArray(pitches), evidence, startFrame, endFrame, chosen.note),
  };
}

function summarizeAudioOctaveEvidence(rawMidi, evidence, startFrame, endFrame, note) {
  let count = 0;
  let scoreSum = 0;
  let penaltySum = 0;
  let sameOctave = 0;
  let octaveConflict = 0;
  const rawValues = [];
  const scores = evidence?.scores;
  const penalties = evidence?.octavePenalties;
  for (let frame = Math.max(0, startFrame); frame < Math.min(rawMidi.length, endFrame); frame += 1) {
    const raw = rawMidi[frame];
    if (!raw) {
      continue;
    }
    const score = scores?.[frame] || 0.58;
    const penalty = penalties?.[frame] ?? 0.18;
    count += 1;
    scoreSum += score;
    penaltySum += penalty;
    rawValues.push(raw);
    if (Math.abs(raw - note) <= 1.35) {
      sameOctave += 1;
    } else if (Math.min(Math.abs(raw - note - 12), Math.abs(raw - note + 12)) <= 1.35) {
      octaveConflict += 1;
    }
  }
  if (!count) {
    return {
      audioConfidence: 0,
      octaveAmbiguity: 1,
      audioAgreement: 0,
      audioOctaveConflict: 0,
      audioOctaveSupport: 0,
      rawNote: note,
    };
  }
  const confidence = clampNumber(scoreSum / count, 0, 1.35);
  const ambiguity = clampNumber(penaltySum / count, 0, 1);
  const agreement = sameOctave / count;
  const conflict = octaveConflict / count;
  const rawNote = clampInt(Math.round(median(rawValues)), 0, 127);
  const support = clampNumber(agreement * clampNumber((confidence - 0.48) / 0.48, 0, 1.15) * (1 - Math.min(0.75, ambiguity * 2.8)), 0, 1);
  return {
    audioConfidence: confidence,
    octaveAmbiguity: ambiguity,
    audioAgreement: agreement,
    audioOctaveConflict: conflict,
    audioOctaveSupport: support,
    rawNote,
  };
}

function chooseStableManualPitch(frames, start, end, settings, allowed = null, previousNote = null) {
  const sortedRms = frames.map((frame) => frame.rms).sort((a, b) => a - b);
  const rmsGate = sortedRms[Math.floor(sortedRms.length * 0.35)] * 0.65;
  const duration = Math.max(0.001, end - start);
  const bins = new Map();
  for (const frame of frames) {
    if (frame.rms < rmsGate && frames.length > 3) {
      continue;
    }
    const candidates = allowed
      ? nearbyAllowedNotes(frame.midiFloat, allowed, 5, previousNote)
      : [{ note: clampInt(Math.round(frame.midiFloat), 0, 127), distance: Math.abs(frame.midiFloat - Math.round(frame.midiFloat)) }];
    const position = clampNumber((frame.time - start) / duration, 0, 1);
    const focus = clampNumber(settings.manualPitchFocus ?? 0.62, 0.4, 0.8);
    const centerWeight = 1 + 0.52 * Math.max(0, 1 - Math.abs(position - focus) / 0.45);
    for (const candidate of candidates) {
      const pitchCenterWeight = Math.max(0.12, 1 - candidate.distance * 0.42);
      const melodicWeight = previousNote == null
        ? 1
        : Math.max(0.38, 1 - Math.max(0, Math.abs(candidate.note - previousNote) - 5) * 0.075);
      const octaveCorrectionWeight = candidate.octaveShift ? 0.74 : 1;
      const weight = Math.max(0.0001, frame.rms) ** 0.65 * centerWeight * pitchCenterWeight ** 2 * melodicWeight;
      if (!bins.has(candidate.note)) {
        bins.set(candidate.note, {
          note: candidate.note,
          weight: 0,
          velocitySum: 0,
          velocityCount: 0,
          distances: [],
          frames: [],
        });
      }
      const bin = bins.get(candidate.note);
      bin.weight += weight * octaveCorrectionWeight;
      bin.velocitySum += frame.rms * pitchCenterWeight;
      bin.velocityCount += pitchCenterWeight;
      bin.distances.push(candidate.distance);
      bin.frames.push(frame.frame);
    }
  }

  if (!bins.size) {
    const midiValues = frames.map((frame) => frame.midiFloat);
    const rmsSum = frames.reduce((sum, frame) => sum + frame.rms, 0);
    return {
      note: clampInt(Math.round(median(midiValues)), 0, 127),
      velocitySum: rmsSum,
      velocityCount: frames.length,
    };
  }

  let best = null;
  let bestScore = -Infinity;
  for (const bin of bins.values()) {
    const runBonus = 1 + Math.min(0.55, longestConsecutiveRun(bin.frames) * 0.07);
    const distancePenalty = Math.max(0.55, 1 - median(bin.distances) * 0.22);
    const score = bin.weight * runBonus * distancePenalty;
    if (score > bestScore) {
      best = bin;
      bestScore = score;
    }
  }
  return {
    note: best.note,
    velocitySum: best.velocitySum,
    velocityCount: best.velocityCount,
  };
}

function nearbyAllowedNotes(midiFloat, allowed, limit, previousNote = null) {
  const center = clampInt(Math.round(midiFloat), 0, 127);
  const candidates = [];
  const addAround = (shift, octavePenaltyScale) => {
    const shiftedFloat = midiFloat + shift;
    const shiftedCenter = clampInt(Math.round(shiftedFloat), 0, 127);
    for (let note = Math.max(0, shiftedCenter - 4); note <= Math.min(127, shiftedCenter + 4); note += 1) {
      if (!allowed.has(note % 12)) {
        continue;
      }
      const rawDistance = Math.abs(note - shiftedFloat);
      const octavePenalty = Math.abs(shift) / 12 * octavePenaltyScale;
      const melodicPenalty = previousNote == null ? 0 : Math.max(0, Math.abs(note - previousNote) - 9) * 0.025;
      const distance = rawDistance + octavePenalty + melodicPenalty;
      if (distance <= 2.65) {
        candidates.push({ note, distance, octaveShift: shift !== 0 });
      }
    }
  };

  addAround(0, 0);
  const direct = candidates.filter((candidate) => !candidate.octaveShift);
  if (!direct.length) {
    addAround(-12, 1.25);
    addAround(12, 1.25);
  } else if (previousNote != null && Math.min(...direct.map((candidate) => Math.abs(candidate.note - previousNote))) > 14) {
    addAround(-12, 1.6);
    addAround(12, 1.6);
  }
  if (!candidates.length) {
    const note = nearestAllowedNote(center, allowed);
    candidates.push({ note, distance: Math.abs(note - midiFloat) });
  }
  const unique = new Map();
  for (const candidate of candidates.sort((a, b) => a.distance - b.distance)) {
    if (!unique.has(candidate.note)) {
      unique.set(candidate.note, candidate);
    }
  }
  return [...unique.values()].slice(0, limit);
}

function longestConsecutiveRun(frames) {
  if (!frames.length) {
    return 0;
  }
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  let current = 1;
  let best = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1] + 1) {
      current += 1;
    } else {
      current = 1;
    }
    best = Math.max(best, current);
  }
  return best;
}

function completeManualNoteSlots(slots, allowed) {
  if (!slots.some((slot) => slot.note != null)) {
    return [];
  }
  return slots.map((slot, index) => {
    if (slot.note != null) {
      return {
        note: slot.note,
        start: slot.start,
        end: slot.end,
        velocity: slot.velocity,
        audioConfidence: slot.audioConfidence ?? 0,
        octaveAmbiguity: slot.octaveAmbiguity ?? 1,
        audioAgreement: slot.audioAgreement ?? 0,
        audioOctaveSupport: slot.audioOctaveSupport ?? 0,
        markerStart: slot.markerStart ?? slot.start,
        markerIndex: slot.markerIndex ?? index,
        manualMarker: true,
      };
    }
    const previous = findRecognizedSlot(slots, index, -1);
    const next = findRecognizedSlot(slots, index, 1);
    let note = previous && next
      ? Math.round((previous.note + next.note) / 2)
      : previous?.note ?? next?.note ?? 60;
    if (allowed) {
      note = nearestAllowedNote(note, allowed);
    }
    return {
      note,
      start: slot.start,
      end: slot.end,
      velocity: Math.round((previous?.velocity ?? next?.velocity ?? 72) * 0.9),
      audioConfidence: 0,
      octaveAmbiguity: 1,
      audioAgreement: 0,
      audioOctaveSupport: 0,
      markerStart: slot.markerStart ?? slot.start,
      markerIndex: slot.markerIndex ?? index,
      manualMarker: true,
    };
  });
}

function findRecognizedSlot(slots, index, direction) {
  for (let i = index + direction; i >= 0 && i < slots.length; i += direction) {
    if (slots[i].note != null) {
      return slots[i];
    }
  }
  return null;
}

function polishNotes(notes, key, settings, preserveCount) {
  let polished = [...notes].sort((a, b) => a.start - b.start || a.note - b.note);
  const allowed = allowedPitchClasses(key);
  const strictManualPitch = preserveCount && settings.manualPitchStrict;
  if (allowed && !strictManualPitch) {
    polished = snapUnstableNotesToKey(polished, allowed, settings);
  }
  const octaveSettings = preserveCount ? { ...settings, preserveLargeLeaps: true } : settings;
  polished = correctOctaveIslands(correctGlobalOctaveBias(correctOctaveJumps(polished, octaveSettings)), octaveSettings);
  polished = correctShortTransitionArtifacts(polished, allowed);
  if (!strictManualPitch) {
    polished = correctMelodicOutliers(polished, allowed, octaveSettings);
  }
  if (!preserveCount) {
    polished = mergeAdjacent(polished, 0.09);
  }
  if (settings.quantize) {
    polished = quantizeTiming(polished, settings);
  }
  polished = enforceOrder(polished, settings);
  if (!settings.quantize) {
    polished = applyLegato(polished, settings);
  }
  polished = correctOctaveIslands(polished, octaveSettings);
  return smoothVelocities(polished);
}

function snapUnstableNotesToKey(notes, allowed, settings) {
  const medianVelocity = median(notes.map((note) => note.velocity || 72));
  const maxShortDuration = Math.max(0.16, (settings.minNoteMs || 100) / 1000 * 1.75);
  return notes.map((note, index) => {
    if (allowed.has(note.note % 12)) {
      return note;
    }
    const duration = note.end - note.start;
    const previous = notes[index - 1] || null;
    const next = notes[index + 1] || null;
    const weak = (note.velocity || 72) < medianVelocity * 0.74;
    const short = duration <= maxShortDuration;
    const closeNeighbors = previous && next
      && Math.abs(next.note - previous.note) <= 5
      && note.start - previous.end <= 0.14
      && next.start - note.end <= 0.14;
    const outsideNeighbors = previous && next
      && Math.abs(note.note - previous.note) >= 3
      && Math.abs(note.note - next.note) >= 3;
    if (!short && !weak && !(closeNeighbors && outsideNeighbors)) {
      return note;
    }
    return { ...note, note: nearestAllowedNote(note.note, allowed) };
  });
}

function correctShortTransitionArtifacts(notes, allowed) {
  if (notes.length < 3) {
    return notes;
  }
  const output = notes.map((note) => ({ ...note }));
  for (let i = 1; i < output.length - 1; i += 1) {
    const previous = output[i - 1];
    const current = output[i];
    const next = output[i + 1];
    if (hasReliableAudioOctave(current)) {
      continue;
    }
    const duration = current.end - current.start;
    const previousDuration = previous.end - previous.start;
    const nextDuration = next.end - next.start;
    const previousGap = current.start - previous.end;
    const nextGap = next.start - current.end;
    if (duration > 0.24 || previousDuration < 0.12 || nextDuration < 0.12 || previousGap > 0.12 || nextGap > 0.12) {
      continue;
    }
    const neighborSpan = Math.abs(next.note - previous.note);
    const zigZag = Math.sign(current.note - previous.note) !== Math.sign(next.note - current.note);
    const outsideNeighbors = Math.abs(current.note - previous.note) >= 3 && Math.abs(current.note - next.note) >= 3;
    const likelyGlide = neighborSpan <= 5 && zigZag && outsideNeighbors;
    const nonScaleArtifact = allowed && !allowed.has(current.note % 12) && neighborSpan <= 7;
    if (!likelyGlide && !nonScaleArtifact) {
      continue;
    }
    let target = Math.round((previous.note + next.note) / 2);
    if (Math.abs(current.note - previous.note) < Math.abs(current.note - next.note)) {
      target = previous.note;
    } else if (Math.abs(current.note - next.note) < Math.abs(current.note - previous.note)) {
      target = next.note;
    }
    if (allowed) {
      target = nearestAllowedNote(target, allowed);
    }
    current.note = clampInt(target, 0, 127);
  }
  return output;
}

function correctOctaveJumps(notes, settings = {}) {
  if (notes.length < 3) {
    return notes;
  }
  const center = registerCenter(notes);
  const statesByIndex = [];
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    const variants = octaveVariants(note.note, notes, index, settings);
    const states = variants.map((variant) => {
      const emission = variant.penalty + octaveRangePenalty(variant.note) + octaveRegisterPenalty(variant.note, center);
      if (index === 0) {
        return { ...variant, cost: emission, previous: null };
      }
      let bestPrevious = null;
      let bestCost = Infinity;
      const previousStates = statesByIndex[index - 1];
      const gap = Math.max(0, note.start - notes[index - 1].end);
      for (const previous of previousStates) {
        const transition = octavePathTransition(previous.note, variant.note, gap);
        const cost = previous.cost + transition + emission;
        if (cost < bestCost) {
          bestPrevious = previous;
          bestCost = cost;
        }
      }
      return { ...variant, cost: bestCost, previous: bestPrevious };
    });
    statesByIndex.push(states);
  }
  let best = statesByIndex[statesByIndex.length - 1][0];
  for (const state of statesByIndex[statesByIndex.length - 1]) {
    if (state.cost < best.cost) {
      best = state;
    }
  }
  const chosen = [];
  let cursor = best;
  while (cursor) {
    chosen.push(cursor.note);
    cursor = cursor.previous;
  }
  chosen.reverse();
  return notes.map((note, index) => {
    const chosenNote = chosen[index] ?? note.note;
    if (chosenNote !== note.note && hasReliableAudioOctave(note)) {
      return { ...note };
    }
    if (chosenNote !== note.note && intentionalLeapProtection(notes, index, settings) >= 1.25) {
      return { ...note };
    }
    return { ...note, note: chosenNote };
  });
}

function octaveVariants(note, notes = [], index = 0, settings = {}) {
  const variants = [];
  const protection = intentionalLeapProtection(notes, index, settings) + audioOctaveProtection(notes[index]);
  for (const shift of [-24, -12, 0, 12, 24]) {
    const candidate = note + shift;
    if (candidate < 0 || candidate > 127) {
      continue;
    }
    const penalty = shift === 0 ? 0 : Math.abs(shift) / 12 * (2.15 + protection);
    variants.push({ note: candidate, penalty });
  }
  return variants;
}

function registerCenter(notes) {
  const values = [];
  for (const note of notes) {
    const repeats = Math.max(1, Math.round((note.end - note.start) / 0.12));
    for (let i = 0; i < repeats; i += 1) {
      values.push(note.note);
    }
  }
  return values.length ? median(values) : 60;
}

function octaveRegisterPenalty(note, center) {
  const low = center - 9;
  const high = center + 15;
  if (note < low) {
    return (low - note) ** 1.18 * 0.24;
  }
  if (note > high) {
    return (note - high) ** 1.15 * 0.14;
  }
  return 0;
}

function octaveRangePenalty(note) {
  if (note < 43) return (43 - note) * 0.12;
  if (note > 84) return (note - 84) * 0.12;
  return 0;
}

function octavePathTransition(previous, current, gap) {
  const interval = Math.abs(current - previous);
  const gapRelax = gap > 0.7 ? 0.42 : gap > 0.32 ? 0.72 : 1;
  const leapCost = Math.max(0, interval - 5) ** 1.42 * 0.48;
  return (interval * 0.22 + leapCost) * gapRelax;
}

function correctOctaveIslands(notes, settings = {}) {
  if (notes.length < 5) {
    return notes;
  }
  const output = notes.map((note) => ({ ...note }));
  let index = 0;
  while (index < output.length) {
    const shift = octaveIslandShift(output, index);
    if (!shift) {
      index += 1;
      continue;
    }
    const start = index;
    while (
      index < output.length
      && octaveIslandShift(output, index) === shift
      && (index === start || output[index].start - output[index - 1].end <= 0.28)
    ) {
      index += 1;
    }
    const end = index;
    if (shouldShiftOctaveRun(output, start, end, shift, settings)) {
      for (let i = start; i < end; i += 1) {
        output[i].note = clampInt(output[i].note + shift, 0, 127);
      }
    }
  }
  return output;
}

function octaveIslandShift(notes, index) {
  const local = localRegisterAround(notes, index);
  if (local == null) {
    return 0;
  }
  const diff = notes[index].note - local;
  if (diff <= -9 && diff >= -17 && notes[index].note + 12 <= 127) {
    return 12;
  }
  if (diff >= 9 && diff <= 17 && notes[index].note - 12 >= 0) {
    return -12;
  }
  return 0;
}

function localRegisterAround(notes, index) {
  const before = nearbyContextNotes(notes, index - 1, -1);
  const after = nearbyContextNotes(notes, index + 1, 1);
  if (!before.length || !after.length) {
    return null;
  }
  return median([...before, ...after]);
}

function nearbyContextNotes(notes, start, direction) {
  const values = [];
  let previous = direction < 0 ? start + 1 : start - 1;
  for (let i = start; i >= 0 && i < notes.length && values.length < 4; i += direction) {
    if (previous >= 0 && previous < notes.length) {
      const gap = direction < 0 ? notes[previous].start - notes[i].end : notes[i].start - notes[previous].end;
      if (gap > 1.15) {
        break;
      }
    }
    values.push(notes[i].note);
    previous = i;
  }
  return values;
}

function shouldShiftOctaveRun(notes, start, end, shift, settings = {}) {
  const run = notes.slice(start, end);
  if (!run.length) {
    return false;
  }
  const duration = run[run.length - 1].end - run[0].start;
  if (duration > 2.4 && run.length > 4) {
    return false;
  }
  const intentionalEvidence = runIntentionalLeapEvidence(notes, start, end, settings);
  if (run.some((note) => hasReliableAudioOctave(note))) {
    return false;
  }
  if (intentionalEvidence >= 1.25) {
    return false;
  }
  const before = nearbyContextNotes(notes, start - 1, -1);
  const after = nearbyContextNotes(notes, end, 1);
  if (!before.length || !after.length) {
    return false;
  }
  const local = median([...before, ...after]);
  const originalMedian = median(run.map((note) => note.note));
  const shiftedMedian = originalMedian + shift;
  if (Math.abs(shiftedMedian - local) > Math.abs(originalMedian - local) - 5.5) {
    return false;
  }
  const originalCost = octaveRunBoundaryCost(notes, start, end, 0);
  const shiftedCost = octaveRunBoundaryCost(notes, start, end, shift);
  const requiredGain = 7.5 + intentionalEvidence * 2.2;
  return originalCost - shiftedCost >= requiredGain;
}

function intentionalLeapProtection(notes, index, settings = {}) {
  const note = notes[index];
  if (!note) {
    return 0;
  }
  const beatSeconds = 60 / Math.max(30, settings.tempo || 120);
  const duration = note.end - note.start;
  const velocities = notes.map((item) => item.velocity || 72);
  const medianVelocity = velocities.length ? median(velocities) : 72;
  let score = settings.preserveLargeLeaps ? 0.55 : 0;
  score += audioOctaveProtection(note);
  if (duration >= Math.max(0.24, beatSeconds * 0.38)) {
    score += 0.75;
  }
  if ((note.velocity || 72) >= Math.max(82, medianVelocity * 1.08)) {
    score += 0.55;
  }
  if (beatStrengthAt(note.start, settings) >= 1.35) {
    score += 0.75;
  }
  if (continuesNewRegister(notes, index)) {
    score += 1.05;
  }
  if (landsFromLargeLeap(notes, index)) {
    score += 0.7;
  }
  if (anchorsLargeLeap(notes, index)) {
    score += 0.7;
  }
  if (isShortIsolatedOctaveReturn(notes, index)) {
    score -= 1.1;
  }
  return clampNumber(score, 0, 3);
}

function audioOctaveProtection(note) {
  if (!note || !Number.isFinite(note.audioOctaveSupport)) {
    return 0;
  }
  const support = clampNumber(note.audioOctaveSupport, 0, 1);
  const ambiguity = clampNumber(note.octaveAmbiguity ?? 1, 0, 1);
  if (support >= 0.72 && ambiguity <= 0.1) {
    return 2.4;
  }
  if (support >= 0.58 && ambiguity <= 0.14) {
    return 1.35;
  }
  if (support >= 0.46 && ambiguity <= 0.18) {
    return 0.65;
  }
  return 0;
}

function hasReliableAudioOctave(note) {
  if (!note || !Number.isFinite(note.audioOctaveSupport)) {
    return false;
  }
  const support = clampNumber(note.audioOctaveSupport, 0, 1);
  const ambiguity = clampNumber(note.octaveAmbiguity ?? 1, 0, 1);
  const agreement = clampNumber(note.audioAgreement ?? 0, 0, 1);
  const conflict = clampNumber(note.audioOctaveConflict ?? 0, 0, 1);
  return agreement >= 0.62
    && conflict <= 0.25
    && ((support >= 0.62 && ambiguity <= 0.14) || (support >= 0.74 && ambiguity <= 0.2));
}

function runIntentionalLeapEvidence(notes, start, end, settings = {}) {
  const run = notes.slice(start, end);
  if (!run.length) {
    return 0;
  }
  let score = 0;
  for (let i = start; i < end; i += 1) {
    score = Math.max(score, intentionalLeapProtection(notes, i, settings));
  }
  if (run.length >= 2) {
    const coherent = run.every((note, offset) => {
      if (offset === 0) {
        return true;
      }
      return Math.abs(note.note - run[offset - 1].note) <= 5;
    });
    if (coherent) {
      score += 0.45;
    }
  }
  return score;
}

function continuesNewRegister(notes, index) {
  const note = notes[index];
  const previous = notes[index - 1];
  const next = notes[index + 1];
  const next2 = notes[index + 2];
  if (!note || !previous) {
    return false;
  }
  const enteredByLeap = Math.abs(note.note - previous.note) >= 8;
  if (!enteredByLeap) {
    return false;
  }
  return (next && Math.abs(next.note - note.note) <= 5)
    || (next2 && Math.abs(next2.note - note.note) <= 5);
}

function anchorsLargeLeap(notes, index) {
  const note = notes[index];
  const previous = notes[index - 1];
  const next = notes[index + 1];
  if (!note || !next) {
    return false;
  }
  const leavesByLeap = Math.abs(next.note - note.note) >= 8;
  if (!leavesByLeap) {
    return false;
  }
  const duration = note.end - note.start;
  return duration >= 0.24 || (previous && Math.abs(previous.note - note.note) <= 5);
}

function landsFromLargeLeap(notes, index) {
  const note = notes[index];
  const previous = notes[index - 1];
  if (!note || !previous) {
    return false;
  }
  const duration = note.end - note.start;
  return duration >= 0.24 && Math.abs(note.note - previous.note) >= 8;
}

function isShortIsolatedOctaveReturn(notes, index) {
  const note = notes[index];
  const previous = notes[index - 1];
  const next = notes[index + 1];
  if (!note || !previous || !next) {
    return false;
  }
  const duration = note.end - note.start;
  return duration < 0.34
    && Math.abs(note.note - previous.note) >= 9
    && Math.abs(note.note - next.note) >= 9
    && Math.abs(previous.note - next.note) <= 5;
}

function octaveRunBoundaryCost(notes, start, end, shift) {
  let cost = 0;
  const shifted = (index) => notes[index].note + (index >= start && index < end ? shift : 0);
  const left = Math.max(0, start - 2);
  const right = Math.min(notes.length - 1, end + 1);
  for (let i = left + 1; i <= right; i += 1) {
    cost += Math.abs(shifted(i) - shifted(i - 1));
  }
  return cost;
}

function correctGlobalOctaveBias(notes) {
  if (notes.length < 3) {
    return notes;
  }
  const weighted = [];
  for (const note of notes) {
    const frames = Math.max(1, Math.round((note.end - note.start) / 0.08));
    for (let i = 0; i < frames; i += 1) {
      weighted.push(note.note);
    }
  }
  const center = median(weighted);
  let shift = 0;
  if (center < 43) {
    shift = 12;
  } else if (center > 84) {
    shift = -12;
  }
  if (!shift) {
    return notes;
  }
  return notes.map((note) => ({
    ...note,
    note: clampInt(note.note + shift, 0, 127),
  }));
}

function correctMelodicOutliers(notes, allowed, settings = {}) {
  if (notes.length < 3) {
    return notes;
  }
  const output = notes.map((note) => ({ ...note }));
  for (let i = 1; i < output.length - 1; i += 1) {
    const previous = output[i - 1];
    const current = output[i];
    const next = output[i + 1];
    const duration = current.end - current.start;
    const neighborsClose = Math.abs(next.note - previous.note) <= 4;
    const isolatedLeap = Math.abs(current.note - previous.note) >= 7 && Math.abs(current.note - next.note) >= 7;
    if (!neighborsClose || !isolatedLeap || duration > 0.7) {
      continue;
    }
    if (hasReliableAudioOctave(current)) {
      continue;
    }
    if (intentionalLeapProtection(output, i, settings) >= 1.25) {
      continue;
    }
    let target = octaveSiblingTarget(current.note, previous.note)
      ?? octaveSiblingTarget(current.note, next.note)
      ?? clampInt(Math.round((previous.note + next.note) / 2), 0, 127);
    if (allowed) {
      target = nearestAllowedNote(target, allowed);
    }
    current.note = target;
  }
  return output;
}

function octaveSiblingTarget(current, neighbor) {
  const interval = Math.abs(current - neighbor);
  if (current % 12 === neighbor % 12 && interval >= 11 && interval <= 25) {
    return neighbor;
  }
  return null;
}

function melodicScore(note, previous, next) {
  let score = 0;
  if (previous) {
    score += Math.abs(note - previous.note);
  }
  if (next) {
    score += Math.abs(note - next.note);
  }
  return score;
}

function quantizeTiming(notes, settings) {
  const grid = quantizeGridSeconds(settings);
  const offset = settings.beatOffsetSeconds || 0;
  if (!hasManualTiming(notes, settings)) {
    return notes.map((note) => {
      const start = snapToGrid(note.start, grid, offset);
      let end = snapToGrid(note.end, grid, offset);
      if (end <= start) {
        end = start + grid;
      }
      return { ...note, start: Math.max(0, start), end: Math.max(0, end) };
    });
  }

  const ordered = notes
    .map((note, index) => ({
      note,
      index,
      sourceStart: manualOnsetSource(note, index, settings),
    }))
    .sort((a, b) => a.sourceStart - b.sourceStart || a.index - b.index);

  let previousTick = -Infinity;
  const snapped = ordered.map((item) => {
    const desiredTick = gridTick(item.sourceStart, grid, offset);
    const tick = Math.max(desiredTick, previousTick + 1);
    previousTick = tick;
    return {
      ...item,
      tick,
      start: gridTime(tick, grid, offset),
    };
  });

  return snapped.map((item, index) => {
    const next = snapped[index + 1];
    const start = Math.max(0, item.start);
    let end = next ? Math.max(start + 0.03, next.start) : snapToGrid(item.note.end, grid, offset);
    if (end <= start) {
      end = start + grid;
    }
    return {
      ...item.note,
      start,
      end: Math.max(start + 0.03, end),
      markerStart: manualOnsetSource(item.note, item.index, settings),
      markerIndex: item.note.markerIndex != null && Number.isFinite(Number(item.note.markerIndex))
        ? Math.round(Number(item.note.markerIndex))
        : item.index,
      manualMarker: true,
    };
  });
}

function hasManualTiming(notes, settings) {
  return Boolean(
    settings.manualMarkers?.length
    || notes.some((note) => note.markerStart != null && Number.isFinite(Number(note.markerStart)) || note.manualMarker === true),
  );
}

function manualOnsetSource(note, index, settings) {
  if (note.markerStart != null && Number.isFinite(Number(note.markerStart))) {
    return Math.max(0, Number(note.markerStart));
  }
  const markerIndex = note.markerIndex != null && Number.isFinite(Number(note.markerIndex)) ? Math.round(Number(note.markerIndex)) : index;
  if (Array.isArray(settings.manualMarkers) && Number.isFinite(Number(settings.manualMarkers[markerIndex]))) {
    return Math.max(0, Number(settings.manualMarkers[markerIndex]));
  }
  if (Array.isArray(settings.manualMarkers) && Number.isFinite(Number(settings.manualMarkers[index]))) {
    return Math.max(0, Number(settings.manualMarkers[index]));
  }
  return Math.max(0, Number(note.start) || 0);
}

function gridTick(time, gridSeconds, offsetSeconds = 0) {
  if (!Number.isFinite(time) || !Number.isFinite(gridSeconds) || gridSeconds <= 0) {
    return 0;
  }
  return Math.round((time - offsetSeconds) / gridSeconds);
}

function gridTime(tick, gridSeconds, offsetSeconds = 0) {
  return Math.max(0, offsetSeconds + tick * gridSeconds);
}

function quantizeGridSeconds(settings) {
  return (60 / Math.max(30, settings.tempo || 120)) * normalizedQuantizeGridBeats(settings.quantizeGridBeats);
}

function normalizedQuantizeGridBeats(value) {
  const grid = Number(value);
  return [1, 0.5, 0.25, 0.125].includes(grid) ? grid : 0.25;
}

function inferKeyFromMelody(notes) {
  if (!notes.length) {
    return null;
  }
  const first = notes[0].note % 12;
  const last = notes[notes.length - 1].note % 12;
  const tonic = notes.length > 1 && first !== last ? last : first;
  return { score: 0, tonic, mode: "major", name: `${NOTE_NAMES[tonic]} major` };
}

function generateChords(notes, key, settings, duration) {
  if (!notes.length || !key) {
    return [];
  }
  const palette = chordPaletteForKey(key, settings);
  const scale = allowedPitchClasses(key);
  const segments = buildHarmonySegments(notes, settings, duration).filter((segment) => segment.profile.total >= 0.018 || segment.isPhraseStart || segment.isPhraseEnd);
  if (!segments.length) {
    return [];
  }
  const path = chooseChordPath(segments, palette, key, scale, settings);
  const chords = [];
  let previousVoicing = null;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const chord = path[index];
    const voicing = voiceChord(chord, previousVoicing);
    const item = {
      name: chord.name,
      root: chord.root,
      quality: chord.quality,
      degree: chord.degree,
      start: segment.start,
      end: segment.end,
      notes: voicing,
      velocity: 54,
    };
    chords.push(item);
    previousVoicing = voicing;
  }

  return mergeAdjacentChords(chords);
}

function buildHarmonySegments(notes, settings, duration) {
  const beatSeconds = 60 / settings.tempo;
  const barSeconds = beatSeconds * settings.sigTop;
  const segmentSeconds = chordGridSeconds(settings);
  const offset = clampNumber(settings.beatOffsetSeconds || 0, 0, Math.max(0, beatSeconds - 0.001));
  const endTime = Math.max(duration || 0, ...notes.map((note) => note.end));
  const segments = [];
  for (let start = offset, index = 0; start < endTime - 0.02; start += segmentSeconds, index += 1) {
    const end = Math.min(endTime, start + segmentSeconds);
    const boundaryStrength = beatStrengthAt(start, settings);
    segments.push({
      index,
      start,
      end,
      boundaryStrength,
      isPhraseStart: isPhraseStart(notes, start, beatSeconds),
      isDownbeat: isNearDownbeat(start, settings),
      isPhraseEnd: isPhraseEnd(notes, end, beatSeconds, endTime),
      profile: segmentPitchProfile(notes, start, end, settings),
    });
  }
  return segments;
}

function chordPaletteForKey(key, settings = {}) {
  const majorDegrees = [0, 2, 4, 5, 7, 9, 11];
  const minorDegrees = [0, 2, 3, 5, 7, 8, 10];
  const majorQualities = ["maj", "min", "min", "maj", "maj", "min", "dim"];
  const minorQualities = ["min", "dim", "maj", "min", "maj", "maj", "maj"];
  const degrees = key.mode === "minor" ? minorDegrees : majorDegrees;
  const qualities = key.mode === "minor" ? minorQualities : majorQualities;
  const candidates = degrees.map((degree, index) => makeChordCandidate({
    root: (key.tonic + degree) % 12,
    degree: index,
    quality: qualities[index],
    functionType: chordFunction(index),
    source: "diatonic",
    penalty: 0,
  }));
  const borrowed = key.mode === "minor" ? minorColorChords(key.tonic) : majorColorChords(key.tonic);
  for (const chord of borrowed) {
    candidates.push(makeChordCandidate(chord));
  }
  for (const chord of extendedColorChords(key, settings)) {
    candidates.push(makeChordCandidate(chord));
  }
  return uniqueChordCandidates(candidates);
}

function makeChordCandidate({ root, degree, quality, functionType, source, penalty }) {
  const intervals = chordIntervals(quality);
  const pitchClasses = [...new Set(intervals.map((interval) => (root + interval) % 12))];
  const pitchClassSet = new Set(pitchClasses);
  const roleByPitchClass = new Array(12).fill("");
  intervals.forEach((interval) => {
    const normalized = ((interval % 12) + 12) % 12;
    const pc = (root + interval) % 12;
    if (normalized === 0) {
      roleByPitchClass[pc] = "root";
    } else if (normalized === 3 || normalized === 4) {
      roleByPitchClass[pc] = "third";
    } else if (normalized === 6 || normalized === 7) {
      roleByPitchClass[pc] = "fifth";
    } else if (normalized === 9) {
      roleByPitchClass[pc] = "sixth";
    } else if (normalized === 10 || normalized === 11) {
      roleByPitchClass[pc] = "seventh";
    } else if (normalized === 2) {
      roleByPitchClass[pc] = "ninth";
    } else if (normalized === 5) {
      roleByPitchClass[pc] = "suspension";
    }
  });
  return {
    root,
    degree,
    quality,
    intervals,
    pitchClasses,
    pitchClassSet,
    roleByPitchClass,
    functionType,
    source,
    penalty,
    color: source === "diatonic" ? 0 : source === "secondary" ? 2 : 1,
    targetRoot: secondaryTargetRoot(root, source),
    name: chordName(root, quality),
  };
}

function secondaryTargetRoot(root, source) {
  return source === "secondary" || source === "harmonic" ? (root + 5) % 12 : null;
}

function majorColorChords(tonic) {
  return [
    { root: (tonic + 10) % 12, degree: 107, quality: "maj", functionType: "predominant", source: "borrowed", penalty: 1.3 },
    { root: (tonic + 8) % 12, degree: 108, quality: "maj", functionType: "predominant", source: "borrowed", penalty: 1.55 },
    { root: (tonic + 3) % 12, degree: 109, quality: "maj", functionType: "tonic", source: "borrowed", penalty: 1.65 },
    { root: (tonic + 5) % 12, degree: 110, quality: "min", functionType: "predominant", source: "borrowed", penalty: 1.45 },
    { root: (tonic + 2) % 12, degree: 111, quality: "maj", functionType: "dominant", source: "secondary", penalty: 1.35 },
    { root: (tonic + 4) % 12, degree: 112, quality: "maj", functionType: "dominant", source: "secondary", penalty: 1.5 },
    { root: (tonic + 9) % 12, degree: 113, quality: "maj", functionType: "dominant", source: "secondary", penalty: 1.55 },
  ];
}

function minorColorChords(tonic) {
  return [
    { root: (tonic + 7) % 12, degree: 207, quality: "maj", functionType: "dominant", source: "harmonic", penalty: 0.45 },
    { root: (tonic + 5) % 12, degree: 208, quality: "maj", functionType: "predominant", source: "melodic", penalty: 0.95 },
    { root: (tonic + 1) % 12, degree: 209, quality: "maj", functionType: "predominant", source: "borrowed", penalty: 1.45 },
    { root: (tonic + 10) % 12, degree: 210, quality: "maj", functionType: "dominant", source: "borrowed", penalty: 1.25 },
    { root: (tonic + 2) % 12, degree: 211, quality: "maj", functionType: "dominant", source: "secondary", penalty: 1.45 },
  ];
}

function extendedColorChords(key, settings) {
  const tonic = key.tonic;
  const density = settings.arrangementDensity || "normal";
  const sparsePenalty = density === "light" ? 0.55 : density === "dense" ? -0.2 : 0;
  if (key.mode === "minor") {
    return [
      { root: tonic, degree: 300, quality: "min7", functionType: "tonic", source: "extension", penalty: 0.8 + sparsePenalty },
      { root: (tonic + 3) % 12, degree: 302, quality: "maj7", functionType: "tonic", source: "extension", penalty: 1.0 + sparsePenalty },
      { root: (tonic + 5) % 12, degree: 303, quality: "min7", functionType: "predominant", source: "extension", penalty: 0.9 + sparsePenalty },
      { root: (tonic + 7) % 12, degree: 304, quality: "7", functionType: "dominant", source: "harmonic", penalty: 0.65 + sparsePenalty },
      { root: (tonic + 8) % 12, degree: 305, quality: "maj7", functionType: "predominant", source: "extension", penalty: 1.1 + sparsePenalty },
      { root: (tonic + 10) % 12, degree: 306, quality: "7", functionType: "dominant", source: "extension", penalty: 1.2 + sparsePenalty },
      { root: tonic, degree: 307, quality: "sus4", functionType: "tonic", source: "suspension", penalty: 1.4 + sparsePenalty },
      { root: tonic, degree: 308, quality: "add9", functionType: "tonic", source: "extension", penalty: 1.35 + sparsePenalty },
    ];
  }
  return [
    { root: tonic, degree: 300, quality: "maj7", functionType: "tonic", source: "extension", penalty: 0.82 + sparsePenalty },
    { root: tonic, degree: 301, quality: "add9", functionType: "tonic", source: "extension", penalty: 1.1 + sparsePenalty },
    { root: tonic, degree: 309, quality: "6", functionType: "tonic", source: "extension", penalty: 0.42 + sparsePenalty * 0.35 },
    { root: tonic, degree: 310, quality: "6add9", functionType: "tonic", source: "extension", penalty: 0.66 + sparsePenalty * 0.45 },
    { root: (tonic + 2) % 12, degree: 301, quality: "min7", functionType: "predominant", source: "extension", penalty: 0.9 + sparsePenalty },
    { root: (tonic + 4) % 12, degree: 302, quality: "min7", functionType: "tonic", source: "extension", penalty: 1.2 + sparsePenalty },
    { root: (tonic + 5) % 12, degree: 303, quality: "maj7", functionType: "predominant", source: "extension", penalty: 0.9 + sparsePenalty },
    { root: (tonic + 5) % 12, degree: 309, quality: "6", functionType: "predominant", source: "extension", penalty: 1.15 + sparsePenalty },
    { root: (tonic + 5) % 12, degree: 304, quality: "add9", functionType: "predominant", source: "extension", penalty: 1.25 + sparsePenalty },
    { root: (tonic + 7) % 12, degree: 305, quality: "7", functionType: "dominant", source: "extension", penalty: 0.62 + sparsePenalty },
    { root: (tonic + 7) % 12, degree: 306, quality: "sus4", functionType: "dominant", source: "suspension", penalty: 1.15 + sparsePenalty },
    { root: (tonic + 9) % 12, degree: 307, quality: "min7", functionType: "tonic", source: "extension", penalty: 0.95 + sparsePenalty },
  ];
}

function uniqueChordCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.root}:${candidate.quality}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chordFunction(degree) {
  if (degree === 0 || degree === 2 || degree === 5) return "tonic";
  if (degree === 1 || degree === 3) return "predominant";
  return "dominant";
}

function chordIntervals(quality) {
  if (quality === "min") return [0, 3, 7];
  if (quality === "dim") return [0, 3, 6];
  if (quality === "7") return [0, 4, 7, 10];
  if (quality === "maj7") return [0, 4, 7, 11];
  if (quality === "min7") return [0, 3, 7, 10];
  if (quality === "sus4") return [0, 5, 7];
  if (quality === "add9") return [0, 4, 7, 14];
  if (quality === "6") return [0, 4, 7, 9];
  if (quality === "6add9") return [0, 4, 7, 9, 14];
  return [0, 4, 7];
}

function chordName(root, quality) {
  if (quality === "min") return `${NOTE_NAMES[root]}m`;
  if (quality === "dim") return `${NOTE_NAMES[root]}dim`;
  if (quality === "7") return `${NOTE_NAMES[root]}7`;
  if (quality === "maj7") return `${NOTE_NAMES[root]}maj7`;
  if (quality === "min7") return `${NOTE_NAMES[root]}m7`;
  if (quality === "sus4") return `${NOTE_NAMES[root]}sus4`;
  if (quality === "add9") return `${NOTE_NAMES[root]}add9`;
  if (quality === "6") return `${NOTE_NAMES[root]}6`;
  if (quality === "6add9") return `${NOTE_NAMES[root]}6add9`;
  return NOTE_NAMES[root];
}

function segmentPitchProfile(notes, start, end, settings) {
  const weights = new Array(12).fill(0);
  const strongWeights = new Array(12).fill(0);
  const endingWeights = new Array(12).fill(0);
  const anchorWeights = new Array(12).fill(0);
  let total = 0;
  let strongTotal = 0;
  let endingTotal = 0;
  let anchorTotal = 0;
  let strongest = -1;
  let strongestWeight = 0;
  let firstPc = -1;
  let finalPc = -1;
  let firstTime = Infinity;
  let finalTime = -Infinity;
  const beatSeconds = 60 / settings.tempo;
  const segmentLength = Math.max(0.01, end - start);
  const events = [];
  for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
    const note = notes[noteIndex];
    const overlapStart = Math.max(note.start, start);
    const overlapEnd = Math.min(note.end, end);
    const overlap = Math.max(0, overlapEnd - overlapStart);
    if (overlap <= 0) {
      continue;
    }
    const pc = note.note % 12;
    const center = (overlapStart + overlapEnd) * 0.5;
    const accent = beatStrengthAt(center, settings);
    const longTone = overlap >= segmentLength * 0.32 ? 1.25 : 1;
    const entryAccent = note.start <= start + 0.08 ? 1.18 : 1;
    const weight = overlap * accent * longTone * entryAccent * Math.sqrt(Math.max(1, note.velocity) / 80);
    const previous = notes[noteIndex - 1];
    const next = notes[noteIndex + 1];
    const ornament = isOrnamentTone(previous, note, next, accent, overlap, segmentLength);
    const arpeggio = isArpeggioTone(previous, note, next);
    const anchor = !ornament && (accent >= 1.35 || overlap >= segmentLength * 0.22 || overlapEnd >= end - beatSeconds * 0.35 || arpeggio);
    weights[pc] += weight;
    total += weight;
    if (accent >= 1.35 || overlap >= segmentLength * 0.32) {
      strongWeights[pc] += weight;
      strongTotal += weight;
    }
    if (overlapEnd >= end - beatSeconds * 0.35) {
      endingWeights[pc] += weight * 1.15;
      endingTotal += weight * 1.15;
    }
    if (anchor) {
      anchorWeights[pc] += weight * 1.28;
      anchorTotal += weight * 1.28;
    }
    if (overlapStart < firstTime) {
      firstTime = overlapStart;
      firstPc = pc;
    }
    if (overlapEnd > finalTime) {
      finalTime = overlapEnd;
      finalPc = pc;
    }
    if (weights[pc] > strongestWeight) {
      strongest = pc;
      strongestWeight = weights[pc];
    }
    events.push({
      pc,
      note: note.note,
      weight,
      strong: accent >= 1.35 || overlap >= segmentLength * 0.32,
      ending: overlapEnd >= end - beatSeconds * 0.35,
      ornament,
      anchor,
      arpeggio,
      accent,
    });
  }
  return {
    weights,
    strongWeights,
    endingWeights,
    anchorWeights,
    total,
    strongTotal,
    endingTotal,
    anchorTotal,
    strongest,
    firstPc,
    finalPc,
    events,
  };
}

function isOrnamentTone(previous, current, next, accent, overlap, segmentLength) {
  if (accent >= 1.35 || overlap >= segmentLength * 0.34) {
    return false;
  }
  if (!previous || !next) {
    return false;
  }
  const from = current.note - previous.note;
  const to = next.note - current.note;
  const previousNext = Math.abs(next.note - previous.note);
  const stepwise = Math.abs(from) <= 2 && Math.abs(to) <= 2;
  const passing = stepwise && Math.sign(from) === Math.sign(to);
  const neighbor = stepwise && previousNext <= 2 && Math.sign(from) !== Math.sign(to);
  return passing || neighbor;
}

function isArpeggioTone(previous, current, next) {
  if (!previous || !next) {
    return false;
  }
  const from = Math.abs(current.note - previous.note);
  const to = Math.abs(next.note - current.note);
  return from >= 3 && from <= 7 && to >= 3 && to <= 7;
}

function chooseChordPath(segments, palette, key, scale, settings) {
  const localScores = segments.map((segment, index) => (
    palette.map((chord) => scoreChordForSegment(chord, segment, index, segments.length, key, scale, settings))
  ));
  const dp = localScores.map(() => new Array(palette.length).fill(-Infinity));
  const back = localScores.map(() => new Array(palette.length).fill(0));

  for (let chordIndex = 0; chordIndex < palette.length; chordIndex += 1) {
    dp[0][chordIndex] = localScores[0][chordIndex];
  }
  for (let index = 1; index < segments.length; index += 1) {
    for (let chordIndex = 0; chordIndex < palette.length; chordIndex += 1) {
      let bestScore = -Infinity;
      let bestPrevious = 0;
      for (let previousIndex = 0; previousIndex < palette.length; previousIndex += 1) {
        const score = dp[index - 1][previousIndex]
          + transitionScore(palette[previousIndex], palette[chordIndex], segments[index - 1], segments[index], settings)
          + localScores[index][chordIndex];
        if (score > bestScore) {
          bestScore = score;
          bestPrevious = previousIndex;
        }
      }
      dp[index][chordIndex] = bestScore;
      back[index][chordIndex] = bestPrevious;
    }
  }

  let bestFinal = 0;
  for (let chordIndex = 1; chordIndex < palette.length; chordIndex += 1) {
    if (dp[segments.length - 1][chordIndex] > dp[segments.length - 1][bestFinal]) {
      bestFinal = chordIndex;
    }
  }

  const path = new Array(segments.length);
  let cursor = bestFinal;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    path[index] = palette[cursor];
    cursor = back[index][cursor];
  }
  return applyPhraseTemplates(path, segments, palette, localScores, key, settings);
}

function applyPhraseTemplates(path, segments, palette, localScores, key, settings) {
  if (segments.length < 3 || settings.harmonyGrid === "bar") {
    return path;
  }
  const refined = [...path];
  const templates = phraseTemplatesForKey(key, settings);
  const maxLength = Math.min(settings.arrangementDensity === "light" ? 4 : 8, segments.length);
  for (let start = 0; start < segments.length - 2; start += 1) {
    if (start > 0 && !segments[start].isPhraseStart && start % 2 !== 0) {
      continue;
    }
    for (const template of templates) {
      const length = template.degrees.length;
      if (length > maxLength || start + length > segments.length) {
        continue;
      }
      const candidate = template.degrees.map((degree, offset) => bestTemplateChordForSegment(
        palette,
        localScores[start + offset],
        key,
        degree,
        settings,
      ));
      if (candidate.some((chord) => !chord)) {
        continue;
      }
      const currentSlice = refined.slice(start, start + length);
      const currentScore = windowPathScore(refined, currentSlice, segments, palette, localScores, start, settings);
      const candidateScore = windowPathScore(refined, candidate, segments, palette, localScores, start, settings)
        + template.bonus * templateStrength(segments, start, length, settings)
        - phraseStartTemplatePenalty(candidate, segments, palette, localScores, start, key, settings);
      const margin = settings.arrangementDensity === "dense" ? 0.45 : settings.arrangementDensity === "light" ? 1.15 : 0.75;
      if (candidateScore > currentScore + margin) {
        for (let offset = 0; offset < length; offset += 1) {
          refined[start + offset] = candidate[offset];
        }
        start += Math.max(0, length - 2);
        break;
      }
    }
  }
  return refined;
}

function phraseStartTemplatePenalty(candidate, segments, palette, localScores, start, key, settings) {
  const segment = segments[start];
  if (!segment || (!segment.isPhraseStart && start !== 0)) {
    return 0;
  }
  const first = candidate[0];
  if (!first || scaleDegreeForRoot(first.root, key) === 0) {
    return 0;
  }
  const tonic = bestTemplateChordForSegment(palette, localScores[start], key, 0, settings);
  if (!tonic) {
    return 0.35;
  }
  const firstIndex = palette.indexOf(first);
  const tonicIndex = palette.indexOf(tonic);
  const firstScore = firstIndex >= 0 ? localScores[start][firstIndex] : -Infinity;
  const tonicScore = tonicIndex >= 0 ? localScores[start][tonicIndex] : -Infinity;
  if (tonicScore >= firstScore - 1.1) {
    return settings.arrangementDensity === "dense" ? 0.75 : 1.35;
  }
  return 0.35;
}

function phraseTemplatesForKey(key, settings) {
  const style = settings.arrangementStyle || "pop";
  const popBonus = style === "pop" ? 1.18 : style === "ballad" ? 0.94 : 1.02;
  const base = commonProgressionTemplates([
    ["4536251", 2.85, "IV-V-iii-vi-ii-V-I"],
    ["1645", 2.35 * popBonus, "I-vi-IV-V"],
    ["6415", 2.05 * popBonus, "vi-IV-I-V"],
    ["1564", 2.15 * popBonus, "I-V-vi-IV"],
    ["1451", 2.05, "I-IV-V-I"],
    ["251", style === "ballad" ? 2.35 : 1.85, "ii-V-I"],
    ["451", 1.75, "IV-V-I"],
    ["456", 1.45, "IV-V-vi"],
    ["1625", 2.0, "I-vi-ii-V"],
    ["3625", 1.9, "iii-vi-ii-V"],
    ["6251", 1.95, "vi-ii-V-I"],
    ["2516", 1.55, "ii-V-I-vi"],
    ["4361", 1.48, "IV-iii-vi-I"],
    ["4536", 1.55, "IV-V-iii-vi"],
    ["6451", 1.72 * popBonus, "vi-IV-V-I"],
    ["4561", 1.62, "IV-V-vi-I"],
  ]);
  if (key.mode === "minor") {
    return [
      ...commonProgressionTemplates([
        ["1645", style === "pop" ? 1.75 : 1.35, "i-VI-iv-V"],
        ["6415", 1.55, "VI-iv-i-V"],
        ["1564", 1.48, "i-V-VI-iv"],
        ["451", 1.35, "iv-V-i"],
        ["6251", 1.36, "VI-ii-V-i"],
        ["4536251", 1.65, "iv-V-III-VI-ii-V-i"],
      ]),
      ...base.filter((item) => item.degrees.length <= 4).map((item) => ({ ...item, bonus: item.bonus * 0.68 })),
    ];
  }
  return base;
}

function commonProgressionTemplates(entries) {
  return entries
    .map(([pattern, bonus, label]) => ({
      pattern,
      label,
      degrees: numericProgressionDegrees(pattern),
      bonus,
    }))
    .filter((item) => item.degrees.length >= 3);
}

function numericProgressionDegrees(pattern) {
  return String(pattern)
    .split("")
    .map((char) => Number(char) - 1)
    .filter((degree) => Number.isInteger(degree) && degree >= 0 && degree <= 6);
}

function bestTemplateChordForSegment(palette, localScores, key, degree, settings) {
  let best = null;
  let bestScore = -Infinity;
  for (let index = 0; index < palette.length; index += 1) {
    const chord = palette[index];
    if (scaleDegreeForRoot(chord.root, key) !== degree) {
      continue;
    }
    if (chord.quality === "dim" || chord.source === "borrowed" || chord.source === "secondary") {
      continue;
    }
    let score = localScores[index] + templateChordPreference(chord, degree, settings);
    if (score > bestScore) {
      best = chord;
      bestScore = score;
    }
  }
  return best;
}

function scaleDegreeForRoot(root, key) {
  const degrees = key.mode === "minor" ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const interval = (root - key.tonic + 12) % 12;
  return degrees.indexOf(interval);
}

function templateChordPreference(chord, degree, settings) {
  let score = 0;
  const density = settings.arrangementDensity || "normal";
  if (chord.source === "diatonic") score += 0.45;
  if (density === "light" && chord.pitchClasses.length > 3) score -= 0.55;
  if (density === "dense" && chord.pitchClasses.length > 3) score += 0.18;
  if (degree === 4 && chord.quality === "7") score += 0.45;
  if (degree === 0 && ["maj7", "min7", "add9", "6", "6add9"].includes(chord.quality) && settings.arrangementStyle === "ballad") score += 0.35;
  if (chord.quality === "sus4") score -= degree === 4 ? 0.05 : 0.55;
  return score;
}

function windowPathScore(fullPath, slice, segments, palette, localScores, start, settings) {
  let score = 0;
  for (let offset = 0; offset < slice.length; offset += 1) {
    const segmentIndex = start + offset;
    const chordIndex = palette.indexOf(slice[offset]);
    score += chordIndex >= 0 ? localScores[segmentIndex][chordIndex] : -20;
    if (offset > 0) {
      score += transitionScore(slice[offset - 1], slice[offset], segments[segmentIndex - 1], segments[segmentIndex], settings);
    }
  }
  if (start > 0) {
    score += transitionScore(fullPath[start - 1], slice[0], segments[start - 1], segments[start], settings) * 0.72;
  }
  const after = start + slice.length;
  if (after < fullPath.length) {
    score += transitionScore(slice[slice.length - 1], fullPath[after], segments[after - 1], segments[after], settings) * 0.72;
  }
  return score;
}

function templateStrength(segments, start, length, settings) {
  const first = segments[start];
  const last = segments[start + length - 1];
  let strength = 1;
  if (first.isPhraseStart || first.isDownbeat) strength += 0.22;
  if (last.isPhraseEnd) strength += 0.28;
  if (settings.arrangementDensity === "light") strength += 0.18;
  return strength;
}

function scoreChordForSegment(chord, segment, index, segmentCount, key, scale, settings) {
  const profile = segment.profile;
  let score = 0;
  for (let pc = 0; pc < 12; pc += 1) {
    const weight = profile.weights[pc];
    const strong = profile.strongWeights[pc];
    const ending = profile.endingWeights[pc];
    if (!weight && !strong && !ending) {
      continue;
    }
    if (chord.pitchClassSet.has(pc)) {
      score += weight * chordToneWeight(chord, pc);
      score += strong * 2.8;
      score += ending * 2.4;
    } else {
      const distance = pitchClassDistanceToChord(pc, chord);
      score -= weight * (distance === 1 ? 0.32 : 0.95);
      score -= strong * (distance === 1 ? 1.7 : 3.9);
      score -= ending * (distance === 1 ? 2.0 : 4.45);
    }
  }
  for (const event of profile.events) {
    if (chord.pitchClassSet.has(event.pc)) {
      continue;
    }
    const distance = pitchClassDistanceToChord(event.pc, chord);
    if (event.ornament && distance <= 2) {
      score += event.weight * 0.62;
    } else if (event.accent < 1.2 && distance <= 1) {
      score += event.weight * 0.22;
    } else if (event.strong || event.ending) {
      score -= event.weight * (distance <= 1 ? 1.0 : 1.9);
    }
  }

  if (profile.strongest >= 0) {
    score += chord.pitchClassSet.has(profile.strongest) ? 1.15 : -0.95;
  }
  if (profile.firstPc >= 0) {
    score += chord.pitchClassSet.has(profile.firstPc) ? 0.45 : -0.25;
  }
  if (profile.finalPc >= 0) {
    score += chord.pitchClassSet.has(profile.finalPc) ? 0.95 : -1.25;
  }
  const coverage = chordCoverage(profile, chord);
  score += coverage * 2.4;
  const anchorCoverage = chordAnchorCoverage(profile, chord);
  score += anchorCoverage * 4.1;

  if (chord.quality === "dim") score -= 3.2;
  if (chord.degree === 2) score -= 0.35;
  if (segment.isDownbeat && (chord.degree === 0 || chord.degree === 3 || chord.degree === 4 || chord.degree === 5)) {
    score += 0.35;
  }
  score += chordStyleScore(chord, segment, settings);
  if (segment.isPhraseStart) {
    if (chord.functionType === "tonic") score += 0.72;
    if (chord.functionType === "predominant") score += 0.22;
    if (chord.quality === "dim") score -= 0.8;
  }
  if (index === 0) {
    if (chord.degree === 0) score += 0.9;
    if (chord.degree === 4) score += 0.45;
    if (chord.quality === "dim") score -= 1.2;
  }
  if (segment.isPhraseEnd) {
    if (chord.degree === 0) score += 1.25;
    if (chord.degree === 4) score += 0.6;
    if (chord.quality === "sus4") score -= 1.35;
  }
  if (index === segmentCount - 1) {
    if (chord.functionType === "tonic") score += 2.4;
    if (chord.degree === 0) score += 4.8;
    if (profile.finalPc === key.tonic && chord.degree === 0) score += 3.8;
    if (chord.functionType === "dominant") score -= 2.4;
    if (chord.degree !== 0) score -= 2.1;
    if (chord.quality === "sus4") score -= 2.6;
  }
  score -= (chord.penalty || 0) + chordComplexityPenalty(chord, settings, profile);
  if (chord.source !== "diatonic") {
    const chromaticSupport = chordChromaticSupport(profile, chord, scale);
    const thirdSupport = chordThirdSupport(profile, chord);
    const extensionOnly = chord.source === "extension" || chord.source === "suspension";
    score += extensionOnly ? chromaticSupport * 0.8 : chromaticSupport * 3.2;
    if (coverage < 0.74) {
      score -= 2.0;
    }
    if (!extensionOnly && chromaticSupport < 0.22) {
      score -= chord.color === 2 ? 2.6 : 1.9;
    }
    if (scale && !scale.has(chord.pitchClasses[1]) && thirdSupport < 0.16) {
      score -= 2.8;
    }
    if (chord.source === "secondary" && thirdSupport >= 0.18 && coverage >= 0.72) {
      score += 3.05;
    }
    if (chord.source === "borrowed" && chord.pitchClasses.filter((pc) => profile.anchorWeights[pc] > 0).length < 2) {
      score -= 1.6;
    }
    if (chord.source === "extension" || chord.source === "suspension") {
      const colorSupport = chordColorToneSupport(profile, chord, scale);
      score += colorSupport * 2.6;
      if (colorSupport < 0.08 && settings.arrangementDensity !== "dense") {
        score -= 1.1;
      }
    }
  }
  return score;
}

function chordStyleScore(chord, segment, settings) {
  const style = settings.arrangementStyle || "pop";
  const density = settings.arrangementDensity || "normal";
  let score = 0;
  if (style === "ballad") {
    if (["maj7", "min7", "add9", "6", "6add9"].includes(chord.quality)) score += density === "light" ? 0.15 : 0.55;
    if (chord.quality === "7" && chord.functionType !== "dominant") score -= 0.35;
    if (chord.quality === "dim") score -= 0.75;
    if (segment.isPhraseEnd && chord.functionType === "tonic") score += 0.35;
  } else if (style === "arpeggio") {
    if (["maj7", "min7", "add9", "6", "6add9"].includes(chord.quality)) score += density === "dense" ? 0.38 : 0.24;
    if (chord.quality === "sus4" && chord.functionType !== "dominant") score -= 0.3;
    if (chord.quality === "dim") score -= 0.55;
  } else {
    if (["maj", "min"].includes(chord.quality)) score += density === "light" ? 0.45 : 0.2;
    if (chord.quality === "7" && chord.functionType === "dominant") score += 0.34;
    if (chord.quality === "sus4" && chord.functionType === "dominant" && !segment.isPhraseEnd) score += 0.28;
    if (["maj7", "add9", "6add9"].includes(chord.quality) && density === "light") score -= 0.25;
  }
  if (chord.degree === 0 && ["6", "6add9"].includes(chord.quality)) {
    score += style === "pop" ? 0.44 : 0.28;
  }
  return score;
}

function chordComplexityPenalty(chord, settings, profile) {
  const hasExtension = chord.pitchClasses.length > 3 || ["7", "maj7", "min7", "sus4", "add9", "6", "6add9"].includes(chord.quality);
  if (!hasExtension) {
    return 0;
  }
  const density = settings.arrangementDensity || "normal";
  const base = density === "dense" ? 0.2 : density === "light" ? 1.05 : 0.55;
  const anchorCoverage = chordAnchorCoverage(profile, chord);
  return Math.max(0, base - anchorCoverage * 0.55);
}

function chordColorToneSupport(profile, chord, scale) {
  let support = 0;
  for (const pc of chord.pitchClasses) {
    const role = chord.roleByPitchClass[pc];
    if (role === "sixth" || role === "seventh" || role === "ninth" || role === "suspension" || (scale && !scale.has(pc))) {
      support += profile.anchorWeights[pc] + profile.strongWeights[pc] * 0.45 + profile.endingWeights[pc] * 0.3;
    }
  }
  return support / Math.max(0.001, profile.anchorTotal + profile.strongTotal * 0.45 + profile.endingTotal * 0.3);
}

function chordAnchorCoverage(profile, chord) {
  if (profile.anchorTotal <= 0) {
    return chordCoverage(profile, chord) * 0.5;
  }
  let covered = 0;
  for (let pc = 0; pc < 12; pc += 1) {
    if (chord.pitchClassSet.has(pc)) {
      covered += profile.anchorWeights[pc];
    }
  }
  return covered / Math.max(0.001, profile.anchorTotal);
}

function chordChromaticSupport(profile, chord, scale) {
  if (!scale || profile.anchorTotal <= 0) {
    return 0;
  }
  let support = 0;
  for (const pc of chord.pitchClasses) {
    if (!scale.has(pc)) {
      support += profile.anchorWeights[pc] + profile.endingWeights[pc] * 0.55;
    }
  }
  return support / Math.max(0.001, profile.anchorTotal + profile.endingTotal * 0.55);
}

function chordThirdSupport(profile, chord) {
  const third = chord.pitchClasses[1];
  return (profile.anchorWeights[third] + profile.weights[third] * 0.35) / Math.max(0.001, profile.anchorTotal + profile.total * 0.35);
}

function chordCoverage(profile, chord) {
  if (profile.total <= 0) {
    return 0;
  }
  let covered = 0;
  for (let pc = 0; pc < 12; pc += 1) {
    if (chord.pitchClassSet.has(pc)) {
      covered += profile.weights[pc] + profile.strongWeights[pc] * 0.75 + profile.endingWeights[pc] * 0.45;
    }
  }
  const total = profile.total + profile.strongTotal * 0.75 + profile.endingTotal * 0.45;
  return covered / Math.max(0.001, total);
}

function transitionScore(previous, next, previousSegment, segment, settings) {
  let score = 0;
  const same = sameChord(previous, next);
  if (same) {
    return settings.arrangementDensity === "dense" ? 0.28 : settings.arrangementDensity === "light" ? 1.15 : 0.72;
  }
  score -= harmonicSwitchPenalty(settings, segment);
  const commonTones = next.pitchClasses.filter((pc) => previous.pitchClassSet.has(pc)).length;
  score += commonTones * 0.5;
  const rootMotion = (next.root - previous.root + 12) % 12;
  if (rootMotion === 5 || rootMotion === 7) score += 1.15;
  if (rootMotion === 2 || rootMotion === 10) score += 0.45;
  if (rootMotion === 3 || rootMotion === 4 || rootMotion === 8 || rootMotion === 9) score += 0.25;
  if (rootMotion === 6) score -= 0.9;
  score -= circularDistance(previous.root, next.root) * 0.025;

  if (previous.functionType === "tonic" && next.functionType === "predominant") score += 0.7;
  if (previous.functionType === "predominant" && next.functionType === "dominant") score += 1.0;
  if (previous.functionType === "dominant" && next.functionType === "tonic") score += 1.45;
  if (previous.functionType === "tonic" && next.functionType === "dominant") score += 0.45;
  if (previous.functionType === "dominant" && next.functionType === "predominant") score -= 0.9;
  if (previous.degree === 3 && next.degree === 4) score += 0.55;
  if (previous.degree === 4 && next.degree === 0) score += 1.15;
  score += commonProgressionScore(previous, next, segment);
  if (previous.targetRoot !== null) {
    if (next.root === previous.targetRoot) {
      score += previous.source === "secondary" ? 2.4 : 1.4;
    } else if (next.functionType !== "tonic") {
      score -= previous.source === "secondary" ? 1.8 : 0.9;
    }
  }
  if (previous.source !== "diatonic" && next.source !== "diatonic") {
    score -= 1.1;
  }
  if (previous.source !== "diatonic" && next.source === "diatonic") {
    score += 0.45;
  }
  if (previous.source === "borrowed" && next.degree === 0) {
    score += 0.8;
  }
  if (next.source !== "diatonic" && segment.isPhraseEnd) {
    score -= 1.1;
  }
  if (previousSegment.isPhraseEnd && next.functionType === "tonic") score += 0.3;
  if (segment.isPhraseEnd && previous.functionType === "dominant" && next.functionType === "tonic") score += 1.1;
  if (next.quality === "dim") score -= 0.7;
  return score;
}

function sameChord(previous, next) {
  return previous.root === next.root && previous.quality === next.quality;
}

function harmonicSwitchPenalty(settings, segment) {
  const density = settings.arrangementDensity || "normal";
  let penalty = density === "dense" ? 0.35 : density === "light" ? 1.45 : 0.78;
  if (settings.harmonyGrid === "bar" || settings.harmonyGrid === "half") {
    penalty *= 0.55;
  }
  if (segment.boundaryStrength >= 1.75 || segment.isPhraseStart) {
    penalty *= 0.62;
  } else if (segment.boundaryStrength < 1.15) {
    penalty *= 1.35;
  }
  return penalty;
}

function commonProgressionScore(previous, next, segment) {
  let score = 0;
  const motion = (next.root - previous.root + 12) % 12;
  if (previous.functionType === "tonic" && next.functionType === "tonic" && motion === 9) score += 0.6; // I -> vi
  if (previous.functionType === "tonic" && next.functionType === "predominant" && motion === 5) score += 0.65; // I -> IV
  if (previous.functionType === "predominant" && next.functionType === "dominant") score += 0.8; // ii/IV -> V
  if (previous.functionType === "dominant" && next.functionType === "tonic") score += segment.isPhraseEnd ? 1.45 : 0.95;
  if (previous.degree === 5 && next.degree === 3) score += 0.42; // vi -> IV pop loop
  if (previous.degree === 3 && next.degree === 0) score += 0.25; // IV -> I plagal
  if (previous.degree === 4 && next.degree === 5) score += 0.32; // V -> vi deceptive
  if (previous.source === "suspension" && next.root === previous.root && next.source !== "suspension") score += 1.05;
  if (previous.quality === "sus4" && next.root === previous.root && (next.quality === "maj" || next.quality === "7")) score += 1.25;
  return score;
}

function chordToneWeight(chord, pc) {
  const role = chord.roleByPitchClass[pc];
  if (role === "third") return 5.35;
  if (role === "root") return 5.05;
  if (role === "fifth") return 4.45;
  if (role === "sixth") return 3.7;
  if (role === "seventh") return 3.65;
  if (role === "ninth") return 3.25;
  if (role === "suspension") return 3.45;
  return 4.2;
}

function pitchClassDistanceToChord(pc, chord) {
  let distance = 6;
  for (const chordPc of chord.pitchClasses) {
    distance = Math.min(distance, circularDistance(pc, chordPc));
  }
  return distance;
}

function beatStrengthAt(time, settings) {
  const beatSeconds = 60 / settings.tempo;
  const beat = (time - (settings.beatOffsetSeconds || 0)) / beatSeconds;
  const position = ((beat % settings.sigTop) + settings.sigTop) % settings.sigTop;
  const nearestBeat = Math.round(position);
  const distance = Math.abs(position - nearestBeat);
  if (distance > 0.16) {
    return 1;
  }
  if (nearestBeat === 0 || nearestBeat === settings.sigTop) {
    return 1.9;
  }
  if (settings.sigTop === 4 && nearestBeat === 2) {
    return 1.45;
  }
  if (settings.sigTop === 3 && nearestBeat === 1) {
    return 1.25;
  }
  return 1.18;
}

function isNearDownbeat(time, settings) {
  const beatSeconds = 60 / settings.tempo;
  const beat = (time - (settings.beatOffsetSeconds || 0)) / beatSeconds;
  const position = ((beat % settings.sigTop) + settings.sigTop) % settings.sigTop;
  return position < 0.12 || settings.sigTop - position < 0.12;
}

function isPhraseStart(notes, time, beatSeconds) {
  let previousEnd = -Infinity;
  let nextStart = Infinity;
  for (const note of notes) {
    if (note.end <= time + 0.04) {
      previousEnd = Math.max(previousEnd, note.end);
    }
    if (note.start >= time - 0.04) {
      nextStart = Math.min(nextStart, note.start);
    }
  }
  if (!Number.isFinite(nextStart)) {
    return false;
  }
  return !Number.isFinite(previousEnd) || nextStart - previousEnd >= beatSeconds * 0.55;
}

function isPhraseEnd(notes, time, beatSeconds, endTime) {
  if (time >= endTime - 0.03) {
    return true;
  }
  let previousEnd = -Infinity;
  let nextStart = Infinity;
  for (const note of notes) {
    if (note.end <= time + 0.04) {
      previousEnd = Math.max(previousEnd, note.end);
    }
    if (note.start >= time - 0.04) {
      nextStart = Math.min(nextStart, note.start);
    }
  }
  return Number.isFinite(previousEnd) && Number.isFinite(nextStart) && nextStart - previousEnd >= beatSeconds * 0.55;
}

function voiceChord(chord, previousVoicing) {
  const pitchClasses = chord.pitchClasses.slice(0, chord.pitchClasses.length > 4 ? 4 : chord.pitchClasses.length);
  const choices = pitchClasses.map((pc, index) => {
    const notes = [];
    const min = index === 0 ? 38 : 46;
    const max = index === 0 ? 58 : 74;
    for (let midi = min; midi <= max; midi += 1) {
      if (midi % 12 === pc) {
        notes.push(midi);
      }
    }
    return notes;
  });
  let best = null;
  let bestScore = Infinity;
  const search = (index, selected) => {
    if (index >= choices.length) {
      const voicing = [...new Set(selected)].sort((left, right) => left - right);
      if (voicing.length < Math.min(3, pitchClasses.length)) {
        return;
      }
      const span = voicing[voicing.length - 1] - voicing[0];
      if (span > 26 || voicing[0] < 36 || voicing[voicing.length - 1] > 76) {
        return;
      }
      const average = voicing.reduce((sum, note) => sum + note, 0) / voicing.length;
      let score = span * 0.16 + Math.abs(average - 56) * 0.11 + Math.abs(voicing[0] - midiForPitchClassNear(chord.root, 42)) * 0.045;
      if (voicing[0] % 12 !== chord.root) {
        score += 0.62;
      }
      if (chord.pitchClasses.length > 3) {
        score += Math.max(0, voicing.length - 3) * 0.18;
      }
      if (previousVoicing?.length) {
        score += voicingDistance(voicing, previousVoicing) * 0.17;
      }
      if (score < bestScore) {
        best = voicing;
        bestScore = score;
      }
      return;
    }
    for (const note of choices[index]) {
      search(index + 1, [...selected, note]);
    }
  };
  search(0, []);
  if (best) {
    return best;
  }
  return pitchClasses.map((pc, index) => midiForPitchClassNear(pc, index === 0 ? 42 : 58)).sort((a, b) => a - b);
}

function voicingDistance(a, b) {
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    total += Math.abs(a[i] - b[i]);
  }
  return total;
}

function midiForPitchClassNear(pc, target) {
  let midi = pc;
  while (midi < target - 6) midi += 12;
  while (midi > target + 6) midi -= 12;
  return clampInt(midi, 0, 127);
}

function mergeAdjacentChords(chords) {
  const merged = [];
  for (const chord of chords) {
    const previous = merged[merged.length - 1];
    if (previous && previous.name === chord.name && chord.start - previous.end <= 0.05) {
      previous.end = chord.end;
    } else {
      merged.push({ ...chord, notes: [...chord.notes] });
    }
  }
  return merged;
}

function circularDistance(a, b) {
  const distance = Math.abs(a - b) % 12;
  return Math.min(distance, 12 - distance);
}

function snapToGrid(time, gridSeconds, offsetSeconds = 0) {
  if (!Number.isFinite(time) || !Number.isFinite(gridSeconds) || gridSeconds <= 0) {
    return Math.max(0, time || 0);
  }
  const snapped = offsetSeconds + Math.round((time - offsetSeconds) / gridSeconds) * gridSeconds;
  return Math.max(0, snapped);
}

function writeMidi(notes, settings, chords = []) {
  const ticksPerBeat = 480;
  const tracks = [buildNoteTrack("Hum Melody", notes, settings, 0, true)];
  if (chords.length) {
    tracks.push(buildChordTrack(chords, settings));
  }
  const arrangement = buildArrangementNotes(chords, settings);
  if (arrangement.length) {
    tracks.push(buildNoteTrack("Auto Arrangement", arrangement, settings, 2, false));
  }

  const bytes = [];
  pushString(bytes, "MThd");
  push32(bytes, 6);
  push16(bytes, tracks.length > 1 ? 1 : 0);
  push16(bytes, tracks.length);
  push16(bytes, ticksPerBeat);
  for (const track of tracks) {
    pushString(bytes, "MTrk");
    push32(bytes, track.length);
    bytes.push(...track);
  }
  return new Uint8Array(bytes);
}

function buildArrangementNotes(chords, settings) {
  if (!settings.arrangement || !Array.isArray(chords) || !chords.length) {
    return [];
  }
  const style = ["pop", "arpeggio", "ballad"].includes(settings.arrangementStyle)
    ? settings.arrangementStyle
    : "pop";
  const density = ["light", "normal", "dense"].includes(settings.arrangementDensity)
    ? settings.arrangementDensity
    : "normal";
  const beatSeconds = 60 / Math.max(30, settings.tempo || 120);
  const gridSeconds = chordGridSeconds(settings);
  const notes = [];
  for (const chord of chords) {
    const start = snapToGrid(chord.start, gridSeconds, settings.beatOffsetSeconds || 0);
    const end = alignedChordEnd(chord, start, gridSeconds, settings.beatOffsetSeconds || 0);
    if (end - start < 0.08) {
      continue;
    }
    const voicing = arrangementVoicing(chord);
    if (style === "arpeggio") {
      appendArpeggioArrangement(notes, chord, voicing, start, end, beatSeconds, density);
    } else if (style === "ballad") {
      appendBalladArrangement(notes, chord, voicing, start, end, beatSeconds, settings, density);
    } else {
      appendPopArrangement(notes, chord, voicing, start, end, beatSeconds, settings, density);
    }
  }
  return notes.sort((a, b) => a.start - b.start || a.note - b.note);
}

function arrangementVoicing(chord) {
  const pitchClasses = chord.notes?.length
    ? [...new Set(chord.notes.map((note) => ((note % 12) + 12) % 12))]
    : chordIntervals(chord.quality || "maj").map((interval) => ((chord.root || 0) + interval) % 12);
  const root = Number.isFinite(chord.root) ? chord.root : pitchClasses[0] || 0;
  const bassRoot = midiForPitchClassNear(root, 38);
  const bassFifth = midiForPitchClassNear((root + 7) % 12, 43);
  const mid = pitchClasses.map((pc) => normalizeArrangementMidi(midiForPitchClassNear(pc, 58), 52, 72));
  const high = pitchClasses.map((pc) => normalizeArrangementMidi(midiForPitchClassNear(pc, 66), 60, 79));
  return {
    bassRoot,
    bassFifth,
    mid: uniqueSorted(mid),
    high: uniqueSorted(high),
  };
}

function appendPopArrangement(output, chord, voicing, start, end, beatSeconds, settings, density) {
  const sigTop = Math.max(1, settings.sigTop || 4);
  const midpoint = Math.floor(sigTop / 2);
  for (let beatIndex = 0, time = start; time < end - 0.035; beatIndex += 1, time += beatSeconds) {
    const beatInBar = beatIndex % sigTop;
    const isStrong = beatInBar === 0 || (sigTop >= 4 && beatInBar === midpoint);
    if (isStrong || density === "dense") {
      const bass = beatInBar === midpoint ? voicing.bassFifth : voicing.bassRoot;
      appendArrangementNote(output, bass, time, beatSeconds * (density === "dense" ? 0.42 : 0.72), 58, end);
    }
    if (density === "light") {
      if (isStrong) {
        appendChordStack(output, voicing.mid, time, beatSeconds * 0.84, 47, end, 0.008);
      }
      continue;
    }
    appendChordStack(output, voicing.mid, time, beatSeconds * 0.46, 50, end, 0.006);
    if (density === "dense") {
      appendChordStack(output, voicing.high, time, beatSeconds * 0.32, 43, end, 0.004);
    }
  }
}

function appendArpeggioArrangement(output, chord, voicing, start, end, beatSeconds, density) {
  const stepBeats = density === "dense" ? 0.25 : (density === "light" ? 1 : 0.5);
  const step = beatSeconds * stepBeats;
  const pattern = density === "light"
    ? [voicing.bassRoot, ...voicing.mid]
    : [voicing.bassRoot, voicing.mid[0], voicing.mid[1], voicing.mid[2], voicing.high[1] || voicing.mid[1], voicing.high[2] || voicing.mid[2]];
  for (let index = 0, time = start; time < end - 0.035; index += 1, time += step) {
    const note = pattern[index % pattern.length];
    const velocity = note < 48 ? 55 : (density === "dense" ? 45 : 49);
    appendArrangementNote(output, note, time, step * 0.88, velocity, end);
  }
}

function appendBalladArrangement(output, chord, voicing, start, end, beatSeconds, settings, density) {
  const sigTop = Math.max(1, settings.sigTop || 4);
  const midpoint = Math.floor(sigTop / 2);
  for (let beatIndex = 0, time = start; time < end - 0.035; beatIndex += 1, time += beatSeconds) {
    const beatInBar = beatIndex % sigTop;
    if (beatInBar === 0 || (sigTop >= 4 && beatInBar === midpoint)) {
      const bass = beatInBar === midpoint ? voicing.bassFifth : voicing.bassRoot;
      appendArrangementNote(output, bass, time, beatSeconds * 0.92, 52, end);
    }
    const chordTime = time;
    appendChordStack(output, voicing.mid, chordTime, beatSeconds * (density === "light" ? 1.05 : 0.78), 45, end, 0.026);
    if (density === "dense") {
      appendArrangementNote(output, voicing.high[1] || voicing.mid[1], time, beatSeconds * 0.24, 39, end);
    }
  }
}

function appendChordStack(output, notes, start, duration, velocity, clipEnd, rollSeconds = 0) {
  notes.forEach((note, index) => {
    const rolledStart = start + index * rollSeconds;
    appendArrangementNote(output, note, rolledStart, Math.max(0.05, duration - index * rollSeconds), velocity - index * 2, clipEnd);
  });
}

function appendArrangementNote(output, note, start, duration, velocity, clipEnd) {
  if (!Number.isFinite(note) || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || start >= clipEnd - 0.025) {
    return;
  }
  const end = Math.min(clipEnd, start + duration);
  if (end - start < 0.025) {
    return;
  }
  output.push({
    note: clampInt(note, 0, 127),
    start,
    end,
    velocity: clampInt(velocity, 1, 127),
  });
}

function normalizeArrangementMidi(note, min, max) {
  let midi = note;
  while (midi < min) midi += 12;
  while (midi > max) midi -= 12;
  return clampInt(midi, 0, 127);
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value)).map((value) => clampInt(value, 0, 127)))]
    .sort((a, b) => a - b);
}

function buildChordTrack(chords, settings) {
  const notes = [];
  const gridSeconds = chordGridSeconds(settings);
  for (const chord of chords) {
    const start = snapToGrid(chord.start, gridSeconds, settings.beatOffsetSeconds || 0);
    const end = alignedChordEnd(chord, start, gridSeconds, settings.beatOffsetSeconds || 0);
    for (const note of chord.notes) {
      notes.push({
        note,
        start,
        end,
        velocity: chord.velocity || 54,
      });
    }
  }
  return buildNoteTrack("Smart Chords", notes, settings, 1, false);
}

function chordGridSeconds(settings) {
  const beatSeconds = 60 / settings.tempo;
  const barSeconds = beatSeconds * settings.sigTop;
  if (settings.harmonyGrid === "bar") {
    return barSeconds;
  }
  if (settings.harmonyGrid === "half") {
    return Math.max(beatSeconds, barSeconds * 0.5);
  }
  return adaptiveHarmonyFrameSeconds(settings);
}

function adaptiveHarmonyFrameSeconds(settings) {
  const beatSeconds = 60 / Math.max(30, settings.tempo || 120);
  const barSeconds = beatSeconds * Math.max(1, settings.sigTop || 4);
  const density = settings.arrangementDensity || "normal";
  if (density === "light") {
    return barSeconds;
  }
  if (density === "dense") {
    return beatSeconds;
  }
  return Math.max(beatSeconds, barSeconds * 0.5);
}

function alignedChordEnd(chord, chordStart, gridSeconds, beatOffsetSeconds) {
  const snappedEnd = snapToGrid(chord.end, gridSeconds, beatOffsetSeconds);
  if (snappedEnd > chordStart + 0.001) {
    return snappedEnd;
  }
  return chordStart + gridSeconds;
}

function buildNoteTrack(name, notes, settings, channel, includeTiming) {
  const ticksPerBeat = 480;
  const ticksPerSecond = ticksPerBeat * settings.tempo / 60;
  const timeOrigin = settings.alignMusicToFirstBeat === false ? 0 : settings.beatOffsetSeconds || 0;
  const track = [];
  pushMetaText(track, 0, 0x03, name);
  if (includeTiming) {
    pushMetaTempo(track, 0, Math.round(60000000 / settings.tempo));
    pushMetaTimeSignature(track, 0, settings.sigTop, settings.sigBottom);
  }
  pushProgramChange(track, 0, channel, 0);

  const events = [];
  for (const note of notes) {
    const midiNote = noteMidiValue(note);
    const startTick = Math.max(0, Math.round((note.start - timeOrigin) * ticksPerSecond));
    const endTick = Math.max(startTick + 1, Math.round((note.end - timeOrigin) * ticksPerSecond));
    events.push({ tick: startTick, order: 1, data: [0x90 | channel, midiNote, note.velocity] });
    events.push({ tick: endTick, order: 0, data: [0x80 | channel, midiNote, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let previousTick = 0;
  for (const event of events) {
    pushVarLen(track, event.tick - previousTick);
    track.push(...event.data);
    previousTick = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  return track;
}

function noteMidiValue(note) {
  return Math.max(0, Math.min(127, Math.round(note.note ?? note.midi ?? note.pitch ?? 60)));
}

function detectKey(notes) {
  if (notes.length < 3) {
    return null;
  }
  const histogram = new Array(12).fill(0);
  let totalWeight = 0;
  const weightedNotes = notes.map((note, index) => {
    const pitchClass = keyDetectionPitchClass(note);
    const weight = keyDetectionWeight(note, index, notes);
    histogram[pitchClass] += weight;
    totalWeight += weight;
    return { note, pitchClass, weight, index };
  });
  if (totalWeight <= 0) {
    return null;
  }
  let best = { score: -Infinity, tonic: 0, mode: "major", fit: 0 };
  let secondScore = -Infinity;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const majorScore = keyCandidateScore(histogram, weightedNotes, tonic, "major", totalWeight);
    const minorScore = keyCandidateScore(histogram, weightedNotes, tonic, "minor", totalWeight);
    if (majorScore > best.score) {
      secondScore = best.score;
      best = { score: majorScore, tonic, mode: "major", fit: scaleFit(weightedNotes, tonic, "major", totalWeight) };
    } else if (majorScore > secondScore) {
      secondScore = majorScore;
    }
    if (minorScore > best.score) {
      secondScore = best.score;
      best = { score: minorScore, tonic, mode: "minor", fit: scaleFit(weightedNotes, tonic, "minor", totalWeight) };
    } else if (minorScore > secondScore) {
      secondScore = minorScore;
    }
  }
  return { ...best, confidence: best.score - secondScore, name: `${NOTE_NAMES[best.tonic]} ${best.mode}` };
}

function keyDetectionPitchClass(note) {
  const audioMidi = Number(note.pyinMidi);
  const midi = Number.isFinite(audioMidi) && audioMidi >= 0 && audioMidi <= 127
    ? Math.round(audioMidi)
    : noteMidiValue(note);
  return ((midi % 12) + 12) % 12;
}

function keyDetectionWeight(note, index, notes) {
  const duration = Math.max(0.02, (Number(note.end) || 0) - (Number(note.start) || 0));
  const velocity = Math.sqrt(clampNumber(note.velocity || 72, 1, 127) / 90);
  const confidence = clampNumber(note.pyinConfidence ?? note.audioConfidence ?? note.confidence ?? 0.72, 0.25, 1);
  const shortPenalty = duration < 0.16 ? 0.42 : duration < 0.24 ? 0.72 : 1;
  const longBonus = Math.min(1.8, 0.72 + duration * 0.82);
  const previous = notes[index - 1] || null;
  const next = notes[index + 1] || null;
  const phraseEnd = !next || (Number(next.start) || 0) - (Number(note.end) || 0) > 0.42;
  const phraseStart = !previous || (Number(note.start) || 0) - (Number(previous.end) || 0) > 0.42;
  const phraseBonus = (phraseStart ? 1.12 : 1) * (phraseEnd ? 1.34 : 1);
  return Math.max(0.001, longBonus * velocity * confidence * shortPenalty * phraseBonus);
}

function keyCandidateScore(histogram, weightedNotes, tonic, mode, totalWeight) {
  const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
  const profileScore = (cosine(histogram, roll(profile, tonic)) + 1) * 0.5;
  const fit = scaleFit(weightedNotes, tonic, mode, totalWeight);
  const tonicFit = pitchClassWeight(weightedNotes, tonic, totalWeight);
  const dominantFit = pitchClassWeight(weightedNotes, (tonic + 7) % 12, totalWeight);
  const third = (tonic + (mode === "major" ? 4 : 3)) % 12;
  const thirdFit = pitchClassWeight(weightedNotes, third, totalWeight);
  const cadence = cadenceSupport(weightedNotes, tonic, mode);
  return profileScore * 0.34
    + fit * 0.42
    + tonicFit * 0.12
    + dominantFit * 0.045
    + thirdFit * 0.035
    + cadence * 0.18;
}

function scaleFit(weightedNotes, tonic, mode, totalWeight) {
  const scale = mode === "major" ? MAJOR_SCALE : MINOR_SCALE;
  const allowed = new Set([...scale].map((interval) => (tonic + interval) % 12));
  let inside = 0;
  for (const item of weightedNotes) {
    if (allowed.has(item.pitchClass)) {
      inside += item.weight;
    }
  }
  return inside / Math.max(0.001, totalWeight);
}

function pitchClassWeight(weightedNotes, pitchClass, totalWeight) {
  return weightedNotes
    .filter((item) => item.pitchClass === pitchClass)
    .reduce((sum, item) => sum + item.weight, 0) / Math.max(0.001, totalWeight);
}

function cadenceSupport(weightedNotes, tonic, mode) {
  if (!weightedNotes.length) {
    return 0;
  }
  const last = weightedNotes[weightedNotes.length - 1];
  const first = weightedNotes[0];
  const dominant = (tonic + 7) % 12;
  const third = (tonic + (mode === "major" ? 4 : 3)) % 12;
  let score = 0;
  if (last.pitchClass === tonic) score += 0.55;
  if (last.pitchClass === dominant) score += 0.25;
  if (last.pitchClass === third) score += 0.12;
  if (first.pitchClass === tonic) score += 0.24;
  if (first.pitchClass === dominant) score += 0.10;
  return Math.min(1, score);
}

function allowedPitchClasses(key) {
  if (!key) {
    return null;
  }
  const scale = key.mode === "major" ? MAJOR_SCALE : MINOR_SCALE;
  return new Set([...scale].map((interval) => (key.tonic + interval) % 12));
}

function nearestAllowedNote(note, allowed) {
  let best = note;
  let bestDistance = Infinity;
  for (let candidate = Math.max(0, note - 6); candidate <= Math.min(127, note + 6); candidate += 1) {
    if (!allowed.has(candidate % 12)) continue;
    const distance = Math.abs(candidate - note);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function estimateStartNoise(data, sampleRate, frameSize, hopSize, settings) {
  const seconds = clampNumber(settings.noiseProfileSeconds ?? 0.5, 0, 2);
  if (!seconds) {
    return 0;
  }
  const frameLimit = Math.max(1, Math.min(
    Math.floor(data.length / hopSize),
    Math.ceil(seconds * sampleRate / hopSize),
  ));
  const values = [];
  for (let frame = 0; frame < frameLimit; frame += 1) {
    values.push(frameRms(data, frame * hopSize - Math.floor(frameSize / 2), frameSize));
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.35)] || 0;
}

function estimateVoicingThreshold(rms, ranges, settings, startNoise) {
  let count = 0;
  let squared = 0;
  const values = [];
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      const value = rms[index];
      if (value <= 0) continue;
      count += 1;
      squared += value * value;
      values.push(value);
    }
  }
  if (!values.length) {
    return 1;
  }
  values.sort((a, b) => a - b);
  const global = Math.sqrt(squared / count);
  const noiseFloor = values[Math.floor(values.length * 0.2)];
  const relative = global * Math.pow(10, -36 / 20);
  const floor = Math.max(noiseFloor, startNoise || 0);
  const noise = floor * Math.pow(10, settings.noiseGateDb / 20);
  return Math.max(0.0008, relative, Math.min(noise, global * 0.7));
}

function smoothPitches(pitches, ranges) {
  const output = new Float32Array(pitches);
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i += 1) {
      if (pitches[i] <= 0) continue;
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(pitches.length - 1, i + 1); j += 1) {
        if (pitches[j] > 0) {
          sum += pitches[j];
          count += 1;
        }
      }
      if (count >= 2) output[i] = sum / count;
    }
  }
  return output;
}

function pitchesToMidiArray(pitches) {
  const midi = new Int16Array(pitches.length);
  for (let i = 0; i < pitches.length; i += 1) {
    if (pitches[i] > 0) {
      midi[i] = clampInt(Math.round(69 + 12 * Math.log2(pitches[i] / 440)), 0, 127);
    }
  }
  return midi;
}

function stabilizePitchTrack(pitches, ranges, evidence = null) {
  const midi = new Float32Array(pitches.length);
  for (let i = 0; i < pitches.length; i += 1) {
    if (pitches[i] > 0) {
      midi[i] = 69 + 12 * Math.log2(pitches[i] / 440);
    }
  }

  const corrected = new Float32Array(midi);
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i += 1) {
      if (midi[i] <= 0) {
        continue;
      }
      const previous = nearbyMidi(midi, i, -1, 6);
      const next = nearbyMidi(midi, i, 1, 6);
      if (!previous || !next) {
        continue;
      }
      if (hasReliableFrameOctave(evidence, i)) {
        continue;
      }
      const current = midi[i];
      let best = current;
      let bestScore = Math.abs(current - previous) + Math.abs(current - next);
      for (const shift of [-24, -12, 12, 24]) {
        const candidate = current + shift;
        if (candidate < 0 || candidate > 127) {
          continue;
        }
        const score = Math.abs(candidate - previous) + Math.abs(candidate - next);
        if (score + 4 < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (Math.abs(best - previous) > 7 && Math.abs(best - next) > 7 && Math.abs(previous - next) <= 3) {
        best = (previous + next) / 2;
      }
      corrected[i] = best;
    }
  }

  const output = new Float32Array(pitches.length);
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i += 1) {
      if (corrected[i] <= 0) {
        continue;
      }
      const local = [];
      for (let j = Math.max(range.start, i - 2); j <= Math.min(range.end - 1, i + 2); j += 1) {
        if (corrected[j] > 0 && Math.abs(corrected[j] - corrected[i]) <= 5) {
          local.push(corrected[j]);
        }
      }
      const smoothed = local.length >= 3 ? lerp(corrected[i], median(local), 0.35) : corrected[i];
      output[i] = 440 * 2 ** ((smoothed - 69) / 12);
    }
  }
  return output;
}

function hasReliableFrameOctave(evidence, index) {
  if (!evidence?.scores || !evidence?.octavePenalties) {
    return false;
  }
  const score = evidence.scores[index] || 0;
  const penalty = evidence.octavePenalties[index] || 0;
  return score >= 0.82 && penalty <= 0.08;
}

function nearbyMidi(midi, index, direction, maxFrames) {
  for (let step = 1; step <= maxFrames; step += 1) {
    const value = midi[index + step * direction];
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

function flattenVibratoRegions(midi, settings) {
  const maxRegionFrames = Math.max(8, Math.round(1350 / settings.hopMs));
  let index = 0;
  while (index < midi.length) {
    if (!midi[index]) {
      index += 1;
      continue;
    }
    const start = index;
    let minNote = midi[index];
    let maxNote = midi[index];
    const counts = new Map();
    while (index < midi.length && midi[index]) {
      const note = midi[index];
      minNote = Math.min(minNote, note);
      maxNote = Math.max(maxNote, note);
      counts.set(note, (counts.get(note) || 0) + 1);
      index += 1;
    }
    const end = index;
    const length = end - start;
    const span = maxNote - minNote;
    if (length > maxRegionFrames || span > 2) {
      continue;
    }
    let modeNote = minNote;
    let modeCount = 0;
    for (const [note, count] of counts.entries()) {
      if (count > modeCount || (count === modeCount && Math.abs(note - (minNote + maxNote) / 2) < Math.abs(modeNote - (minNote + maxNote) / 2))) {
        modeNote = note;
        modeCount = count;
      }
    }
    if (modeCount / length >= 0.28 || span <= 1) {
      for (let frame = start; frame < end; frame += 1) {
        midi[frame] = modeNote;
      }
    }
  }
}

function fillShortGaps(midi, maxGap) {
  let i = 0;
  while (i < midi.length) {
    if (midi[i] !== 0) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < midi.length && midi[i] === 0) i += 1;
    const end = i;
    const previous = start > 0 ? midi[start - 1] : 0;
    const next = end < midi.length ? midi[end] : 0;
    if (previous && next && previous === next && end - start <= maxGap) {
      for (let j = start; j < end; j += 1) midi[j] = previous;
    }
  }
}

function modeFilter(midi, windowSize) {
  const copy = new Int16Array(midi);
  const radius = Math.floor(windowSize / 2);
  for (let i = 0; i < midi.length; i += 1) {
    if (midi[i] === 0) continue;
    let bestNote = midi[i];
    let bestCount = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(midi.length - 1, i + radius); j += 1) {
      const candidate = copy[j];
      if (!candidate) continue;
      let count = 0;
      for (let k = Math.max(0, i - radius); k <= Math.min(midi.length - 1, i + radius); k += 1) {
        if (copy[k] === candidate) count += 1;
      }
      if (count > bestCount) {
        bestNote = candidate;
        bestCount = count;
      }
    }
    midi[i] = bestNote;
  }
}

function removeUnstableRuns(midi, minFrames) {
  let i = 0;
  while (i < midi.length) {
    const note = midi[i];
    const start = i;
    while (i < midi.length && midi[i] === note) i += 1;
    const end = i;
    if (note && end - start < minFrames) {
      for (let j = start; j < end; j += 1) midi[j] = 0;
    }
  }
}

function enforceOrder(notes, settings) {
  const minDuration = settings.quantize
    ? quantizeGridSeconds(settings)
    : Math.max(0.08, settings.minNoteMs / 1000);
  const output = [];
  for (const note of [...notes].sort((a, b) => a.start - b.start || a.note - b.note)) {
    let start = Math.max(0, note.start);
    let end = Math.max(start + minDuration, note.end);
    if (output.length && start < output[output.length - 1].end) {
      const previous = output[output.length - 1];
      previous.end = Math.max(previous.start + minDuration, Math.min(previous.end, start));
      start = Math.max(start, previous.end);
      end = Math.max(start + minDuration, end);
    }
    output.push({
      ...note,
      note: clampInt(note.note, 0, 127),
      start,
      end,
      velocity: clampInt(note.velocity, 1, 127),
    });
  }
  return output;
}

function applyLegato(notes, settings) {
  const output = notes.map((note) => ({ ...note }));
  const maxGap = 0.42;
  const minDuration = settings.quantize
    ? quantizeGridSeconds(settings)
    : Math.max(0.12, settings.minNoteMs / 1000);
  for (let i = 0; i < output.length - 1; i += 1) {
    const gap = output[i + 1].start - output[i].end;
    if (gap <= maxGap) {
      output[i].end = Math.max(output[i].start + minDuration, output[i + 1].start);
    }
  }
  return output;
}

function smoothVelocities(notes) {
  return notes.map((note, index) => {
    const left = notes[Math.max(0, index - 1)].velocity;
    const center = note.velocity;
    const right = notes[Math.min(notes.length - 1, index + 1)].velocity;
    const localMedian = median3(left, center, right);
    return { ...note, velocity: clampInt(Math.round(lerp(note.velocity, localMedian, 0.42)), 42, 110) };
  });
}

function mergeAdjacent(notes, maxGap) {
  const merged = [];
  for (const note of notes) {
    const last = merged[merged.length - 1];
    if (last && last.note === note.note && note.start - last.end <= maxGap) {
      const previousDuration = Math.max(0.001, last.end - last.start);
      const nextDuration = Math.max(0.001, note.end - note.start);
      const totalDuration = previousDuration + nextDuration;
      last.end = note.end;
      last.velocity = Math.max(last.velocity, note.velocity);
      last.audioConfidence = weightedAverage(last.audioConfidence, note.audioConfidence, previousDuration, nextDuration, totalDuration);
      last.octaveAmbiguity = weightedAverage(last.octaveAmbiguity, note.octaveAmbiguity, previousDuration, nextDuration, totalDuration);
      last.audioAgreement = weightedAverage(last.audioAgreement, note.audioAgreement, previousDuration, nextDuration, totalDuration);
      last.audioOctaveConflict = weightedAverage(last.audioOctaveConflict, note.audioOctaveConflict, previousDuration, nextDuration, totalDuration);
      last.audioOctaveSupport = Math.max(last.audioOctaveSupport || 0, note.audioOctaveSupport || 0);
    } else {
      merged.push({ ...note });
    }
  }
  return merged;
}

function weightedAverage(a, b, weightA, weightB, totalWeight) {
  if (!Number.isFinite(a)) {
    return b;
  }
  if (!Number.isFinite(b)) {
    return a;
  }
  return (a * weightA + b * weightB) / Math.max(0.001, totalWeight);
}

function makeNote(note, start, end, velocitySum, velocityCount, evidence = {}) {
  return {
    note: clampInt(note, 0, 127),
    start,
    end: Math.max(start + 0.02, end),
    velocity: rmsToVelocity(velocitySum, velocityCount),
    ...evidence,
  };
}

function rmsToVelocity(sum, count) {
  if (!count) {
    return 72;
  }
  const normalized = Math.min(1, (sum / count) / 0.12);
  return clampInt(Math.round(42 + normalized * (110 - 42)), 1, 127);
}

function estimateLastMarkerEnd(pitches, start, duration, hopSeconds, minDuration) {
  const startFrame = Math.max(0, Math.floor(start / hopSeconds));
  let last = -1;
  for (let i = startFrame; i < pitches.length; i += 1) {
    if (pitches[i] > 0) last = i;
  }
  if (last < 0) return Math.min(duration, start + Math.max(0.5, minDuration));
  return Math.min(duration, Math.max(start + minDuration, (last + 2) * hopSeconds));
}

function frameRms(data, start, size) {
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const value = data[start + i] || 0;
    sum += value * value;
  }
  return Math.sqrt(sum / size);
}

function hannWindow(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, size - 1));
  }
  return window;
}

function resampleLinear(data, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return data;
  }
  const duration = data.length / sourceRate;
  const output = new Float32Array(Math.max(1, Math.round(duration * targetRate)));
  for (let i = 0; i < output.length; i += 1) {
    const sourceIndex = i * sourceRate / targetRate;
    const left = Math.floor(sourceIndex);
    const right = Math.min(data.length - 1, left + 1);
    const amount = sourceIndex - left;
    output[i] = data[left] * (1 - amount) + data[right] * amount;
  }
  return output;
}

function pushMetaText(bytes, delta, type, text) {
  const encoded = new TextEncoder().encode(text);
  pushVarLen(bytes, delta);
  bytes.push(0xff, type);
  pushVarLen(bytes, encoded.length);
  bytes.push(...encoded);
}

function pushMetaTempo(bytes, delta, tempo) {
  pushVarLen(bytes, delta);
  bytes.push(0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
}

function pushMetaTimeSignature(bytes, delta, numerator, denominator) {
  pushVarLen(bytes, delta);
  bytes.push(0xff, 0x58, 0x04, numerator & 0xff, Math.round(Math.log2(denominator)), 24, 8);
}

function pushProgramChange(bytes, delta, channel, program) {
  pushVarLen(bytes, delta);
  bytes.push(0xc0 | (channel & 0x0f), program & 0x7f);
}

function pushString(bytes, value) {
  for (let i = 0; i < value.length; i += 1) {
    bytes.push(value.charCodeAt(i));
  }
}

function push16(bytes, value) {
  bytes.push((value >> 8) & 0xff, value & 0xff);
}

function push32(bytes, value) {
  bytes.push((value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

function pushVarLen(bytes, value) {
  let buffer = value & 0x7f;
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= ((value & 0x7f) | 0x80);
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }
}

function cosine(a, b) {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    dot += da * db;
    normA += da * da;
    normB += db * db;
  }
  return dot / Math.sqrt(Math.max(normA * normB, 1e-12));
}

function roll(array, amount) {
  return array.map((_, index) => array[(index - amount + array.length) % array.length]);
}

function median3(a, b, c) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function clampInt(value, min, max) {
  return Math.round(clampNumber(value, min, max));
}
