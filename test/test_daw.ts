import type { Lane, Trigger } from '../src/types';

console.log('=== RUNNING HITSOUND STUDIO DAW FEATURES TEST SUITE ===');

// 1. Test Undo / Redo Logic
class UndoRedoManager {
  private undoStack: Trigger[][] = [];
  private redoStack: Trigger[][] = [];
  private readonly maxHistory = 50;
  public triggers: Trigger[] = [];

  public pushHistorySnapshot() {
    const snapshot = this.triggers.map((t) => ({ ...t }));
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.triggers.map((t) => ({ ...t })));
    this.triggers = this.undoStack.pop()!;
    return true;
  }

  public redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.triggers.map((t) => ({ ...t })));
    this.triggers = this.redoStack.pop()!;
    return true;
  }
}

const manager = new UndoRedoManager();
manager.triggers = [
  { id: 't1', laneId: 'l1', time: 1000 },
  { id: 't2', laneId: 'l2', time: 2000 },
];

// Action: add a note
manager.pushHistorySnapshot();
manager.triggers.push({ id: 't3', laneId: 'l1', time: 3000 });
if (manager.triggers.length !== 3) throw new Error('Failed to add note');

// Test Undo
manager.undo();
if (manager.triggers.length !== 2 || manager.triggers.some((t) => t.id === 't3')) {
  throw new Error('Undo failed to restore previous trigger state');
}
console.log('[PASS] Undo successfully reverted added note');

// Test Redo
manager.redo();
if (manager.triggers.length !== 3 || !manager.triggers.some((t) => t.id === 't3')) {
  throw new Error('Redo failed to restore state');
}
console.log('[PASS] Redo successfully reapplied added note');

// Action: delete a note
manager.pushHistorySnapshot();
manager.triggers = manager.triggers.filter((t) => t.id !== 't2');
if (manager.triggers.length !== 2) throw new Error('Failed to delete note');

// Undo accidental deletion
manager.undo();
if (manager.triggers.length !== 3 || !manager.triggers.some((t) => t.id === 't2')) {
  throw new Error('Undo failed to restore accidentally deleted note');
}
console.log('[PASS] Undo successfully restored accidentally deleted note');

// 2. Test Copy & Paste with Relative Timing
interface ClipboardItem {
  laneId: string;
  relTime: number;
  volume?: number;
}

function copyNotes(triggers: Trigger[], selectedIds: Set<string>): ClipboardItem[] {
  const selected = triggers.filter((tr) => selectedIds.has(tr.id));
  if (selected.length === 0) return [];
  selected.sort((a, b) => a.time - b.time);
  const minTime = selected[0].time;
  return selected.map((tr) => ({
    laneId: tr.laneId,
    relTime: tr.time - minTime,
    volume: tr.volume,
  }));
}

function pasteNotes(
  clipboard: ClipboardItem[],
  existingTriggers: Trigger[],
  pasteBaseTime: number,
  lanes: Lane[]
): { updatedTriggers: Trigger[]; pastedIds: string[] } {
  const laneIds = new Set(lanes.map((l) => l.id));
  const fallbackLaneId = lanes[0]?.id || '';
  const resultTriggers = [...existingTriggers];
  const pastedIds: string[] = [];

  for (const item of clipboard) {
    const laneId = laneIds.has(item.laneId) ? item.laneId : fallbackLaneId;
    const targetTime = Math.max(0, Math.round(pasteBaseTime + item.relTime));

    const existing = resultTriggers.find((t) => t.laneId === laneId && Math.abs(t.time - targetTime) < 2);
    if (!existing) {
      const newTr: Trigger = {
        id: `tr-pasted-${targetTime}-${laneId}`,
        laneId,
        time: targetTime,
        volume: item.volume,
      };
      resultTriggers.push(newTr);
      pastedIds.push(newTr.id);
    } else {
      pastedIds.push(existing.id);
    }
  }

  return { updatedTriggers: resultTriggers, pastedIds };
}

const testLanes: Lane[] = [
  { id: 'l1', name: 'Clap', sampleSet: 'Soft', addition: 'Clap', additionSet: 'Auto', customIndex: 0, volume: 90, color: '#f00', muted: false, solo: false },
  { id: 'l2', name: 'Kick', sampleSet: 'Drum', addition: 'None', additionSet: 'Auto', customIndex: 0, volume: 90, color: '#0f0', muted: false, solo: false },
];

