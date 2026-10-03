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
  lossyMerges: number; // timestamps where stacked lanes could not all fit in one circle
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

  let lossyMerges = 0;
  let lastActiveVolume = 100;
  let lastActiveIndex = 0;
  let lastActiveSampleSet = 2; // default to Soft for osu! hitsounds

  for (const t of timestamps) {
    const trList = timeMap.get(t)!;

    // One circle per timestamp: osu! gives a circle a single normal set, a single addition set,
    // one index, one filename and a combined addition bitmask, so simultaneous lanes merge into it.
    const layers = trList.map((tr) => {
      const lane = laneMap.get(tr.laneId)!;
      return { lane, vol: tr.volume !== undefined ? tr.volume : lane.volume, custom: lane.customSampleName?.trim() || '' };
    });
    const loudest = <T extends { vol: number }>(list: T[]): T | undefined =>
      list.reduce<T | undefined>((a, b) => (!a || b.vol > a.vol ? b : a), undefined);

    const normalLayer = loudest(layers.filter((l) => !l.custom && l.lane.addition === 'None'));
    const additionLayers = layers.filter((l) => !l.custom && l.lane.addition !== 'None');
    const customLayer = loudest(layers.filter((l) => l.custom));

    const additionSetOf = (l: { lane: Lane }) => {
      const n = sampleSetToNumber(l.lane.additionSet !== 'Auto' ? l.lane.additionSet : l.lane.sampleSet);
      return n > 0 ? n : 2;
    };
    const loudestAddition = loudest(additionLayers);
    const additionSet = loudestAddition ? additionSetOf(loudestAddition) : 0;
    const normalSet = customLayer && !normalLayer
      ? 0
      : normalLayer
        ? sampleSetToNumber(normalLayer.lane.sampleSet) || 2
        : additionSet || 2;
    const soundLayers = layers.filter((l) => !l.custom);
    const index = customLayer && !normalLayer && additionLayers.length === 0
      ? 0
      : Math.max(0, ...soundLayers.map((l) => l.lane.customIndex || 0));
    const bitmask = layers.reduce((m, l) => m | additionToBitmask(l.lane.addition), 0);

    // What one circle cannot express: report it instead of silently dropping layers
    const distinct = (xs: number[]) => new Set(xs).size > 1;
    if (
      distinct(additionLayers.map(additionSetOf)) ||
      distinct(soundLayers.map((l) => l.lane.customIndex || 0)) ||
      layers.filter((l) => l.custom).length > 1
    ) {
      lossyMerges++;
    }

    const timestampHitObjects: HitObject[] = [
      {
        x: 256,
        y: 192,
        time: t,
        type: 1,
        hitSound: bitmask,
        hitSample: {
          normalSet,
          additionSet: additionSet || normalSet,
          index,
          volume: Math.max(...layers.map((l) => l.vol)),
          filename: customLayer?.custom || '',
        },
        rawString: '',
      },
    ];

    // Check if we need to emit a green line for volume / custom index
    const primaryHo = timestampHitObjects[0];
    const primarySampleSet = primaryHo?.hitSample?.normalSet || primaryHo?.hitSample?.additionSet || lastActiveSampleSet;
    const primaryIndex = primaryHo?.hitSample?.index || 0;
    const primaryVol = primaryHo?.hitSample?.volume || 100;

    if (primaryVol !== lastActiveVolume || primaryIndex !== lastActiveIndex || primarySampleSet !== lastActiveSampleSet) {
      generatedGreenLines.push({
        time: t,
        beatLength: -100, // 1.0x SV
        meter: 4,
        sampleSet: primarySampleSet,
        sampleIndex: primaryIndex,
        volume: primaryVol,
        uninherited: false,
        effects: 0,
      });
      lastActiveVolume = primaryVol;
      lastActiveIndex = primaryIndex;
      lastActiveSampleSet = primarySampleSet;
    }

    hitObjects.push(...timestampHitObjects);
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
      StackLeniency: '0', // every note sits at (256,192); stacking would scatter them
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
    lossyMerges,
  };
}
