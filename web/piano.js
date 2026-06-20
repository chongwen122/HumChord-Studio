(() => {
  const TWO_PI = Math.PI * 2;

  class MiniPiano {
    constructor(audioContext) {
      this.audioContext = audioContext;
      this.activeNodes = new Set();
      this.sampleCache = new Map();
      this.maxCacheSize = 96;
      this.releaseBuffer = createReleaseBuffer(audioContext);

      this.input = audioContext.createGain();
      this.body = audioContext.createBiquadFilter();
      this.presence = audioContext.createBiquadFilter();
      this.air = audioContext.createBiquadFilter();
      this.dry = audioContext.createGain();
      this.wet = audioContext.createGain();
      this.reverb = audioContext.createConvolver();
      this.chorus = createChorus(audioContext);
      this.compressor = audioContext.createDynamicsCompressor();
      this.master = audioContext.createGain();

      this.body.type = "lowshelf";
      this.body.frequency.value = 170;
      this.body.gain.value = 1.8;
      this.presence.type = "peaking";
      this.presence.frequency.value = 2600;
      this.presence.Q.value = 0.8;
      this.presence.gain.value = 1.4;
      this.air.type = "highshelf";
      this.air.frequency.value = 5400;
      this.air.gain.value = -1.2;
      this.dry.gain.value = 0.82;
      this.wet.gain.value = 0.22;
      this.master.gain.value = 0.74;
      this.reverb.buffer = createImpulseResponse(audioContext);
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 3.2;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.22;

      this.input.connect(this.body);
      this.body.connect(this.presence);
      this.presence.connect(this.air);
      this.air.connect(this.dry);
      this.air.connect(this.chorus.input);
      this.air.connect(this.wet);
      this.chorus.output.connect(this.dry);
      this.wet.connect(this.reverb);
      this.reverb.connect(this.master);
      this.dry.connect(this.master);
      this.master.connect(this.compressor);
      this.compressor.connect(audioContext.destination);
    }

    scheduleNote(midi, startTime, duration, velocity = 80, options = {}) {
      const note = clampInt(midi, 21, 108);
      const buffer = this.getSampleBuffer(note);
      const velocityAmount = clamp(velocity / 112, 0.16, 1);
      const roleGain = options.role === "chord" ? 0.34 : 0.58;
      const peak = velocityCurve(velocityAmount) * roleGain * (options.gain ?? 1);
      const releaseStart = startTime + Math.max(0.08, duration);
      const releaseTime = options.role === "chord" ? 0.52 : 0.44;
      const stopTime = Math.min(startTime + buffer.duration, releaseStart + releaseTime + 0.18);

      const source = this.audioContext.createBufferSource();
      const voiceGain = this.audioContext.createGain();
      const tone = this.audioContext.createBiquadFilter();
      const pan = this.audioContext.createStereoPanner();
      const noteBrightness = options.role === "chord" ? 3.6 : 4.6;

      source.buffer = buffer;
      tone.type = "lowpass";
      tone.frequency.setValueAtTime(clamp(midiToHz(note) * noteBrightness, 1300, 8200), startTime);
      tone.frequency.exponentialRampToValueAtTime(clamp(midiToHz(note) * 2.35, 900, 5200), startTime + 0.42);
      tone.Q.value = note < 50 ? 0.55 : 0.72;
      pan.pan.value = options.pan ?? clamp((note - 62) / 54, -0.42, 0.42);

      voiceGain.gain.setValueAtTime(0.0001, startTime);
      voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), startTime + 0.005);
      voiceGain.gain.setValueAtTime(Math.max(0.0002, peak), releaseStart);
      voiceGain.gain.setTargetAtTime(0.0001, releaseStart, releaseTime / 4);

      source.connect(tone);
      tone.connect(pan);
      pan.connect(voiceGain);
      voiceGain.connect(this.input);
      source.start(startTime);
      source.stop(stopTime);

      if (!options.disableReleaseNoise) {
        this.scheduleReleaseNoise(note, releaseStart, peak * 0.38, pan.pan.value);
      }
      this.trackVoice([source, tone, pan, voiceGain], stopTime);
      return stopTime;
    }

    getSampleBuffer(midi) {
      const key = String(midi);
      const cached = this.sampleCache.get(key);
      if (cached) {
        return cached;
      }
      const buffer = createPianoSample(this.audioContext, midi);
      this.sampleCache.set(key, buffer);
      if (this.sampleCache.size > this.maxCacheSize) {
        const firstKey = this.sampleCache.keys().next().value;
        this.sampleCache.delete(firstKey);
      }
      return buffer;
    }

    preload(midiValues, onProgress) {
      const unique = [...new Set(midiValues.map((midi) => clampInt(midi, 21, 108)))];
      let index = 0;
      return new Promise((resolve) => {
        const step = () => {
          const startedAt = performance.now();
          while (index < unique.length && performance.now() - startedAt < 18) {
            this.getSampleBuffer(unique[index]);
            index += 1;
            if (onProgress) {
              onProgress(index, unique.length);
            }
          }
          if (index < unique.length) {
            window.setTimeout(step, 0);
          } else {
            resolve();
          }
        };
        step();
      });
    }

    scheduleReleaseNoise(midi, startTime, gainValue, panValue) {
      const source = this.audioContext.createBufferSource();
      const gain = this.audioContext.createGain();
      const filter = this.audioContext.createBiquadFilter();
      const pan = this.audioContext.createStereoPanner();
      source.buffer = this.releaseBuffer;
      filter.type = "bandpass";
      filter.frequency.value = clamp(950 + (midi - 48) * 22, 700, 2600);
      filter.Q.value = 1.1;
      pan.pan.value = panValue;
      gain.gain.setValueAtTime(Math.max(0.0001, gainValue * 0.08), startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.12);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(pan);
      pan.connect(this.input);
      source.start(startTime);
      source.stop(startTime + 0.16);
      this.trackVoice([source, filter, gain, pan], startTime + 0.18);
    }

    stopAll() {
      const now = this.audioContext.currentTime;
      for (const node of this.activeNodes) {
        try {
          if (typeof node.stop === "function") {
            node.stop(now + 0.01);
          }
        } catch {
          // The node may already have finished naturally.
        }
        try {
          node.disconnect();
        } catch {
          // Already disconnected.
        }
      }
      this.activeNodes.clear();
    }

    trackVoice(nodes, stopTime) {
      for (const node of nodes) {
        this.activeNodes.add(node);
      }
      const delay = Math.max(50, (stopTime - this.audioContext.currentTime) * 1000 + 120);
      window.setTimeout(() => {
        for (const node of nodes) {
          this.activeNodes.delete(node);
          try {
            node.disconnect();
          } catch {
            // Already disconnected.
          }
        }
      }, delay);
    }
  }

  function createPianoSample(audioContext, midi) {
    const sampleRate = audioContext.sampleRate;
    const frequency = midiToHz(midi);
    const lengthSeconds = midi < 45 ? 5.8 : midi < 68 ? 4.5 : 3.35;
    const length = Math.max(1, Math.floor(lengthSeconds * sampleRate));
    const buffer = audioContext.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const random = seededRandom(1009 + midi * 9176);
    const partials = partialProfile(midi);
    const strings = stringProfile(midi);
    const inharmonicity = 0.00006 + Math.max(0, midi - 21) * 0.0000024;

    for (const string of strings) {
      const detuneRatio = 2 ** (string.cents / 1200);
      for (const partial of partials) {
        const ratio = partial.index * Math.sqrt(1 + inharmonicity * partial.index * partial.index);
        const partialFrequency = frequency * ratio * detuneRatio;
        if (partialFrequency > sampleRate * 0.46) {
          continue;
        }
        let phase = random() * TWO_PI;
        const phaseStep = TWO_PI * partialFrequency / sampleRate;
        const decay = partialDecay(midi, partial.index, partialFrequency) * string.decay;
        const level = partial.level * string.level;
        const leftLevel = level * Math.sqrt(1 - string.pan * 0.42);
        const rightLevel = level * Math.sqrt(1 + string.pan * 0.42);
        for (let i = 0; i < length; i += 1) {
          const time = i / sampleRate;
          const attack = 1 - Math.exp(-time / partial.attack);
          const decayEnvelope = Math.exp(-time / decay);
          const shimmer = 1 + 0.006 * Math.sin(TWO_PI * (1.1 + partial.index * 0.17) * time + string.phase);
          const value = Math.sin(phase) * attack * decayEnvelope * shimmer;
          left[i] += value * leftLevel;
          right[i] += value * rightLevel;
          phase += phaseStep;
          if (phase > TWO_PI) phase -= TWO_PI;
        }
      }
    }

    addHammerAndBody(left, right, sampleRate, midi, frequency, random);
    normalizeStereo(left, right, midi < 45 ? 0.82 : 0.9);
    return buffer;
  }

  function partialProfile(midi) {
    const mellow = midi < 48 ? 0.78 : midi > 76 ? 1.08 : 1;
    const count = midi < 45 ? 16 : midi < 72 ? 14 : 11;
    const partials = [];
    for (let index = 1; index <= count; index += 1) {
      const rolloff = index === 1 ? 1 : 1 / (index ** 1.14);
      const oddLift = index % 2 ? 1.08 : 0.92;
      const highDamping = midi > 72 && index > 7 ? 0.5 : 1;
      partials.push({
        index,
        level: rolloff * oddLift * highDamping * mellow,
        attack: 0.0025 + index * 0.0007,
      });
    }
    return partials;
  }

  function stringProfile(midi) {
    if (midi < 42) {
      return [{ cents: 0, pan: clamp((midi - 57) / 62, -0.38, 0.38), level: 1, decay: 1.08, phase: 0 }];
    }
    return [
      { cents: -2.4, pan: -0.28, level: 0.72, decay: 1.04, phase: 0.2 },
      { cents: 0.0, pan: 0.02, level: 0.88, decay: 1.0, phase: 1.7 },
      { cents: 2.1, pan: 0.32, level: 0.7, decay: 0.96, phase: 2.8 },
    ];
  }

  function partialDecay(midi, partialIndex, partialFrequency) {
    const register = clamp((midi - 21) / 87, 0, 1);
    const base = 4.9 - register * 2.15;
    const bassBoost = midi < 48 ? 1.25 : 1;
    const partialLoss = 1 / (1 + partialIndex * 0.18 + partialFrequency / 13000);
    return clamp(base * bassBoost * partialLoss, 0.42, 6.4);
  }

  function addHammerAndBody(left, right, sampleRate, midi, frequency, random) {
    const length = left.length;
    const hammerLength = Math.min(length, Math.floor(sampleRate * 0.045));
    const strikeFrequency = clamp(1800 + (midi - 60) * 32, 900, 4200);
    let strikePhase = random() * TWO_PI;
    const strikeStep = TWO_PI * strikeFrequency / sampleRate;
    for (let i = 0; i < hammerLength; i += 1) {
      const time = i / sampleRate;
      const noise = (random() * 2 - 1) * Math.exp(-time / 0.012);
      const click = Math.sin(strikePhase) * Math.exp(-time / 0.009);
      const thump = Math.sin(TWO_PI * frequency * 0.48 * time) * Math.exp(-time / 0.035);
      const value = noise * 0.028 + click * 0.034 + thump * (midi < 52 ? 0.055 : 0.026);
      left[i] += value * 0.92;
      right[i] += value * 0.86;
      strikePhase += strikeStep;
      if (strikePhase > TWO_PI) strikePhase -= TWO_PI;
    }

    const resonances = [98, 147, 196, 247, 330, 392, 523, 659, 784];
    for (const resonance of resonances) {
      if (resonance > sampleRate * 0.44) continue;
      const distance = Math.abs(12 * Math.log2(resonance / frequency));
      const amount = 0.008 / (1 + distance * 0.12);
      let phase = random() * TWO_PI;
      const step = TWO_PI * resonance / sampleRate;
      for (let i = 0; i < length; i += 1) {
        const time = i / sampleRate;
        const envelope = Math.exp(-time / 2.6) * (1 - Math.exp(-time / 0.035));
        const value = Math.sin(phase) * envelope * amount;
        left[i] += value;
        right[i] += value * 0.96;
        phase += step;
        if (phase > TWO_PI) phase -= TWO_PI;
      }
    }
  }

  function normalizeStereo(left, right, targetPeak) {
    let peak = 0;
    for (let i = 0; i < left.length; i += 1) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    if (peak < 0.0001) {
      return;
    }
    const gain = targetPeak / peak;
    for (let i = 0; i < left.length; i += 1) {
      left[i] *= gain;
      right[i] *= gain;
    }
  }

  function createChorus(audioContext) {
    const input = audioContext.createGain();
    const output = audioContext.createGain();
    const delay = audioContext.createDelay(0.04);
    const wetGain = audioContext.createGain();
    const lfo = audioContext.createOscillator();
    const depth = audioContext.createGain();
    delay.delayTime.value = 0.014;
    wetGain.gain.value = 0.13;
    lfo.frequency.value = 0.42;
    depth.gain.value = 0.0045;
    lfo.connect(depth);
    depth.connect(delay.delayTime);
    input.connect(output);
    input.connect(delay);
    delay.connect(wetGain);
    wetGain.connect(output);
    lfo.start();
    return { input, output };
  }

  function createReleaseBuffer(audioContext) {
    const length = Math.max(1, Math.floor(audioContext.sampleRate * 0.16));
    const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    let random = 0.34;
    for (let i = 0; i < length; i += 1) {
      random = (random * 16807) % 1;
      data[i] = (random * 2 - 1) * Math.exp(-i / length * 7);
    }
    return buffer;
  }

  function createImpulseResponse(audioContext) {
    const length = Math.max(1, Math.floor(audioContext.sampleRate * 1.15));
    const buffer = audioContext.createBuffer(2, length, audioContext.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      const random = seededRandom(800 + channel * 31);
      for (let i = 0; i < length; i += 1) {
        const time = i / audioContext.sampleRate;
        const decay = Math.exp(-time / 0.48) * (1 - i / length);
        data[i] = (random() * 2 - 1) * decay * 0.42;
      }
    }
    return buffer;
  }

  function velocityCurve(value) {
    return 0.18 + (value ** 1.65) * 0.82;
  }

  function midiToHz(midi) {
    return 440 * 2 ** ((midi - 69) / 12);
  }

  function seededRandom(seed) {
    let value = seed >>> 0;
    return () => {
      value += 0x6d2b79f5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampInt(value, min, max) {
    return Math.round(clamp(value, min, max));
  }

  window.MiniPiano = MiniPiano;
})();
