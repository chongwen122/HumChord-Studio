const $ = (selector) => document.querySelector(selector);

const state = {
  audioContext: null,
  mediaStream: null,
  recordingSource: null,
  recordingProcessor: null,
  recordingSilentGain: null,
  mediaRecorder: null,
  mediaRecorderChunks: [],
  recordedFrames: [],
  recordedSampleCount: 0,
  recordingContextStartedAt: 0,
  audioInputDevices: [],
  selectedAudioInputId: "",
  audioBuffer: null,
  monoData: null,
  sampleRate: 0,
  duration: 0,
  notes: [],
  chords: [],
  currentPage: "record",
  keySnapUndoNotes: null,
  keySnapUndoChords: null,
  selectedNoteIndex: -1,
  selectedChordIndex: -1,
  pianoLayout: null,
  beatOffsetSeconds: 0,
  recordingBeatOffsetSeconds: 0,
  markers: [],
  key: null,
  suggestedKey: null,
  recording: false,
  preparingRecording: false,
  recordingStartedAt: 0,
  metronomeTimer: null,
  nextBeatTime: 0,
  beatIndex: 0,
  midiUrl: null,
  piano: null,
  midiPlaying: false,
  midiPlaybackTimer: null,
  midiSchedulerTimer: null,
  worker: null,
  analysisJobId: 0,
  analyzing: false,
  engineAvailable: false,
  engineLastError: "",
};

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR_SCALE = new Set([0, 2, 4, 5, 7, 9, 11]);
const MINOR_SCALE = new Set([0, 2, 3, 5, 7, 8, 10]);
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const METRONOME_LEAD_IN_SECONDS = 0.08;
const ASSET_VERSION = "20260621-keysnap";
const WORKFLOW_PAGES = new Set(["record", "detect", "harmony", "export"]);

const els = {};

window.addEventListener("DOMContentLoaded", init);

function init() {
  Object.assign(els, {
    statusCard: $(".status-card"),
    statusDot: $("#statusDot"),
    statusText: $("#statusText"),
    pageTabs: [...document.querySelectorAll("[data-page-tab]")],
    pagePanels: [...document.querySelectorAll("[data-pages]")],
    recordBtn: $("#recordBtn"),
    stopBtn: $("#stopBtn"),
    fileInput: $("#fileInput"),
    audioInput: $("#audioInputSelect"),
    refreshInputsBtn: $("#refreshInputsBtn"),
    audioName: $("#audioName"),
    audioDuration: $("#audioDuration"),
    exportWavBtn: $("#exportWavBtn"),
    melodyneMidiInput: $("#melodyneMidiInput"),
    melodyneStatus: $("#melodyneStatus"),
    tempo: $("#tempoInput"),
    sigTop: $("#sigTopInput"),
    sigBottom: $("#sigBottomInput"),
    keySelect: $("#keySelect"),
    metronome: $("#metronomeToggle"),
    manualMarker: $("#manualMarkerToggle"),
    markerCount: $("#markerCount"),
    fmin: $("#fminInput"),
    fmax: $("#fmaxInput"),
    noiseGate: $("#noiseGateInput"),
    minNote: $("#minNoteInput"),
    polish: $("#polishToggle"),
    quantize: $("#quantizeToggle"),
    harmony: $("#harmonyToggle"),
    harmonyGrid: $("#harmonyGridSelect"),
    quantizeGrid: $("#quantizeGridSelect"),
    manualAttack: $("#manualAttackInput"),
    manualWindow: $("#manualWindowInput"),
    noteCount: $("#noteCount"),
    keyLabel: $("#keyLabel"),
    rangeLabel: $("#rangeLabel"),
    waveCanvas: $("#waveCanvas"),
    pianoCanvas: $("#pianoCanvas"),
    analyzeBtn: $("#analyzeBtn"),
    quantizeNowBtn: $("#quantizeNowBtn"),
    keySnapBtn: $("#keySnapBtn"),
    keyUndoBtn: $("#keyUndoBtn"),
    midiPlayBtn: $("#midiPlayBtn"),
    playBtn: $("#playBtn"),
    downloadLink: $("#downloadLink"),
    resultSummary: $("#resultSummary"),
    chordStrip: $("#chordStrip"),
    chordEditor: $("#chordEditor"),
    chordEditLabel: $("#chordEditLabel"),
    chordSelect: $("#chordSelect"),
    noteEditor: $("#noteEditor"),
    noteEditLabel: $("#noteEditLabel"),
    notePitchSelect: $("#notePitchSelect"),
    noteStartBeat: $("#noteStartBeatInput"),
    noteDurationBeat: $("#noteDurationBeatInput"),
    noteVelocity: $("#noteVelocityInput"),
    noteOctaveDownBtn: $("#noteOctaveDownBtn"),
    noteDownBtn: $("#noteDownBtn"),
    noteUpBtn: $("#noteUpBtn"),
    noteOctaveUpBtn: $("#noteOctaveUpBtn"),
    noteApplyBtn: $("#noteApplyBtn"),
    noteDeleteBtn: $("#noteDeleteBtn"),
  });

  els.recordBtn.addEventListener("click", startRecording);
  els.stopBtn.addEventListener("click", stopRecording);
  els.fileInput.addEventListener("change", handleFileInput);
  els.exportWavBtn.addEventListener("click", exportWavForMelodyne);
  els.melodyneMidiInput.addEventListener("change", handleMelodyneMidiInput);
  els.audioInput.addEventListener("change", () => {
    state.selectedAudioInputId = els.audioInput.value;
  });
  els.keySelect.addEventListener("change", handleKeySelectChange);
  els.refreshInputsBtn.addEventListener("click", refreshAudioInputs);
  els.analyzeBtn.addEventListener("click", analyzeAndExport);
  els.quantizeNowBtn.addEventListener("click", quantizeCurrentNotes);
  els.keySnapBtn.addEventListener("click", applyKeySnapToCurrentNotes);
  els.keyUndoBtn.addEventListener("click", undoKeySnap);
  els.midiPlayBtn.addEventListener("click", toggleMidiPlayback);
  els.playBtn.addEventListener("click", playAudio);
  els.chordSelect.addEventListener("change", handleChordSelectChange);
  els.pianoCanvas.addEventListener("click", handlePianoRollClick);
  els.notePitchSelect.addEventListener("change", applyNoteEditorChanges);
  els.noteStartBeat.addEventListener("change", applyNoteEditorChanges);
  els.noteDurationBeat.addEventListener("change", applyNoteEditorChanges);
  els.noteVelocity.addEventListener("change", applyNoteEditorChanges);
  els.noteApplyBtn.addEventListener("click", applyNoteEditorChanges);
  els.noteDeleteBtn.addEventListener("click", deleteSelectedNote);
  els.noteUpBtn.addEventListener("click", () => transposeSelectedNote(1));
  els.noteDownBtn.addEventListener("click", () => transposeSelectedNote(-1));
  els.noteOctaveUpBtn.addEventListener("click", () => transposeSelectedNote(12));
  els.noteOctaveDownBtn.addEventListener("click", () => transposeSelectedNote(-12));
  els.pageTabs.forEach((tab) => {
    tab.addEventListener("click", () => setWorkflowPage(tab.dataset.pageTab || "record"));
  });
  window.addEventListener("resize", render);
  window.addEventListener("hashchange", () => setWorkflowPage(pageFromHash() || state.currentPage, false));
  document.addEventListener("keydown", handleKeyDown, true);
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", refreshAudioInputs);
  }

  setStatus("准备就绪");
  populateNotePitchSelect();
  refreshAudioInputs();
  checkHighPrecisionEngine();
  setWorkflowPage(pageFromHash() || "record", false);
  render();
}

function pageFromHash() {
  const page = window.location.hash.replace(/^#/, "");
  return WORKFLOW_PAGES.has(page) ? page : "";
}

function setWorkflowPage(page, updateHash = true) {
  if (!WORKFLOW_PAGES.has(page)) {
    page = "record";
  }
  state.currentPage = page;
  els.pageTabs.forEach((tab) => {
    const active = tab.dataset.pageTab === page;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
  });
  els.pagePanels.forEach((panel) => {
    const pages = (panel.dataset.pages || "").split(/\s+/).filter(Boolean);
    panel.hidden = !pages.includes(page);
  });
  if (updateHash && window.location.hash !== `#${page}`) {
    history.replaceState(null, "", `#${page}`);
  }
  renderWorkflowTools();
  render();
}

function renderWorkflowTools() {
  renderNoteEditor();
  renderChordEditor();
}

async function checkHighPrecisionEngine() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    state.engineAvailable = data.available === true;
    state.engineLastError = data.error || "";
    if (state.engineAvailable) {
      els.melodyneStatus.textContent = `本地高精度引擎已就绪：${data.engine} ${data.runtime || ""}`.trim();
    } else {
      els.melodyneStatus.textContent = "本地高精度引擎未就绪，生成时会使用网页备份引擎";
    }
  } catch (error) {
    state.engineAvailable = false;
    state.engineLastError = error instanceof Error ? error.message : String(error);
    els.melodyneStatus.textContent = "未连接本地高精度引擎，生成时会使用网页备份引擎";
  }
}

async function ensureAudioContext() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("当前浏览器不支持 Web Audio。");
    }
    state.audioContext = new AudioContextClass();
  }
  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
  return state.audioContext;
}

async function refreshAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    els.audioInput.replaceChildren(new Option("浏览器不支持设备选择", ""));
    els.audioInput.disabled = true;
    els.refreshInputsBtn.disabled = true;
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.audioInputDevices = devices.filter((device) => device.kind === "audioinput");
    renderAudioInputOptions();
  } catch {
    els.audioInput.replaceChildren(new Option("无法读取输入设备", ""));
  }
}

function renderAudioInputOptions() {
  const previous = state.selectedAudioInputId || els.audioInput.value;
  els.audioInput.replaceChildren();
  els.audioInput.appendChild(new Option("系统默认输入", ""));
  state.audioInputDevices.forEach((device, index) => {
    const label = device.label || `麦克风 ${index + 1}`;
    els.audioInput.appendChild(new Option(label, device.deviceId));
  });
  const hasPrevious = [...els.audioInput.options].some((option) => option.value === previous);
  els.audioInput.value = hasPrevious ? previous : "";
  state.selectedAudioInputId = els.audioInput.value;
  els.audioInput.disabled = false;
  els.refreshInputsBtn.disabled = false;
}

