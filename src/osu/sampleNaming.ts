import type { Lane, OsuBeatmap } from '../types';

// osu! only resolves these names through sampleset/addition/index; anything else is a "custom" name.
const STANDARD_HIT_RE = /^(normal|soft|drum)-(hit(normal|whistle|finish|clap)|slider(slide|tick|whistle))\d*(\.(wav|ogg|mp3))?$/i;
const STANDARD_MISC_RE = /^(spinnerbonus|spinnerspin|combobreak|sectionpass|sectionfail|nightcore-(clap|finish|hat|kick)|pause-loop|applause)\d*(\.(wav|ogg|mp3))?$/i;
const AUDIO_EXT_RE = /\.(wav|ogg|mp3)$/i;

export const isStandardSampleName = (name: string) =>
  STANDARD_HIT_RE.test(name.trim()) || STANDARD_MISC_RE.test(name.trim());

/** Lowercased name without audio extension: osu! matches "Kicks 1" to "kicks 1.wav". */
export const sampleStem = (name: string) => name.trim().replace(AUDIO_EXT_RE, '').toLowerCase();

/**
 * Non-standard sample names that must be renamed before export: audio files in the mapset
 * (minus song audio and 44-byte silent dummies) plus custom names used by lanes.
 * Returns one display name per stem, preferring the real archive filename.
 */
export function findNonStandardSamples(
  zipFiles: Map<string, Uint8Array>,
  beatmaps: OsuBeatmap[],
  lanes: Lane[],
  songFile: string
): string[] {
  const songStems = new Set([songFile, ...beatmaps.map((bm) => bm.general.AudioFilename || '')].map(sampleStem));
  const byStem = new Map<string, string>();

  for (const [name, bytes] of zipFiles) {
    if (!AUDIO_EXT_RE.test(name) || bytes.length <= 44 || isStandardSampleName(name)) continue;
    if (songStems.has(sampleStem(name))) continue;
    byStem.set(sampleStem(name), name);
  }
  for (const lane of lanes) {
    const name = lane.customSampleName?.trim();
    if (name && !isStandardSampleName(name) && !byStem.has(sampleStem(name))) byStem.set(sampleStem(name), name);
  }
  return [...byStem.values()];
}

/**
 * Suggests a standard name per file, each with its own index so a filename-referenced sample
 * never collides with index-based lookups already used by the mapset.
 */
export function suggestStandardNames(files: string[], zipFiles: Map<string, Uint8Array>, beatmaps: OsuBeatmap[]): Map<string, string> {
  const used = new Set<number>([0, 1]);
  for (const name of zipFiles.keys()) {
    const m = sampleStem(name).match(/^(normal|soft|drum)-\D+(\d+)$/);
    if (m) used.add(parseInt(m[2], 10));
  }
  for (const bm of beatmaps) {
    for (const tp of bm.timingPoints) used.add(tp.sampleIndex);
    for (const ho of bm.hitObjects) if (ho.hitSample) used.add(ho.hitSample.index);
  }

  const out = new Map<string, string>();
  let idx = 2;
  for (const file of files) {
    while (used.has(idx)) idx++;
    used.add(idx);
    const s = sampleStem(file);
    const set = /kick|snare|drum|tom|hat/.test(s) ? 'drum' : 'soft';
    const add = /clap/.test(s) ? 'clap' : /whistle/.test(s) ? 'whistle' : /finish|crash|cymbal/.test(s) ? 'finish' : 'normal';
    const ext = file.match(AUDIO_EXT_RE)?.[0].toLowerCase() ?? '.wav';
    out.set(file, `${set}-hit${add}${idx}${ext}`);
  }
  return out;
}

/** Returns an error message, or null when `newName` is an acceptable rename target. */
export function validateRename(newName: string, taken: Set<string>): string | null {
  if (!STANDARD_HIT_RE.test(newName.trim())) return 'Use {soft|normal|drum}-hit{normal|whistle|finish|clap}[index].wav';
  if (taken.has(sampleStem(newName))) return 'Name already used';
  return null;
}

/** Rewrites hitobject sample filenames and storyboard Sample events in .osu/.osb text. */
export function renameSamplesInOsuText(text: string, renames: Map<string, string>): string {
  let section = '';
  return text
    .split(/(\r?\n)/)
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('[') && t.endsWith(']')) section = t;
      if (section === '[HitObjects]') {
        const lastComma = line.lastIndexOf(',');
        const sample = line.slice(lastComma + 1).split(':');
        if (lastComma === -1 || sample.length !== 5) return line;
        const next = renames.get(sampleStem(sample[4]));
        if (!next) return line;
        sample[4] = next;
        return line.slice(0, lastComma + 1) + sample.join(':');
      }
      if (/^(Sample|5),/.test(t)) {
        return line.replace(/"([^"]+)"/, (m, file) => {
          const next = renames.get(sampleStem(file));
          return next ? `"${next}"` : m;
        });
      }
      return line;
    })
    .join('');
}