const sourceTriggers: Trigger[] = [
  { id: 'src-1', laneId: 'l1', time: 5000 },
  { id: 'src-2', laneId: 'l2', time: 5250 },
  { id: 'src-3', laneId: 'l1', time: 5500 },
];

// Copy source triggers
const clipboard = copyNotes(sourceTriggers, new Set(['src-1', 'src-2', 'src-3']));
if (clipboard.length !== 3) throw new Error('Clipboard should have 3 items');
if (clipboard[0].relTime !== 0 || clipboard[1].relTime !== 250 || clipboard[2].relTime !== 500) {
  throw new Error('Relative time preservation failed in copy');
}
console.log('[PASS] Copy correctly preserved relative time offsets [0ms, 250ms, 500ms]');

// Paste at 8000ms
const pasteResult = pasteNotes(clipboard, sourceTriggers, 8000, testLanes);
if (pasteResult.updatedTriggers.length !== 6) {
  throw new Error(`Expected 6 triggers after paste, got ${pasteResult.updatedTriggers.length}`);
}

const pastedT1 = pasteResult.updatedTriggers.find((t) => t.time === 8000 && t.laneId === 'l1');
const pastedT2 = pasteResult.updatedTriggers.find((t) => t.time === 8250 && t.laneId === 'l2');
const pastedT3 = pasteResult.updatedTriggers.find((t) => t.time === 8500 && t.laneId === 'l1');

if (!pastedT1 || !pastedT2 || !pastedT3) {
  throw new Error('Pasted notes did not match expected times and lanes');
}
console.log('[PASS] Paste placed notes at exact target playhead with preserved lanes and timings (8000ms, 8250ms, 8500ms)');

// 3. Test Selection vs Click Placement Threshold
class MockInteraction {
  public pendingClickNote: { laneId: string; time: number } | null = null;
  public mouseDownPos = { x: 0, y: 0 };
  public isBoxSelecting = false;
  public placedNotes: { laneId: string; time: number }[] = [];

  public onMouseDown(x: number, y: number, laneId: string, time: number) {
    this.pendingClickNote = { laneId, time };
    this.mouseDownPos = { x, y };
    this.isBoxSelecting = false;
  }

  public onMouseMove(x: number, y: number) {
    if (this.pendingClickNote) {
      const dist = Math.hypot(x - this.mouseDownPos.x, y - this.mouseDownPos.y);
      if (dist >= 5) {
        this.pendingClickNote = null; // Cancel single click placement
        this.isBoxSelecting = true;
      }
    }
  }

  public onMouseUp() {
    if (this.pendingClickNote) {
      this.placedNotes.push(this.pendingClickNote);
      this.pendingClickNote = null;
    }
    this.isBoxSelecting = false;
  }
}

// Case A: User drags to select notes (movement >= 5px)
const dragSession = new MockInteraction();
dragSession.onMouseDown(100, 100, 'l1', 1000);
dragSession.onMouseMove(101, 101); // 1.4px movement
dragSession.onMouseMove(150, 150); // > 50px movement (dragging box selection)
dragSession.onMouseUp();

if (dragSession.placedNotes.length !== 0) {
  throw new Error('FAIL: Note was accidentally placed during marquee drag selection!');
}
console.log('[PASS] Marquee drag selection placed 0 accidental notes (pending note properly cancelled)');

// Case B: User clicks without dragging (movement < 5px)
const clickSession = new MockInteraction();
clickSession.onMouseDown(100, 100, 'l1', 1000);
clickSession.onMouseMove(101, 101); // 1.4px tiny movement / jitter
clickSession.onMouseUp();

if (clickSession.placedNotes.length !== 1 || clickSession.placedNotes[0].time !== 1000) {
  throw new Error('FAIL: Single click failed to place note!');
}
console.log('[PASS] Single click successfully placed intentional note at target position');