async function startRecording() {
  if (state.recording || state.preparingRecording) {
    return;
  }
  try {
    const audioContext = await ensureAudioContext();
    state.preparingRecording = true;
    els.recordBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.recordBtn.blur();
    setStatus("正在打开麦克风");
    releaseMediaStream(state.mediaStream);
    state.mediaStream = null;
    state.mediaStream = await withTimeout(
      requestMicrophoneStream(),
      8000,
      "打开麦克风超时。请点“刷新”后重新选择 VoiceMeeter Output / Aux Output，或先关闭再打开浏览器页面。",
    );
    await refreshAudioInputs();
    selectActiveInputFromStream(state.mediaStream);
    state.recordedFrames = [];
    state.recordedSampleCount = 0;
    state.markers = [];
    state.recordingBeatOffsetSeconds = els.metronome.checked ? METRONOME_LEAD_IN_SECONDS : 0;
    updateMarkerCount();
    const source = audioContext.createMediaStreamSource(state.mediaStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0.000001;
    processor.onaudioprocess = (event) => {
      if (!state.recording) {
        return;
      }
      const frame = extractDominantMonoFrame(event.inputBuffer);
      state.recordedFrames.push(frame);
      state.recordedSampleCount += frame.length;
    };
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
    state.recordingSource = source;
    state.recordingProcessor = processor;
    state.recordingSilentGain = silentGain;
    state.sampleRate = audioContext.sampleRate;
    startMediaRecorderFallback(state.mediaStream);
    state.recordedFrames = [];
    state.recordedSampleCount = 0;
    state.recording = true;
    state.recordingContextStartedAt = audioContext.currentTime;
    state.recordingStartedAt = performance.now();
    state.preparingRecording = false;
    els.recordBtn.disabled = true;
    els.stopBtn.disabled = false;
    setStatus("正在录音", "recording");
    if (els.metronome.checked) {
      startMetronome(audioContext);
    }
    render();
  } catch (error) {
    state.recording = false;
    state.preparingRecording = false;
    stopMediaRecorderFallback();
    stopRecordingGraph();
    releaseMediaStream(state.mediaStream);
    state.mediaStream = null;
    els.recordBtn.disabled = false;
    els.stopBtn.disabled = true;
    setStatus("录音失败", "error");
    alert(error.message);
  }
}

function startMediaRecorderFallback(stream) {
  const chunks = [];
  state.mediaRecorderChunks = chunks;
  state.mediaRecorder = null;
  if (!window.MediaRecorder) {
    return;
  }
  try {
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) {
        chunks.push(event.data);
      }
    });
    recorder.start(250);
    state.mediaRecorder = recorder;
  } catch {
    state.mediaRecorder = null;
    state.mediaRecorderChunks = [];
  }
}

function stopMediaRecorderFallback() {
  const recorder = state.mediaRecorder;
  const chunks = state.mediaRecorderChunks;
  state.mediaRecorder = null;
  state.mediaRecorderChunks = [];
  if (!recorder) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(chunks.length ? new Blob(chunks, { type: chunks[0].type || recorder.mimeType || "audio/webm" }) : null);
    };
    recorder.addEventListener("stop", finish, { once: true });
    recorder.addEventListener("error", finish, { once: true });
    try {
      if (recorder.state !== "inactive") {
        if (recorder.state === "recording") {
          recorder.requestData();
        }
        recorder.stop();
      } else {
        finish();
      }
    } catch {
      finish();
    }
    setTimeout(finish, 1200);
  });
}

async function handleKeySelectChange() {
  const key = selectedLockedKey();
  if (!key) {
    state.key = null;
    state.suggestedKey = state.notes.length ? detectKey(state.notes) : state.suggestedKey;
    state.chords = [];
    refreshMidiBlobFromState();
    updateNoteLabels();
    render();
    setStatus("调性自动识别");
    return;
  }
  state.key = key;
  state.suggestedKey = null;
  updateNoteLabels();
  if (state.recording || state.preparingRecording) {
    setStatus(`已选择 ${key.name}`);
    return;
  }
  try {
    const audioContext = await ensureAudioContext();
    setStatus(`${key.name} 基准音`);
    await playReferenceTone(audioContext, referenceFrequencyForKey(key));
    setStatus(`已锁定 ${key.name}`);
  } catch {
    setStatus(`已选择 ${key.name}`);
  }
}

function selectedLockedKey() {
  return parseKeySelection(els.keySelect?.value || "");
}

function parseKeySelection(value) {
  if (!value) {
    return null;
  }
  const [tonicText, modeText] = value.split(":");
  const tonic = Number(tonicText);
  const mode = modeText === "minor" ? "minor" : "major";
  if (!Number.isFinite(tonic)) {
    return null;
  }
  const normalizedTonic = ((Math.round(tonic) % 12) + 12) % 12;
  return {
    tonic: normalizedTonic,
    mode,
    name: `${NOTE_NAMES[normalizedTonic]} ${mode}`,
  };
}

function referenceFrequencyForKey(key) {
  const tonic = ((key.tonic % 12) + 12) % 12;
  const midi = tonic <= 7 ? 60 + tonic : 48 + tonic;
  return 440 * 2 ** ((midi - 69) / 12);
}

function playReferenceTone(audioContext, frequency) {
  return new Promise((resolve) => {
    let settled = false;
    let oscillator = null;
    let gain = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        oscillator?.disconnect();
        gain?.disconnect();
      } catch {
        // Audio nodes can already be disconnected by the browser.
      }
      resolve();
    };

    try {
      const startTime = audioContext.currentTime + 0.04;
      const duration = 0.75;
      const stopTime = startTime + duration;
      gain = audioContext.createGain();
      oscillator = audioContext.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, startTime);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.2, startTime + 0.04);
      gain.gain.setValueAtTime(0.2, Math.max(startTime + 0.05, stopTime - 0.12));
      gain.gain.exponentialRampToValueAtTime(0.0001, stopTime);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.addEventListener("ended", () => setTimeout(finish, 80), { once: true });
      oscillator.start(startTime);
      oscillator.stop(stopTime + 0.04);
      setTimeout(finish, 1100);
    } catch {
      finish();
    }
  });
}

function releaseMediaStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function extractDominantMonoFrame(input) {
  const frame = new Float32Array(input.length);
  const channels = Math.max(1, input.numberOfChannels);
  if (channels === 1) {
    frame.set(input.getChannelData(0));
    return frame;
  }

  let bestChannel = 0;
  let bestEnergy = -1;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = input.getChannelData(channel);
    let energy = 0;
    for (let i = 0; i < data.length; i += 1) {
      energy += data[i] * data[i];
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestChannel = channel;
    }
  }

  frame.set(input.getChannelData(bestChannel));
  return frame;
}

async function requestMicrophoneStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持麦克风录音，请使用新版 Chrome 或 Edge，并通过 localhost 打开页面。");
  }
  const deviceId = state.selectedAudioInputId || "";
  const deviceConstraint = deviceId ? { deviceId: { exact: deviceId } } : {};
  const attempts = [
    {
      audio: {
        ...deviceConstraint,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        latency: { ideal: 0.02 },
      },
    },
    {
      audio: {
        ...deviceConstraint,
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
        channelCount: { ideal: 2 },
      },
    },
    { audio: deviceId ? deviceConstraint : true },
    { audio: true },
  ];

  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      if (isMicrophoneBusyError(error)) {
        await wait(220);
      }
    }
  }
  throw new Error(microphoneErrorMessage(lastError));
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function isMicrophoneBusyError(error) {
  return error?.name === "NotReadableError" || error?.name === "TrackStartError";
}

function selectActiveInputFromStream(stream) {
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.();
  if (!settings?.deviceId) {
    return;
  }
  const hasDevice = state.audioInputDevices.some((device) => device.deviceId === settings.deviceId);
  if (hasDevice) {
    state.selectedAudioInputId = settings.deviceId;
    els.audioInput.value = settings.deviceId;
  }
}

function microphoneErrorMessage(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "没有找到可用麦克风，请检查声卡输入是否已连接并在系统里启用。";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return [
      "声卡输入通道没有被浏览器打开。请按下面顺序处理：",
      "1. 关闭可能占用声卡的软件：Melodyne、宿主 DAW、OBS、微信、QQ、浏览器里其他录音网页。",
      "2. 在 Windows 设置 > 系统 > 声音 > 输入 里确认选中这张声卡，并且输入电平会跳动。",
      "3. 打开 控制面板 > 声音 > 录制 > 声卡设备 > 属性 > 高级，取消“允许应用程序独占控制此设备”。采样率先设为 48000 Hz。",
      "4. 回到网页点“刷新”，重新选择麦克风输入；还不行就拔插声卡或重启浏览器。",
      "提示：浏览器不能直接使用只支持 ASIO 的输入，需要声卡提供 WDM/MME/DirectSound 输入设备。",
    ].join("\n");
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "当前声卡不接受浏览器请求的录音参数，请点击刷新设备后选择正确输入再试。";
  }
  return error?.message || "麦克风打开失败，请刷新设备或检查声卡输入。";
}

async function stopRecording() {
  if (!state.recording) {
    return;
  }
  stopMetronome();
  state.recording = false;
  const fallbackBlobPromise = stopMediaRecorderFallback();
  stopRecordingGraph();
  els.recordBtn.disabled = false;
  els.stopBtn.disabled = true;
  setStatus("正在解析");
  const recordedBlob = await fallbackBlobPromise;
  releaseMediaStream(state.mediaStream);
  state.mediaStream = null;
  await handleRawRecordingStopped(recordedBlob);
}

function stopRecordingGraph() {
  const nodes = [state.recordingSource, state.recordingProcessor, state.recordingSilentGain];
  for (const node of nodes) {
    if (!node) {
      continue;
    }
    try {
      node.disconnect();
    } catch {
      // Browsers may disconnect audio graph nodes automatically on stream stop.
    }
  }
  if (state.recordingProcessor) {
    state.recordingProcessor.onaudioprocess = null;
  }
  state.recordingSource = null;
  state.recordingProcessor = null;
  state.recordingSilentGain = null;
}

async function handleRawRecordingStopped(fallbackBlob = null) {
  try {
    if (fallbackBlob?.size) {
      await loadAudioBlob(fallbackBlob, "浏览器录音", state.recordingBeatOffsetSeconds);
      setStatus("录音已载入");
      return;
    }
    if (!state.recordedFrames.length || !state.recordedSampleCount) {
      throw new Error("没有录到有效音频。使用 Voicemeeter 时，请在“麦克风输入”里选择 VoiceMeeter Output / Aux Output 这类录音端，并确认麦克风通道推到 B1；如果刚切换过设备，点“刷新”后重新选择输入。");
    }
    const audioContext = state.audioContext;
    const mono = concatAudioFrames(state.recordedFrames, state.recordedSampleCount);
    const buffer = audioContext.createBuffer(1, mono.length, audioContext.sampleRate);
    buffer.copyToChannel(mono, 0);
    setLoadedAudio(buffer, mono, "浏览器录音", state.recordingBeatOffsetSeconds);
    setStatus("录音已载入");
  } catch (error) {
    setStatus("解析失败", "error");
    alert(error.message);
  } finally {
    state.recordedFrames = [];
    state.recordedSampleCount = 0;
  }
}

