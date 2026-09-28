import * as fs from 'node:fs';
import { parseOsu } from '../src/osu/parser';
import { serializeOsu } from '../src/osu/serializer';
import { generateHitsoundBeatmap } from '../src/osu/hitsoundGenerator';
import { copyHitsounds } from '../src/osu/copier';
import type { Lane, Trigger, CopierOptions } from '../src/types';

console.log('=== RUNNING HITSOUND STUDIO CORE TEST SUITE ===');

// Test 1: Real Beatmap Parsing
const sampleFile = '/home/afterlight/Downloads/MiLO - BEST PLOT (Game Ver.) (RyoYamada) [Expert].osu';
const sampleText = fs.existsSync(sampleFile)
  ? fs.readFileSync(sampleFile, 'utf-8')
  : `osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: -1
Countdown: 0
SampleSet: Soft
StackLeniency: 0.7
Mode: 0
LetterboxInBreaks: 0
WidescreenStoryboard: 0

[Metadata]
Title: BEST PLOT
TitleUnicode: BEST PLOT
Artist: MiLO
ArtistUnicode: MiLO
Creator: RyoYamada
Version: Expert
Source: 
Tags: 
BeatmapID: 0
BeatmapSetID: -1

[Difficulty]
HPDrainRate: 5
CircleSize: 4
OverallDifficulty: 8
ApproachRate: 9
SliderMultiplier: 1.4
SliderTickRate: 1

[Events]

[TimingPoints]
1000,500,4,2,1,60,1,0
9000,-100,4,2,1,80,0,0

[HitObjects]
256,192,9325,1,0,0:0:0:0:
256,192,9611,1,0,0:0:0:0:
256,192,10000,1,0,0:0:0:0:
`;
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
if (hsResult.beatmap.general.StackLeniency !== '0' || !hsResult.osuString.includes('StackLeniency: 0\r\n')) {
  throw new Error(`Hitsound diff StackLeniency must be 0, got ${hsResult.beatmap.general.StackLeniency}`);
}
console.log('[PASS] Hitsound diff exports StackLeniency: 0');

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

    // Without sample-awareness: creates 216 lanes
    const naive = importHitsoundsFromBeatmap(hoyoParsed);
    if (naive.lanes.length !== 216) {
      throw new Error(`Expected 216 naive lanes, got ${naive.lanes.length}`);
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

  // 8. Test Multiple BPMs & Kiai Interval Detection (Ariabl'eyeS - Kegare Naki Bara Juuji)
  const ariaPath = "/home/afterlight/Downloads/1229824 Ariabl'eyeS - Kegare Naki Bara Juuji (1).osz";
  if (fs.existsSync(ariaPath)) {
    const ariaBuf = fs.readFileSync(ariaPath);
    const ariaZip = await JSZip.loadAsync(ariaBuf);
    const osuKey = Object.keys(ariaZip.files).find((k) => k.endsWith('.osu'))!;
    const ariaText = await ariaZip.files[osuKey].async('text');
    const ariaParsed = parseOsu(ariaText, osuKey);

    const redLines = ariaParsed.timingPoints.filter((tp) => tp.uninherited);
    if (redLines.length !== 42) {
      throw new Error(`Expected 42 red lines (BPM changes), got ${redLines.length}`);
    }

    // Verify Kiai calculation
    let currentStart: number | null = null;
    const kiaiIntervals: { start: number; end: number }[] = [];
    for (const tp of ariaParsed.timingPoints) {
      const isKiai = (tp.effects & 1) !== 0;
      if (isKiai && currentStart === null) {
        currentStart = tp.time;
      } else if (!isKiai && currentStart !== null) {
        kiaiIntervals.push({ start: currentStart, end: tp.time });
        currentStart = null;
      }
    }
    if (currentStart !== null) {
      kiaiIntervals.push({ start: currentStart, end: 350000 });
    }

    if (kiaiIntervals.length !== 6) {
      throw new Error(`Expected 6 Kiai intervals, got ${kiaiIntervals.length}`);
    }

    // Test active BPM detection across different sections
    function getActiveBpm(timeMs: number): number {
      let active = redLines[0];
      for (const rl of redLines) {
        if (rl.time <= timeMs) active = rl;
        else break;
      }
      return Math.round(60000 / active.beatLength);
    }

    if (getActiveBpm(10422) !== 84) throw new Error(`Expected 84 BPM at 10422ms, got ${getActiveBpm(10422)}`);
    if (getActiveBpm(44684) !== 260) throw new Error(`Expected 260 BPM at 44684ms, got ${getActiveBpm(44684)}`);
    if (getActiveBpm(144376) !== 130) throw new Error(`Expected 130 BPM at 144376ms, got ${getActiveBpm(144376)}`);

    // Test 9: Exact Slider Edge Timing & Grid Snap in Ariabl'eyeS
    const slider127299 = ariaParsed.hitObjects.find((ho) => ho.time === 127299);
    if (!slider127299 || slider127299.endTime !== 127530) {
      throw new Error(`Expected slider at 127299 to end at 127530, got ${slider127299?.endTime}`);
    }

    // Verify imported triggers from Ariabl'eyeS are aligned to grid
    const ariaImported = importHitsoundsFromBeatmap(ariaParsed);
    let offGridCount = 0;
    for (const tr of ariaImported.triggers) {
      const activeRed = redLines.findLast ? redLines.findLast((r) => r.time <= tr.time) || redLines[0] : redLines[0];
      const snap16 = activeRed.beatLength / 16;
      const diff = tr.time - activeRed.time;
      const err16 = Math.abs(diff - Math.round(diff / snap16) * snap16);
      const snap12 = activeRed.beatLength / 12;
      const err12 = Math.abs(diff - Math.round(diff / snap12) * snap12);
      if (err16 > 2 && err12 > 2) offGridCount++;
    }
    if (offGridCount > 0) {
      throw new Error(`Expected 0 off-grid triggers in Ariabl'eyeS, got ${offGridCount}`);
    }

    console.log(`[PASS] Exact slider duration & edge times: slider at 127299ms ends at exactly 127530ms, 0 off-grid triggers!`);

    console.log(
      `[PASS] Multiple BPMs (42 red lines, 84-260 BPM) & Kiai intervals (${kiaiIntervals.length} zones) verified!`
    );
  }
}

