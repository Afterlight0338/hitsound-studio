import type { CopierOptions, HitObject, OsuBeatmap, TimingPoint } from '../types';
import { calculateSliderEdgeTimes } from './parser';
import { serializeOsu } from './serializer';

export interface CopyResult {
  fileName: string;
  version: string;
  osuString: string;
  beatmap: OsuBeatmap;
  stats: {
    totalObjects: number;
    matchedObjects: number;
    sliderEdgesMatched: number;
    timingPointsMerged: number;
  };
}

export function copyHitsounds(
  sourceBeatmap: OsuBeatmap,
  targetBeatmaps: OsuBeatmap[],
  options: CopierOptions
): CopyResult[] {
  const sourceObjects = [...sourceBeatmap.hitObjects].sort((a, b) => a.time - b.time);

  // Helper to find all source objects within snap tolerance
  function findMatchingSources(time: number): HitObject[] {
    const matches: HitObject[] = [];
    for (const src of sourceObjects) {
      const diff = Math.abs(src.time - time);
      if (diff <= options.snapToleranceMs) {
        matches.push(src);
      } else if (src.time > time + options.snapToleranceMs) {
        break;
      }
    }
    return matches;
  }

  function combineSourceMatches(matches: HitObject[]) {
    let combinedHs = 0;
    let normalSet = 0;
    let additionSet = 0;
    let customIndex = 0;
    let maxVolume = 0;
    let filename = '';

    for (const m of matches) {
      combinedHs |= m.hitSound;
      if (m.hitSample) {
        if (m.hitSample.normalSet > 0) normalSet = m.hitSample.normalSet;
        if (m.hitSample.additionSet > 0) additionSet = m.hitSample.additionSet;
        if (m.hitSample.index > 0) customIndex = m.hitSample.index;
        if (m.hitSample.volume > maxVolume) maxVolume = m.hitSample.volume;
        if (m.hitSample.filename) filename = m.hitSample.filename;
      }
    }
    return { combinedHs, normalSet, additionSet, customIndex, maxVolume, filename };
  }

  return targetBeatmaps.map((target) => {
    // Clone hit objects
    const newHitObjects: HitObject[] = JSON.parse(JSON.stringify(target.hitObjects));
    let matchedObjects = 0;
    let sliderEdgesMatched = 0;

    const sliderMultiplier = parseFloat(target.difficulty.SliderMultiplier || '1.4') || 1.4;

    function getSliderEdgeTimes(ho: HitObject): number[] {
      return ho.edgeTimes || calculateSliderEdgeTimes(ho, target.timingPoints, sliderMultiplier);
    }

    for (const ho of newHitObjects) {
      const isCircle = (ho.type & 1) !== 0;
      const isSlider = (ho.type & 2) !== 0;
      const isSpinner = (ho.type & 8) !== 0;

      if (isCircle) {
        const matches = findMatchingSources(ho.time);
        if (matches.length > 0) {
          matchedObjects++;
          const info = combineSourceMatches(matches);
          if (options.copyAdditions) {
            ho.hitSound = options.cleanExistingAdditions ? info.combinedHs : (ho.hitSound | info.combinedHs);
          }
          if (!ho.hitSample) {
            ho.hitSample = { normalSet: 0, additionSet: 0, index: 0, volume: 0, filename: '' };
          }
          if (options.copySampleSets) {
            if (info.normalSet > 0) ho.hitSample.normalSet = info.normalSet;
            if (info.additionSet > 0) ho.hitSample.additionSet = info.additionSet;
          }
          if (options.copyCustomIndices && info.customIndex > 0) {
            ho.hitSample.index = info.customIndex;
          }
          if (options.copyVolumes && info.maxVolume > 0) {
            ho.hitSample.volume = info.maxVolume;
          }
          if (info.filename) {
            ho.hitSample.filename = info.filename;
          }
        } else if (options.cleanExistingAdditions) {
          ho.hitSound = 0;
          if (ho.hitSample) {
            ho.hitSample.additionSet = 0;
          }
        }
      } else if (isSlider) {
        const edgeTimes = getSliderEdgeTimes(ho);
        const slides = ho.slides || 1;
        const totalEdges = slides + 1;

        let anyEdgeMatched = false;
        const matchedEdgeInfos: ({ matched: boolean } & ReturnType<typeof combineSourceMatches>)[] = [];

        for (let i = 0; i < edgeTimes.length; i++) {
          const edgeTime = edgeTimes[i];
          const isHead = i === 0;
          const isTail = i === edgeTimes.length - 1;
          const isRepeat = !isHead && !isTail;

          const shouldProcess =
            (isHead && options.copyToSliderHeads) ||
            (isRepeat && options.copyToSliderRepeats) ||
            (isTail && options.copyToSliderTails);

          if (shouldProcess) {
            const matches = findMatchingSources(edgeTime);
            if (matches.length > 0) {
              anyEdgeMatched = true;
              sliderEdgesMatched++;
              matchedEdgeInfos[i] = { matched: true, ...combineSourceMatches(matches) };
              continue;
            }
          }
          matchedEdgeInfos[i] = { matched: false, combinedHs: 0, normalSet: 0, additionSet: 0, customIndex: 0, maxVolume: 0, filename: '' };
        }

        if (anyEdgeMatched || options.cleanExistingAdditions) {
          if (!ho.edgeSounds) {
            ho.edgeSounds = Array(totalEdges).fill(options.cleanExistingAdditions ? 0 : ho.hitSound);
          }
          if (!ho.edgeSets) {
            ho.edgeSets = Array(totalEdges).fill('0:0');
          }

          for (let i = 0; i < edgeTimes.length; i++) {
            const info = matchedEdgeInfos[i];
            if (info && info.matched) {
              if (options.copyAdditions) {
                ho.edgeSounds[i] = options.cleanExistingAdditions ? info.combinedHs : (ho.edgeSounds[i] | info.combinedHs);
              }
              if (options.copySampleSets) {
                const nSet = info.normalSet > 0 ? info.normalSet : 0;
                const aSet = info.additionSet > 0 ? info.additionSet : nSet;
                ho.edgeSets[i] = `${nSet}:${aSet}`;
              }
            } else if (options.cleanExistingAdditions) {
              ho.edgeSounds[i] = 0;
              ho.edgeSets[i] = '0:0';
            }
          }

          matchedObjects++;
          // Base slider hitsound can match head
          if (options.copyToSliderHeads && ho.edgeSounds.length > 0) {
            ho.hitSound = ho.edgeSounds[0];
          }

          // Apply head hitSample info to slider hitSample if matched
          if (matchedEdgeInfos[0]?.matched) {
            if (!ho.hitSample) {
              ho.hitSample = { normalSet: 0, additionSet: 0, index: 0, volume: 0, filename: '' };
            }
            if (options.copySampleSets) {
              if (matchedEdgeInfos[0].normalSet > 0) ho.hitSample.normalSet = matchedEdgeInfos[0].normalSet;
              if (matchedEdgeInfos[0].additionSet > 0) ho.hitSample.additionSet = matchedEdgeInfos[0].additionSet;
            }
            if (options.copyCustomIndices && matchedEdgeInfos[0].customIndex > 0) {
              ho.hitSample.index = matchedEdgeInfos[0].customIndex;
            }
            if (options.copyVolumes && matchedEdgeInfos[0].maxVolume > 0) {
              ho.hitSample.volume = matchedEdgeInfos[0].maxVolume;
            }
            if (matchedEdgeInfos[0].filename) {
              ho.hitSample.filename = matchedEdgeInfos[0].filename;
            }
          }
        }
      } else if (isSpinner && options.copyToSpinners) {
        const endTime = ho.endTime || ho.time;
        const matches = findMatchingSources(endTime);
        if (matches.length > 0) {
          matchedObjects++;
          const info = combineSourceMatches(matches);
          if (options.copyAdditions) {
            ho.hitSound = options.cleanExistingAdditions ? info.combinedHs : (ho.hitSound | info.combinedHs);
          }
          if (!ho.hitSample) {
            ho.hitSample = { normalSet: 0, additionSet: 0, index: 0, volume: 0, filename: '' };
          }
          if (options.copySampleSets) {
            if (info.normalSet > 0) ho.hitSample.normalSet = info.normalSet;
            if (info.additionSet > 0) ho.hitSample.additionSet = info.additionSet;
          }
          if (options.copyCustomIndices && info.customIndex > 0) {
            ho.hitSample.index = info.customIndex;
          }
          if (options.copyVolumes && info.maxVolume > 0) {
            ho.hitSample.volume = info.maxVolume;
          }
          if (info.filename) {
            ho.hitSample.filename = info.filename;
          }
        }
      }
    }

    // Merge Timing Points: preserve target's SVs, but apply source's volumes and sample indices
    const newTimingPoints: TimingPoint[] = [];
    const targetRedLines = target.timingPoints.filter((tp) => tp.uninherited);
    newTimingPoints.push(...targetRedLines);

    // Source green lines with volume/sample index info
    const sourceGreenLines = sourceBeatmap.timingPoints.filter((tp) => !tp.uninherited);
    const targetGreenLines = target.timingPoints.filter((tp) => !tp.uninherited);

    // Helper to get active volume & sample info from source at time t
    function getSourceTimingInfo(t: number): { volume: number; sampleIndex: number; sampleSet: number } {
      let vol = 100;
      let idx = 0;
      let set = 2; // soft
      for (const tp of sourceBeatmap.timingPoints) {
        if (tp.time <= t) {
          if (tp.volume > 0) vol = tp.volume;
          idx = tp.sampleIndex;
          if (tp.sampleSet > 0) set = tp.sampleSet;
        } else {
          break;
        }
      }
      return { volume: vol, sampleIndex: idx, sampleSet: set };
    }

    // Merge target's existing green lines with source's timing info
    const processedTimes = new Set<number>();

    for (const tgl of targetGreenLines) {
      const srcInfo = getSourceTimingInfo(tgl.time);
      newTimingPoints.push({
        ...tgl,
        volume: options.copyVolumes ? srcInfo.volume : tgl.volume,
        sampleIndex: options.copyCustomIndices ? srcInfo.sampleIndex : tgl.sampleIndex,
        sampleSet: options.copySampleSets ? srcInfo.sampleSet : tgl.sampleSet,
      });
      processedTimes.add(tgl.time);
    }

    // For any source green line at a timestamp not in target, insert it without altering SV (-100)
    for (const sgl of sourceGreenLines) {
      if (!processedTimes.has(sgl.time)) {
        newTimingPoints.push({
          time: sgl.time,
          beatLength: -100, // 1.0x SV preserved
          meter: 4,
          sampleSet: sgl.sampleSet,
          sampleIndex: sgl.sampleIndex,
          volume: sgl.volume,
          uninherited: false,
          effects: sgl.effects,
        });
        processedTimes.add(sgl.time);
      }
    }

    // Sort timing points
    newTimingPoints.sort((a, b) => a.time - b.time || (a.uninherited === b.uninherited ? 0 : a.uninherited ? -1 : 1));

    const updatedBeatmap: OsuBeatmap = {
      ...target,
      hitObjects: newHitObjects,
      timingPoints: newTimingPoints,
    };

    const osuString = serializeOsu(updatedBeatmap);
    updatedBeatmap.rawText = osuString;

    return {
      fileName: target.fileName,
      version: target.metadata.Version || 'Unknown',
      osuString,
      beatmap: updatedBeatmap,
      stats: {
        totalObjects: target.hitObjects.length,
        matchedObjects,
        sliderEdgesMatched,
        timingPointsMerged: newTimingPoints.length,
      },
    };
  });
}