function concatAudioFrames(frames, totalLength) {
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}

async function handleFileInput(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  try {
    await loadAudioBlob(file, file.name);
    setStatus("音频已载入");
  } catch (error) {
    setStatus("载入失败", "error");
    alert(error.message);
  }
}

async function loadAudioBlob(blob, name, beatOffsetSeconds = 0) {
  const audioContext = await ensureAudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  setLoadedAudio(decoded, audioBufferToMono(decoded), name, beatOffsetSeconds);
}

function setLoadedAudio(decoded, monoData, name, beatOffsetSeconds = 0) {
  stopMidiPlayback(false);
  state.audioBuffer = decoded;
  state.sampleRate = decoded.sampleRate;
  state.monoData = monoData;
  state.duration = decoded.duration;
  state.notes = [];
  state.chords = [];
  clearKeySnapUndo();
  state.selectedNoteIndex = -1;
  state.selectedChordIndex = -1;
  state.beatOffsetSeconds = beatOffsetSeconds;
  state.key = null;
  state.suggestedKey = null;
  clearMidiUrl();
  els.audioName.textContent = name;
  els.audioDuration.textContent = `${decoded.duration.toFixed(1)}s`;
  els.playBtn.disabled = false;
  els.midiPlayBtn.disabled = true;
  els.exportWavBtn.disabled = false;
  els.melodyneStatus.textContent = state.engineAvailable
    ? "本地高精度引擎会优先用于生成 MIDI"
    : "本地高精度引擎未连接，生成时会使用网页备份引擎";
  updateNoteLabels();
  setWorkflowPage("detect");
}

