import JSZip from 'jszip';
import { AudioEngine } from '../audio/audioEngine';
import { Sequencer } from '../editor/sequencer';
import { copyHitsounds } from '../osu/copier';
import { generateHitsoundBeatmap } from '../osu/hitsoundGenerator';
import { importHitsoundsFromBeatmap } from '../osu/hitsoundImporter';
import { parseOsu } from '../osu/parser';
import type {
  CopierOptions,
  Lane,
  OsuBeatmap,
  TimingPoint,
  Trigger,
} from '../types';

export class App {
  private audioEngine: AudioEngine;
  private sequencer!: Sequencer;

  // Project State
  private lanes: Lane[] = [];
  private triggers: Trigger[] = [];
  private timingPoints: TimingPoint[] = [];
  private allBeatmaps: OsuBeatmap[] = [];
  private referenceBeatmap: OsuBeatmap | null = null;
  private customSamples: Map<string, AudioBuffer> = new Map();
  private rawZipFiles: Map<string, Uint8Array> = new Map();

  public activeTab: 'studio' | 'copier' = 'studio';
  private title = 'New Project';
  private artist = 'Unknown Artist';
  private creator = 'Mapper';
  private audioFileName = 'audio.mp3';

  // History (Undo / Redo)
  private undoStack: Trigger[][] = [];
  private redoStack: Trigger[][] = [];
  private readonly maxHistory = 50;

  // Clipboard & Toast
  private clipboard: { laneId: string; relTime: number; volume?: number }[] = [];
  private toastTimeout: number | null = null;

  constructor() {
    this.audioEngine = new AudioEngine();
    this.initDefaultLanes();
    this.initDefaultTiming();
  }

  public init() {
    this.renderLayout();
    this.initSequencer();
    this.setupGlobalShortcuts();
    this.setupAudioListeners();
    this.audioEngine.preloadDefaultSamples().catch(() => {});
  }

  private initDefaultLanes() {
    this.lanes = [
      {
        id: 'lane-soft-clap',
        name: 'Soft Clap',
        sampleSet: 'Soft',
        addition: 'Clap',
        additionSet: 'Auto',
        customIndex: 0,
        volume: 90,
        color: '#ff4081',
        muted: false,
        solo: false,
      },
      {
        id: 'lane-soft-whistle',
        name: 'Soft Whistle',
        sampleSet: 'Soft',
        addition: 'Whistle',
        additionSet: 'Auto',
        customIndex: 0,
        volume: 80,
        color: '#00e5ff',
        muted: false,
        solo: false,
      },
      {
        id: 'lane-soft-finish',
        name: 'Soft Finish',
        sampleSet: 'Soft',
        addition: 'Finish',
        additionSet: 'Auto',
        customIndex: 0,
        volume: 90,
        color: '#ffc400',
        muted: false,
        solo: false,
      },
      {
        id: 'lane-drum-kick',
        name: 'Drum Kick',
        sampleSet: 'Drum',
        addition: 'None',
        additionSet: 'Auto',
        customIndex: 0,
        volume: 85,
        color: '#76ff03',
        muted: false,
        solo: false,
      },
    ];
  }

  private initDefaultTiming() {
    // 175 BPM default
    this.timingPoints = [
      {
        time: 0,
        beatLength: 342.857, // 175 BPM
        meter: 4,
        sampleSet: 2,
        sampleIndex: 0,
        volume: 100,
        uninherited: true,
        effects: 0,
      },
    ];
  }

  // --- Layout & DOM ---