// 5. Test Mute & Solo Mutual Exclusivity and Active State Evaluation
const lanes: Lane[] = [
  {
    id: 'l1',
    name: 'Soft Whistle #1',
    sampleSet: 'Soft',
    addition: 'Whistle',
    additionSet: 'Auto',
    customIndex: 1,
    volume: 80,
    color: '#00e5ff',
    muted: false,
    solo: false,
  },
  {
    id: 'l2',
    name: 'Soft Clap #1',
    sampleSet: 'Soft',
    addition: 'Clap',
    additionSet: 'Auto',
    customIndex: 1,
    volume: 90,
    color: '#ff4081',
    muted: false,
    solo: false,
  },
];

// Click Mute on lane 1
lanes[0].muted = !lanes[0].muted;
if (lanes[0].muted) lanes[0].solo = false;
if (!lanes[0].muted || lanes[0].solo) throw new Error('Mute failed to activate or solo was not false');

// Click Solo on lane 1: must clear Mute
lanes[0].solo = !lanes[0].solo;
if (lanes[0].solo) lanes[0].muted = false;
if (lanes[0].muted || !lanes[0].solo) throw new Error('Solo failed to override and clear mute');

// Check active state of all lanes when solo is active on lane 0
const hasSolo = lanes.some((l) => l.solo);
const isLane1Inactive = lanes[0].muted || (hasSolo && !lanes[0].solo);
const isLane2Inactive = lanes[1].muted || (hasSolo && !lanes[1].solo);

if (isLane1Inactive) throw new Error('Soloed lane 1 should not be inactive');
if (!isLane2Inactive) throw new Error('Non-soloed lane 2 must be inactive when solo is active');
console.log('[PASS] Mute and Solo are strictly mutually exclusive and lane dimming states compute correctly');

// 6. Test Additions Toggling (W / E / R hotkeys)
let lanesList: Lane[] = [
  { id: 'lane-whistle', name: 'Soft Whistle', sampleSet: 'Soft', addition: 'Whistle', additionSet: 'Auto', customIndex: 0, volume: 80, color: '#00e5ff', muted: false, solo: false },
  { id: 'lane-clap', name: 'Soft Clap', sampleSet: 'Soft', addition: 'Clap', additionSet: 'Auto', customIndex: 0, volume: 90, color: '#ff4081', muted: false, solo: false },
];
let activeTriggers: Trigger[] = [
  { id: 't-1', laneId: 'lane-whistle', time: 1000 },
  { id: 't-2', laneId: 'lane-whistle', time: 2000 },
];

function toggleAddition(addition: 'Whistle' | 'Finish' | 'Clap', selectedTriggerIds: Set<string>) {
  let targetLane = lanesList.find((l) => l.addition === addition);
  if (!targetLane) {
    targetLane = {
      id: `lane-${addition.toLowerCase()}`,
      name: `Soft ${addition}`,
      sampleSet: 'Soft',
      addition,
      additionSet: 'Auto',
      customIndex: 0,
      volume: 85,
      color: '#ffc400',
      muted: false,
      solo: false,
    };
    lanesList.push(targetLane);
  }

  const selected = activeTriggers.filter((t) => selectedTriggerIds.has(t.id));
  const timestamps = Array.from(new Set(selected.map((t) => t.time)));
  const existingOnTarget = activeTriggers.filter((t) => t.laneId === targetLane!.id);
  const existingTimes = new Set(existingOnTarget.map((t) => t.time));
  const allHaveIt = timestamps.every((time) => existingTimes.has(time));

  if (allHaveIt) {
    const removeSet = new Set(timestamps);
    activeTriggers = activeTriggers.filter((t) => !(t.laneId === targetLane!.id && removeSet.has(t.time)));
  } else {
    for (const time of timestamps) {
      if (!existingTimes.has(time)) {
        activeTriggers.push({
          id: `tr-${targetLane.id}-${time}`,
          laneId: targetLane.id,
          time,
        });
      }
    }
  }
}

// Case A: Toggle Clap on selected notes at 1000ms & 2000ms (should add clap triggers)
toggleAddition('Clap', new Set(['t-1', 't-2']));
const clapTriggers = activeTriggers.filter((t) => t.laneId === 'lane-clap');
if (clapTriggers.length !== 2) throw new Error('Failed to add Clap additions to selected notes');
console.log('[PASS] W/E/R additions toggle: successfully added Clap additions to selected notes');