function audioBufferToMono(buffer) {
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      output[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return output;
}

function exportWavForMelodyne() {
  if (!state.audioBuffer) {
    setStatus("需要音频", "error");
    return;
  }
  try {
    const blob = encodeWavFromAudioBuffer(state.audioBuffer);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileStem(els.audioName.textContent || "hum")}-source.wav`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    els.melodyneStatus.textContent = "WAV 已导出，可用于外部修音或备份";
    setStatus("WAV 已导出");
  } catch (error) {
    setStatus("导出 WAV 失败", "error");
    alert(error.message);
  }
}

async function handleMelodyneMidiInput(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  try {
    stopMidiPlayback(false);
    const parsed = parseMidiFile(await file.arrayBuffer());
    if (!parsed.notes.length) {
      throw new Error("这个 MIDI 里没有可用的旋律音符。");
    }
    const duration = Math.max(parsed.duration, state.duration || 0);
    const settings = readSettings();
    const result = await harmonizeImportedMidi(parsed.notes, settings, duration);
    state.notes = result.notes;
    state.chords = result.chords || [];
    clearKeySnapUndo();
    state.selectedNoteIndex = state.notes.length ? 0 : -1;
    state.selectedChordIndex = state.chords.length ? 0 : -1;
    applyAnalysisKeyState(result);
    state.duration = Math.max(duration, result.duration || 0, ...state.notes.map((note) => note.end));
    updateNoteLabels();
    setMidiBlob(new Blob([result.midiBytes], { type: "audio/midi" }));
    els.melodyneStatus.textContent = `已导入外部 MIDI：${file.name}`;
    setStatus(`已导入外部 MIDI`);
    setWorkflowPage("detect");
  } catch (error) {
    setStatus("导入 MIDI 失败", "error");
    alert(error.message);
  } finally {
    event.target.value = "";
  }
}

function encodeWavFromAudioBuffer(buffer) {
  const channelCount = Math.min(Math.max(buffer.numberOfChannels, 1), 2);
  const frameCount = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  writeAsciiToView(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiToView(view, 8, "WAVE");
  writeAsciiToView(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAsciiToView(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function parseMidiFile(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let offset = 0;
  const readU16 = () => {
    const value = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    return value;
  };
  const readU32 = () => {
    const value = (bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
    offset += 4;
    return value >>> 0;
  };
  const readString = (length) => {
    let text = "";
    for (let i = 0; i < length; i += 1) {
      text += String.fromCharCode(bytes[offset + i]);
    }
    offset += length;
    return text;
  };
  const readVarLen = () => {
    let value = 0;
    let byte = 0;
    do {
      byte = bytes[offset++];
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return value;
  };

  if (readString(4) !== "MThd") {
    throw new Error("不是标准 MIDI 文件。");
  }
  const headerLength = readU32();
  const headerEnd = offset + headerLength;
  const format = readU16();
  const trackCount = readU16();
  const division = readU16();
  offset = headerEnd;
  if (format > 2 || !trackCount) {
    throw new Error("无法读取这个 MIDI 格式。");
  }
  if (division & 0x8000) {
    throw new Error("暂不支持 SMPTE 时间格式的 MIDI。");
  }

  const ticksPerBeat = division;
  const tempoEvents = [{ tick: 0, microsecondsPerBeat: 500000 }];
  const rawNotes = [];

  for (let trackIndex = 0; trackIndex < trackCount && offset < bytes.length; trackIndex += 1) {
    if (readString(4) !== "MTrk") {
      throw new Error("MIDI 轨道数据损坏。");
    }
    const trackEnd = offset + readU32();
    const active = new Map();
    let tick = 0;
    let runningStatus = 0;
    while (offset < trackEnd) {
      tick += readVarLen();
      let status = bytes[offset++];
      if (status < 0x80) {
        offset -= 1;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }
      if (!status) {
        break;
      }

      if (status === 0xff) {
        const type = bytes[offset++];
        const length = readVarLen();
        if (type === 0x51 && length === 3) {
          tempoEvents.push({
            tick,
            microsecondsPerBeat: (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2],
          });
        }
        offset += length;
        runningStatus = 0;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        offset += readVarLen();
        runningStatus = 0;
        continue;
      }

      const command = status & 0xf0;
      const channel = status & 0x0f;
      if (command === 0x80 || command === 0x90) {
        const note = bytes[offset++];
        const velocity = bytes[offset++];
        const key = `${channel}:${note}`;
        if (command === 0x90 && velocity > 0) {
          const stack = active.get(key) || [];
          stack.push({ tick, velocity });
          active.set(key, stack);
        } else {
          const stack = active.get(key);
          const started = stack?.shift();
          if (started && tick > started.tick && channel !== 9) {
            rawNotes.push({ startTick: started.tick, endTick: tick, note, velocity: started.velocity });
          }
          if (stack && !stack.length) {
            active.delete(key);
          }
        }
      } else if (command === 0xc0 || command === 0xd0) {
        offset += 1;
      } else {
        offset += 2;
      }
    }
    offset = trackEnd;
  }

  const tickToSeconds = buildMidiTickConverter(tempoEvents, ticksPerBeat);
  const notes = rawNotes
    .map((note) => ({
      note: clampInt(note.note, 0, 127),
      start: tickToSeconds(note.startTick),
      end: tickToSeconds(note.endTick),
      velocity: clampInt(note.velocity || 86, 1, 127),
    }))
    .filter((note) => note.end - note.start >= 0.025)
    .sort((a, b) => a.start - b.start || a.note - b.note);
  return {
    notes,
    duration: notes.length ? Math.max(...notes.map((note) => note.end)) : 0,
  };
}

function buildMidiTickConverter(tempoEvents, ticksPerBeat) {
  const sorted = tempoEvents
    .filter((event) => Number.isFinite(event.tick) && Number.isFinite(event.microsecondsPerBeat))
    .sort((a, b) => a.tick - b.tick);
  return (targetTick) => {
    let seconds = 0;
    let previousTick = 0;
    let tempo = 500000;
    for (const event of sorted) {
      if (event.tick > targetTick) {
        break;
      }
      seconds += (event.tick - previousTick) * tempo / ticksPerBeat / 1000000;
      previousTick = event.tick;
      tempo = event.microsecondsPerBeat;
    }
    seconds += (targetTick - previousTick) * tempo / ticksPerBeat / 1000000;
    return Math.max(0, seconds);
  };
}

function harmonizeImportedMidi(notes, settings, duration) {
  if (!window.Worker) {
    const lockedKey = selectedLockedKey();
    const key = lockedKey || null;
    const preserveCount = Array.isArray(settings.manualMarkers) && settings.manualMarkers.length > 0;
    let processedNotes = cloneNotes(notes);
    if (lockedKey) {
      processedNotes = snapNotesToKey(processedNotes, lockedKey);
    }
    if (settings.polish) {
      processedNotes = polishNotes(processedNotes, lockedKey || null, settings, preserveCount);
    } else {
      if (settings.quantize) {
        processedNotes = quantizeTiming(processedNotes, settings);
      }
      processedNotes = enforceOrder(processedNotes, settings);
      if (!settings.quantize) {
        processedNotes = applyLegato(processedNotes, settings);
      }
      processedNotes = smoothVelocities(processedNotes);
    }
    const suggestedKey = lockedKey ? null : detectKey(processedNotes) || inferKeyFromMelody(processedNotes);
    const midiBytes = writeMidi(processedNotes, settings, []);
    return Promise.resolve({ notes: processedNotes, chords: [], key, suggestedKey, midiBytes, duration });
  }
  if (!state.worker) {
    state.worker = new Worker(`worker.js?v=${ASSET_VERSION}`);
  }
  const jobId = state.analysisJobId + 1;
  state.analysisJobId = jobId;
  return new Promise((resolve, reject) => {
    const handleMessage = (event) => {
      const message = event.data;
      if (!message || message.jobId !== jobId) {
        return;
      }
      cleanup();
      if (message.type === "done") {
        resolve({
          notes: message.notes,
          chords: message.chords || [],
          key: message.key,
          suggestedKey: message.suggestedKey,
          midiBytes: new Uint8Array(message.midiBytes),
          duration: message.duration || duration,
        });
      } else {
        reject(new Error(message.error || "外部 MIDI 编配失败。"));
      }
    };
    const handleError = (event) => {
      cleanup();
      reject(new Error(event.message || "外部 MIDI 编配失败。"));
    };
    const cleanup = () => {
      state.worker.removeEventListener("message", handleMessage);
      state.worker.removeEventListener("error", handleError);
    };
    state.worker.addEventListener("message", handleMessage);
    state.worker.addEventListener("error", handleError);
    state.worker.postMessage({
      type: "harmonize",
      jobId,
      notes,
      duration,
      settings,
    });
  });
}

function safeFileStem(value) {
  return String(value)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .trim()
    .slice(0, 80) || "hum";
}

function writeAsciiToView(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function playAudio() {
  if (!state.audioBuffer || !state.audioContext) {
    return;
  }
  const source = state.audioContext.createBufferSource();
  source.buffer = state.audioBuffer;
  source.connect(state.audioContext.destination);
  source.start();
}

async function toggleMidiPlayback() {
  if (state.midiPlaying) {
    stopMidiPlayback(true);
    return;
  }
  if (!state.notes.length) {
    setStatus("需要先生成 MIDI", "error");
    return;
  }
  try {
    const audioContext = await ensureAudioContext();
    if (!window.MiniPiano) {
      throw new Error("本地钢琴音源未载入。");
    }
    if (!state.piano || state.piano.audioContext !== audioContext) {
      state.piano = new window.MiniPiano(audioContext);
    }
    state.piano.stopAll();
    els.midiPlayBtn.disabled = true;
    setStatus("正在准备钢琴音源");
    await state.piano.preload(collectMidiPreviewNotes(), (done, total) => {
      if (total > 8) {
        setStatus(`正在准备钢琴音源 ${done}/${total}`);
      }
    });
    els.midiPlayBtn.disabled = false;

    const preview = buildMidiPreviewEvents();
    const startTime = audioContext.currentTime + 0.36;
    state.midiPlaying = true;
    const endTime = startMidiPreviewScheduler(state.piano, startTime, preview.events, preview.endOffset);
    els.midiPlayBtn.textContent = "停止 MIDI";
    setStatus("正在试听 MIDI");
    const timeoutMs = Math.max(160, (endTime - audioContext.currentTime) * 1000 + 120);
    state.midiPlaybackTimer = window.setTimeout(() => {
      finishMidiPlayback();
    }, timeoutMs);
  } catch (error) {
    els.midiPlayBtn.disabled = false;
    setStatus("试听失败", "error");
    alert(error.message);
  }
}

function collectMidiPreviewNotes() {
  const values = state.notes.map((note) => note.note);
  for (const chord of state.chords) {
    values.push(...chord.notes);
  }
  return values;
}

function buildMidiPreviewEvents() {
  const events = [];
  let endOffset = 0;
  const settings = readSettings();
  const gridSeconds = chordGridSeconds(settings);
  const timeOrigin = musicTimeOrigin(settings);
  for (const note of state.notes) {
    const duration = Math.max(0.08, note.end - note.start);
    const start = Math.max(0, note.start - timeOrigin);
    endOffset = Math.max(endOffset, start + duration + 0.7);
    events.push({
      start,
      note: note.note,
      duration,
      velocity: note.velocity,
      options: {
        role: "melody",
        gain: 1,
      },
    });
  }
  for (const chord of state.chords) {
    const chordStart = snapToGrid(chord.start, gridSeconds, settings.beatOffsetSeconds);
    const chordEnd = alignedChordEnd(chord, chordStart, gridSeconds, settings.beatOffsetSeconds);
    chord.notes.forEach((note, index) => {
      const duration = Math.max(0.12, chordEnd - chordStart);
      const start = Math.max(0, chordStart - timeOrigin);
      endOffset = Math.max(endOffset, start + duration + 0.7);
      events.push({
        start,
        note,
        duration,
        velocity: chord.velocity || 54,
        options: {
          role: "chord",
          pan: clampNumber((index - 1) * 0.08, -0.2, 0.2),
        },
      });
    });
  }
  const densePlayback = events.length > 120;
  for (const event of events) {
    event.options.disableReleaseNoise = densePlayback || event.options.role === "chord";
  }
  events.sort((a, b) => a.start - b.start || (a.options.role === "chord" ? 1 : -1));
  return { events, endOffset };
}

function musicTimeOrigin(settings) {
  return settings.alignMusicToFirstBeat === false ? 0 : settings.beatOffsetSeconds || 0;
}

function startMidiPreviewScheduler(piano, startTime, events, endOffset) {
  clearMidiScheduler();
  const audioContext = piano.audioContext;
  let index = 0;
  let queuedSoon = false;
  const lookAhead = events.length > 180 ? 1.45 : 1.1;
  const intervalMs = 90;
  const maxPerTick = 90;

  const scheduleDue = () => {
    if (!state.midiPlaying) {
      return;
    }
    queuedSoon = false;
    const horizon = audioContext.currentTime + lookAhead;
    let scheduled = 0;
    while (index < events.length && startTime + events[index].start <= horizon && scheduled < maxPerTick) {
      const event = events[index];
      piano.scheduleNote(event.note, startTime + event.start, event.duration, event.velocity, event.options);
      index += 1;
      scheduled += 1;
    }
    if (index >= events.length) {
      clearMidiScheduler();
      return;
    }
    if (startTime + events[index].start <= horizon && !queuedSoon) {
      queuedSoon = true;
      window.setTimeout(scheduleDue, 0);
    }
  };

  scheduleDue();
  state.midiSchedulerTimer = window.setInterval(scheduleDue, intervalMs);
  return startTime + endOffset;
}

function chordGridSeconds(settings) {
  const beatSeconds = 60 / settings.tempo;
  const barSeconds = beatSeconds * settings.sigTop;
  return settings.harmonyGrid === "bar" ? barSeconds : Math.max(beatSeconds, barSeconds * 0.5);
}

function alignedChordEnd(chord, chordStart, gridSeconds, beatOffsetSeconds) {
  const snappedEnd = snapToGrid(chord.end, gridSeconds, beatOffsetSeconds);
  if (snappedEnd > chordStart + 0.001) {
    return snappedEnd;
  }
  return chordStart + gridSeconds;
}

function snapToGrid(time, gridSeconds, offsetSeconds = 0) {
  if (!Number.isFinite(time) || !Number.isFinite(gridSeconds) || gridSeconds <= 0) {
    return Math.max(0, time || 0);
  }
  const snapped = offsetSeconds + Math.round((time - offsetSeconds) / gridSeconds) * gridSeconds;
  return Math.max(0, snapped);
}

function stopMidiPlayback(showStatus) {
  if (state.midiPlaybackTimer) {
    window.clearTimeout(state.midiPlaybackTimer);
  }
  state.midiPlaybackTimer = null;
  clearMidiScheduler();
  if (state.piano) {
    state.piano.stopAll();
  }
  state.midiPlaying = false;
  if (els.midiPlayBtn) {
    els.midiPlayBtn.textContent = "试听 MIDI";
  }
  if (showStatus) {
    setStatus("MIDI 试听已停止");
  }
}

async function ensurePiano() {
  const audioContext = await ensureAudioContext();
  if (!window.MiniPiano) {
    throw new Error("本地钢琴音源未载入。");
  }
  if (!state.piano || state.piano.audioContext !== audioContext) {
    state.piano = new window.MiniPiano(audioContext);
  }
  return state.piano;
}

async function previewNote(note = selectedNote()) {
  if (!note) {
    return;
  }
  try {
    if (state.midiPlaying) {
      stopMidiPlayback(false);
    } else if (state.piano) {
      state.piano.stopAll();
    }
    const piano = await ensurePiano();
    await piano.preload([note.note]);
    const startTime = piano.audioContext.currentTime + 0.025;
    const duration = clampNumber(note.end - note.start, 0.18, 0.75);
    piano.scheduleNote(note.note, startTime, duration, note.velocity || 86, {
      role: "melody",
      gain: 0.95,
    });
  } catch (error) {
    setStatus(error.message || "试听失败", "error");
  }
}

function finishMidiPlayback() {
  clearMidiScheduler();
  state.midiPlaybackTimer = null;
  state.midiPlaying = false;
  if (els.midiPlayBtn) {
    els.midiPlayBtn.textContent = "试听 MIDI";
  }
  setStatus("MIDI 试听完成");
}

function clearMidiScheduler() {
  if (state.midiSchedulerTimer) {
    window.clearInterval(state.midiSchedulerTimer);
  }
  state.midiSchedulerTimer = null;
}

function handleKeyDown(event) {
  if (event.code !== "Space" || !state.recording || !els.manualMarker.checked) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const marker = currentRecordingAudioTime();
  if (state.markers.length && marker - state.markers[state.markers.length - 1] < 0.08) {
    return;
  }
  state.markers.push(marker);
  updateMarkerCount();
  render();
}

function currentRecordingAudioTime() {
  if (state.recordingStartedAt) {
    return Math.max(0, (performance.now() - state.recordingStartedAt) / 1000);
  }
  if (state.audioContext && state.recordingContextStartedAt) {
    return Math.max(0, state.audioContext.currentTime - state.recordingContextStartedAt);
  }
  return 0;
}

function startMetronome(audioContext) {
  stopMetronome();
  state.nextBeatTime = audioContext.currentTime + METRONOME_LEAD_IN_SECONDS;
  state.beatIndex = 0;
  state.metronomeTimer = setInterval(() => {
    const bpm = clampInt(els.tempo.value, 40, 240);
    const numerator = clampInt(els.sigTop.value, 1, 12);
    const beatSeconds = 60 / bpm;
    while (state.nextBeatTime < audioContext.currentTime + 0.14) {
      scheduleClick(audioContext, state.nextBeatTime, state.beatIndex % numerator === 0);
      state.beatIndex += 1;
      state.nextBeatTime += beatSeconds;
    }
  }, 25);
}

function scheduleClick(audioContext, time, accent) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(accent ? 1700 : 1120, time);
  gain.gain.setValueAtTime(accent ? 0.22 : 0.14, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(time);
  oscillator.stop(time + 0.045);
}

function stopMetronome() {
  if (state.metronomeTimer) {
    clearInterval(state.metronomeTimer);
  }
  state.metronomeTimer = null;
}

async function analyzeAndExport() {
  if (!state.monoData || !state.sampleRate) {
    setStatus("需要音频", "error");
    return;
  }
  try {
    stopMidiPlayback(false);
    if (state.analyzing) {
      return;
    }
    state.analyzing = true;
    els.analyzeBtn.disabled = true;
    setStatus("正在分析");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settings = readSettings();
    const startedAt = performance.now();
    let result = null;
    const highPrecision = await analyzeWithLocalEngine(settings);
    if (highPrecision?.notes?.length) {
      setStatus("正在整理节拍与和弦");
      result = await harmonizeImportedMidi(
        highPrecision.notes,
        settings,
        Math.max(state.duration || 0, highPrecision.duration || 0),
      );
      result.engine = highPrecision.engine || "Basic Pitch";
      result.rawCount = highPrecision.rawCount || highPrecision.notes.length;
      result.elapsedMs = performance.now() - startedAt;
    } else {
      setStatus("正在使用网页备份引擎");
      result = await analyzeInWorker(state.monoData, state.sampleRate, state.duration, settings);
      result.engine = "网页备份引擎";
    }
    state.notes = result.notes;
    state.chords = result.chords || [];
    clearKeySnapUndo();
    state.selectedNoteIndex = state.notes.length ? 0 : -1;
    state.selectedChordIndex = state.chords.length ? 0 : -1;
    applyAnalysisKeyState(result);
    updateNoteLabels();
    const blob = new Blob([result.midiBytes], { type: "audio/midi" });
    setMidiBlob(blob);
    const engineLabel = result.engine ? ` · ${result.engine}` : "";
    setStatus(`MIDI 已生成${engineLabel} ${Math.round(result.elapsedMs)}ms`);
    setWorkflowPage("detect");
  } catch (error) {
    setStatus("生成失败", "error");
    alert(error.message);
  } finally {
    state.analyzing = false;
    els.analyzeBtn.disabled = false;
  }
}

async function analyzeWithLocalEngine(settings) {
  if (!state.audioBuffer) {
    return null;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 180000);
  try {
    const form = new FormData();
    form.append("audio", encodeWavFromAudioBuffer(state.audioBuffer), `${safeFileStem(els.audioName.textContent || "hum")}.wav`);
    form.append("settings", JSON.stringify(settings));
    form.append("duration", String(state.duration || state.audioBuffer.duration || 0));
    const response = await fetch("/api/analyze", {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    if (!Array.isArray(data.notes) || !data.notes.length) {
      throw new Error("本地高精度引擎没有识别到有效音符。");
    }
    state.engineAvailable = true;
    state.engineLastError = "";
    const markerPart = settings.manualMarkers?.length ? `，Space 标记 ${settings.manualMarkers.length} 个` : "";
    els.melodyneStatus.textContent = `${data.engine || "Basic Pitch"} 已识别 ${data.notes.length} 个音符${markerPart}（原始 ${data.rawCount || data.notes.length} 个候选）`;
    return data;
  } catch (error) {
    state.engineAvailable = false;
    state.engineLastError = error instanceof Error ? error.message : String(error);
    els.melodyneStatus.textContent = `本地高精度引擎不可用，已切换网页备份：${state.engineLastError}`;
    console.warn("Local high precision engine unavailable:", error);
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function analyzeInWorker(monoData, sampleRate, duration, settings) {
  if (!window.Worker) {
    const startedAt = performance.now();
    const analysis = analyzeAudio(monoData, sampleRate, settings);
    const midiBytes = writeMidi(analysis.notes, settings, analysis.chords || []);
    return Promise.resolve({
      notes: analysis.notes,
      chords: analysis.chords || [],
      key: analysis.key,
      suggestedKey: analysis.suggestedKey,
      midiBytes,
      elapsedMs: performance.now() - startedAt,
    });
  }

  if (!state.worker) {
    state.worker = new Worker(`worker.js?v=${ASSET_VERSION}`);
  }

  const jobId = state.analysisJobId + 1;
  state.analysisJobId = jobId;
  const workerAudio = monoData.slice();
  return new Promise((resolve, reject) => {
    const handleMessage = (event) => {
      const message = event.data;
      if (!message || message.jobId !== jobId) {
        return;
      }
      cleanup();
      if (message.type === "done") {
        resolve({
          notes: message.notes,
          chords: message.chords || [],
          key: message.key,
          suggestedKey: message.suggestedKey,
          midiBytes: new Uint8Array(message.midiBytes),
          elapsedMs: message.elapsedMs,
        });
      } else {
        reject(new Error(message.error || "Worker 分析失败。"));
      }
    };
    const handleError = (event) => {
      cleanup();
      reject(new Error(event.message || "Worker 分析失败。"));
    };
    const cleanup = () => {
      state.worker.removeEventListener("message", handleMessage);
      state.worker.removeEventListener("error", handleError);
    };
    state.worker.addEventListener("message", handleMessage);
    state.worker.addEventListener("error", handleError);
    state.worker.postMessage(
      {
        type: "analyze",
        jobId,
        audioData: workerAudio,
        sampleRate,
        duration,
        settings,
      },
      [workerAudio.buffer],
    );
  });
}

function applyAnalysisKeyState(result) {
  const lockedKey = selectedLockedKey();
  if (lockedKey) {
    state.key = lockedKey;
    state.suggestedKey = null;
    return;
  }
  state.key = result.key || null;
  state.suggestedKey = result.suggestedKey || (!result.key ? detectKey(result.notes || []) : null);
}

function readSettings() {
  return {
    tempo: clampInt(els.tempo.value, 40, 240),
    sigTop: clampInt(els.sigTop.value, 1, 12),
    sigBottom: nearestDenominator(clampInt(els.sigBottom.value, 2, 16)),
    fmin: clampNumber(els.fmin.value, 50, 400),
    fmax: clampNumber(els.fmax.value, 300, 1600),
    noiseGateDb: clampNumber(els.noiseGate.value, 0, 24),
    minNoteMs: clampNumber(els.minNote.value, 40, 500),
    polish: els.polish.checked,
    quantize: els.quantize.checked,
    quantizeGridBeats: quantizeGridBeats(),
    harmony: els.harmony.checked,
    harmonyGrid: els.harmonyGrid.value === "bar" ? "bar" : "half",
    beatOffsetSeconds: state.beatOffsetSeconds,
    alignMusicToFirstBeat: true,
    lockedKey: selectedLockedKey(),
    manualMarkers: els.manualMarker.checked ? cleanMarkers(state.markers, state.duration) : [],
    frameMs: 64,
    hopMs: 12,
    clarity: 0.56,
    yinThreshold: 0.11,
    stableSegmentRatio: 0.56,
    manualPitchWindowMs: clampNumber(els.manualWindow?.value, 160, 900),
    manualPitchAttackMs: clampNumber(els.manualAttack?.value, 0, 180),
    manualPitchFocus: 0.62,
    manualPitchFallbackWindowMs: 680,
    manualScaleSnap: true,
    manualPitchStrict: false,
    autoKeySnap: false,
    useSuggestedKeyForHarmony: false,
    noiseProfileSeconds: 0.5,
    targetSampleRate: 16000,
  };
}

function quantizeGridBeats() {
  const value = Number(els.quantizeGrid?.value);
  return [1, 0.5, 0.25, 0.125].includes(value) ? value : 0.25;
}

function quantizeGridLabel(value = quantizeGridBeats()) {
  const grid = normalizedQuantizeGridBeats(value);
  if (grid === 1) return "1/4 音符";
  if (grid === 0.5) return "1/8 音符";
  if (grid === 0.25) return "1/16 音符";
  return "1/32 音符";
}

function analyzeAudio(input, sampleRate, settings) {
  const data = resampleLinear(input, sampleRate, settings.targetSampleRate);
  const sr = settings.targetSampleRate;
  const pitchTrack = estimatePitchTrack(data, sr, settings);
  const manualMode = settings.manualMarkers.length > 0;
  const lockedKey = lockedKeyFromSettings(settings);
  let notes = manualMode
    ? markersToNotes(pitchTrack.pitches, pitchTrack.rms, state.duration, settings)
    : pitchTrackToNotes(pitchTrack.pitches, pitchTrack.rms, settings);

  let key = lockedKey || null;
  let suggestedKey = lockedKey ? null : detectKey(notes);
  const autoKeySnap = settings.autoKeySnap === true;
  let polishKey = lockedKey || (autoKeySnap ? reliableKeyForSnapping(suggestedKey, notes, settings) : null);
  if (manualMode && settings.manualScaleSnap !== false) {
    const scaleKey = lockedKey || (autoKeySnap ? polishKey : null);
    const allowed = allowedPitchClasses(scaleKey);
    if (allowed) {
      const scaleNotes = markersToNotes(pitchTrack.pitches, pitchTrack.rms, state.duration, settings, allowed);
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
  return { notes, key, suggestedKey };
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

function estimatePitchTrack(data, sampleRate, settings) {
  const frameSize = Math.max(64, Math.round(sampleRate * settings.frameMs / 1000));
  const hopSize = Math.max(32, Math.round(sampleRate * settings.hopMs / 1000));
  const minLag = Math.max(1, Math.floor(sampleRate / settings.fmax));
  const maxLag = Math.min(frameSize - 2, Math.ceil(sampleRate / settings.fmin));
  const frameCount = Math.max(1, Math.floor((data.length + frameSize) / hopSize));
  const pitches = new Float32Array(frameCount);
  const rms = new Float32Array(frameCount);
  const window = hannWindow(frameSize);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * hopSize - Math.floor(frameSize / 2);
    rms[frameIndex] = frameRms(data, start, frameSize);
  }

  const threshold = estimateVoicingThreshold(rms, settings);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    if (rms[frameIndex] < threshold) {
      continue;
    }
    const start = frameIndex * hopSize - Math.floor(frameSize / 2);
    pitches[frameIndex] = estimateFramePitch(data, start, frameSize, window, sampleRate, minLag, maxLag, settings);
  }
  return { pitches: smoothPitches(pitches), rms };
}

function estimateFramePitch(data, start, frameSize, window, sampleRate, minLag, maxLag, settings) {
  const frame = new Float32Array(frameSize);
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

  const clarity = [];
  let bestLag = 0;
  let bestClarity = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let energyA = 0;
    let energyB = 0;
    const length = frameSize - lag;
    for (let i = 0; i < length; i += 1) {
      const a = frame[i];
      const b = frame[i + lag];
      sum += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const value = sum / Math.sqrt(Math.max(energyA * energyB, 1e-12));
    clarity.push(value);
    if (value > bestClarity) {
      bestClarity = value;
      bestLag = lag;
    }
  }

  let chosenLag = 0;
  for (let i = 1; i < clarity.length - 1; i += 1) {
    if (clarity[i] > clarity[i - 1] && clarity[i] >= clarity[i + 1] && clarity[i] >= settings.clarity) {
      chosenLag = minLag + i;
      break;
    }
  }
  if (!chosenLag && bestClarity >= settings.clarity * 0.82) {
    chosenLag = bestLag;
  }
  if (!chosenLag) {
    return 0;
  }
  const pitch = sampleRate / chosenLag;
  return pitch >= settings.fmin && pitch <= settings.fmax ? pitch : 0;
}

function pitchTrackToNotes(pitches, rms, settings) {
  const hopSeconds = settings.hopMs / 1000;
  const midi = new Int16Array(pitches.length);
  for (let i = 0; i < pitches.length; i += 1) {
    if (pitches[i] > 0) {
      midi[i] = Math.round(69 + 12 * Math.log2(pitches[i] / 440));
    }
  }
  fillShortGaps(midi, Math.round(90 / settings.hopMs));
  modeFilter(midi, 3);
  removeUnstableRuns(midi, Math.max(2, Math.ceil(settings.minNoteMs / settings.hopMs)));
  fillShortGaps(midi, Math.round(90 / settings.hopMs));

  const notes = [];
  let current = 0;
  let startFrame = 0;
  let velocities = [];
  for (let frame = 0; frame < midi.length; frame += 1) {
    const note = midi[frame];
    if (note === current) {
      if (note) velocities.push(rms[frame]);
      continue;
    }
    if (current) {
      notes.push(makeNote(current, startFrame * hopSeconds, frame * hopSeconds, velocities));
    }
    current = note;
    startFrame = frame;
    velocities = note ? [rms[frame]] : [];
  }
  if (current) {
    notes.push(makeNote(current, startFrame * hopSeconds, midi.length * hopSeconds, velocities));
  }
  const minDuration = settings.minNoteMs / 1000;
  return mergeAdjacent(notes.filter((note) => note.end - note.start >= minDuration), 0.09);
}

function markersToNotes(pitches, rms, duration, settings, allowed = null) {
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
    const note = noteFromWindow(pitches, rms, window.start, window.end, hopSeconds, settings, allowed, previousNote);
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
      );
      slots.push({
        note: fallback?.note ?? null,
        velocity: fallback?.velocity ?? null,
        start,
        end: Math.max(start + minDuration, end),
      });
      if (fallback) {
        previousNote = fallback.note;
      }
    } else {
      slots.push({ ...note, start, end: Math.max(start + minDuration, end) });
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

function noteFromWindow(pitches, rms, start, end, hopSeconds, settings, allowed = null, previousNote = null) {
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
    velocity: rmsToVelocity(chosen.velocities),
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
      ? nearbyAllowedNotes(frame.midiFloat, allowed, 3)
      : [{ note: clampInt(Math.round(frame.midiFloat), 0, 127), distance: Math.abs(frame.midiFloat - Math.round(frame.midiFloat)) }];
    const position = clampNumber((frame.time - start) / duration, 0, 1);
    const focus = clampNumber(settings.manualPitchFocus ?? 0.62, 0.4, 0.8);
    const centerWeight = 1 + 0.52 * Math.max(0, 1 - Math.abs(position - focus) / 0.45);
    for (const candidate of candidates) {
      const pitchCenterWeight = Math.max(0.12, 1 - candidate.distance * 0.42);
      const melodicWeight = previousNote == null
        ? 1
        : Math.max(0.68, 1 - Math.max(0, Math.abs(candidate.note - previousNote) - 7) * 0.035);
      const weight = Math.max(0.0001, frame.rms) ** 0.65 * centerWeight * pitchCenterWeight ** 2 * melodicWeight;
      if (!bins.has(candidate.note)) {
        bins.set(candidate.note, {
          note: candidate.note,
          weight: 0,
          distances: [],
          frames: [],
          velocities: [],
        });
      }
      const bin = bins.get(candidate.note);
      bin.weight += weight;
      bin.distances.push(candidate.distance);
      bin.frames.push(frame.frame);
      bin.velocities.push(frame.rms * pitchCenterWeight);
    }
  }
  if (!bins.size) {
    return {
      note: clampInt(Math.round(median(frames.map((frame) => frame.midiFloat))), 0, 127),
      velocities: frames.map((frame) => frame.rms),
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
  return { note: best.note, velocities: best.velocities };
}

function nearbyAllowedNotes(midiFloat, allowed, limit) {
  const center = clampInt(Math.round(midiFloat), 0, 127);
  const candidates = [];
  for (let note = Math.max(0, center - 4); note <= Math.min(127, center + 4); note += 1) {
    if (!allowed.has(note % 12)) {
      continue;
    }
    const distance = Math.abs(note - midiFloat);
    if (distance <= 2.35) {
      candidates.push({ note, distance });
    }
  }
  if (!candidates.length) {
    const note = nearestAllowedNote(center, allowed);
    candidates.push({ note, distance: Math.abs(note - midiFloat) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, limit);
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
  if (allowed) {
    polished = snapUnstableNotesToKey(polished, allowed, settings);
  }
  const octaveSettings = preserveCount ? { ...settings, preserveLargeLeaps: true } : settings;
  polished = correctOctaveIslands(correctGlobalOctaveBias(correctOctaveJumps(polished, octaveSettings)), octaveSettings);
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

function octaveRangePenalty(note) {
  if (note < 43) return (43 - note) * 0.12;
  if (note > 84) return (note - 84) * 0.12;
  return 0;
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

function octavePathTransition(previous, current, gap) {
  const interval = Math.abs(current - previous);
  const gapRelax = gap > 0.7 ? 0.42 : gap > 0.32 ? 0.72 : 1;
  const leapCost = Math.max(0, interval - 5) ** 1.42 * 0.48;
  return (interval * 0.22 + leapCost) * gapRelax;
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

function beatStrengthAt(time, settings) {
  const beatSeconds = 60 / Math.max(30, settings.tempo || 120);
  const sigTop = Math.max(1, settings.sigTop || 4);
  const beat = (time - (settings.beatOffsetSeconds || 0)) / beatSeconds;
  const position = ((beat % sigTop) + sigTop) % sigTop;
  const nearestBeat = Math.round(position);
  const distance = Math.abs(position - nearestBeat);
  if (distance > 0.16) {
    return 1;
  }
  if (nearestBeat === 0 || nearestBeat === sigTop) {
    return 1.9;
  }
  if (sigTop === 4 && nearestBeat === 2) {
    return 1.45;
  }
  if (sigTop === 3 && nearestBeat === 1) {
    return 1.25;
  }
  return 1.18;
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

function quantizeTiming(notes, settings) {
  const grid = quantizeGridSeconds(settings);
  const offset = settings.beatOffsetSeconds || 0;
  return notes.map((note) => {
    const start = snapToGrid(note.start, grid, offset);
    let end = snapToGrid(note.end, grid, offset);
    if (end <= start) {
      end = start + grid;
    }
    return { ...note, start: Math.max(0, start), end: Math.max(0, end) };
  });
}

function quantizeGridSeconds(settings) {
  return (60 / Math.max(30, settings.tempo || 120)) * normalizedQuantizeGridBeats(settings.quantizeGridBeats);
}

function normalizedQuantizeGridBeats(value) {
  const grid = Number(value);
  return [1, 0.5, 0.25, 0.125].includes(grid) ? grid : 0.25;
}

function writeMidi(notes, settings, chords = []) {
  const ticksPerBeat = 480;
  const tracks = [buildNoteTrack("Hum Melody", notes, settings, 0, true)];
  if (chords.length) {
    tracks.push(buildChordTrack(chords, settings));
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

function buildChordTrack(chords, settings) {
  const notes = [];
  const gridSeconds = chordGridSeconds(settings);
  for (const chord of chords) {
    const start = snapToGrid(chord.start, gridSeconds, settings.beatOffsetSeconds);
    const end = alignedChordEnd(chord, start, gridSeconds, settings.beatOffsetSeconds);
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

function buildNoteTrack(name, notes, settings, channel, includeTiming) {
  const ticksPerBeat = 480;
  const ticksPerSecond = ticksPerBeat * settings.tempo / 60;
  const timeOrigin = musicTimeOrigin(settings);
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

function setMidiBlob(blob) {
  clearMidiUrl();
  state.midiUrl = URL.createObjectURL(blob);
  els.downloadLink.href = state.midiUrl;
  els.downloadLink.classList.remove("disabled");
  els.downloadLink.download = `hum-${Date.now()}.mid`;
}

function clearMidiUrl() {
  if (state.midiUrl) {
    URL.revokeObjectURL(state.midiUrl);
  }
  state.midiUrl = null;
  els.downloadLink.href = "#";
  els.downloadLink.classList.add("disabled");
}

function render() {
  drawWaveform();
  drawPianoRoll();
}

function drawWaveform() {
  const canvas = els.waveCanvas;
  const ctx = resizeCanvas(canvas);
  const { width, height } = canvas;
  ctx.fillStyle = "#151922";
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height, 10, "#252c39");
  if (!state.monoData) {
    drawCentered(ctx, width, height, "等待音频");
    return;
  }
  const data = state.monoData;
  const mid = height / 2;
  const step = Math.max(1, Math.floor(data.length / width));
  ctx.strokeStyle = "#6ce0c8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x < width; x += 1) {
    let min = 1;
    let max = -1;
    const offset = x * step;
    for (let i = 0; i < step && offset + i < data.length; i += 1) {
      const value = data[offset + i];
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    ctx.moveTo(x, mid + min * mid * 0.86);
    ctx.lineTo(x, mid + max * mid * 0.86);
  }
  ctx.stroke();
  drawMarkers(ctx, width, height);
}

function drawPianoRoll() {
  const canvas = els.pianoCanvas;
  const ctx = resizeCanvas(canvas);
  const { width, height } = canvas;
  ctx.fillStyle = "#151922";
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height, 12, "#222938");
  if (!state.notes.length) {
    state.pianoLayout = null;
    drawCentered(ctx, width, height, "等待 MIDI 生成");
    return;
  }
  const minNote = Math.max(0, Math.min(...state.notes.map((n) => n.note)) - 4);
  const maxNote = Math.min(127, Math.max(...state.notes.map((n) => n.note)) + 4);
  const lanes = maxNote - minNote + 1;
  const left = 48;
  const top = 16;
  const rollWidth = width - left - 14;
  const rollHeight = height - top - 20;
  const duration = Math.max(state.duration, ...state.notes.map((n) => n.end), 1);
  state.pianoLayout = { left, top, rollWidth, rollHeight, duration, minNote, maxNote, lanes };
  for (let note = minNote; note <= maxNote; note += 1) {
    const y = top + (maxNote - note) / lanes * rollHeight;
    ctx.fillStyle = note % 12 === 0 ? "#202736" : "#1a202c";
    ctx.fillRect(left, y, rollWidth, Math.ceil(rollHeight / lanes));
    if (note % 12 === 0) {
      ctx.fillStyle = "#9aa7b9";
      ctx.font = "12px Segoe UI";
      ctx.fillText(noteName(note), 8, y + 12);
    }
  }
  drawBeatGrid(ctx, left, top, rollWidth, rollHeight, duration);
  state.notes.forEach((note, index) => {
    const x = left + note.start / duration * rollWidth;
    const w = Math.max(8, (note.end - note.start) / duration * rollWidth);
    const y = top + (maxNote - note.note) / lanes * rollHeight + 2;
    const h = Math.max(10, rollHeight / lanes - 4);
    const selected = index === state.selectedNoteIndex;
    ctx.fillStyle = selected ? "#f0a43a" : "#4fa3ff";
    ctx.strokeStyle = selected ? "#fff1c7" : "#9bd0ff";
    ctx.lineWidth = selected ? 2 : 1;
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.stroke();
  });
}

function populateNotePitchSelect() {
  els.notePitchSelect.replaceChildren();
  for (let midi = 0; midi <= 127; midi += 1) {
    const option = document.createElement("option");
    option.value = String(midi);
    option.textContent = `${noteName(midi)} (${midi})`;
    els.notePitchSelect.appendChild(option);
  }
}

function handlePianoRollClick(event) {
  if (!state.notes.length || !state.pianoLayout) {
    return;
  }
  const canvas = els.pianoCanvas;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;
  for (let index = state.notes.length - 1; index >= 0; index -= 1) {
    const box = pianoNoteRect(state.notes[index]);
    if (box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
      state.selectedNoteIndex = index;
      renderNoteEditor();
      render();
      setStatus(`已选中 ${noteName(state.notes[index].note)}`);
      void previewNote(state.notes[index]);
      return;
    }
  }
  state.selectedNoteIndex = -1;
  renderNoteEditor();
  render();
}

function pianoNoteRect(note) {
  const layout = state.pianoLayout;
  if (!layout) {
    return null;
  }
  const x = layout.left + note.start / layout.duration * layout.rollWidth;
  const w = Math.max(8, (note.end - note.start) / layout.duration * layout.rollWidth);
  const y = layout.top + (layout.maxNote - note.note) / layout.lanes * layout.rollHeight + 2;
  const h = Math.max(10, layout.rollHeight / layout.lanes - 4);
  return { x, y, w, h };
}

function drawMarkers(ctx, width, height) {
  if (!state.duration || !state.markers.length) {
    return;
  }
  ctx.strokeStyle = "#f0a43a";
  ctx.lineWidth = 1.5;
  for (const marker of state.markers) {
    const x = marker / state.duration * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawBeatGrid(ctx, left, top, width, height, duration) {
  const beatSeconds = 60 / clampInt(els.tempo.value, 40, 240);
  const offset = state.beatOffsetSeconds || 0;
  ctx.strokeStyle = "#394255";
  ctx.lineWidth = 1;
  for (let time = offset; time <= duration + beatSeconds; time += beatSeconds) {
    if (time < 0) continue;
    const x = left + time / duration * width;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
  }
}

function updateNoteLabels() {
  els.noteCount.textContent = `${state.notes.length} 音符`;
  els.keyLabel.textContent = keyLabelText();
  if (!state.notes.length) {
    els.rangeLabel.textContent = "-";
    els.resultSummary.textContent = state.audioBuffer ? "可生成 MIDI" : "等待音频";
    renderChordEditor();
    renderNoteEditor();
    els.midiPlayBtn.disabled = true;
    els.quantizeNowBtn.disabled = true;
    els.keySnapBtn.disabled = true;
    els.keyUndoBtn.disabled = true;
    return;
  }
  els.midiPlayBtn.disabled = false;
  els.quantizeNowBtn.disabled = false;
  els.keySnapBtn.disabled = !keyForPitchCorrection();
  els.keyUndoBtn.disabled = !state.keySnapUndoNotes?.length;
  if (state.selectedNoteIndex < 0 || state.selectedNoteIndex >= state.notes.length) {
    state.selectedNoteIndex = 0;
  }
  const minNote = Math.min(...state.notes.map((note) => note.note));
  const maxNote = Math.max(...state.notes.map((note) => note.note));
  els.rangeLabel.textContent = `${noteName(minNote)} - ${noteName(maxNote)}`;
  const chordPart = state.chords.length ? `，${state.chords.length} 个和弦` : "";
  els.resultSummary.textContent = `${state.notes.length} 个音符${chordPart}，${Math.max(...state.notes.map((n) => n.end)).toFixed(1)}s`;
  renderNoteEditor();
  renderChordEditor();
}

function keyLabelText() {
  const lockedKey = selectedLockedKey();
  if (lockedKey) {
    return `已选调性 ${lockedKey.name}`;
  }
  if (state.key) {
    return `已采用调性 ${state.key.name}`;
  }
  if (!state.suggestedKey) {
    return "调性未识别";
  }
  if (!Number.isFinite(state.suggestedKey.score)) {
    return `推测调性 ${state.suggestedKey.name} · 未采用`;
  }
  const confidence = Number.isFinite(state.suggestedKey.confidence) ? state.suggestedKey.confidence : 0;
  const label = state.suggestedKey.score >= 0.58 && confidence >= 0.08 ? "可信" : "待确认";
  return `推测调性 ${state.suggestedKey.name} · ${label} · 未采用`;
}

function keyForPitchCorrection() {
  return selectedLockedKey() || state.key || state.suggestedKey || null;
}

function updateKeyStateAfterNoteChange() {
  const lockedKey = selectedLockedKey();
  if (lockedKey) {
    state.key = lockedKey;
    state.suggestedKey = null;
    return;
  }
  if (state.key) {
    return;
  }
  state.suggestedKey = state.notes.length ? detectKey(state.notes) : null;
}

function updateMarkerCount() {
  els.markerCount.textContent = `${state.markers.length} 标记`;
}

function renderNoteEditor() {
  const note = selectedNote();
  if (state.currentPage !== "detect" || !note) {
    els.noteEditor.hidden = true;
    return;
  }
  const beat = beatSeconds();
  const origin = musicTimeOrigin(readSettings());
  const grid = quantizeGridBeats();
  els.noteEditor.hidden = false;
  els.noteEditLabel.textContent = `${state.selectedNoteIndex + 1}/${state.notes.length} ${noteName(note.note)}`;
  els.notePitchSelect.value = String(note.note);
  els.noteStartBeat.step = String(grid);
  els.noteDurationBeat.step = String(grid);
  els.noteStartBeat.value = formatBeatValue(Math.max(0, (note.start - origin) / beat));
  els.noteDurationBeat.value = formatBeatValue(Math.max(grid, (note.end - note.start) / beat));
  els.noteVelocity.value = String(clampInt(note.velocity, 1, 127));
}

function selectedNote() {
  if (state.selectedNoteIndex < 0 || state.selectedNoteIndex >= state.notes.length) {
    return null;
  }
  return state.notes[state.selectedNoteIndex];
}

function beatSeconds() {
  return 60 / clampInt(els.tempo.value, 40, 240);
}

function formatBeatValue(value) {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}

function applyNoteEditorChanges() {
  const note = selectedNote();
  if (!note) {
    return;
  }
  clearKeySnapUndo();
  const settings = readSettings();
  const beat = 60 / settings.tempo;
  const origin = musicTimeOrigin(settings);
  const startBeat = clampNumber(els.noteStartBeat.value, 0, 9999);
  const durationBeat = clampNumber(els.noteDurationBeat.value, quantizeGridBeats(), 9999);
  note.note = clampInt(els.notePitchSelect.value, 0, 127);
  note.start = Math.max(0, origin + startBeat * beat);
  note.end = Math.max(note.start + beat * quantizeGridBeats(), note.start + durationBeat * beat);
  note.velocity = clampInt(els.noteVelocity.value, 1, 127);
  sortNotesKeeping(note);
  finalizeNoteEdit("音符已修改");
  void previewNote(note);
}

function transposeSelectedNote(semitones) {
  const note = selectedNote();
  if (!note) {
    return;
  }
  clearKeySnapUndo();
  note.note = clampInt(note.note + semitones, 0, 127);
  const label = Math.abs(semitones) === 12
    ? (semitones > 0 ? "已升八度" : "已降八度")
    : (semitones > 0 ? "已升半音" : "已降半音");
  finalizeNoteEdit(label);
  void previewNote(note);
}

function deleteSelectedNote() {
  if (!selectedNote()) {
    return;
  }
  clearKeySnapUndo();
  state.notes.splice(state.selectedNoteIndex, 1);
  state.selectedNoteIndex = Math.min(state.selectedNoteIndex, state.notes.length - 1);
  finalizeNoteEdit("音符已删除");
}

function quantizeCurrentNotes() {
  if (!state.notes.length) {
    return;
  }
  stopMidiPlayback(false);
  clearKeySnapUndo();
  const settings = { ...readSettings(), quantize: true };
  state.notes = enforceOrder(quantizeTiming(state.notes, settings), settings);
  state.selectedNoteIndex = state.notes.length ? Math.max(0, Math.min(state.selectedNoteIndex, state.notes.length - 1)) : -1;
  finalizeNoteEdit(`已按 ${quantizeGridLabel(settings.quantizeGridBeats)} 量化`);
}

function applyKeySnapToCurrentNotes() {
  if (!state.notes.length) {
    setStatus("需要先生成 MIDI", "error");
    return;
  }
  const lockedKey = selectedLockedKey();
  const key = lockedKey || state.key || state.suggestedKey;
  const allowed = allowedPitchClasses(key);
  if (!key || !allowed) {
    setStatus("暂无可用调性", "error");
    return;
  }
  stopMidiPlayback(false);
  const previousNotes = cloneNotes(state.notes);
  const previousChords = cloneChords(state.chords);
  const settings = readSettings();
  const snapped = snapAllOutOfKeyToAllowed(state.notes, allowed);
  const nextNotes = enforceOrder(snapped, settings);
  const changed = countPitchChanges(previousNotes, nextNotes);
  if (!changed) {
    setStatus("没有需要修正的音");
    return;
  }
  state.keySnapUndoNotes = previousNotes;
  state.keySnapUndoChords = previousChords;
  state.notes = nextNotes;
  state.key = key;
  state.suggestedKey = null;
  state.selectedNoteIndex = Math.min(Math.max(state.selectedNoteIndex, 0), state.notes.length - 1);
  refreshMidiBlobFromState();
  updateNoteLabels();
  render();
  setStatus(`已按 ${key.name} 修正 ${changed} 个调外音`);
}

function undoKeySnap() {
  if (!state.keySnapUndoNotes?.length) {
    return;
  }
  stopMidiPlayback(false);
  state.notes = cloneNotes(state.keySnapUndoNotes);
  state.chords = cloneChords(state.keySnapUndoChords || []);
  clearKeySnapUndo();
  state.selectedNoteIndex = state.notes.length ? Math.min(Math.max(state.selectedNoteIndex, 0), state.notes.length - 1) : -1;
  const lockedKey = selectedLockedKey();
  state.key = lockedKey || null;
  state.suggestedKey = lockedKey ? null : detectKey(state.notes);
  refreshMidiBlobFromState();
  updateNoteLabels();
  render();
  setStatus("已撤销调性修正");
}

function clearKeySnapUndo() {
  state.keySnapUndoNotes = null;
  state.keySnapUndoChords = null;
}

function cloneNotes(notes) {
  return notes.map((note) => ({ ...note }));
}

function cloneChords(chords) {
  return chords.map((chord) => ({ ...chord, notes: [...(chord.notes || [])] }));
}

function countPitchChanges(before, after) {
  const length = Math.min(before.length, after.length);
  let changed = Math.abs(before.length - after.length);
  for (let i = 0; i < length; i += 1) {
    if (before[i].note !== after[i].note) {
      changed += 1;
    }
  }
  return changed;
}

function sortNotesKeeping(note) {
  state.notes.sort((a, b) => a.start - b.start || a.note - b.note);
  state.selectedNoteIndex = state.notes.indexOf(note);
}

function finalizeNoteEdit(statusText) {
  stopMidiPlayback(false);
  state.duration = Math.max(state.audioBuffer?.duration || 0, ...state.notes.map((note) => note.end), 0);
  updateKeyStateAfterNoteChange();
  refreshMidiBlobFromState();
  updateNoteLabels();
  render();
  setStatus(statusText);
}

function renderChordEditor() {
  if (state.currentPage !== "harmony" && state.currentPage !== "export") {
    els.chordEditor.hidden = true;
    return;
  }
  els.chordStrip.replaceChildren();
  if (!state.chords.length) {
    els.chordStrip.textContent = "和弦未生成";
    els.chordEditor.hidden = true;
    return;
  }

  if (state.selectedChordIndex < 0 || state.selectedChordIndex >= state.chords.length) {
    state.selectedChordIndex = 0;
  }
  state.chords.forEach((chord, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chord-chip${index === state.selectedChordIndex ? " selected" : ""}`;
    button.textContent = chord.name;
    button.title = `${formatTime(chord.start)} - ${formatTime(chord.end)}`;
    button.addEventListener("click", () => selectChordForEdit(index));
    els.chordStrip.appendChild(button);
  });

  const selected = state.chords[state.selectedChordIndex];
  els.chordEditor.hidden = state.currentPage !== "harmony";
  if (state.currentPage !== "harmony") {
    return;
  }
  els.chordEditLabel.textContent = `${formatTime(selected.start)} - ${formatTime(selected.end)}`;
  populateChordSelect(selected);
}