  private renderLayout() {
    const root = document.getElementById('app')!;
    root.innerHTML = `
      <div class="studio-app">
        <!-- Top Navigation & Transport Bar -->
        <header class="top-bar">
          <div class="brand">
            <span class="logo-icon">⚡</span>
            <span class="logo-text">HITSOUND STUDIO</span>
            <span class="badge">OSU!</span>
          </div>

          <div class="transport">
            <button id="btn-play" class="btn btn-primary" title="Play / Pause (Space)">
              <span id="play-icon">▶</span>
            </button>
            <button id="btn-stop" class="btn btn-secondary" title="Return to start (Home)">⏮</button>
            <div class="time-display" id="time-display">00:00.000</div>

            <div class="transport-group">
              <label>Rate:</label>
              <select id="select-rate" class="dropdown">
                <option value="0.5">0.5x</option>
                <option value="0.75">0.75x</option>
                <option value="1.0" selected>1.0x</option>
              </select>
            </div>

            <div class="transport-group">
              <label>Snap:</label>
              <select id="select-snap" class="dropdown">
                <option value="1">1/1</option>
                <option value="2">1/2</option>
                <option value="4" selected>1/4</option>
                <option value="3">1/3</option>
                <option value="6">1/6</option>
                <option value="8">1/8</option>
                <option value="12">1/12</option>
                <option value="16">1/16</option>
              </select>
            </div>

            <div class="transport-group">
              <label>Zoom:</label>
              <input type="range" id="slider-zoom" min="30" max="3000" value="220" class="range-slider">
            </div>

            <div class="transport-group volumes">
              <span>🎵</span>
              <input type="range" id="vol-song" min="0" max="100" value="80" title="Song Volume" class="range-slider mini">
              <span>🥁</span>
              <input type="range" id="vol-hs" min="0" max="100" value="90" title="Hitsound Volume" class="range-slider mini">
            </div>
          </div>

          <div class="header-actions">
            <nav class="tabs">
              <button id="tab-studio" class="tab-btn active">Studio</button>
              <button id="tab-copier" class="tab-btn">Hitsound Copier</button>
            </nav>

            <button id="btn-reset" class="btn btn-outline" title="Reset all and start fresh">🔄 Reset</button>
            <label class="btn btn-outline file-btn">
              Import .osz / .osu
              <input type="file" id="file-input" accept="*/*" multiple hidden>
            </label>
            <button id="btn-export-diff" class="btn btn-success">Export [Hitsounds].osu</button>
            <button id="btn-download-osz" class="btn btn-accent" title="Download updated .osz package">Save .osz</button>
          </div>
        </header>

        <!-- Main Workspace View -->
        <main class="main-workspace">
          <!-- STUDIO VIEW -->
          <div id="view-studio" class="view-panel active">
            <!-- Left Channel Rack -->
            <aside class="channel-rack">
              <!-- Top header container: EXACTLY 64px to align with canvas rulerHeight -->
              <div class="rack-header-container">
                <div class="rack-top-line">
                  <span id="rack-lanes-title" class="rack-title">LANES (${this.lanes.length})</span>
                  <button id="btn-add-lane" class="btn btn-sm btn-primary">+ Add Lane</button>
                </div>
                <div class="rack-sub-line">
                  <label style="font-size:0.75rem; color:var(--text-muted)">Ghost:</label>
                  <select id="select-reference-diff" class="dropdown" style="flex:1">
                    <option value="">None</option>
                  </select>
                  <button id="btn-toggle-ghost" class="btn btn-sm btn-outline active" title="Toggle ghost notes visibility (G)">👁</button>
                  <button id="btn-import-hs-diff" class="btn btn-sm btn-outline" title="Convert an existing diff into editable lanes">📥 From Diff</button>
                </div>
              </div>

              <!-- Lane Items Container -->
              <div id="lanes-list" class="lanes-list"></div>
            </aside>

            <!-- Sequencer Canvas Area -->
            <div class="sequencer-container">
              <canvas id="sequencer-canvas"></canvas>
              <div class="hint-bar">
                💡 <strong>Click</strong>: Place | <strong>Drag</strong>: Select | <strong>Ctrl+Drag</strong>: Paint | <strong>Right-Click</strong>: Erase | <strong>Ctrl+Z</strong>: Undo | <strong>C / V</strong>: Copy/Paste | <strong>Del / X</strong>: Delete
              </div>
            </div>
          </div>

          <!-- COPIER VIEW -->
          <div id="view-copier" class="view-panel">
            <div class="copier-container">
              <div class="copier-card">
                <h2>⚡ Built-In Hitsound Copier</h2>
                <p class="subtitle">
                  Bake hitsounds from the studio project or a source diff directly into your mapset's difficulties.
                  <strong>Preserves Slider Velocity (SV)</strong> while transferring additions, custom indices, and volumes.
                </p>

                <div class="copier-grid">
                  <!-- Left: Source & Targets -->
                  <div class="copier-col">
                    <div class="form-group">
                      <label>Source Beatmap:</label>
                      <select id="copier-source" class="dropdown full-width">
                        <option value="__current__">Current Studio Project ([Hitsounds])</option>
                      </select>
                    </div>

                    <div class="form-group">
                      <div class="flex-between">
                        <label>Target Difficulties:</label>
                        <div>
                          <button id="btn-select-all-diffs" class="btn-link">Select All</button>
                          <button id="btn-deselect-all-diffs" class="btn-link">None</button>
                        </div>
                      </div>
                      <div id="copier-targets-list" class="checkbox-list">
                        <div class="empty-state">No other difficulties loaded yet. Import an .osz file.</div>
                      </div>
                    </div>
                  </div>

                  <!-- Right: Options -->
                  <div class="copier-col">
                    <h3>Copy Options</h3>
                    <div class="form-group inline">
                      <label>Snap Tolerance:</label>
                      <input type="number" id="copier-snap" value="5" min="0" max="25" class="input-num">
                      <span>ms</span>
                    </div>

                    <div class="options-list">
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-additions" checked>
                        Copy HitObject Additions (Whistle / Finish / Clap)
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-samplesets" checked>
                        Copy SampleSets (Soft / Normal / Drum)
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-indices" checked>
                        Copy Custom Sample Indices
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-volumes" checked>
                        Copy Volumes & Green Timing Points (preserves target SV)
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-heads" checked>
                        Copy to Slider Heads
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-repeats" checked>
                        Copy to Slider Repeat Arrows
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-tails" checked>
                        Copy to Slider Tails
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-spinners" checked>
                        Copy to Spinners
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" id="opt-clean">
                        Clean unmatched notes (remove old hitsounds on notes with no match)
                      </label>
                    </div>

                    <div class="copier-actions">
                      <button id="btn-run-copier" class="btn btn-primary btn-lg">Copy Hitsounds & Download .osz</button>
                      <button id="btn-download-diffs-zip" class="btn btn-secondary btn-lg">Download Updated .osu Files</button>
                    </div>
                  </div>
                </div>

                <!-- Copier Result Console -->
                <div id="copier-console" class="copier-console"></div>
              </div>
            </div>
          </div>
        </main>
        <div id="toast-container" class="toast-container"></div>
      </div>
    `;

    this.bindDomEvents();
    this.renderLanesList();
  }

  private initSequencer() {
    const canvas = document.getElementById('sequencer-canvas') as HTMLCanvasElement;
    const lanesList = document.getElementById('lanes-list') as HTMLDivElement;

    this.sequencer = new Sequencer(canvas, {
      onAddTrigger: (laneId, time) => {
        const tr: Trigger = {
          id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          laneId,
          time,
        };
        this.triggers.push(tr);
        this.updateSequencerData();
      },
      onRemoveTrigger: (triggerId) => {
        this.triggers = this.triggers.filter((t) => t.id !== triggerId);
        this.updateSequencerData();
      },
      onDeleteSelected: () => {
        this.deleteSelected();
      },
      onSeek: (timeMs) => {
        this.audioEngine.seek(timeMs, this.lanes, this.triggers);
        this.sequencer.setTime(timeMs);
        this.updateTimeDisplay(timeMs);
      },
      onPreviewSample: (lane) => {
        this.audioEngine.playSingleSample(lane);
      },
      onScrollVertical: (scrollTop) => {
        if (lanesList) {
          lanesList.scrollTop = scrollTop;
        }
      },
      onZoomChange: (newZoom) => {
        const slider = document.getElementById('slider-zoom') as HTMLInputElement;
        if (slider) slider.value = String(Math.round(newZoom));
      },
      onPushHistory: () => {
        this.pushHistorySnapshot();
      },
    });

    // Synchronize vertical scroll from left rack to canvas
    lanesList?.addEventListener('scroll', () => {
      this.sequencer.setScrollTop(lanesList.scrollTop);
    });

    this.updateSequencerData();
  }

