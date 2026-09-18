import type { HitObject, HitSample, OsuBeatmap, TimingPoint } from '../types';

export function parseOsu(content: string, fileName: string = 'beatmap.osu'): OsuBeatmap {
  const lines = content.split(/\r?\n/);
  let version = 14;

  const general: Record<string, string> = {};
  const editor: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  const difficulty: Record<string, string> = {};
  const events: string[] = [];
  const colours: Record<string, string> = {};
  const timingPoints: TimingPoint[] = [];
  const hitObjects: HitObject[] = [];

  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith('//')) {
      if (currentSection === 'Events' && line.startsWith('//')) {
        events.push(line);
      }
      continue;
    }

    if (line.startsWith('osu file format v')) {
      version = parseInt(line.replace('osu file format v', '').trim(), 10) || 14;
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1);
      continue;
    }

    switch (currentSection) {
      case 'General': {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          general[key] = val;
        }
        break;
      }
      case 'Editor': {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          editor[key] = val;
        }
        break;
      }
      case 'Metadata': {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          metadata[key] = val;
        }
        break;
      }
      case 'Difficulty': {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          difficulty[key] = val;
        }
        break;
      }
      case 'Events': {
        events.push(line);
        break;
      }
      case 'TimingPoints': {
        const parts = line.split(',');
        if (parts.length >= 2) {
          const time = Math.round(parseFloat(parts[0]));
          const beatLength = parseFloat(parts[1]);
          const meter = parts.length > 2 ? parseInt(parts[2], 10) || 4 : 4;
          const sampleSet = parts.length > 3 ? parseInt(parts[3], 10) || 0 : 0;
          const sampleIndex = parts.length > 4 ? parseInt(parts[4], 10) || 0 : 0;
          const volume = parts.length > 5 ? Math.max(0, Math.min(100, parseInt(parts[5], 10) || 0)) : 100;
          const uninherited = parts.length > 6 ? parts[6].trim() === '1' : beatLength > 0;
          const effects = parts.length > 7 ? parseInt(parts[7], 10) || 0 : 0;

          timingPoints.push({
            time,
            beatLength,
            meter,
            sampleSet,
            sampleIndex,
            volume,
            uninherited,
            effects,
          });
        }
        break;
      }
      case 'Colours': {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          colours[key] = val;
        }
        break;
      }
      case 'HitObjects': {
        const ho = parseHitObject(line);
        if (ho) {
          hitObjects.push(ho);
        }
        break;
      }
    }
  }

  // Ensure timing points are sorted chronologically
  timingPoints.sort((a, b) => a.time - b.time || (a.uninherited === b.uninherited ? 0 : a.uninherited ? -1 : 1));

  return {
    version,
    general,
    editor,
    metadata,
    difficulty,
    events,
    timingPoints,
    colours,
    hitObjects,
    rawText: content,
    fileName,
  };
}

export function parseHitSample(sampleStr: string): HitSample {
  const parts = sampleStr.split(':');
  return {
    normalSet: parts[0] ? parseInt(parts[0], 10) || 0 : 0,
    additionSet: parts[1] ? parseInt(parts[1], 10) || 0 : 0,
    index: parts[2] ? parseInt(parts[2], 10) || 0 : 0,
    volume: parts[3] ? parseInt(parts[3], 10) || 0 : 0,
    filename: parts[4] || '',
  };
}

export function formatHitSample(sample: HitSample): string {
  return `${sample.normalSet}:${sample.additionSet}:${sample.index}:${sample.volume}:${sample.filename}`;
}

export function parseHitObject(line: string): HitObject | null {
  const parts = line.split(',');
  if (parts.length < 5) return null;

  const x = parseInt(parts[0], 10) || 0;
  const y = parseInt(parts[1], 10) || 0;
  const time = Math.round(parseFloat(parts[2]));
  const type = parseInt(parts[3], 10) || 0;
  const hitSound = parseInt(parts[4], 10) || 0;

  const isCircle = (type & 1) !== 0;
  const isSlider = (type & 2) !== 0;
  const isSpinner = (type & 8) !== 0;

  let endTime: number | undefined = undefined;
  let curveType: string | undefined = undefined;
  let curvePoints: { x: number; y: number }[] | undefined = undefined;
  let slides: number | undefined = undefined;
  let length: number | undefined = undefined;
  let edgeSounds: number[] | undefined = undefined;
  let edgeSets: string[] | undefined = undefined;
  let hitSample: HitSample | undefined = undefined;

  if (isCircle) {
    if (parts.length > 5) {
      hitSample = parseHitSample(parts[5]);
    }
  } else if (isSlider) {
    if (parts.length > 5) {
      const curveData = parts[5].split('|');
      curveType = curveData[0];
      curvePoints = [];
      for (let i = 1; i < curveData.length; i++) {
        const coord = curveData[i].split(':');
        if (coord.length === 2) {
          curvePoints.push({ x: parseInt(coord[0], 10), y: parseInt(coord[1], 10) });
        }
      }
    }
    slides = parts.length > 6 ? parseInt(parts[6], 10) || 1 : 1;
    length = parts.length > 7 ? parseFloat(parts[7]) || 0 : 0;
    if (parts.length > 8 && parts[8]) {
      edgeSounds = parts[8].split('|').map((s) => parseInt(s, 10) || 0);
    }
    if (parts.length > 9 && parts[9]) {
      edgeSets = parts[9].split('|');
    }
    if (parts.length > 10 && parts[10]) {
      hitSample = parseHitSample(parts[10]);
    }
  } else if (isSpinner) {
    if (parts.length > 5) {
      endTime = Math.round(parseFloat(parts[5]));
    }
    if (parts.length > 6) {
      hitSample = parseHitSample(parts[6]);
    }
  }

  return {
    x,
    y,
    time,
    type,
    hitSound,
    endTime,
    curveType,
    curvePoints,
    slides,
    length,
    edgeSounds,
    edgeSets,
    hitSample,
    rawString: line,
  };
}