function selectChordForEdit(index) {
  state.selectedChordIndex = index;
  renderChordEditor();
}

function populateChordSelect(selected) {
  const selectedValue = chordValue(selected);
  els.chordSelect.replaceChildren();
  const groups = buildChordOptionGroups();
  for (const group of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const option of group.options) {
      const element = document.createElement("option");
      element.value = chordValue(option);
      element.textContent = option.name;
      element.selected = element.value === selectedValue;
      optgroup.appendChild(element);
    }
    els.chordSelect.appendChild(optgroup);
  }
}

function handleChordSelectChange() {
  const index = state.selectedChordIndex;
  if (index < 0 || index >= state.chords.length) {
    return;
  }
  const selected = parseChordValue(els.chordSelect.value);
  if (!selected) {
    return;
  }
  stopMidiPlayback(false);
  clearKeySnapUndo();
  const current = state.chords[index];
  const previous = index > 0 ? state.chords[index - 1] : null;
  state.chords[index] = {
    ...current,
    name: selected.name,
    root: selected.root,
    quality: selected.quality,
    notes: voiceChordForPreview(selected, previous?.notes),
  };
  refreshMidiBlobFromState();
  updateNoteLabels();
  render();
  setStatus("和弦已修改");
}

function buildChordOptionGroups() {
  const diatonic = state.key ? chordChoicesForKey(state.key) : [];
  const all = [];
  for (let root = 0; root < 12; root += 1) {
    all.push(makeChordChoice(root, "maj"));
    all.push(makeChordChoice(root, "min"));
  }
  for (let root = 0; root < 12; root += 1) {
    all.push(makeChordChoice(root, "dim"));
  }
  return [
    { label: "调内三和弦", options: diatonic.length ? diatonic : all.slice(0, 24) },
    { label: "全部三和弦", options: uniqueChordChoices(all) },
  ];
}

