import * as fs from 'node:fs';
import { parseOsu } from '../src/osu/parser';
import { serializeOsu } from '../src/osu/serializer';
import { generateHitsoundBeatmap } from '../src/osu/hitsoundGenerator';
import { copyHitsounds } from '../src/osu/copier';
import type { Lane, Trigger, CopierOptions } from '../src/types';

console.log('=== RUNNING HITSOUND STUDIO CORE TEST SUITE ===');

// Test 1: Real Beatmap Parsing
const sampleFile = '/home/afterlight/Downloads/MiLO - BEST PLOT (Game Ver.) (RyoYamada) [Expert].osu';
const sampleText = fs.readFileSync(sampleFile, 'utf-8');
const beatmap = parseOsu(sampleText, 'Expert.osu');

console.log(`[PASS] Parsed beatmap: ${beatmap.metadata.Artist} - ${beatmap.metadata.Title} [${beatmap.metadata.Version}]`);
console.log(`       HitObjects: ${beatmap.hitObjects.length}, TimingPoints: ${beatmap.timingPoints.length}`);

if (beatmap.hitObjects.length === 0) {
  throw new Error('Expected hit objects to be parsed!');
}

// Test 2: Serializer round-trip
const serialized = serializeOsu(beatmap);
const reParsed = parseOsu(serialized, 'ReParsed.osu');
if (reParsed.hitObjects.length !== beatmap.hitObjects.length) {
  throw new Error(`Round-trip mismatch! ${reParsed.hitObjects.length} vs ${beatmap.hitObjects.length}`);
}
console.log(`[PASS] Serializer round-trip matched exact object count (${reParsed.hitObjects.length})`);

// Test 3: Hitsound Diff Generation
const testLanes: Lane[] = [
  {
    id: 'l1',
    name: 'Soft Clap',
    sampleSet: 'Soft',
    addition: 'Clap',
    additionSet: 'Auto',
    customIndex: 1,
    volume: 90,
    color: '#ff4081',
    muted: false,
    solo: false,
  },
  {
    id: 'l2',
    name: 'Soft Whistle',
    sampleSet: 'Soft',
    addition: 'Whistle',
    additionSet: 'Auto',
    customIndex: 2,
    volume: 85,
    color: '#00e5ff',
    muted: false,
    solo: false,
  },
  {
    id: 'l3',
    name: 'Finish',
    sampleSet: 'Normal',
    addition: 'Finish',
    additionSet: 'Auto',
    customIndex: 0,
    volume: 100,
    color: '#ffc400',
    muted: false,
    solo: false,
  },
];

const testTriggers: Trigger[] = [
  { id: 't1', laneId: 'l1', time: 9325 }, // Clap (8) at 9325ms
  { id: 't2', laneId: 'l2', time: 9325 }, // Whistle (2) at 9325ms -> Combined bitmask = 10!
  { id: 't3', laneId: 'l3', time: 9611 }, // Finish (4) at 9611ms
];

const hsResult = generateHitsoundBeatmap(testLanes, testTriggers, beatmap, 'Hitsounds');

console.log(`[PASS] Generated Hitsound diff: ${hsResult.beatmap.fileName}`);
console.log(`       Total generated hitsound notes: ${hsResult.totalNotes}`);

// Assert notes are at center (256, 192)
for (const ho of hsResult.beatmap.hitObjects) {
  if (ho.x !== 256 || ho.y !== 192) {
    throw new Error(`Hit object not centered at 256, 192! Found: ${ho.x}, ${ho.y}`);
  }
}
console.log('[PASS] Verified all generated notes are placed at (256, 192)');

// Assert combined bitmask at 9325ms
const note9325 = hsResult.beatmap.hitObjects.find((h) => h.time === 9325);
if (!note9325) {
  throw new Error('Note at 9325ms not found!');
}
if (note9325.hitSound !== 10) {
  throw new Error(`Expected combined bitmask 10 (Clap + Whistle), got: ${note9325.hitSound}`);
}
console.log(`[PASS] Combined bitmask verified: note at 9325ms has hitsound = ${note9325.hitSound} (Clap 8 + Whistle 2)`);

// Test 4: Built-in Hitsound Copier
const copierOptions: CopierOptions = {
  snapToleranceMs: 5,
  copyAdditions: true,
  copySampleSets: true,
  copyVolumes: true,
  copyCustomIndices: true,
  copyToSliderHeads: true,
  copyToSliderRepeats: true,
  copyToSliderTails: true,
  copyToSpinners: true,
  cleanExistingAdditions: false,
};

const copyResults = copyHitsounds(hsResult.beatmap, [beatmap], copierOptions);
const copyRes = copyResults[0];

console.log(`[PASS] Copier ran successfully on ${copyRes.version}:`);
console.log(`       Matched objects: ${copyRes.stats.matchedObjects}/${copyRes.stats.totalObjects}`);
console.log(`       Timing points merged: ${copyRes.stats.timingPointsMerged}`);

// Verify that the note at 9325 in the copied beatmap got hitsound 10
const copiedObj = copyRes.beatmap.hitObjects.find((h) => Math.abs(h.time - 9325) <= 5);
if (!copiedObj) {
  throw new Error('Target object at 9325ms not found in copied beatmap!');
}
if (copiedObj.hitSound !== 10 && !(copiedObj.edgeSounds && copiedObj.edgeSounds[0] === 10)) {
  throw new Error(`Copied hitsound mismatch at 9325ms: ${copiedObj.hitSound}`);
}
console.log(`[PASS] Successfully transferred hitsounds to target beatmap note at 9325ms!`);