  private animFrameId: number | null = null;

  private startPlaybackLoop() {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
    }
    const tick = () => {
      if (this.audioEngine.isAudioPlaying()) {
        const cur = this.audioEngine.getCurrentTimeMs();
        this.sequencer.setTime(cur, true);
        this.updateTimeDisplay(cur);
        this.animFrameId = requestAnimationFrame(tick);
      } else {
        this.animFrameId = null;
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private updateSequencerData() {
    const ghostObjects = this.referenceBeatmap ? this.referenceBeatmap.hitObjects : [];
    this.sequencer.updateData(
      this.lanes,
      this.triggers,
      this.timingPoints,
      ghostObjects,
      this.audioEngine.getWaveform()
    );
    this.audioEngine.updateSchedulerData(this.lanes, this.triggers);
  }

  private setupAudioListeners() {
    this.audioEngine.onTimeUpdate = (timeMs) => {
      this.sequencer.setTime(timeMs, true);
      this.updateTimeDisplay(timeMs);
    };

    this.audioEngine.onStateChange = (isPlaying) => {
      const icon = document.getElementById('play-icon');
      if (icon) {
        icon.textContent = isPlaying ? '⏸' : '▶';
      }
      if (isPlaying) {
        this.startPlaybackLoop();
      } else if (this.animFrameId !== null) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }
    };
  }

  private updateTimeDisplay(ms: number) {
    const disp = document.getElementById('time-display');
    if (!disp) return;

    const totalSec = Math.max(0, ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = Math.floor(totalSec % 60);
    const millis = Math.floor(ms % 1000);

    const mStr = String(mins).padStart(2, '0');
    const sStr = String(secs).padStart(2, '0');
    const msStr = String(millis).padStart(3, '0');

    disp.textContent = `${mStr}:${sStr}.${msStr}`;
  }

  // --- DOM & User Events ---

  private bindDomEvents() {
    // Play/Pause
    document.getElementById('btn-play')?.addEventListener('click', () => this.togglePlay());
    document.getElementById('btn-stop')?.addEventListener('click', () => {
      this.audioEngine.seek(0, this.lanes, this.triggers);
      this.sequencer.setTime(0);
      this.updateTimeDisplay(0);
    });

    // Rate selector
    document.getElementById('select-rate')?.addEventListener('change', (e) => {
      const rate = parseFloat((e.target as HTMLSelectElement).value) || 1.0;
      this.audioEngine.setPlaybackRate(rate);
    });

    // Snap selector
    document.getElementById('select-snap')?.addEventListener('change', (e) => {
      const snap = parseInt((e.target as HTMLSelectElement).value, 10) || 4;
      this.sequencer.setSnapDivisor(snap);
    });

    // Zoom slider
    document.getElementById('slider-zoom')?.addEventListener('input', (e) => {
      const zoom = parseFloat((e.target as HTMLInputElement).value) || 140;
      this.sequencer.setZoom(zoom);
    });

    // Volumes
    document.getElementById('vol-song')?.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      this.audioEngine.setSongVolume(val);
    });
    document.getElementById('vol-hs')?.addEventListener('input', (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10) / 100;
      this.audioEngine.setHitsoundVolume(val);
    });

    // Tabs
    document.getElementById('tab-studio')?.addEventListener('click', () => this.switchTab('studio'));
    document.getElementById('tab-copier')?.addEventListener('click', () => this.switchTab('copier'));

    // Add Lane
    document.getElementById('btn-add-lane')?.addEventListener('click', () => this.addNewLane());