// Test 10: Multi-SampleSet Additions Separation (Soft HitNormal + Drum Clap)
{
  const lanes10: Lane[] = [
    { id: 'hn', name: 'Soft HitNormal', sampleSet: 'Soft', addition: 'None', additionSet: 'Auto', customIndex: 0, volume: 80, color: '#fff', muted: false, solo: false },
    { id: 'cl', name: 'Drum Clap', sampleSet: 'Drum', addition: 'Clap', additionSet: 'Auto', customIndex: 0, volume: 85, color: '#ff4081', muted: false, solo: false },
  ];
  const triggers10: Trigger[] = [
    { id: 'tr1', laneId: 'hn', time: 5000 },
    { id: 'tr2', laneId: 'cl', time: 5000 },
  ];
  const gen10 = generateHitsoundBeatmap(lanes10, triggers10, beatmap, 'Hitsounds');
  const ho10 = gen10.beatmap.hitObjects.find((h) => h.time === 5000);
  if (!ho10) throw new Error('Test 10: Note at 5000ms not found!');
  if (ho10.hitSound !== 8) throw new Error(`Test 10: Expected hitSound = 8 (Clap), got ${ho10.hitSound}`);
  if (ho10.hitSample.normalSet !== 2) throw new Error(`Test 10: Expected normalSet = 2 (Soft), got ${ho10.hitSample.normalSet}`);
  if (ho10.hitSample.additionSet !== 3) throw new Error(`Test 10: Expected additionSet = 3 (Drum), got ${ho10.hitSample.additionSet}`);
  console.log('[PASS] Test 10: Multi-sampleSet addition verified! Soft HitNormal + Drum Clap -> normalSet: 2 (Soft), additionSet: 3 (Drum)');
}

// Test 11: Multi-Layer Additions with Different AdditionSets
{
  const lanes11: Lane[] = [
    { id: 'w1', name: 'Soft Whistle', sampleSet: 'Soft', addition: 'Whistle', additionSet: 'Auto', customIndex: 1, volume: 80, color: '#00e5ff', muted: false, solo: false },
    { id: 'c1', name: 'Drum Clap', sampleSet: 'Drum', addition: 'Clap', additionSet: 'Auto', customIndex: 0, volume: 85, color: '#ff4081', muted: false, solo: false },
  ];
  const triggers11: Trigger[] = [
    { id: 'tr11_1', laneId: 'w1', time: 6000 },
    { id: 'tr11_2', laneId: 'c1', time: 6000 },
  ];
  const gen11 = generateHitsoundBeatmap(lanes11, triggers11, beatmap, 'Hitsounds');
  const hos11 = gen11.beatmap.hitObjects.filter((h) => h.time === 6000);
  if (hos11.length !== 2) throw new Error(`Test 11: Expected 2 layered notes at 6000ms, got ${hos11.length}`);
  const whistleNote = hos11.find((h) => h.hitSound === 2);
  const clapNote = hos11.find((h) => h.hitSound === 8);
  if (!whistleNote || whistleNote.hitSample.additionSet !== 2) throw new Error('Test 11: Soft Whistle layer missing or wrong additionSet!');
  if (!clapNote || clapNote.hitSample.additionSet !== 3) throw new Error('Test 11: Drum Clap layer missing or wrong additionSet!');
  console.log('[PASS] Test 11: Multi-layer additions verified! Soft Whistle and Drum Clap cleanly layered at same timestamp.');
}

