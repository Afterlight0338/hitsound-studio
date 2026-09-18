import type { CopierOptions, HitObject, OsuBeatmap, TimingPoint } from '../types';
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

  // Helper to find closest source object within snap tolerance
  function findMatchingSource(time: number): HitObject | null {
    let closest: HitObject | null = null;
    let minDiff = Infinity;

    for (const src of sourceObjects) {
      const diff = Math.abs(src.time - time);
      if (diff <= options.snapToleranceMs) {
        if (diff < minDiff) {
          minDiff = diff;
          closest = src;
        }
      } else if (src.time > time + options.snapToleranceMs) {
        // Sorted, can break early
        break;
      }
    }
    return closest;
  }

  return targetBeatmaps.map((target) => {
    // Clone hit objects
    const newHitObjects: HitObject[] = JSON.parse(JSON.stringify(target.hitObjects));
    let matchedObjects = 0;
    let sliderEdgesMatched = 0;

    const sliderMultiplier = parseFloat(target.difficulty.SliderMultiplier || '1.4') || 1.4;

    // Helper to calculate slider duration
    function calculateSliderEdgeTimes(ho: HitObject): number[] {
      const slides = ho.slides || 1;
      const length = ho.length || 0;
      if (length <= 0) return [ho.time];

      // Find active red line
      let activeRedBeatLength = 500; // 120 bpm fallback
      for (const tp of target.timingPoints) {
        if (tp.uninherited && tp.time <= ho.time) {
          activeRedBeatLength = tp.beatLength;
        }
      }

      // Find active green line
      let svMultiplier = 1.0;
      for (const tp of target.timingPoints) {
        if (tp.time <= ho.time) {
          if (!tp.uninherited) {
            svMultiplier = Math.max(0.1, Math.min(10, -100 / tp.beatLength));
          }
        }
      }

      const pixelsPerBeat = sliderMultiplier * 100 * svMultiplier;
      const totalDuration = ((length * slides) / pixelsPerBeat) * activeRedBeatLength;
      const slideDuration = totalDuration / slides;

      const edgeTimes: number[] = [];
      for (let i = 0; i <= slides; i++) {
        edgeTimes.push(Math.round(ho.time + i * slideDuration));
      }
      return edgeTimes;
    }

    for (const ho of newHitObjects) {
      const isCircle = (ho.type & 1) !== 0;
      const isSlider = (ho.type & 2) !== 0;
      const isSpinner = (ho.type & 8) !== 0;

      if (isCircle) {
        const match = findMatchingSource(ho.time);
        if (match) {
          matchedObjects++;
          if (options.copyAdditions) {
            ho.hitSound = match.hitSound;
          }
          if (match.hitSample) {
            if (!ho.hitSample) {
              ho.hitSample = { normalSet: 0, additionSet: 0, index: 0, volume: 0, filename: '' };
            }
            if (options.copySampleSets) {
              ho.hitSample.normalSet = match.hitSample.normalSet;
              ho.hitSample.additionSet = match.hitSample.additionSet;
            }
            if (options.copyCustomIndices) {
              ho.hitSample.index = match.hitSample.index;
            }
            if (options.copyVolumes && match.hitSample.volume > 0) {
              ho.hitSample.volume = match.hitSample.volume;
            }
          }
        } else if (options.cleanExistingAdditions) {
          ho.hitSound = 0;
          if (ho.hitSample) {
            ho.hitSample.additionSet = 0;
          }
        }
      } else if (isSlider) {
        const edgeTimes = calculateSliderEdgeTimes(ho);
        const slides = ho.slides || 1;

        if (!ho.edgeSounds) {
          ho.edgeSounds = Array(slides + 1).fill(0);
        }
        if (!ho.edgeSets) {
          ho.edgeSets = Array(slides + 1).fill('0:0');
        }

        let anyEdgeMatched = false;

        for (let i = 0; i < edgeTimes.length; i++) {
          const edgeTime = edgeTimes[i];
          const isHead = i === 0;
          const isTail = i === edgeTimes.length - 1;
          const isRepeat = !isHead && !isTail;

          const shouldProcess =
            (isHead && options.copyToSliderHeads) ||
            (isRepeat && options.copyToSliderRepeats) ||
            (isTail && options.copyToSliderTails);

          if (!shouldProcess) continue;

          const match = findMatchingSource(edgeTime);
          if (match) {
            anyEdgeMatched = true;
            sliderEdgesMatched++;
            if (options.copyAdditions) {
              ho.edgeSounds[i] = match.hitSound;
            }
            if (match.hitSample && options.copySampleSets) {
              ho.edgeSets[i] = `${match.hitSample.normalSet}:${match.hitSample.additionSet}`;
            }
          } else if (options.cleanExistingAdditions) {
            ho.edgeSounds[i] = 0;
            ho.edgeSets[i] = '0:0';
          }
        }

        if (anyEdgeMatched) {
          matchedObjects++;
          // Base slider hitsound can match head
          if (options.copyToSliderHeads && ho.edgeSounds.length > 0) {
            ho.hitSound = ho.edgeSounds[0];
          }
        }
      } else if (isSpinner && options.copyToSpinners) {
        const endTime = ho.endTime || ho.time;
        const match = findMatchingSource(endTime);
        if (match) {
          matchedObjects++;
          if (options.copyAdditions) {
            ho.hitSound = match.hitSound;
          }
          if (match.hitSample && ho.hitSample) {
            if (options.copySampleSets) {
              ho.hitSample.normalSet = match.hitSample.normalSet;
              ho.hitSample.additionSet = match.hitSample.additionSet;
            }
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
