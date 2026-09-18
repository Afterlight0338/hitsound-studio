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
  ];
  let colorIdx = 0;

  function getOrCreateLane(
    sampleSet: SampleSetType,
    addition: 'None' | 'Whistle' | 'Finish' | 'Clap',
    customIndex: number,
    volume: number
  ): Lane {
    const key = `${sampleSet}_${addition}_idx${customIndex}`;
    if (!laneMap.has(key)) {
      const additionName = addition === 'None' ? 'HitNormal' : addition;
      const idxLabel = customIndex > 0 ? ` #${customIndex}` : '';
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

  // Helper to determine timing point volume at time t
  function getVolumeAtTime(timeMs: number): number {
    let vol = 100;
    for (const tp of beatmap.timingPoints) {
      if (tp.time <= timeMs) {
        if (tp.volume > 0) vol = tp.volume;
      } else {
        break;
      }
    }
    return vol;
  }

  function processHitsoundAtTime(
    time: number,
    hitSound: number,
    normalSetNum: number,
    additionSetNum: number,
    customIndex: number,
    volOverride: number
  ) {
    const vol = volOverride > 0 ? volOverride : getVolumeAtTime(time);
    const normalSet = numberToSampleSet(normalSetNum || 2);
    const additionSet = numberToSampleSet(additionSetNum || normalSetNum || 2);

    const hasWhistle = (hitSound & 2) !== 0;
    const hasFinish = (hitSound & 4) !== 0;
    const hasClap = (hitSound & 8) !== 0;

    // Normal hit
    if (!hasWhistle && !hasFinish && !hasClap) {
      const lane = getOrCreateLane(normalSet, 'None', customIndex, vol);
      triggers.push({
        id: `tr-${time}-${lane.id}-${triggers.length}`,
        laneId: lane.id,
        time,
        volume: vol,
      });
    }

    // Additions
    if (hasClap) {
      const lane = getOrCreateLane(additionSet, 'Clap', customIndex, vol);
      triggers.push({
        id: `tr-${time}-${lane.id}-${triggers.length}`,
        laneId: lane.id,
        time,
        volume: vol,
      });
    }
    if (hasWhistle) {
      const lane = getOrCreateLane(additionSet, 'Whistle', customIndex, vol);
      triggers.push({
        id: `tr-${time}-${lane.id}-${triggers.length}`,
        laneId: lane.id,
        time,
        volume: vol,
      });
    }
    if (hasFinish) {
      const lane = getOrCreateLane(additionSet, 'Finish', customIndex, vol);
      triggers.push({
        id: `tr-${time}-${lane.id}-${triggers.length}`,
        laneId: lane.id,
        time,
        volume: vol,
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
      // Check slider edges
      const edgeSounds = ho.edgeSounds || [ho.hitSound];
      const edgeSets = ho.edgeSets || [];
      const slides = ho.slides || 1;

      // Approximate edge times
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
