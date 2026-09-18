import type { Lane, Trigger } from '../types';
import { createSynthesizedSample } from './synthesizer';

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
  private lookaheadMs = 120; // schedule ahead 120ms
  private scheduleTimer: number | null = null;
  private scheduledTriggerIds = new Set<string>();

  // Synth cache & custom samples
  private synthCache = new Map<string, AudioBuffer>();
  private customSamples = new Map<string, AudioBuffer>();

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

  public setCustomSamples(samples: Map<string, AudioBuffer>) {
    this.customSamples = samples;
  }

  public setSongBuffer(buffer: AudioBuffer) {
    this.songBuffer = buffer;
    this.computeWaveform(buffer);
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
   * Resolves sample audio buffer: checks lane buffer -> custom sample files from map -> synth fallback
   */
  public getSampleBuffer(lane: Lane): AudioBuffer {
    if (lane.audioBuffer) return lane.audioBuffer;

    const setStr = lane.sampleSet.toLowerCase();
    const addStr = lane.addition.toLowerCase();
    const idx = lane.customIndex || 0;
    const idxStr = idx > 1 ? String(idx) : '';

    // Check custom sample map (e.g. "soft-hitclap.wav", "soft-hitclap2.ogg")
    const searchKeys: string[] = [];
    if (lane.addition === 'None') {
      searchKeys.push(`${setStr}-hitnormal${idxStr}.wav`);
      searchKeys.push(`${setStr}-hitnormal${idxStr}.ogg`);
      searchKeys.push(`${setStr}-hitnormal.wav`);
      searchKeys.push(`${setStr}-hitnormal.ogg`);
    } else {
      searchKeys.push(`${setStr}-hit${addStr}${idxStr}.wav`);
      searchKeys.push(`${setStr}-hit${addStr}${idxStr}.ogg`);
      searchKeys.push(`${setStr}-hit${addStr}.wav`);
      searchKeys.push(`${setStr}-hit${addStr}.ogg`);
    }

    for (const key of searchKeys) {
      if (this.customSamples.has(key)) {
        return this.customSamples.get(key)!;
      }
    }

    // Procedural synthesis fallback
    const ctx = this.ensureContext();
    let synthKey = 'soft-hitnormal';

    if (lane.addition === 'Clap') {
      synthKey = lane.sampleSet === 'Drum' ? 'drum-hitclap' : 'soft-hitclap';
    } else if (lane.addition === 'Whistle') {
      synthKey = 'soft-hitwhistle';
    } else if (lane.addition === 'Finish') {
      synthKey = 'soft-hitfinish';
    } else {
      synthKey = lane.sampleSet === 'Drum' ? 'drum-hitnormal' : 'soft-hitnormal';
    }

    if (!this.synthCache.has(synthKey)) {
      const buf = createSynthesizedSample(ctx, synthKey as any);
      this.synthCache.set(synthKey, buf);
    }

    return this.synthCache.get(synthKey)!;
  }

  public updateSchedulerData(lanes: Lane[], triggers: Trigger[]) {
    this.currentLanes = lanes;
    this.currentTriggers = triggers;
  }

  public play(fromMs?: number, lanes: Lane[] = [], triggers: Trigger[] = []) {
    const ctx = this.ensureContext();
    if (this.isPlaying) this.pause();

    this.currentLanes = lanes;
    this.currentTriggers = triggers;

    if (fromMs !== undefined) {
      this.pauseOffsetMs = Math.max(0, fromMs);
    }

    this.isPlaying = true;
    this.startTimeContext = ctx.currentTime;
    this.scheduledTriggerIds.clear();

    if (this.songBuffer) {
      this.songSource = ctx.createBufferSource();
      this.songSource.buffer = this.songBuffer;
      this.songSource.playbackRate.value = this.playbackRate;
      this.songSource.connect(this.songGainNode!);

      const offsetSec = this.pauseOffsetMs / 1000;
      if (offsetSec < this.songBuffer.duration) {
        this.songSource.start(0, offsetSec);
      }
      this.songSource.onended = () => {
        // Only trigger pause if we actually reached or exceeded duration
        if (this.isPlaying && this.songBuffer && this.getCurrentTimeMs() >= this.songBuffer.duration * 1000 - 50) {
          this.pause();
        }
      };
    }

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
    return this.pauseOffsetMs + elapsedSec * 1000;
  }

  public playSingleSample(lane: Lane, volumeOverride?: number) {
    const ctx = this.ensureContext();
    const buffer = this.getSampleBuffer(lane);
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    const vol = (volumeOverride ?? lane.volume) / 100;
    gain.gain.value = vol;

    source.connect(gain);
    gain.connect(this.hitsoundGainNode!);
    source.start();
  }

  private startScheduler() {
    if (this.scheduleTimer !== null) {
      window.clearInterval(this.scheduleTimer);
    }

    this.scheduleTimer = window.setInterval(() => {
      if (!this.isPlaying || !this.ctx) return;

      const currentMs = this.getCurrentTimeMs();
      const lookaheadEndMs = currentMs + this.lookaheadMs;

      if (this.onTimeUpdate) {
        this.onTimeUpdate(currentMs);
      }

      const lanes = this.currentLanes;
      const triggers = this.currentTriggers;

      const laneMap = new Map<string, Lane>();
      const hasSolo = lanes.some((l) => l.solo);
      for (const l of lanes) {
        laneMap.set(l.id, l);
      }

      for (const tr of triggers) {
        if (tr.time >= currentMs - 20 && tr.time <= lookaheadEndMs) {
          if (!this.scheduledTriggerIds.has(tr.id)) {
            this.scheduledTriggerIds.add(tr.id);

            const lane = laneMap.get(tr.laneId);
            if (!lane) continue;
            if (lane.muted) continue;
            if (hasSolo && !lane.solo) continue;

            const buffer = this.getSampleBuffer(lane);
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;

            const gain = this.ctx.createGain();
            const vol = (tr.volume !== undefined ? tr.volume : lane.volume) / 100;
            gain.gain.value = vol;

            source.connect(gain);
            gain.connect(this.hitsoundGainNode!);

            // AudioContext high-precision scheduling
            const delaySec = Math.max(0, (tr.time - currentMs) / 1000 / this.playbackRate);
            const scheduledCtxTime = this.ctx.currentTime + delaySec;
            source.start(scheduledCtxTime);
          }
        }
      }

      // Garbage collect old scheduled IDs
      if (this.scheduledTriggerIds.size > 2000) {
        for (const tr of triggers) {
          if (tr.time < currentMs - 1000) {
            this.scheduledTriggerIds.delete(tr.id);
          }
        }
      }
    }, 25);
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
