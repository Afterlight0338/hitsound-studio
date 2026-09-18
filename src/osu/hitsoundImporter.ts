import type { Lane, OsuBeatmap, SampleSetType, Trigger } from '../types';
import { calculateSliderEdgeTimes } from './parser';

export interface ImportHitsoundsResult {
  lanes: Lane[];
  triggers: Trigger[];
  importedNoteCount: number;
}

function numberToSampleSet(num: number): SampleSetType {
  switch (num) {
    case 1:
      return 'Normal';
    case 2:
      return 'Soft';
    case 3:
      return 'Drum';
    default:
      return 'Soft';
  }
}

export function importHitsoundsFromBeatmap(
  beatmap: OsuBeatmap,
  availableSampleFiles?: Set<string> | Map<string, unknown>
): ImportHitsoundsResult {
  const laneMap = new Map<string, Lane>();
  const triggers: Trigger[] = [];

  const sampleFileSet = availableSampleFiles
    ? (availableSampleFiles instanceof Set
        ? new Set(Array.from(availableSampleFiles).map((s) => s.toLowerCase()))
        : new Set(Array.from(availableSampleFiles.keys()).map((s) => s.toLowerCase())))
    : null;

  function resolveEffectiveIndex(
    sampleSet: SampleSetType,
    addition: 'None' | 'Whistle' | 'Finish' | 'Clap',
    customIndex: number
  ): number {
    if (!sampleFileSet || customIndex <= 0) return customIndex;

    const setStr = sampleSet.toLowerCase();
    const addStr = addition.toLowerCase();
    const baseName = addition === 'None' ? `${setStr}-hitnormal` : `${setStr}-hit${addStr}`;

    // 1. If index > 1, does the mapset provide this specific numbered sample?
    if (customIndex > 1) {
      if (
        sampleFileSet.has(`${baseName}${customIndex}.wav`) ||
        sampleFileSet.has(`${baseName}${customIndex}.ogg`) ||
        sampleFileSet.has(`${baseName}${customIndex}.mp3`)
      ) {
        return customIndex;
      }
    }

    // 2. Does the mapset provide the base or index 1 custom override?
    if (
      sampleFileSet.has(`${baseName}.wav`) ||
      sampleFileSet.has(`${baseName}.ogg`) ||
      sampleFileSet.has(`${baseName}.mp3`) ||
      sampleFileSet.has(`${baseName}1.wav`) ||
      sampleFileSet.has(`${baseName}1.ogg`) ||
      sampleFileSet.has(`${baseName}1.mp3`)
    ) {
      return 1;
    }

    // 3. Beatmap does not override this sample at all; in osu! it falls back to standard skin default (index 0)
    return 0;
  }

  const laneColors = [
    '#ff4081', '#00e5ff', '#ffc400', '#76ff03', '#e040fb',
    '#ff6e40', '#40c4ff', '#b2ff59', '#ffd740', '#69f0ae',
    '#ff5252', '#7c4dff', '#18ffff', '#b388ff', '#ffab40',
    '#00b0ff', '#f50057', '#00e676', '#ff9100', '#651fff',
  ];
  let colorIdx = 0;

  // Map general sample set fallback
  const mapGeneralSet = beatmap.general.SampleSet?.toLowerCase() || 'soft';
  const defaultSampleSet: SampleSetType =
    mapGeneralSet === 'drum' ? 'Drum' : mapGeneralSet === 'normal' ? 'Normal' : 'Soft';

  // Helper to find the active timing point (both red and green lines affect sampleSet/index/vol)
  function getActiveTimingPoint(timeMs: number) {
    let active = beatmap.timingPoints[0] || null;
    for (const tp of beatmap.timingPoints) {
      if (tp.time <= timeMs) {
        active = tp;
      } else {
        break;
      }
    }
    return active;
  }

  function getOrCreateLane(
    sampleSet: SampleSetType,
    addition: 'None' | 'Whistle' | 'Finish' | 'Clap',
    customIndex: number,
    volume: number
  ): Lane {
    const key = `${sampleSet}_${addition}_idx${customIndex}`;
    if (!laneMap.has(key)) {
      const additionName = addition === 'None' ? 'HitNormal' : addition;
      const idxLabel = customIndex > 1 ? ` #${customIndex}` : customIndex === 1 ? ' #1' : '';
      const name = `${sampleSet} ${additionName}${idxLabel}`;

      const lane: Lane = {
        id: `lane-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        sampleSet,
        addition,
        additionSet: 'Auto',
        customIndex,
        volume: volume > 0 ? volume : 85,
        color: laneColors[colorIdx % laneColors.length],
        muted: false,
        solo: false,
      };
      colorIdx++;
      laneMap.set(key, lane);
    }
    return laneMap.get(key)!;
  }

  function processHitsoundAtTime(
    time: number,
    hitSound: number,
    normalSetNum: number,
    additionSetNum: number,
    customIndexOverride: number,
    volumeOverride: number
  ) {
    const activeTp = getActiveTimingPoint(time);

    // 1. Resolve Timing Point inheritance
    const tpSet = activeTp?.sampleSet ? numberToSampleSet(activeTp.sampleSet) : defaultSampleSet;
    const normalSet = normalSetNum > 0 ? numberToSampleSet(normalSetNum) : tpSet;
    const additionSet = additionSetNum > 0 ? numberToSampleSet(additionSetNum) : normalSet;
    const customIndex = customIndexOverride > 0 ? customIndexOverride : (activeTp?.sampleIndex || 0);
    const volume = volumeOverride > 0 ? volumeOverride : (activeTp?.volume || 100);

    // 2. IN OSU!: Every note ALWAYS triggers HitNormal (the base tap/kick layer)
    const effNormalIdx = resolveEffectiveIndex(normalSet, 'None', customIndex);
    const normalLane = getOrCreateLane(normalSet, 'None', effNormalIdx, volume);
    triggers.push({
      id: `tr-${time}-${normalLane.id}-${triggers.length}`,
      laneId: normalLane.id,
      time,
      volume,
    });

    // 3. Trigger Additions if present
    const hasWhistle = (hitSound & 2) !== 0;
    const hasFinish = (hitSound & 4) !== 0;
    const hasClap = (hitSound & 8) !== 0;

    if (hasClap) {
      const effClapIdx = resolveEffectiveIndex(additionSet, 'Clap', customIndex);
      const clapLane = getOrCreateLane(additionSet, 'Clap', effClapIdx, volume);
      triggers.push({
        id: `tr-${time}-${clapLane.id}-${triggers.length}`,
        laneId: clapLane.id,
        time,
        volume,
      });
    }

    if (hasWhistle) {
      const effWhistleIdx = resolveEffectiveIndex(additionSet, 'Whistle', customIndex);
      const whistleLane = getOrCreateLane(additionSet, 'Whistle', effWhistleIdx, volume);
      triggers.push({
        id: `tr-${time}-${whistleLane.id}-${triggers.length}`,
        laneId: whistleLane.id,
        time,
        volume,
      });
    }

    if (hasFinish) {
      const effFinishIdx = resolveEffectiveIndex(additionSet, 'Finish', customIndex);
      const finishLane = getOrCreateLane(additionSet, 'Finish', effFinishIdx, volume);
      triggers.push({
        id: `tr-${time}-${finishLane.id}-${triggers.length}`,
        laneId: finishLane.id,
        time,
        volume,
      });
    }
  }

  // Iterate over hit objects
  for (const ho of beatmap.hitObjects) {
    const isCircle = (ho.type & 1) !== 0;
    const isSlider = (ho.type & 2) !== 0;

    if (isCircle) {
      const nSet = ho.hitSample?.normalSet || 0;
      const aSet = ho.hitSample?.additionSet || 0;
      const idx = ho.hitSample?.index || 0;
      const vol = ho.hitSample?.volume || 0;
      processHitsoundAtTime(ho.time, ho.hitSound, nSet, aSet, idx, vol);
    } else if (isSlider) {
      const edgeSounds = ho.edgeSounds || [ho.hitSound];
      const edgeSets = ho.edgeSets || [];
      const slides = ho.slides || 1;

      const sliderMult = parseFloat(beatmap.difficulty?.SliderMultiplier || '1.4') || 1.4;
      const edgeTimes =
        ho.edgeTimes && ho.edgeTimes.length >= edgeSounds.length
          ? ho.edgeTimes
          : calculateSliderEdgeTimes(ho, beatmap.timingPoints, sliderMult);

      for (let i = 0; i < edgeSounds.length; i++) {
        const edgeTime =
          edgeTimes[i] !== undefined
            ? edgeTimes[i]
            : Math.round(ho.time + (i * ((edgeTimes[edgeTimes.length - 1] ?? ho.time) - ho.time)) / Math.max(1, slides));
        const edgeHs = edgeSounds[i] || 0;

        let nSet = 0;
        let aSet = 0;
        if (edgeSets[i]) {
          const parts = edgeSets[i].split(':');
          nSet = parseInt(parts[0], 10) || 0;
          aSet = parseInt(parts[1], 10) || 0;
        }
        const idx = ho.hitSample?.index || 0;
        const vol = ho.hitSample?.volume || 0;

        processHitsoundAtTime(edgeTime, edgeHs, nSet, aSet, idx, vol);
      }
    }
  }

  const lanes = Array.from(laneMap.values());
  return {
    lanes,
    triggers,
    importedNoteCount: triggers.length,
  };
}
