import { formatHitSample } from './parser';
import type { HitObject, OsuBeatmap, TimingPoint } from '../types';

export function serializeTimingPoint(tp: TimingPoint): string {
  // Format: time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
  return `${tp.time},${tp.beatLength},${tp.meter},${tp.sampleSet},${tp.sampleIndex},${tp.volume},${tp.uninherited ? 1 : 0},${tp.effects}`;
}

export function serializeHitObject(ho: HitObject): string {
  const isCircle = (ho.type & 1) !== 0;
  const isSlider = (ho.type & 2) !== 0;
  const isSpinner = (ho.type & 8) !== 0;

  const sampleStr = ho.hitSample ? formatHitSample(ho.hitSample) : '0:0:0:0:';

  if (isCircle) {
    return `${ho.x},${ho.y},${ho.time},${ho.type},${ho.hitSound},${sampleStr}`;
  }

  if (isSlider) {
    const curvePointsStr = (ho.curvePoints || []).map((p: { x: number; y: number }) => `${p.x}:${p.y}`).join('|');
    const curveStr = ho.curveType ? `${ho.curveType}|${curvePointsStr}` : `L|${curvePointsStr}`;
    const slides = ho.slides ?? 1;
    const length = ho.length ?? 100;
    const edgeSoundsStr = ho.edgeSounds ? ho.edgeSounds.join('|') : Array(slides + 1).fill(0).join('|');
    const edgeSetsStr = ho.edgeSets ? ho.edgeSets.join('|') : Array(slides + 1).fill('0:0').join('|');

    return `${ho.x},${ho.y},${ho.time},${ho.type},${ho.hitSound},${curveStr},${slides},${length},${edgeSoundsStr},${edgeSetsStr},${sampleStr}`;
  }

  if (isSpinner) {
    const end = ho.endTime ?? ho.time + 1000;
    return `${ho.x},${ho.y},${ho.time},${ho.type},${ho.hitSound},${end},${sampleStr}`;
  }

  return ho.rawString;
}

export function serializeOsu(beatmap: OsuBeatmap): string {
  const lines: string[] = [];

  lines.push(`osu file format v${beatmap.version || 14}`);
  lines.push('');

  lines.push('[General]');
  for (const [k, v] of Object.entries(beatmap.general)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('');

  lines.push('[Editor]');
  for (const [k, v] of Object.entries(beatmap.editor)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('');

  lines.push('[Metadata]');
  for (const [k, v] of Object.entries(beatmap.metadata)) {
    lines.push(`${k}:${v}`);
  }
  lines.push('');

  lines.push('[Difficulty]');
  for (const [k, v] of Object.entries(beatmap.difficulty)) {
    lines.push(`${k}:${v}`);
  }
  lines.push('');

  lines.push('[Events]');
  for (const evt of beatmap.events) {
    lines.push(evt);
  }
  lines.push('');

  lines.push('[TimingPoints]');
  for (const tp of beatmap.timingPoints) {
    lines.push(serializeTimingPoint(tp));
  }
  lines.push('');

  if (Object.keys(beatmap.colours).length > 0) {
    lines.push('[Colours]');
    for (const [k, v] of Object.entries(beatmap.colours)) {
      lines.push(`${k} : ${v}`);
    }
    lines.push('');
  }

  lines.push('[HitObjects]');
  for (const ho of beatmap.hitObjects) {
    lines.push(serializeHitObject(ho));
  }
  lines.push('');

  return lines.join('\r\n');
}
