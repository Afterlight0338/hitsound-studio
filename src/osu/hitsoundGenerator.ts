import type { HitObject, Lane, OsuBeatmap, TimingPoint, Trigger } from '../types';
import { serializeOsu } from './serializer';

export function sampleSetToNumber(s: string): number {
  switch (s.toLowerCase()) {
    case 'normal':
      return 1;
    case 'soft':
      return 2;
    case 'drum':
      return 3;
    default:
      return 0; // default / auto
  }
}

export function additionToBitmask(a: string): number {
  switch (a.toLowerCase()) {
    case 'whistle':
      return 2;
    case 'finish':
      return 4;
    case 'clap':
      return 8;
    default:
      return 0;
  }
}

export interface GeneratorResult {
  beatmap: OsuBeatmap;
  osuString: string;
  totalNotes: number;
}

export function generateHitsoundBeatmap(
  lanes: Lane[],
  triggers: Trigger[],
  baseBeatmap: OsuBeatmap,
  diffName: string = 'Hitsounds'
): GeneratorResult {
  const laneMap = new Map<string, Lane>();
  for (const lane of lanes) {
    laneMap.set(lane.id, lane);
  }

  // Group triggers by rounded timestamp (ms)
  const timeMap = new Map<number, Trigger[]>();
  for (const tr of triggers) {
    const lane = laneMap.get(tr.laneId);
    if (!lane || lane.muted) continue;

    const t = Math.round(tr.time);
    if (!timeMap.has(t)) {
      timeMap.set(t, []);
    }
    timeMap.get(t)!.push(tr);
  }

  // Sort timestamps
  const timestamps = Array.from(timeMap.keys()).sort((a, b) => a - b);

  const hitObjects: HitObject[] = [];
  const generatedGreenLines: TimingPoint[] = [];

  let lastActiveVolume = 100;
  let lastActiveIndex = 0;
  let lastActiveSampleSet = 2; // default to Soft for osu! hitsounds

  for (const t of timestamps) {
    const trList = timeMap.get(t)!;

    let combinedHitSound = 0;
    let normalSet = 0;
    let additionSet = 0;
    let customIndex = 0;
    let maxVolume = 0;

    for (const tr of trList) {
      const lane = laneMap.get(tr.laneId)!;
      const bit = additionToBitmask(lane.addition);
      combinedHitSound |= bit;

      const laneNormalSet = sampleSetToNumber(lane.sampleSet);
      if (laneNormalSet > 0) {
        normalSet = laneNormalSet;
      }

      if (lane.additionSet !== 'Auto') {
        const laneAddSet = sampleSetToNumber(lane.additionSet);
        if (laneAddSet > 0) {
          additionSet = laneAddSet;
        }
      }

      if (lane.customIndex > 0) {
        customIndex = lane.customIndex;
      }

      const vol = tr.volume !== undefined ? tr.volume : lane.volume;
      if (vol > maxVolume) {
        maxVolume = vol;
      }
    }

    if (maxVolume === 0) maxVolume = 100;
    if (normalSet === 0) normalSet = 2; // default to Soft
    if (additionSet === 0) additionSet = normalSet;

    // Check if we need to emit a green line for volume / custom index
    if (maxVolume !== lastActiveVolume || customIndex !== lastActiveIndex || normalSet !== lastActiveSampleSet) {
      generatedGreenLines.push({
        time: t,
        beatLength: -100, // 1.0x SV
        meter: 4,
        sampleSet: normalSet,
        sampleIndex: customIndex,
        volume: maxVolume,
        uninherited: false,
        effects: 0,
      });
      lastActiveVolume = maxVolume;
      lastActiveIndex = customIndex;
      lastActiveSampleSet = normalSet;
    }

    const ho: HitObject = {
      x: 256,
      y: 192,
      time: t,
      type: 1, // Circle
      hitSound: combinedHitSound,
      hitSample: {
        normalSet,
        additionSet,
        index: customIndex,
        volume: maxVolume,
        filename: '',
      },
      rawString: '',
    };

    hitObjects.push(ho);
  }

  // Base red lines (BPM/offset)
  const redLines = baseBeatmap.timingPoints.filter((tp) => tp.uninherited);
  if (redLines.length === 0) {
    // Fallback if no timing points exist: 120 BPM at 0ms
    redLines.push({
      time: 0,
      beatLength: 500, // 120 BPM
      meter: 4,
      sampleSet: 2,
      sampleIndex: 0,
      volume: 100,
      uninherited: true,
      effects: 0,
    });
  }

  // Combine red lines and generated green lines, then sort
  const combinedTimingPoints = [...redLines, ...generatedGreenLines];
  combinedTimingPoints.sort((a, b) => a.time - b.time || (a.uninherited === b.uninherited ? 0 : a.uninherited ? -1 : 1));

  // Build the new beatmap object
  const hitsoundBeatmap: OsuBeatmap = {
    version: baseBeatmap.version || 14,
    general: {
      ...baseBeatmap.general,
      AudioFilename: baseBeatmap.general.AudioFilename || 'audio.mp3',
      SampleSet: baseBeatmap.general.SampleSet || 'Soft',
      Mode: '0', // Standard
    },
    editor: {
      ...baseBeatmap.editor,
      BeatDivisor: '4',
      GridSize: '16',
      TimelineZoom: '2',
    },
    metadata: {
      ...baseBeatmap.metadata,
      Version: diffName,
    },
    difficulty: {
      HPDrainRate: '5',
      CircleSize: '4',
      OverallDifficulty: '5',
      ApproachRate: '9',
      SliderMultiplier: baseBeatmap.difficulty.SliderMultiplier || '1.4',
      SliderTickRate: '1',
    },
    events: [...(baseBeatmap.events || [])],
    timingPoints: combinedTimingPoints,
    colours: { ...baseBeatmap.colours },
    hitObjects,
    rawText: '',
    fileName: `${baseBeatmap.metadata.Artist || 'Artist'} - ${baseBeatmap.metadata.Title || 'Title'} (${baseBeatmap.metadata.Creator || 'Mapper'}) [${diffName}].osu`,
  };

  const osuString = serializeOsu(hitsoundBeatmap);
  hitsoundBeatmap.rawText = osuString;

  return {
    beatmap: hitsoundBeatmap,
    osuString,
    totalNotes: hitObjects.length,
  };
}
