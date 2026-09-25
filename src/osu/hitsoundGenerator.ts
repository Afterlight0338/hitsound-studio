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

    let normalTrigger: { lane: Lane; vol: number } | null = null;
    const additionTriggers: { lane: Lane; vol: number; bit: number; addSet: number; customIndex: number }[] = [];
    const customSampleTriggers: { lane: Lane; vol: number; filename: string }[] = [];

    for (const tr of trList) {
      const lane = laneMap.get(tr.laneId)!;
      const vol = tr.volume !== undefined ? tr.volume : lane.volume;

      const customFile = lane.customSampleName?.trim();
      if (customFile) {
        customSampleTriggers.push({ lane, vol, filename: customFile });
        continue;
      }

      if (lane.addition === 'None') {
        if (!normalTrigger || vol > normalTrigger.vol) {
          normalTrigger = { lane, vol };
        }
      } else {
        const bit = additionToBitmask(lane.addition);
        const addSet = lane.additionSet !== 'Auto'
          ? sampleSetToNumber(lane.additionSet)
          : sampleSetToNumber(lane.sampleSet);
        additionTriggers.push({
          lane,
          vol,
          bit,
          addSet: addSet > 0 ? addSet : 2,
          customIndex: lane.customIndex || 0,
        });
      }
    }

    const baseNormalSet = normalTrigger ? sampleSetToNumber(normalTrigger.lane.sampleSet) : 2;
    const baseNormalIndex = normalTrigger?.lane.customIndex || 0;
    const baseNormalVol = normalTrigger ? normalTrigger.vol : 100;

    const timestampHitObjects: HitObject[] = [];

    if (additionTriggers.length === 0 && customSampleTriggers.length === 0) {
      // HitNormal only
      timestampHitObjects.push({
        x: 256,
        y: 192,
        time: t,
        type: 1,
        hitSound: 0,
        hitSample: {
          normalSet: baseNormalSet,
          additionSet: baseNormalSet,
          index: baseNormalIndex,
          volume: baseNormalVol,
          filename: '',
        },
        rawString: '',
      });
    } else {
      // Group addition triggers by addSet
      const addGroups = new Map<number, { bitmask: number; addSet: number; customIndex: number; maxVol: number }>();
      for (const at of additionTriggers) {
        if (!addGroups.has(at.addSet)) {
          addGroups.set(at.addSet, { bitmask: 0, addSet: at.addSet, customIndex: at.customIndex, maxVol: at.vol });
        }
        const grp = addGroups.get(at.addSet)!;
        grp.bitmask |= at.bit;
        if (at.customIndex > 0 && at.customIndex > grp.customIndex) grp.customIndex = at.customIndex;
        if (at.vol > grp.maxVol) grp.maxVol = at.vol;
      }

      let isFirst = true;
      for (const grp of addGroups.values()) {
        timestampHitObjects.push({
          x: 256,
          y: 192,
          time: t,
          type: 1,
          hitSound: grp.bitmask,
          hitSample: {
            normalSet: isFirst && normalTrigger ? baseNormalSet : (isFirst ? grp.addSet : 0),
            additionSet: grp.addSet,
            index: grp.customIndex || (isFirst ? baseNormalIndex : 0),
            volume: isFirst && normalTrigger ? Math.max(grp.maxVol, baseNormalVol) : grp.maxVol,
            filename: '',
          },
          rawString: '',
        });
        isFirst = false;
      }

      // If there was a HitNormal lane, but no addition triggers (only custom sample triggers):
      if (addGroups.size === 0 && normalTrigger) {
        timestampHitObjects.push({
          x: 256,
          y: 192,
          time: t,
          type: 1,
          hitSound: 0,
          hitSample: {
            normalSet: baseNormalSet,
            additionSet: baseNormalSet,
            index: baseNormalIndex,
            volume: baseNormalVol,
            filename: '',
          },
          rawString: '',
        });
      }

      // Custom sample triggers
      for (const ct of customSampleTriggers) {
        timestampHitObjects.push({
          x: 256,
          y: 192,
          time: t,
          type: 1,
          hitSound: additionToBitmask(ct.lane.addition),
          hitSample: {
            normalSet: 0,
            additionSet: 0,
            index: 0,
            volume: ct.vol,
            filename: ct.filename,
          },
          rawString: '',
        });
      }
    }

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