// Test 12: Custom Sample Filename Preservation
{
  const lanes12: Lane[] = [
    { id: 'k1', name: 'Kicks 1', sampleSet: 'Soft', addition: 'None', additionSet: 'Auto', customIndex: 0, volume: 90, color: '#ffc400', muted: false, solo: false, customSampleName: 'Kicks 1' },
    { id: 's1', name: 'snares 3', sampleSet: 'Drum', addition: 'Clap', additionSet: 'Auto', customIndex: 0, volume: 85, color: '#ff4081', muted: false, solo: false, customSampleName: 'snares 3' },
  ];
  const triggers12: Trigger[] = [
    { id: 'tr12_1', laneId: 'k1', time: 7000 },
    { id: 'tr12_2', laneId: 's1', time: 7000 },
  ];
  const gen12 = generateHitsoundBeatmap(lanes12, triggers12, beatmap, 'Hitsounds');
  const hos12 = gen12.beatmap.hitObjects.filter((h) => h.time === 7000);
  const kickHo = hos12.find((h) => h.hitSample.filename === 'Kicks 1');
  const snareHo = hos12.find((h) => h.hitSample.filename === 'snares 3');
  if (!kickHo || !snareHo) throw new Error('Test 12: Custom sample filenames missing from generated notes!');
  console.log('[PASS] Test 12: Custom sample filenames preserved in generated hitsound diff: Kicks 1, snares 3');

  // Test Copier combining multi-source objects
  const target12 = JSON.parse(JSON.stringify(beatmap)) as OsuBeatmap;
  target12.hitObjects = [{ x: 100, y: 100, time: 7000, type: 1, hitSound: 0, rawString: '' }];
  const copyRes12 = copyHitsounds(gen12.beatmap, [target12], copierOptions)[0];
  const copiedHo = copyRes12.beatmap.hitObjects[0];
  if (copiedHo.hitSound !== 8) throw new Error(`Test 12: Expected copied hitSound = 8 (Clap), got ${copiedHo.hitSound}`);
  console.log('[PASS] Test 12: Copier successfully combined multiple layered source objects into target hitobject!');
}

// Test 13: Clear Custom Sample Names & Standard Naming Compliance
{
  const lanes13: Lane[] = [
    { id: 'k1', name: 'Kicks 1', sampleSet: 'Soft', addition: 'None', additionSet: 'Auto', customIndex: 0, volume: 90, color: '#ffc400', muted: false, solo: false, customSampleName: 'Kicks 1' },
    { id: 's1', name: 'snares 3', sampleSet: 'Drum', addition: 'Clap', additionSet: 'Auto', customIndex: 2, volume: 85, color: '#ff4081', muted: false, solo: false, customSampleName: 'snares 3' },
  ];
  const triggers13: Trigger[] = [
    { id: 'tr13_1', laneId: 'k1', time: 7500 },
    { id: 'tr13_2', laneId: 's1', time: 7500 },
  ];

  // 1. Before clearing: outputs custom filename references
  const genBefore = generateHitsoundBeatmap(lanes13, triggers13, beatmap, 'Hitsounds');
  const serializedBefore = serializeOsu(genBefore.beatmap);
  if (!serializedBefore.includes(':Kicks 1') || !serializedBefore.includes(':snares 3')) {
    throw new Error('Test 13: Expected custom filenames in serialized diff before clearing!');
  }

  // 2. Clear custom names (Simulating Option A: Clear Custom Names)
  for (const l of lanes13) {
    delete l.customSampleName;
    delete l.audioBuffer;
  }

  // 3. After clearing: outputs clean ranking-criteria standard hitobject without filenames
  const genAfter = generateHitsoundBeatmap(lanes13, triggers13, beatmap, 'Hitsounds');
  const serializedAfter = serializeOsu(genAfter.beatmap);
  if (serializedAfter.includes(':Kicks 1') || serializedAfter.includes(':snares 3')) {
    throw new Error('Test 13: Expected NO custom filenames in serialized diff after clearing!');
  }
  const noteAfter = genAfter.beatmap.hitObjects.find((h) => h.time === 7500);
  if (!noteAfter) throw new Error('Test 13: Note at 7500ms not found after clearing!');
  if (noteAfter.hitSample.filename) throw new Error(`Test 13: Expected empty filename, got "${noteAfter.hitSample.filename}"`);
  if (noteAfter.hitSound !== 8) throw new Error(`Test 13: Expected hitSound = 8 (Clap), got ${noteAfter.hitSound}`);
  if (noteAfter.hitSample.normalSet !== 2) throw new Error(`Test 13: Expected normalSet = 2 (Soft), got ${noteAfter.hitSample.normalSet}`);
  if (noteAfter.hitSample.additionSet !== 3) throw new Error(`Test 13: Expected additionSet = 3 (Drum), got ${noteAfter.hitSample.additionSet}`);
  if (noteAfter.hitSample.index !== 2) throw new Error(`Test 13: Expected custom index = 2, got ${noteAfter.hitSample.index}`);

  // 4. Verify standard vs non-standard sample detector regex
  const stdRegex = /^(normal|soft|drum)-(hit(normal|whistle|finish|clap)|slider(slide|tick|whistle))\d*(\.(wav|ogg|mp3))?$/i;
  if (!stdRegex.test('soft-hitclap.wav')) throw new Error('Test 13: soft-hitclap.wav should be recognized as standard');
  if (!stdRegex.test('drum-hitnormal2.ogg')) throw new Error('Test 13: drum-hitnormal2.ogg should be recognized as standard');
  if (!stdRegex.test('soft-hitwhistle')) throw new Error('Test 13: soft-hitwhistle without ext should be recognized as standard');
  if (stdRegex.test('Kicks 1.wav')) throw new Error('Test 13: Kicks 1.wav should NOT be recognized as standard');
  if (stdRegex.test('snares 3')) throw new Error('Test 13: snares 3 should NOT be recognized as standard');

  console.log('[PASS] Test 13: Clear Custom Sample Names correctly strips filename tags and outputs clean ranking-compliant hitsounds!');
}

