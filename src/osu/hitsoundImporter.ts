import type { Lane, OsuBeatmap, SampleSetType, Trigger } from '../types';

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

export function importHitsoundsFromBeatmap(beatmap: OsuBeatmap): ImportHitsoundsResult {
  const laneMap = new Map<string, Lane>();
  const triggers: Trigger[] = [];

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
    const normalLane = getOrCreateLane(normalSet, 'None', customIndex, volume);
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
      const clapLane = getOrCreateLane(additionSet, 'Clap', customIndex, volume);
      triggers.push({
        id: `tr-${time}-${clapLane.id}-${triggers.length}`,
        laneId: clapLane.id,
        time,
        volume,
      });
    }

    if (hasWhistle) {
      const whistleLane = getOrCreateLane(additionSet, 'Whistle', customIndex, volume);
      triggers.push({
        id: `tr-${time}-${whistleLane.id}-${triggers.length}`,
        laneId: whistleLane.id,
        time,
        volume,
      });
    }

    if (hasFinish) {
      const finishLane = getOrCreateLane(additionSet, 'Finish', customIndex, volume);
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

      const duration = (ho.endTime || ho.time + 300) - ho.time;
      const slideDur = duration / Math.max(1, slides);

      for (let i = 0; i < edgeSounds.length; i++) {
        const edgeTime = Math.round(ho.time + i * slideDur);
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