function chordChoicesForKey(key) {
  const degrees = key.mode === "minor" ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const qualities = key.mode === "minor"
    ? ["min", "dim", "maj", "min", "maj", "maj", "maj"]
    : ["maj", "min", "min", "maj", "maj", "min", "dim"];
  return degrees.map((degree, index) => makeChordChoice((key.tonic + degree) % 12, qualities[index]));
}

function uniqueChordChoices(options) {
  const seen = new Set();
  return options.filter((option) => {
    const value = chordValue(option);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function makeChordChoice(root, quality) {
  return {
    root,
    quality,
    name: chordName(root, quality),
    pitchClasses: chordIntervals(quality).map((interval) => (root + interval) % 12),
  };
}

function parseChordValue(value) {
  const [rootText, quality] = value.split(":");
  const root = Number(rootText);
  if (!Number.isInteger(root) || !["maj", "min", "dim"].includes(quality)) {
    return null;
  }
  return makeChordChoice(root, quality);
}

function chordValue(chord) {
  return `${chord.root}:${chord.quality}`;
}

function chordIntervals(quality) {
  if (quality === "min") return [0, 3, 7];
  if (quality === "dim") return [0, 3, 6];
  return [0, 4, 7];
}

function chordName(root, quality) {
  if (quality === "min") return `${NOTE_NAMES[root]}m`;
  if (quality === "dim") return `${NOTE_NAMES[root]}dim`;
  return NOTE_NAMES[root];
}

function voiceChordForPreview(chord, previousVoicing) {
  const choices = chord.pitchClasses.map((pc) => {
    const notes = [];
    for (let midi = 38; midi <= 69; midi += 1) {
      if (midi % 12 === pc) notes.push(midi);
    }
    return notes;
  });
  let best = null;
  let bestScore = Infinity;
  for (const a of choices[0]) {
    for (const b of choices[1]) {
      for (const c of choices[2]) {
        const voicing = [...new Set([a, b, c])].sort((left, right) => left - right);
        if (voicing.length < 3 || voicing[2] - voicing[0] > 19) continue;
        let score = Math.abs((voicing[0] + voicing[1] + voicing[2]) / 3 - 54);
        if (previousVoicing?.length) {
          score += voicingDistance(voicing, previousVoicing) * 0.25;
        }
        if (score < bestScore) {
          best = voicing;
          bestScore = score;
        }
      }
    }
  }
  return best || chord.pitchClasses.map((pc) => midiForPitchClassNear(pc, 54)).sort((a, b) => a - b);
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

function formatTime(seconds) {
  return `${seconds.toFixed(2)}s`;
}

function refreshMidiBlobFromState() {
  if (!state.notes.length) {
    clearMidiUrl();
    return;
  }
  const midiBytes = writeMidi(state.notes, readSettings(), state.chords);
  setMidiBlob(new Blob([midiBytes], { type: "audio/midi" }));
}

function setStatus(text, mode = "") {
  els.statusText.textContent = text;
  els.statusCard.classList.toggle("recording", mode === "recording");
  els.statusCard.classList.toggle("error", mode === "error");
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

function inferKeyFromMelody(notes) {
  if (!notes.length) {
    return null;
  }
  const first = notes[0].note % 12;
  const last = notes[notes.length - 1].note % 12;
  const tonic = notes.length > 1 && first !== last ? last : first;
  return { score: 0, tonic, mode: "major", name: `${NOTE_NAMES[tonic]} major` };
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

function estimateVoicingThreshold(rms, settings) {
  const values = [...rms].filter((value) => value > 0).sort((a, b) => a - b);
  if (!values.length) {
    return 1;
  }
  const global = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  const noiseFloor = values[Math.floor(values.length * 0.2)];
  const relative = global * Math.pow(10, -36 / 20);
  const noise = noiseFloor * Math.pow(10, settings.noiseGateDb / 20);
  return Math.max(0.0008, relative, Math.min(noise, global * 0.75));
}

function smoothPitches(pitches) {
  const output = new Float32Array(pitches);
  for (let i = 0; i < pitches.length; i += 1) {
    if (pitches[i] <= 0) continue;
    const values = [];
    for (let j = Math.max(0, i - 1); j <= Math.min(pitches.length - 1, i + 1); j += 1) {
      if (pitches[j] > 0) values.push(pitches[j]);
    }
    if (values.length >= 2) output[i] = median(values);
  }
  return output;
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
    const counts = new Map();
    for (let j = Math.max(0, i - radius); j <= Math.min(midi.length - 1, i + radius); j += 1) {
      if (!copy[j]) continue;
      counts.set(copy[j], (counts.get(copy[j]) || 0) + 1);
    }
    let bestNote = midi[i];
    let bestCount = 0;
    for (const [note, count] of counts.entries()) {
      if (count > bestCount) {
        bestNote = note;
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
    const local = notes.slice(Math.max(0, index - 1), Math.min(notes.length, index + 2)).map((item) => item.velocity);
    return { ...note, velocity: clampInt(Math.round(lerp(note.velocity, median(local), 0.42)), 42, 110) };
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

function makeNote(note, start, end, rmsValues) {
  return {
    note: clampInt(note, 0, 127),
    start,
    end: Math.max(start + 0.02, end),
    velocity: rmsToVelocity(rmsValues),
  };
}

function rmsToVelocity(values) {
  if (!values.length) {
    return 72;
  }
  const normalized = Math.min(1, median(values) / 0.12);
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

function cleanMarkers(markers, duration) {
  const cleaned = [];
  for (const marker of [...markers].sort((a, b) => a - b)) {
    if (marker < 0 || marker >= duration) continue;
    if (cleaned.length && marker - cleaned[cleaned.length - 1] < 0.08) continue;
    cleaned.push(marker);
  }
  return cleaned;
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

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx;
}

function drawGrid(ctx, width, height, divisions, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 1; i < divisions; i += 1) {
    const x = width * i / divisions;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let i = 1; i < 5; i += 1) {
    const y = height * i / 5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawCentered(ctx, width, height, text) {
  ctx.fillStyle = "#9aa7b9";
  ctx.font = "16px Segoe UI";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2);
  ctx.textAlign = "start";
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function noteName(note) {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

function nearestDenominator(value) {
  return [2, 4, 8, 16].reduce((best, item) => Math.abs(item - value) < Math.abs(best - value) ? item : best, 4);
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