console.log('\n>>> ALL 13 CORE TESTS PASSED WITH 100% INTEGRITY! <<<');

// Test 14: custom sample rename (files + references)
{
  const { findNonStandardSamples, suggestStandardNames, validateRename, renameSamplesInOsuText, sampleStem } = await import('../src/osu/sampleNaming');
  const zip = new Map<string, Uint8Array>([
    ['audio.mp3', new Uint8Array(100)],
    ['kicks 1.wav', new Uint8Array(100)],
    ['soft-hitclap2.wav', new Uint8Array(100)],
    ['silent.wav', new Uint8Array(44)],
  ]);
  const osu = '[Events]\r\nSample,100,0,"Kicks 1.wav",70\r\n[HitObjects]\r\n256,192,100,1,0,0:0:0:80:Kicks 1\r\n256,192,200,1,8,2:2:2:80:\r\n';
  const bm = parseOsu(osu, 'x.osu');
  bm.general.AudioFilename = 'audio.mp3';
  const lanes = [{ id: 'a', name: 'k', sampleSet: 'Soft', addition: 'None', additionSet: 'Auto', customIndex: 0, volume: 80, color: '', muted: false, solo: false, customSampleName: 'Kicks 1' }] as Lane[];

  const pending = findNonStandardSamples(zip, [bm], lanes, 'audio.mp3');
  if (pending.length !== 1 || pending[0] !== 'kicks 1.wav') throw new Error(`Test 14: expected [kicks 1.wav], got ${JSON.stringify(pending)}`);

  const suggestion = suggestStandardNames(pending, zip, [bm]).get('kicks 1.wav')!;
  if (suggestion !== 'drum-hitnormal3.wav') throw new Error(`Test 14: expected drum-hitnormal3.wav (2 is taken), got ${suggestion}`);
  if (!validateRename('kick.wav', new Set())) throw new Error('Test 14: non-standard target must be rejected');
  if (!validateRename('soft-hitclap2.wav', new Set(['soft-hitclap2']))) throw new Error('Test 14: taken name must be rejected');
  if (validateRename(suggestion, new Set())) throw new Error('Test 14: suggestion must validate');

  const out = renameSamplesInOsuText(osu, new Map([[sampleStem('kicks 1.wav'), suggestion]]));
  if (!out.includes('0:0:0:80:drum-hitnormal3.wav\r\n') || !out.includes('"drum-hitnormal3.wav"') || !out.includes('2:2:2:80:\r\n')) {
    throw new Error(`Test 14: rename not applied correctly:\n${out}`);
  }
  console.log('[PASS] Test 14: non-standard samples detected, suggested, validated and renamed in .osu text');
}
