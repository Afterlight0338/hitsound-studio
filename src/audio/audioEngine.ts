import type { Lane, Trigger } from '../types';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private songSource: AudioBufferSourceNode | null = null;
  private songBuffer: AudioBuffer | null = null;
  private songGainNode: GainNode | null = null;
  private hitsoundGainNode: GainNode | null = null;
  private masterGainNode: GainNode | null = null;

  private isPlaying = false;
  private startTimeContext = 0;
  private pauseOffsetMs = 0;
  private playbackRate = 1.0;

  // Volumes (0 - 1)
  private songVol = 0.8;
  private hsVol = 0.9;
  private masterVol = 1.0;

  // Scheduling
  private lookaheadMs = 150; // schedule ahead 150ms for rock-solid stability
  private scheduleTimer: number | null = null;
  private scheduledTriggerIds = new Set<string>();

  // Custom samples from mapset or user
  private customSamples = new Map<string, AudioBuffer>();
  private defaultSamples = new Map<string, AudioBuffer>();
  private laneBufferCache = new Map<string, AudioBuffer>();
  private rawSampleFiles = new Map<string, Uint8Array>();
  private decodingPromises = new Map<string, Promise<AudioBuffer | null>>();
  private isPreloadingDefaults = false;

  // Dynamic references to active project data
  private currentLanes: Lane[] = [];
  private currentTriggers: Trigger[] = [];

  // Waveform
  private waveformPeaks: Float32Array | null = null;
  private transientPeaks: Float32Array | null = null;

  // Listeners
  public onTimeUpdate: ((timeMs: number) => void) | null = null;
  public onStateChange: ((isPlaying: boolean) => void) | null = null;

  constructor() {
    // Lazy AudioContext initialization
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGainNode = this.ctx.createGain();
      this.masterGainNode.gain.value = this.masterVol;
      this.masterGainNode.connect(this.ctx.destination);

      this.songGainNode = this.ctx.createGain();
      this.songGainNode.gain.value = this.songVol;
      this.songGainNode.connect(this.masterGainNode);

      this.hitsoundGainNode = this.ctx.createGain();
      this.hitsoundGainNode.gain.value = this.hsVol;
      this.hitsoundGainNode.connect(this.masterGainNode);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public getContext(): AudioContext {
    return this.ensureContext();
  }

  /**
   * Decodes main song audio (mp3/ogg/wav), computes waveform peaks and sets songBuffer
   */
  public async decodeSongAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    // Use a copy of arrayBuffer in case decodeAudioData detaches it
    const copy = arrayBuffer.slice(0);
    const buffer = await ctx.decodeAudioData(copy);
    this.songBuffer = buffer;
    this.computeWaveform(buffer);
    return buffer;
  }

  /**
   * Decodes a sample audio file (.wav / .ogg) without touching songBuffer
   */
  public async decodeSampleAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    const copy = arrayBuffer.slice(0);
    return await ctx.decodeAudioData(copy);
  }

  public setRawSampleFiles(files: Map<string, Uint8Array>) {
    this.rawSampleFiles = files;
    this.decodingPromises.clear();
    this.laneBufferCache.clear();
  }

  public setCustomSamples(samples: Map<string, AudioBuffer>) {
    this.customSamples = samples;
    this.laneBufferCache.clear();
  }

  public setSongBuffer(buffer: AudioBuffer | null) {
    this.songBuffer = buffer;
    if (buffer) {
      this.computeWaveform(buffer);
    } else {
      this.waveformPeaks = null;
      this.transientPeaks = null;
    }
  }

  public clear() {
    if (this.isPlaying) {
      this.pause();
    }
    if (this.songSource) {
      try {
        this.songSource.stop();
        this.songSource.disconnect();
      } catch {}
      this.songSource = null;
    }
    this.songBuffer = null;
    this.waveformPeaks = null;
    this.transientPeaks = null;
    this.pauseOffsetMs = 0;
    this.customSamples.clear();
    this.laneBufferCache.clear();
    this.currentLanes = [];
    this.currentTriggers = [];
    this.scheduledTriggerIds.clear();
  }

  public getWaveform(): { peaks: Float32Array | null; transients: Float32Array | null; duration: number } {
    return {
      peaks: this.waveformPeaks,
      transients: this.transientPeaks,
      duration: this.songBuffer ? this.songBuffer.duration : 0,
    };
  }

  private computeWaveform(buffer: AudioBuffer) {
    const rawData = buffer.getChannelData(0); // Left channel
    const sampleRate = buffer.sampleRate;
    const pointsPerSec = 150; // 150 peak points per second
    const totalPoints = Math.ceil(buffer.duration * pointsPerSec);
    const blockSize = Math.floor(sampleRate / pointsPerSec);

    const peaks = new Float32Array(totalPoints);
    const transients = new Float32Array(totalPoints);

    let prevRms = 0;

    for (let i = 0; i < totalPoints; i++) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, rawData.length);

      let max = 0;
      let sumSq = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(rawData[j]);
        if (abs > max) max = abs;
        sumSq += abs * abs;
      }
      peaks[i] = max;

      const rms = Math.sqrt(sumSq / Math.max(1, end - start));
      const diff = Math.max(0, rms - prevRms);
      transients[i] = diff;
      prevRms = rms;
    }

    this.waveformPeaks = peaks;
    this.transientPeaks = transients;
  }

  /**
   * Preload official osu! standard default skin hitsound samples (/defaults/*.wav).
   * These act as the authentic baseline when a beatmap (.osz) does not provide custom overrides.
   */
  public async preloadDefaultSamples(): Promise<void> {
    if (this.isPreloadingDefaults || typeof window === 'undefined' || typeof fetch === 'undefined') return;
    this.isPreloadingDefaults = true;

    const defaultFiles = [
      'soft-hitnormal.wav',
      'soft-hitclap.wav',
      'soft-hitwhistle.wav',
      'soft-hitfinish.wav',
      'normal-hitnormal.wav',
      'normal-hitclap.wav',
      'normal-hitwhistle.wav',
      'normal-hitfinish.wav',
      'drum-hitnormal.wav',
      'drum-hitclap.wav',
      'drum-hitwhistle.wav',
      'drum-hitfinish.wav',
    ];

    const ctx = this.ensureContext();
    const baseUrl = ((import.meta as any)?.env?.BASE_URL || '').replace(/\/$/, '');
    await Promise.all(
      defaultFiles.map(async (file) => {
        try {
          const res = await fetch(`${baseUrl}/defaults/${file}`);
          if (res.ok) {
            const buf = await ctx.decodeAudioData(await res.arrayBuffer());
            this.defaultSamples.set(file, buf);
          }
        } catch {
          // ignore network error
        }
      })
    );
  }

  /**
   * Resolves sample audio buffer:
   * 1. Checks lane.audioBuffer
   * 2. Checks custom sample files from loaded beatmap (.osz)
   * 3. Falls back to standard osu! default skin sample (/defaults/*.wav)
   */
  public getSampleBuffer(lane: Lane): AudioBuffer | null {
    if (lane.audioBuffer) return lane.audioBuffer;

    const cacheKey = `${lane.id}_${lane.sampleSet}_${lane.addition}_${lane.customIndex}`;
    const cached = this.laneBufferCache.get(cacheKey);
    if (cached) return cached;

    const setStr = lane.sampleSet.toLowerCase();
    const addStr = lane.addition.toLowerCase();
    const idx = lane.customIndex || 0;

    // Check custom sample map (e.g. "soft-hitclap.wav", "soft-hitclap2.ogg")
    const searchKeys: string[] = [];
    const baseName = lane.addition === 'None' ? `${setStr}-hitnormal` : `${setStr}-hit${addStr}`;

    if (idx > 1) {
      searchKeys.push(`${baseName}${idx}.wav`, `${baseName}${idx}.ogg`, `${baseName}${idx}.mp3`);
    } else if (idx === 1) {
      searchKeys.push(`${baseName}1.wav`, `${baseName}1.ogg`, `${baseName}1.mp3`);
      searchKeys.push(`${baseName}.wav`, `${baseName}.ogg`, `${baseName}.mp3`);
    }
    searchKeys.push(`${baseName}.wav`, `${baseName}.ogg`, `${baseName}.mp3`);

    // Also check clean lane name if custom
    const cleanLaneName = lane.name.trim().toLowerCase();
    if (cleanLaneName) {
      searchKeys.push(cleanLaneName, `${cleanLaneName}.wav`, `${cleanLaneName}.ogg`, `${cleanLaneName}.mp3`);
    }

    // 1. Check custom samples provided by mapset
    for (const key of searchKeys) {
      if (this.customSamples.has(key)) {
        const buf = this.customSamples.get(key)!;
        this.laneBufferCache.set(cacheKey, buf);
        return buf;
      }
    }

    // 1.5. If raw sample exists in map archive, decode on demand
    for (const key of searchKeys) {
      if (this.rawSampleFiles.has(key)) {
        if (!this.decodingPromises.has(key)) {
          const rawBytes = this.rawSampleFiles.get(key)!;
          if (rawBytes.length > 44) {
            const arrBuf = rawBytes.buffer.slice(
              rawBytes.byteOffset,
              rawBytes.byteOffset + rawBytes.byteLength
            ) as ArrayBuffer;
            const p = this.decodeSampleAudio(arrBuf)
              .then((buf) => {
                this.customSamples.set(key, buf);
                this.laneBufferCache.set(cacheKey, buf);
                return buf;
              })
              .catch(() => null);
            this.decodingPromises.set(key, p);
          }
        }
        break;
      }
    }

    // 2. Fall back to authentic osu! default hitsound sample
    const defaultKey = `${baseName}.wav`;
    if (this.defaultSamples.has(defaultKey)) {
      const buf = this.defaultSamples.get(defaultKey)!;
      this.laneBufferCache.set(cacheKey, buf);
      return buf;
    }

    // Lazy load default if not preloaded yet
    if (typeof window !== 'undefined' && typeof fetch !== 'undefined') {
      const baseUrl = ((import.meta as any)?.env?.BASE_URL || '').replace(/\/$/, '');
      fetch(`${baseUrl}/defaults/${defaultKey}`)
        .then((res) => {
          if (!res.ok) return null;
          return res.arrayBuffer();
        })
        .then(async (arr) => {
          if (arr) {
            const buf = await this.ensureContext().decodeAudioData(arr);
            this.defaultSamples.set(defaultKey, buf);
            this.laneBufferCache.set(cacheKey, buf);
          }
        })
        .catch(() => {});
    }

    return null;
  }

  public updateSchedulerData(lanes: Lane[], triggers: Trigger[]) {
    this.currentLanes = lanes;
    this.currentTriggers = [...triggers].sort((a, b) => a.time - b.time);
  }

  public play(fromMs?: number, lanes: Lane[] = [], triggers: Trigger[] = []) {
    const ctx = this.ensureContext();
    if (this.isPlaying) this.pause();

    this.currentLanes = lanes;
    this.currentTriggers = [...triggers].sort((a, b) => a.time - b.time);

    if (fromMs !== undefined) {
      this.pauseOffsetMs = Math.max(0, fromMs);
    }

    this.isPlaying = true;
    // 25ms lead time so audio hardware initializes without jitter or underrun
    const leadTimeSec = 0.025;
    this.startTimeContext = ctx.currentTime + leadTimeSec;
    this.scheduledTriggerIds.clear();

    if (this.songBuffer) {
      this.songSource = ctx.createBufferSource();
      this.songSource.buffer = this.songBuffer;
      this.songSource.playbackRate.value = this.playbackRate;
      this.songSource.connect(this.songGainNode!);

      const offsetSec = this.pauseOffsetMs / 1000;
      if (offsetSec < this.songBuffer.duration) {
        this.songSource.start(this.startTimeContext, offsetSec);
      }
      this.songSource.onended = () => {
        // Only trigger pause if we actually reached or exceeded duration
        if (this.isPlaying && this.songBuffer && this.getCurrentTimeMs() >= this.songBuffer.duration * 1000 - 50) {
          this.pause();
        }
      };
    }

    // Schedule the first batch immediately before interval starts
    this.scheduleTick();
    this.startScheduler();

    if (this.onStateChange) this.onStateChange(true);
  }

  public pause() {
    if (!this.isPlaying) return;

    this.pauseOffsetMs = this.getCurrentTimeMs();
    this.isPlaying = false;

    if (this.songSource) {
      try {
        this.songSource.stop();
        this.songSource.disconnect();
      } catch {
        // ignore
      }
      this.songSource = null;
    }

    if (this.scheduleTimer !== null) {
      window.clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }

    if (this.onStateChange) this.onStateChange(false);
  }

  public seek(toMs: number, lanes?: Lane[], triggers?: Trigger[]) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.pause();
    }
    this.pauseOffsetMs = Math.max(0, toMs);
    if (lanes) this.currentLanes = lanes;
    if (triggers) this.currentTriggers = triggers;

    if (this.onTimeUpdate) {
      this.onTimeUpdate(this.pauseOffsetMs);
    }
    if (wasPlaying) {
      this.play(this.pauseOffsetMs, this.currentLanes, this.currentTriggers);
    }
  }

  public getCurrentTimeMs(): number {
    if (!this.isPlaying || !this.ctx) {
      return this.pauseOffsetMs;
    }
    const elapsedSec = (this.ctx.currentTime - this.startTimeContext) * this.playbackRate;
    return Math.max(0, this.pauseOffsetMs + elapsedSec * 1000);
  }

  public playSingleSample(lane: Lane, volumeOverride?: number): boolean {
    const buffer = this.getSampleBuffer(lane);
    if (!buffer) return false;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    const vol = (volumeOverride ?? lane.volume) / 100;
    gain.gain.value = vol;

    source.connect(gain);
    gain.connect(this.hitsoundGainNode!);
    source.start();
    return true;
  }

  private startScheduler() {
    if (this.scheduleTimer !== null) {
      window.clearInterval(this.scheduleTimer);
    }

    // High frequency 15ms audio tick decoupled from UI rendering
    this.scheduleTimer = window.setInterval(() => {
      this.scheduleTick();
    }, 15);
  }

  private scheduleTick() {
    if (!this.isPlaying || !this.ctx) return;

    const currentMs = this.getCurrentTimeMs();
    const lookaheadEndMs = currentMs + this.lookaheadMs;

    const lanes = this.currentLanes;
    const triggers = this.currentTriggers;

    const laneMap = new Map<string, Lane>();
    const hasSolo = lanes.some((l) => l.solo);
    for (const l of lanes) {
      laneMap.set(l.id, l);
    }

    const targetTime = currentMs - 15;
    let startIdx = 0;
    let low = 0;
    let high = triggers.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (triggers[mid].time < targetTime) {
        low = mid + 1;
      } else {
        startIdx = mid;
        high = mid - 1;
      }
    }
    if (low > high && low < triggers.length) startIdx = low;

    for (let i = startIdx; i < triggers.length; i++) {
      const tr = triggers[i];
      if (tr.time > lookaheadEndMs) break;

      if (!this.scheduledTriggerIds.has(tr.id)) {
        this.scheduledTriggerIds.add(tr.id);

        const lane = laneMap.get(tr.laneId);
        if (!lane || lane.muted) continue;
        if (hasSolo && !lane.solo) continue;

        // Hardware-locked context time: exact sample offset from song start
        const noteSongSec = (tr.time - this.pauseOffsetMs) / 1000 / this.playbackRate;
        const scheduledCtxTime = this.startTimeContext + noteSongSec;

        // Ensure we only schedule within the valid context horizon
        if (scheduledCtxTime >= this.ctx.currentTime - 0.008) {
          const buffer = this.getSampleBuffer(lane);
          if (!buffer) continue;

          const source = this.ctx.createBufferSource();
          source.buffer = buffer;

          const gain = this.ctx.createGain();
          const vol = (tr.volume !== undefined ? tr.volume : lane.volume) / 100;
          gain.gain.value = vol;

          source.connect(gain);
          gain.connect(this.hitsoundGainNode!);

          source.start(Math.max(this.ctx.currentTime, scheduledCtxTime));
        }
      }
    }

    // Fast garbage collection
    if (this.scheduledTriggerIds.size > 1500) {
      for (const tr of triggers) {
        if (tr.time < currentMs - 2000) {
          this.scheduledTriggerIds.delete(tr.id);
        } else {
          break;
        }
      }
    }
  }

  public setSongVolume(vol: number) {
    this.songVol = Math.max(0, Math.min(1, vol));
    if (this.songGainNode) this.songGainNode.gain.value = this.songVol;
  }

  public setHitsoundVolume(vol: number) {
    this.hsVol = Math.max(0, Math.min(1, vol));
    if (this.hitsoundGainNode) this.hitsoundGainNode.gain.value = this.hsVol;
  }

  public setPlaybackRate(rate: number) {
    this.playbackRate = rate;
    if (this.songSource) {
      this.songSource.playbackRate.value = rate;
    }
  }

  public isAudioPlaying(): boolean {
    return this.isPlaying;
  }

  public getDurationMs(): number {
    return this.songBuffer ? this.songBuffer.duration * 1000 : 0;
  }
}