    // File Input
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    fileInput?.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.handleFiles(Array.from(files));
      }
    });

    // Reset Button
    document.getElementById('btn-reset')?.addEventListener('click', () => {
      if (confirm('Reset project and clear all loaded data?')) {
        this.resetProject();
      }
    });

    // Export Hitsounds.osu
    document.getElementById('btn-export-diff')?.addEventListener('click', () => this.exportHitsoundDiff());

    // Download .osz
    document.getElementById('btn-download-osz')?.addEventListener('click', () => this.downloadFullOsz());

    // Toggle Ghost Notes Button
    const btnGhost = document.getElementById('btn-toggle-ghost');
    btnGhost?.addEventListener('click', () => {
      this.sequencer.showGhostNotes = !this.sequencer.showGhostNotes;
      btnGhost.classList.toggle('active', this.sequencer.showGhostNotes);
      this.sequencer.render();
    });

    // Reference Diff selector
    document.getElementById('select-reference-diff')?.addEventListener('change', (e) => {
      const ver = (e.target as HTMLSelectElement).value;
      this.referenceBeatmap = this.allBeatmaps.find((bm) => (bm.metadata.Version || '') === ver) || null;
      this.updateSequencerData();
    });

    // Import from Diff button
    document.getElementById('btn-import-hs-diff')?.addEventListener('click', () => {
      if (this.allBeatmaps.length === 0) {
        alert('No difficulties loaded. Import an .osz or .osu file first!');
        return;
      }
      if (this.allBeatmaps.length === 1) {
        this.importDiffIntoLanes(this.allBeatmaps[0], true);
        return;
      }
      const list = this.allBeatmaps.map((bm, i) => `${i + 1}. [${bm.metadata.Version || bm.fileName}] (${bm.hitObjects.length} notes)`).join('\n');
      const pick = prompt(`Select difficulty number to extract hitsounds from:\n\n${list}`, '1');
      if (pick) {
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < this.allBeatmaps.length) {
          this.importDiffIntoLanes(this.allBeatmaps[idx], true);
        }
      }
    });

    // Copier buttons
    document.getElementById('btn-select-all-diffs')?.addEventListener('click', () => {
      document.querySelectorAll<HTMLInputElement>('.target-diff-cb').forEach((cb) => (cb.checked = true));
    });
    document.getElementById('btn-deselect-all-diffs')?.addEventListener('click', () => {
      document.querySelectorAll<HTMLInputElement>('.target-diff-cb').forEach((cb) => (cb.checked = false));
    });
    document.getElementById('btn-run-copier')?.addEventListener('click', () => this.executeCopier(true));
    document.getElementById('btn-download-diffs-zip')?.addEventListener('click', () => this.executeCopier(false));

    // Drag and Drop support
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        this.handleFiles(Array.from(e.dataTransfer.files));
      }
    });
  }

  private setupGlobalShortcuts() {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlay();
        return;
      }

      if (this.activeTab !== 'studio') {
        return;
      }

      if (e.code === 'Home') {
        e.preventDefault();
        this.audioEngine.seek(0, this.lanes, this.triggers);
        this.sequencer.setTime(0);
        return;
      }

      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        const cur = this.audioEngine.getCurrentTimeMs();
        const redLine = this.sequencer.findActiveRedLine(cur);
        const step = (redLine.beatLength / this.sequencer.activeSnapDivisor) * (e.code === 'ArrowRight' ? 1 : -1);
        const target = Math.max(0, cur + step);
        this.audioEngine.seek(target, this.lanes, this.triggers);
        this.sequencer.setTime(target);
        return;
      }

      if (e.key >= '1' && e.key <= '6') {
        const divisors = [1, 2, 4, 3, 6, 8];
        const d = divisors[parseInt(e.key, 10) - 1];
        if (d) {
          const sel = document.getElementById('select-snap') as HTMLSelectElement;
          if (sel) sel.value = String(d);
          this.sequencer.setSnapDivisor(d);
          return;
        }
      }

      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        this.sequencer.showGhostNotes = !this.sequencer.showGhostNotes;
        const btnGhost = document.getElementById('btn-toggle-ghost');
        btnGhost?.classList.toggle('active', this.sequencer.showGhostNotes);
        this.sequencer.render();
        return;
      }

      // Undo: Ctrl+Z (without Shift)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        this.undo();
        return;
      }

      // Redo: Ctrl+Y OR Ctrl+Shift+Z
      if ((e.ctrlKey || e.metaKey) && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
        e.preventDefault();
        this.redo();
        return;
      }

      // Copy: Ctrl+C OR c
      if (((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) || (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'c' || e.key === 'C'))) {
        e.preventDefault();
        this.copySelected();
        return;
      }

      // Cut: Ctrl+X
      if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        this.cutSelected();
        return;
      }

      // Delete: Delete, Backspace, OR x (without Ctrl/Alt)
      if (e.code === 'Delete' || e.code === 'Backspace' || (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'x' || e.key === 'X'))) {
        if (this.sequencer.selectedTriggerIds.size > 0) {
          e.preventDefault();
          this.deleteSelected();
          return;
        }
      }

      // Paste: Ctrl+V OR v
      if (((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) || (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'v' || e.key === 'V'))) {
        e.preventDefault();
        this.paste();
        return;
      }

      // Select All: Ctrl+A
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        this.selectAll();
        return;
      }

      // Deselect All: Escape
      if (e.key === 'Escape') {
        e.preventDefault();
        this.sequencer.deselectAll();
        return;
      }
    });
  }

  private togglePlay() {
    if (this.audioEngine.isAudioPlaying()) {
      this.audioEngine.pause();
    } else {
      const cur = this.sequencer.currentTimeMs;
      this.audioEngine.play(cur, this.lanes, this.triggers);
    }
  }

  private switchTab(tab: 'studio' | 'copier') {
    this.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));

    if (tab === 'studio') {
      document.getElementById('tab-studio')?.classList.add('active');
      document.getElementById('view-studio')?.classList.add('active');
      this.sequencer.resize();
    } else {
      document.getElementById('tab-copier')?.classList.add('active');
      document.getElementById('view-copier')?.classList.add('active');
      this.updateCopierTargetsList();
    }
  }

  // --- History & Clipboard Operations ---

  public pushHistorySnapshot() {
    const snapshot = this.triggers.map((t) => ({ ...t }));
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public undo() {
    if (this.undoStack.length === 0) {
      this.showToast('Nothing to undo');
      return;
    }
    this.redoStack.push(this.triggers.map((t) => ({ ...t })));
    this.triggers = this.undoStack.pop()!;

    const currentIds = new Set(this.triggers.map((t) => t.id));
    for (const id of this.sequencer.selectedTriggerIds) {
      if (!currentIds.has(id)) {
        this.sequencer.selectedTriggerIds.delete(id);
      }
    }

    this.updateSequencerData();
    this.showToast('↩ Undone');
  }

  public redo() {
    if (this.redoStack.length === 0) {
      this.showToast('Nothing to redo');
      return;
    }
    this.undoStack.push(this.triggers.map((t) => ({ ...t })));
    this.triggers = this.redoStack.pop()!;

    const currentIds = new Set(this.triggers.map((t) => t.id));
    for (const id of this.sequencer.selectedTriggerIds) {
      if (!currentIds.has(id)) {
        this.sequencer.selectedTriggerIds.delete(id);
      }
    }

    this.updateSequencerData();
    this.showToast('↪ Redone');
  }

  public copySelected() {
    const selected = this.triggers.filter((tr) => this.sequencer.selectedTriggerIds.has(tr.id));
    if (selected.length === 0) {
      this.showToast('No notes selected to copy');
      return;
    }
    selected.sort((a, b) => a.time - b.time);
    const minTime = selected[0].time;
    this.clipboard = selected.map((tr) => ({
      laneId: tr.laneId,
      relTime: tr.time - minTime,
      volume: tr.volume,
    }));
    this.showToast(`📋 Copied ${this.clipboard.length} note${this.clipboard.length > 1 ? 's' : ''}`);
  }

  public cutSelected() {
    const selected = this.triggers.filter((tr) => this.sequencer.selectedTriggerIds.has(tr.id));
    if (selected.length === 0) {
      this.showToast('No notes selected to cut');
      return;
    }
    this.copySelected();
    this.deleteSelected();
  }

  public paste() {
    if (this.clipboard.length === 0) {
      this.showToast('Clipboard empty');
      return;
    }
    this.pushHistorySnapshot();

    const pasteBaseTime = this.sequencer.snapTimeToGrid(this.sequencer.currentTimeMs);
    const laneIds = new Set(this.lanes.map((l) => l.id));
    const fallbackLaneId = this.lanes[0]?.id || '';
    const newSelectedIds = new Set<string>();

    for (const item of this.clipboard) {
      const laneId = laneIds.has(item.laneId) ? item.laneId : fallbackLaneId;
      const targetTime = Math.max(0, Math.round(pasteBaseTime + item.relTime));

      const existing = this.triggers.find((t) => t.laneId === laneId && Math.abs(t.time - targetTime) < 2);
      if (!existing) {
        const newTr: Trigger = {
          id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          laneId,
          time: targetTime,
          volume: item.volume,
        };
        this.triggers.push(newTr);
        newSelectedIds.add(newTr.id);
      } else {
        newSelectedIds.add(existing.id);
      }
    }

    this.sequencer.selectedTriggerIds = newSelectedIds;
    this.updateSequencerData();
    this.showToast(`📥 Pasted ${newSelectedIds.size} note${newSelectedIds.size > 1 ? 's' : ''}`);
  }

  public deleteSelected() {
    if (this.sequencer.selectedTriggerIds.size === 0) return;
    this.pushHistorySnapshot();
    const count = this.sequencer.selectedTriggerIds.size;
    const idSet = new Set(this.sequencer.selectedTriggerIds);
    this.triggers = this.triggers.filter((t) => !idSet.has(t.id));
    this.sequencer.selectedTriggerIds.clear();
    this.updateSequencerData();
    this.showToast(`🗑 Deleted ${count} note${count > 1 ? 's' : ''}`);
  }

  public selectAll() {
    this.sequencer.selectAll();
    this.showToast(`Selected all ${this.triggers.length} notes`);
  }

  public showToast(message: string) {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    container.innerHTML = '';
    const toast = document.createElement('div');
    toast.className = 'toast show';
    toast.textContent = message;
    container.appendChild(toast);

    if (this.toastTimeout !== null) {
      clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = window.setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
      this.toastTimeout = null;
    }, 1400);
  }

  // --- Dynamic Lanes Management ---

  public addNewLane(presetName?: string) {
    const colors = ['#ff4081', '#00e5ff', '#ffc400', '#76ff03', '#e040fb', '#ff6e40', '#40c4ff', '#b2ff59'];
    const color = colors[this.lanes.length % colors.length];

    const newLane: Lane = {
      id: `lane-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: presetName || `Lane ${this.lanes.length + 1}`,
      sampleSet: 'Soft',
      addition: 'Whistle',
      additionSet: 'Auto',
      customIndex: 0,
      volume: 85,
      color,
      muted: false,
      solo: false,
    };

    this.lanes.push(newLane);
    this.renderLanesList();
    this.updateSequencerData();
  }

  public removeLane(laneId: string) {
    if (this.lanes.length <= 1) {
      alert('Must keep at least 1 lane!');
      return;
    }
    this.lanes = this.lanes.filter((l) => l.id !== laneId);
    this.triggers = this.triggers.filter((t) => t.laneId !== laneId);
    this.renderLanesList();
    this.updateSequencerData();
  }

  private renderLanesList() {
    const container = document.getElementById('lanes-list');
    const titleEl = document.getElementById('rack-lanes-title');
    if (!container) return;
    if (titleEl) titleEl.textContent = `LANES (${this.lanes.length})`;

    container.innerHTML = '';

    const hasSolo = this.lanes.some((l) => l.solo);

    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      const el = document.createElement('div');
      const isMuted = lane.muted;
      const isSoloInactive = hasSolo && !lane.solo;
      el.className = `lane-item${isMuted ? ' is-muted' : ''}${isSoloInactive ? ' is-inactive' : ''}`;
      el.style.borderLeftColor = lane.color;

      el.innerHTML = `
        <div class="lane-top-row">
          <input type="text" class="lane-name-input" value="${lane.name}" title="Rename lane">
          <div class="lane-btns">
            <button class="btn-mute ${lane.muted ? 'active' : ''}" title="Mute lane">MUTE</button>
            <button class="btn-solo ${lane.solo ? 'active' : ''}" title="Solo lane">SOLO</button>
            <button class="btn-play-sample" title="Test sample">🔊</button>
            <button class="btn-del-lane" title="Delete lane">✕</button>
          </div>
        </div>

        <div class="lane-controls-row">
          <select class="lane-sampleset dropdown mini">
            <option value="Soft" ${lane.sampleSet === 'Soft' ? 'selected' : ''}>Soft</option>
            <option value="Normal" ${lane.sampleSet === 'Normal' ? 'selected' : ''}>Normal</option>
            <option value="Drum" ${lane.sampleSet === 'Drum' ? 'selected' : ''}>Drum</option>
          </select>

          <select class="lane-addition dropdown mini">
            <option value="None" ${lane.addition === 'None' ? 'selected' : ''}>None</option>
            <option value="Clap" ${lane.addition === 'Clap' ? 'selected' : ''}>Clap</option>
            <option value="Whistle" ${lane.addition === 'Whistle' ? 'selected' : ''}>Whistle</option>
            <option value="Finish" ${lane.addition === 'Finish' ? 'selected' : ''}>Finish</option>
          </select>

          <div class="lane-idx-group" title="Custom sample index (e.g. 1 for soft-hitclap.wav, 2 for soft-hitclap2.wav)">
            <span>#</span>
            <input type="number" class="lane-custom-idx" min="0" max="99" value="${lane.customIndex}">
          </div>

          <div class="lane-vol-group" title="Lane volume: ${lane.volume}%">
            <span>Vol</span>
            <input type="range" class="lane-volume range-slider mini" min="0" max="100" value="${lane.volume}">
          </div>
        </div>
      `;

      // Event bindings for this lane
      const nameInput = el.querySelector('.lane-name-input') as HTMLInputElement;
      nameInput.addEventListener('input', () => {
        lane.name = nameInput.value;
      });

      const btnMute = el.querySelector('.btn-mute') as HTMLButtonElement;
      btnMute.addEventListener('click', () => {
        lane.muted = !lane.muted;
        if (lane.muted) {
          lane.solo = false;
        }
        this.renderLanesList();
        this.updateSequencerData();
      });

      const btnSolo = el.querySelector('.btn-solo') as HTMLButtonElement;
      btnSolo.addEventListener('click', () => {
        lane.solo = !lane.solo;
        if (lane.solo) {
          lane.muted = false;
        }
        this.renderLanesList();
        this.updateSequencerData();
      });

      const btnPlaySample = el.querySelector('.btn-play-sample') as HTMLButtonElement;
      btnPlaySample.addEventListener('click', () => {
        const played = this.audioEngine.playSingleSample(lane);
        if (!played) {
          this.showToast(`No sample file loaded for "${lane.name}"`);
        }
      });

      const btnDel = el.querySelector('.btn-del-lane') as HTMLButtonElement;
      btnDel.addEventListener('click', () => {
        this.removeLane(lane.id);
      });

      const setSelect = el.querySelector('.lane-sampleset') as HTMLSelectElement;
      setSelect.addEventListener('change', () => {
        lane.sampleSet = setSelect.value as any;
        this.updateSequencerData();
      });

      const addSelect = el.querySelector('.lane-addition') as HTMLSelectElement;
      addSelect.addEventListener('change', () => {
        lane.addition = addSelect.value as any;
        this.updateSequencerData();
      });

      const idxInput = el.querySelector('.lane-custom-idx') as HTMLInputElement;
      idxInput.addEventListener('change', () => {
        lane.customIndex = parseInt(idxInput.value, 10) || 0;
        this.updateSequencerData();
      });

      const volSlider = el.querySelector('.lane-volume') as HTMLInputElement;
      volSlider.addEventListener('input', () => {
        lane.volume = parseInt(volSlider.value, 10) || 0;
        this.updateSequencerData();
      });

      container.appendChild(el);
    }
  }

  // --- Convert Existing Hitsound Diff into Lanes ---

  public importDiffIntoLanes(beatmap: OsuBeatmap, showAlert: boolean = true) {
    const res = importHitsoundsFromBeatmap(beatmap);
    if (res.lanes.length === 0) {
      if (showAlert) alert('No hitsound notes found in selected difficulty.');
      return;
    }

    this.lanes = res.lanes;
    this.triggers = res.triggers;
    this.undoStack = [];
    this.redoStack = [];
    this.renderLanesList();
    this.updateSequencerData();
    if (showAlert) {
      alert(`Imported ${res.lanes.length} lanes and ${res.importedNoteCount} hitsound triggers from [${beatmap.metadata.Version || 'Diff'}]!`);
    }
  }

  // --- Reset All Project State ---

  public resetProject() {
    if (this.audioEngine.isAudioPlaying()) {
      this.audioEngine.pause();
    }
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.audioEngine.seek(0, [], []);
    this.audioEngine.clear();

    this.rawZipFiles.clear();
    this.allBeatmaps = [];
    this.referenceBeatmap = null;
    this.customSamples.clear();

    this.title = 'New Project';
    this.artist = 'Unknown Artist';
    this.creator = 'Mapper';
    this.audioFileName = 'audio.mp3';

    this.initDefaultLanes();
    this.initDefaultTiming();
    this.triggers = [];
    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = [];

    // Clear file inputs so re-importing the same file works
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    if (fileInput) fileInput.value = '';

    this.renderLanesList();
    this.updateBeatmapSelectors();
    this.sequencer.resetView();
    this.updateSequencerData();
    this.updateTimeDisplay(0);

    const playIcon = document.getElementById('play-icon');
    if (playIcon) playIcon.textContent = '▶';
  }

  // --- File Ingestion (.osz, .osu, audio) ---

  public async handleFiles(files: File[]) {
    for (const file of files) {
      const lower = file.name.toLowerCase();

      if (lower.endsWith('.osz') || lower.endsWith('.zip')) {
        await this.loadOsz(file);
      } else if (lower.endsWith('.osu')) {
        const text = await file.text();
        const parsed = parseOsu(text, file.name);
        this.addBeatmap(parsed);
        const isHs = (parsed.metadata.Version || '').toLowerCase().includes('hitsound') || (parsed.metadata.Version || '').toLowerCase() === 'hs';
        if (isHs || this.triggers.length === 0) {
          this.importDiffIntoLanes(parsed, false);
        }
      } else if (lower.endsWith('.mp3') || lower.endsWith('.ogg') || lower.endsWith('.wav')) {
        if (lower.includes('hit') || lower.includes('clap') || lower.includes('whistle') || lower.includes('finish') || lower.includes('slider')) {
          try {
            const buf = await this.audioEngine.decodeSampleAudio(await file.arrayBuffer());
            this.customSamples.set(file.name.toLowerCase(), buf);
            this.audioEngine.setCustomSamples(this.customSamples);
          } catch (e) {
            console.warn('Could not decode sample:', file.name, e);
          }
        } else {
          await this.loadSongAudio(file);
        }
      }
    }
  }

  public async loadOsz(file: File) {
    try {
      const zip = await JSZip.loadAsync(file);
      this.rawZipFiles.clear();
      this.allBeatmaps = [];
      this.customSamples.clear();

      // Clear any old triggers from demo so mapper starts fresh
      this.triggers = [];

      // 1. Extract and store all files as Uint8Array
      for (const [filename, zipEntry] of Object.entries(zip.files)) {
        if (!zipEntry.dir) {
          const bytes = await zipEntry.async('uint8array');
          this.rawZipFiles.set(filename, bytes);
        }
      }

      // 2. Parse all .osu files
      for (const [filename, bytes] of this.rawZipFiles.entries()) {
        if (filename.toLowerCase().endsWith('.osu')) {
          const text = new TextDecoder('utf-8').decode(bytes);
          const parsed = parseOsu(text, filename);
          this.allBeatmaps.push(parsed);
        }
      }

      if (this.allBeatmaps.length === 0) {
        alert('No .osu beatmap files found in the archive!');
        return;
      }

      // 3. Find and decode main song audio
      let audioName = this.allBeatmaps[0].general.AudioFilename || 'audio.mp3';
      let foundSong = false;
      for (const [filename, bytes] of this.rawZipFiles.entries()) {
        if (filename.toLowerCase() === audioName.toLowerCase()) {
          const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          await this.audioEngine.decodeSongAudio(arrayBuf);
          this.audioFileName = filename;
          foundSong = true;
          break;
        }
      }

      // If audioName didn't match, fallback to any mp3/ogg not containing 'hit'
      if (!foundSong) {
        for (const [filename, bytes] of this.rawZipFiles.entries()) {
          const lower = filename.toLowerCase();
          if ((lower.endsWith('.mp3') || lower.endsWith('.ogg')) && !lower.includes('hit')) {
            const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            await this.audioEngine.decodeSongAudio(arrayBuf);
            this.audioFileName = filename;
            foundSong = true;
            break;
          }
        }
      }

      // 4. Decode custom hitsound samples (.wav and .ogg)
      for (const [filename, bytes] of this.rawZipFiles.entries()) {
        const lower = filename.toLowerCase();
        if (lower.endsWith('.wav') || lower.endsWith('.ogg')) {
          try {
            const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            const sampleBuffer = await this.audioEngine.decodeSampleAudio(arrayBuf);
            this.customSamples.set(lower, sampleBuffer);
          } catch {
            // Ignore corrupted/unsupported sample
          }
        }
      }
      this.audioEngine.setCustomSamples(this.customSamples);

      // 5. Intelligent Separation & Ghost setup:
      const hsDiff = this.allBeatmaps.find(
        (bm) => (bm.metadata.Version || '').toLowerCase().includes('hitsound') || (bm.metadata.Version || '').toLowerCase() === 'hs'
      );

      // Playable diffs (excluding hitsound diff)
      const playableDiffs = this.allBeatmaps.filter(
        (bm) => !(bm.metadata.Version || '').toLowerCase().includes('hitsound') && (bm.metadata.Version || '').toLowerCase() !== 'hs'
      );
      playableDiffs.sort((a, b) => b.hitObjects.length - a.hitObjects.length);

      if (hsDiff) {
        // Automatically import hitsound diff straight into lanes (no confirm prompt)
        this.importDiffIntoLanes(hsDiff, false);
        // Default ghost notes to top playable diff
        this.referenceBeatmap = playableDiffs[0] || hsDiff;
      } else {
        // Mapset without hitsound diff (like Fallen Symphony) -> auto-separate top diff into lanes!
        const topDiff = playableDiffs[0] || this.allBeatmaps[0];
        this.referenceBeatmap = topDiff;
        this.importDiffIntoLanes(topDiff, false);
      }

      // Sync metadata & timing from reference diff
      if (this.referenceBeatmap) {
        this.timingPoints = this.referenceBeatmap.timingPoints.length > 0 ? this.referenceBeatmap.timingPoints : this.timingPoints;
        this.title = this.referenceBeatmap.metadata.Title || this.title;
        this.artist = this.referenceBeatmap.metadata.Artist || this.artist;
        this.creator = this.referenceBeatmap.metadata.Creator || this.creator;
      }

      this.updateBeatmapSelectors();
      this.updateSequencerData();
    } catch (err) {
      console.error('Error importing .osz:', err);
      alert(`Failed to import .osz: ${err}`);
    }
  }

  private async loadSongAudio(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    await this.audioEngine.decodeSongAudio(arrayBuffer);
    this.audioFileName = file.name;
    this.updateSequencerData();
  }

  private addBeatmap(bm: OsuBeatmap) {
    this.allBeatmaps.push(bm);

    if (!this.referenceBeatmap) {
      this.referenceBeatmap = bm;
      this.timingPoints = bm.timingPoints.length > 0 ? bm.timingPoints : this.timingPoints;
      this.title = bm.metadata.Title || 'Project';
      this.artist = bm.metadata.Artist || 'Artist';
      this.creator = bm.metadata.Creator || 'Mapper';
    }

    this.updateBeatmapSelectors();
  }

  private updateBeatmapSelectors() {
    const refSelect = document.getElementById('select-reference-diff') as HTMLSelectElement;
    if (refSelect) {
      refSelect.innerHTML = '<option value="">None</option>';
      const playables = this.allBeatmaps.filter(
        (bm) => !(bm.metadata.Version || '').toLowerCase().includes('hitsound') && (bm.metadata.Version || '').toLowerCase() !== 'hs'
      );
      const diffsToShow = playables.length > 0 ? playables : this.allBeatmaps;

      for (const bm of diffsToShow) {
        const opt = document.createElement('option');
        const ver = bm.metadata.Version || bm.fileName;
        opt.value = ver;
        opt.textContent = `${ver} (${bm.hitObjects.length} notes)`;
        if (this.referenceBeatmap && (this.referenceBeatmap.metadata.Version || this.referenceBeatmap.fileName) === ver) {
          opt.selected = true;
        }
        refSelect.appendChild(opt);
      }
    }

    this.updateCopierTargetsList();
  }

  private updateCopierTargetsList() {
    const container = document.getElementById('copier-targets-list');
    if (!container) return;

    if (this.allBeatmaps.length === 0) {
      container.innerHTML = '<div class="empty-state">No other difficulties loaded yet. Import an .osz file.</div>';
      return;
    }

    container.innerHTML = '';
    for (const bm of this.allBeatmaps) {
      const ver = bm.metadata.Version || bm.fileName;
      // Default hitsound diff uncheck, playables check
      const isHs = ver.toLowerCase().includes('hitsound');
      const row = document.createElement('label');
      row.className = 'checkbox-label target-row';
      row.innerHTML = `
        <input type="checkbox" class="target-diff-cb" value="${bm.fileName}" ${!isHs ? 'checked' : ''}>
        <span><strong>${ver}</strong> (${bm.hitObjects.length} objects)</span>
      `;
      container.appendChild(row);
    }
  }

  // --- Exporting & Copier Execution ---

  public getBaseBeatmap(): OsuBeatmap {
    if (this.referenceBeatmap) return this.referenceBeatmap;
    if (this.allBeatmaps.length > 0) return this.allBeatmaps[0];

    // Minimal fallback
    return {
      version: 14,
      general: { AudioFilename: this.audioFileName, SampleSet: 'Soft', Mode: '0' },
      editor: { BeatDivisor: '4', GridSize: '16', TimelineZoom: '2' },
      metadata: { Title: this.title, Artist: this.artist, Creator: this.creator, Version: 'Hitsounds' },
      difficulty: { HPDrainRate: '5', CircleSize: '4', OverallDifficulty: '5', ApproachRate: '9', SliderMultiplier: '1.4', SliderTickRate: '1' },
      events: [],
      timingPoints: this.timingPoints,
      colours: {},
      hitObjects: [],
      rawText: '',
      fileName: 'Hitsounds.osu',
    };
  }

  public exportHitsoundDiff() {
    const base = this.getBaseBeatmap();
    const result = generateHitsoundBeatmap(this.lanes, this.triggers, base, 'Hitsounds');

    const blob = new Blob([result.osuString], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.beatmap.fileName;
    a.click();
    URL.revokeObjectURL(url);

    alert(`Exported [Hitsounds].osu with ${result.totalNotes} hitsound notes placed at (256, 192)!`);
  }

  public async executeCopier(saveAsOsz: boolean) {
    const consoleEl = document.getElementById('copier-console')!;
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = '<div class="log-line">Running Hitsound Copier...</div>';

    // 1. Prepare Source Beatmap
    const sourceResult = generateHitsoundBeatmap(this.lanes, this.triggers, this.getBaseBeatmap(), 'Hitsounds');
    const sourceBeatmap = sourceResult.beatmap;

    // 2. Collect selected target diffs
    const selectedFileNames = new Set<string>();
    document.querySelectorAll<HTMLInputElement>('.target-diff-cb:checked').forEach((cb) => {
      selectedFileNames.add(cb.value);
    });

    const targetBeatmaps = this.allBeatmaps.filter((bm) => selectedFileNames.has(bm.fileName));

    if (targetBeatmaps.length === 0) {
      consoleEl.innerHTML += '<div class="log-line error">❌ No target difficulties selected!</div>';
      return;
    }

    // 3. Collect options
    const options: CopierOptions = {
      snapToleranceMs: parseInt((document.getElementById('copier-snap') as HTMLInputElement).value, 10) || 5,
      copyAdditions: (document.getElementById('opt-additions') as HTMLInputElement).checked,
      copySampleSets: (document.getElementById('opt-samplesets') as HTMLInputElement).checked,
      copyCustomIndices: (document.getElementById('opt-indices') as HTMLInputElement).checked,
      copyVolumes: (document.getElementById('opt-volumes') as HTMLInputElement).checked,
      copyToSliderHeads: (document.getElementById('opt-heads') as HTMLInputElement).checked,
      copyToSliderRepeats: (document.getElementById('opt-repeats') as HTMLInputElement).checked,
      copyToSliderTails: (document.getElementById('opt-tails') as HTMLInputElement).checked,
      copyToSpinners: (document.getElementById('opt-spinners') as HTMLInputElement).checked,
      cleanExistingAdditions: (document.getElementById('opt-clean') as HTMLInputElement).checked,
    };

    const results = copyHitsounds(sourceBeatmap, targetBeatmaps, options);

    for (const res of results) {
      consoleEl.innerHTML += `
        <div class="log-line success">
          ✔ <strong>${res.version}</strong>: Matched ${res.stats.matchedObjects}/${res.stats.totalObjects} objects 
          (${res.stats.sliderEdgesMatched} slider edges), merged ${res.stats.timingPointsMerged} timing points.
        </div>
      `;
    }

    // 4. Package output
    if (saveAsOsz) {
      const zip = new JSZip();

      // Copy existing files (images, audio, etc.)
      for (const [fname, bytes] of this.rawZipFiles.entries()) {
        zip.file(fname, bytes);
      }

      // Add Hitsounds diff
      zip.file(sourceBeatmap.fileName, sourceResult.osuString);

      // Overwrite target diffs
      for (const res of results) {
        zip.file(res.fileName, res.osuString);
      }

      consoleEl.innerHTML += '<div class="log-line">Generating .osz archive...</div>';
      const oszBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(oszBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.artist} - ${this.title}.osz`;
      a.click();
      URL.revokeObjectURL(url);
      consoleEl.innerHTML += '<div class="log-line success">🎉 Done! Downloaded updated .osz archive.</div>';
    } else {
      // Download individual diffs as a zip
      const zip = new JSZip();
      zip.file(sourceBeatmap.fileName, sourceResult.osuString);
      for (const res of results) {
        zip.file(res.fileName, res.osuString);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hitsounded_diffs.zip`;
      a.click();
      URL.revokeObjectURL(url);
      consoleEl.innerHTML += '<div class="log-line success">🎉 Done! Downloaded zip with updated .osu diffs.</div>';
    }
  }

  public async downloadFullOsz() {
    await this.executeCopier(true);
  }
}