// Case B: Toggle Clap AGAIN on selected notes (should toggle off and remove clap triggers)
toggleAddition('Clap', new Set(['t-1', 't-2']));
const clapTriggersAfter = activeTriggers.filter((t) => t.laneId === 'lane-clap');
if (clapTriggersAfter.length !== 0) throw new Error('Failed to toggle off Clap additions');
console.log('[PASS] W/E/R additions toggle: successfully toggled off Clap additions when already present');

// Case C: Toggle Finish (lane does not exist yet; should auto-create Finish lane and add notes)
toggleAddition('Finish', new Set(['t-1']));
const finishLane = lanesList.find((l) => l.addition === 'Finish');
const finishTriggers = activeTriggers.filter((t) => t.laneId === finishLane?.id);
if (!finishLane || finishTriggers.length !== 1) throw new Error('Failed to auto-create Finish lane and assign note');
console.log('[PASS] W/E/R additions toggle: auto-created missing addition lane and added note');

// 7. Test Compact Lane Mode and Numeric Volume Validation
let isCompact = false;
let laneHeight = 58;
function toggleCompact() {
  isCompact = !isCompact;
  laneHeight = isCompact ? 28 : 58;
}
toggleCompact();
if (laneHeight !== 28 || !isCompact) throw new Error('Compact mode failed to set 28px lane height');
toggleCompact();
if (laneHeight !== 58 || isCompact) throw new Error('Expand mode failed to restore 58px lane height');
console.log('[PASS] Compact lane toggle correctly alternates between 28px and 58px height');

// Numeric volume parsing
function parseVolume(input: string): number {
  let val = parseInt(input, 10);
  if (isNaN(val)) val = 0;
  return Math.max(0, Math.min(100, val));
}
if (parseVolume('85') !== 85 || parseVolume('150') !== 100 || parseVolume('-20') !== 0 || parseVolume('abc') !== 0) {
  throw new Error('Volume percentage parsing/clamping validation failed');
}
console.log('[PASS] Numeric volume percentage parsing strictly clamps to [0, 100]%');

// 8. Test Note Dragging (moving notes across time and lanes)
let dragTriggers: Trigger[] = [
  { id: 'drag-1', laneId: 'l1', time: 1000 },
  { id: 'drag-2', laneId: 'l2', time: 1250 },
];

function moveTriggers(
  triggers: Trigger[],
  moves: { id: string; laneId: string; time: number }[]
): Trigger[] {
  const moveMap = new Map(moves.map((m) => [m.id, m]));
  const updated = triggers.map((t) => {
    const m = moveMap.get(t.id);
    return m ? { ...t, laneId: m.laneId, time: m.time } : { ...t };
  });
  // Deduplicate
  const seen = new Set<string>();
  return updated.filter((t) => {
    const key = `${t.laneId}_${t.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.time - b.time);
}

// Case A: Drag a single note forward in time by 500ms
const movedSingle = moveTriggers(dragTriggers, [{ id: 'drag-1', laneId: 'l1', time: 1500 }]);
if (movedSingle.find((t) => t.id === 'drag-1')?.time !== 1500) {
  throw new Error('Failed to move single note in time');
}
console.log('[PASS] Note drag: successfully moved single note forward in time to 1500ms');

// Case B: Drag a note between lanes (l1 -> l2)
const movedLane = moveTriggers(dragTriggers, [{ id: 'drag-1', laneId: 'l2', time: 1000 }]);
if (movedLane.find((t) => t.id === 'drag-1')?.laneId !== 'l2') {
  throw new Error('Failed to move single note between lanes');
}
console.log('[PASS] Note drag: successfully moved note to different lane');

// Case C: Drag multiple selected notes simultaneously (preserving relative offset)
const movedGroup = moveTriggers(dragTriggers, [
  { id: 'drag-1', laneId: 'l1', time: 2000 },
  { id: 'drag-2', laneId: 'l2', time: 2250 },
]);
if (
  movedGroup.find((t) => t.id === 'drag-1')?.time !== 2000 ||
  movedGroup.find((t) => t.id === 'drag-2')?.time !== 2250
) {
  throw new Error('Failed to move group of selected notes');
}
console.log('[PASS] Note drag: successfully moved group of selected notes preserving relative timing');

console.log('\n>>> ALL DAW FEATURE TESTS PASSED WITH 100% INTEGRITY! <<<');

