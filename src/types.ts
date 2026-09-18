// Core types for hitsound-studio

export type SampleSetType = 'Normal' | 'Soft' | 'Drum';
export type AdditionType = 'None' | 'Whistle' | 'Finish' | 'Clap';

export interface Lane {
  id: string;
  name: string;
  sampleSet: SampleSetType;
  addition: AdditionType;
  additionSet: SampleSetType | 'Auto';
  customIndex: number; // 0 for default
  volume: number; // 0 - 100
  color: string;
  muted: boolean;
  solo: boolean;
  customSampleName?: string; // e.g. "soft-hitclap.wav"
  audioBuffer?: AudioBuffer;
}

export interface Trigger {
  id: string;
  laneId: string;
  time: number; // ms timestamp
  volume?: number; // optional trigger override
}

export interface TimingPoint {
  time: number; // ms
  beatLength: number; // positive = ms per beat (uninherited / red), negative = SV percentage (-100 = 1.0x)
  meter: number; // beats per measure (e.g. 4)
  sampleSet: number; // 0=default, 1=normal, 2=soft, 3=drum
  sampleIndex: number; // 0=default, 1..N
  volume: number; // 0 - 100
  uninherited: boolean; // true = red line (BPM/offset), false = green line (SV/volume)
  effects: number; // 1 = kiai
}

export interface HitSample {
  normalSet: number; // 0=auto, 1=normal, 2=soft, 3=drum
  additionSet: number; // 0=auto, 1=normal, 2=soft, 3=drum
  index: number; // custom index
  volume: number; // 0-100
  filename: string;
}

export interface HitObject {
  x: number;
  y: number;
  time: number;
  type: number; // 1=circle, 2=slider, 8=spinner, etc.
  hitSound: number; // bitmask: 0=normal, 2=whistle, 4=finish, 8=clap
  endTime?: number;
  // Slider properties
  curveType?: string;
  curvePoints?: { x: number; y: number }[];
  slides?: number;
  length?: number;
  edgeSounds?: number[];
  edgeSets?: string[];
  // Raw extras & hitSample
  hitSample?: HitSample;
  rawString: string;
}

export interface OsuBeatmap {
  version: number;
  general: Record<string, string>;
  editor: Record<string, string>;
  metadata: Record<string, string>;
  difficulty: Record<string, string>;
  events: string[];
  timingPoints: TimingPoint[];
  colours: Record<string, string>;
  hitObjects: HitObject[];
  rawText: string;
  fileName: string;
}

export interface CopierOptions {
  snapToleranceMs: number; // e.g. 5ms
  copyAdditions: boolean;
  copySampleSets: boolean;
  copyVolumes: boolean;
  copyCustomIndices: boolean;
  copyToSliderHeads: boolean;
  copyToSliderRepeats: boolean;
  copyToSliderTails: boolean;
  copyToSpinners: boolean;
  cleanExistingAdditions: boolean;
}

export interface ProjectState {
  beatmapSetId?: number;
  title: string;
  artist: string;
  creator: string;
  audioFilename: string;
  audioBuffer?: AudioBuffer;
  waveformPeaks?: Float32Array;
  lanes: Lane[];
  triggers: Trigger[];
  timingPoints: TimingPoint[];
  referenceBeatmap?: OsuBeatmap;
  allBeatmaps: OsuBeatmap[];
  customSamples: Map<string, AudioBuffer>;
  rawZipFiles?: Map<string, Uint8Array>;
  activeSnapDivisor: number; // 1, 2, 4, 3, 6, 8, 12, 16
  currentTimeMs: number;
  isPlaying: boolean;
  playbackRate: number;
  songVolume: number;
  hitsoundVolume: number;
}