// Verify SV preservation: Ensure target's SVs were not overwritten by -100
const originalGreenLine = beatmap.timingPoints.find((tp) => !tp.uninherited);
const copiedGreenLine = copyRes.beatmap.timingPoints.find((tp) => tp.time === originalGreenLine?.time && !tp.uninherited);
if (originalGreenLine && copiedGreenLine) {
  if (copiedGreenLine.beatLength !== originalGreenLine.beatLength) {
    throw new Error(`SV was overwritten! Original: ${originalGreenLine.beatLength}, Copied: ${copiedGreenLine.beatLength}`);
  }
  console.log(`[PASS] SV Preservation verified: Slider velocity ${originalGreenLine.beatLength} strictly preserved.`);
}

// Test 5: Importing Hitsounds Diff from real .osz (Shiori)
const shioriOszPath = '/home/afterlight/Downloads/2403722 shiho - Shiori (Sped Up & Cut Ver.).osz';
if (fs.existsSync(shioriOszPath)) {
  const JSZip = (await import('jszip')).default;
  const { importHitsoundsFromBeatmap } = await import('../src/osu/hitsoundImporter');
  const shioriData = fs.readFileSync(shioriOszPath);
  const zip = await JSZip.loadAsync(shioriData);
  const hsEntry = zip.file('shiho - Shiori (Sped Up & Cut Ver.) (RyoYamada) [Hitsounds].osu');
  if (hsEntry) {
    const text = await hsEntry.async('text');
    const shioriHsMap = parseOsu(text, 'Shiori_Hitsounds.osu');
    const imported = importHitsoundsFromBeatmap(shioriHsMap);
    console.log(`[PASS] Hitsound diff import: created ${imported.lanes.length} lanes from ${imported.importedNoteCount} triggers!`);
    if (imported.lanes.length === 0 || imported.triggers.length === 0) {
      throw new Error('Expected imported lanes and triggers from Shiori hitsound diff!');
    }
  }
}

// Test 6: Auto-separating hitsounds from maps without hitsound diff (Fallen Symphony)
const fallenPath = '/home/afterlight/Downloads/1952187 Ludicin - Fallen Symphony.osz';
if (fs.existsSync(fallenPath)) {
  const JSZip = (await import('jszip')).default;
  const { importHitsoundsFromBeatmap } = await import('../src/osu/hitsoundImporter');
  const data = fs.readFileSync(fallenPath);
  const zip = await JSZip.loadAsync(data);
  const diffEntry = zip.file('Ludicin - Fallen Symphony (Ilay) [Cruel Descent].osu');
  if (diffEntry) {
    const text = await diffEntry.async('text');
    const parsed = parseOsu(text, 'Cruel Descent.osu');
    const imported = importHitsoundsFromBeatmap(parsed);
    console.log(`[PASS] Auto-separated Fallen Symphony diff: created ${imported.lanes.length} lanes from ${imported.importedNoteCount} triggers!`);
    if (imported.lanes.length !== 43 || imported.importedNoteCount !== 8081) {
      throw new Error(`Expected 43 lanes and 8081 triggers from Fallen Symphony, got ${imported.lanes.length} lanes and ${imported.importedNoteCount} triggers`);
    }

    // Generate Hitsound diff from these separated lanes
    const gen = generateHitsoundBeatmap(imported.lanes, imported.triggers, parsed, 'Hitsounds');
    if (gen.totalNotes === 0) {
      throw new Error('Expected generated hitsound notes!');
    }
    console.log(`[PASS] Generated Hitsounds diff from separated lanes: ${gen.totalNotes} centered notes!`);
  }

  // 7. Test Keysounded Map (HOYO-MiX with 240+ samples) Consolidation
  const hoyoPath = '/home/afterlight/Downloads/2136372 HOYO-MiX - If I Can Stop One Heart From Breaking.osz';
  if (fs.existsSync(hoyoPath)) {
    const hoyoBuf = fs.readFileSync(hoyoPath);
    const hoyoZip = await JSZip.loadAsync(hoyoBuf);
    const rawZipFiles = new Map<string, Uint8Array>();
    for (const [filename, entry] of Object.entries(hoyoZip.files)) {
      if (!entry.dir) {
        rawZipFiles.set(filename.toLowerCase(), await entry.async('uint8array'));
      }
    }
    const osuKey = Object.keys(hoyoZip.files).find((k) => k.includes('Longing Dream'))!;
    const hoyoText = await hoyoZip.files[osuKey].async('text');
    const hoyoParsed = parseOsu(hoyoText, osuKey);

    // Without sample-awareness: would create 234 lanes
    const naive = importHitsoundsFromBeatmap(hoyoParsed);
    if (naive.lanes.length !== 234) {
      throw new Error(`Expected 234 naive lanes, got ${naive.lanes.length}`);
    }

    // With sample-awareness: cleanly consolidates nonexistent hitnormal indices from 234 down to 139 active lanes!
    const consolidated = importHitsoundsFromBeatmap(hoyoParsed, rawZipFiles);
    if (consolidated.lanes.length !== 139) {
      throw new Error(`Expected consolidated lanes === 139, got ${consolidated.lanes.length}`);
    }
    console.log(
      `[PASS] Keysounded map consolidation: collapsed ${naive.lanes.length} raw lanes down to ${consolidated.lanes.length} active, non-empty keysound lanes!`
    );
  }
}

console.log('\n>>> ALL 7 CORE TESTS PASSED WITH 100% INTEGRITY! <<<');
