import JSZip from 'jszip';
import { AudioEngine } from '../audio/audioEngine';
import { Sequencer } from '../editor/sequencer';
import { copyHitsounds } from '../osu/copier';
import { generateHitsoundBeatmap } from '../osu/hitsoundGenerator';
import { importHitsoundsFromBeatmap } from '../osu/hitsoundImporter';
import { parseOsu } from '../osu/parser';
import {
  clearSessionCache,
  loadSessionFromCache,
  saveSessionToCache,
  type CachedSessionRecord,
} from '../storage/sessionCache';
import type {
  AdditionType,
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
  private rawSongAudioData: ArrayBuffer | null = null;
  private laneDroppedSamples: Map<string, Uint8Array> = new Map();
  private autoSaveTimeout: number | null = null;

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
  private isCompactLanes: boolean = false;

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
    this.checkRecentSessionOnStartup();
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
            <div class="bpm-display" id="bpm-display" title="Active BPM at playhead">120 BPM</div>

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
              <input type="number" id="num-vol-song" min="0" max="100" value="80" class="vol-num-input" title="Song Volume %"><span class="pct-sign">%</span>
              <span>🔔</span>
              <input type="range" id="vol-hs" min="0" max="100" value="90" title="Hitsound Volume" class="range-slider mini">
              <input type="number" id="num-vol-hs" min="0" max="100" value="90" class="vol-num-input" title="Hitsound Volume %"><span class="pct-sign">%</span>
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
                  <div class="rack-top-actions">
                    <button id="btn-toggle-compact" class="btn btn-sm btn-outline" title="Toggle compact lanes mode (see more lanes)">⊟ Compact</button>
                    <div class="add-lane-btn-group">
                      <button id="btn-add-lane" class="btn btn-sm btn-primary">+ Add Lane</button>
                      <button id="btn-add-lane-menu" class="btn btn-sm btn-primary btn-arrow" title="Add specific addition lane">▾</button>
                      <div id="add-lane-menu" class="add-lane-menu" style="display: none;">
                        <div class="add-lane-menu-item" data-add="Clap">👏 Add Soft Clap</div>
                        <div class="add-lane-menu-item" data-add="Whistle">🎵 Add Soft Whistle</div>
                        <div class="add-lane-menu-item" data-add="Finish">💥 Add Soft Finish</div>
                        <div class="add-lane-menu-item" data-add="None">🥁 Add HitNormal</div>
                      </div>
                    </div>
                  </div>
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
                💡 <strong>Click</strong>: Place | <strong>Drag</strong>: Select | <strong>W/E/R</strong>: Toggle Additions | <strong>Drop audio</strong>: Load Sample | <strong>Ctrl+Z</strong>: Undo | <strong>C / V</strong>: Copy/Paste
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
      onMoveTriggers: (moves) => {
        this.moveTriggers(moves);
      },
    });

    // Synchronize vertical scroll from left rack to canvas
    lanesList?.addEventListener('scroll', () => {
      this.sequencer.setScrollTop(lanesList.scrollTop);
    });

    lanesList?.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const maxScrollTop = Math.max(0, this.lanes.length * this.sequencer.laneHeight - (lanesList.clientHeight || 500));
        const newScroll = Math.max(0, Math.min(maxScrollTop, this.sequencer.scrollTopPx + e.deltaY));
        this.sequencer.scrollTopPx = newScroll;
        lanesList.scrollTop = newScroll;
        this.sequencer.render();
      },
      { passive: false }
    );

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

        // Active lane luminous flash during playback
        const activeIds = this.sequencer.getActiveLaneIds(cur, 80);
        this.sequencer.setActivePlayingLanes(activeIds);
        this.updateActiveLaneDomIndicators(activeIds);

        this.animFrameId = requestAnimationFrame(tick);
      } else {
        this.animFrameId = null;
        this.sequencer.setActivePlayingLanes(new Set());
        this.updateActiveLaneDomIndicators(new Set());
      }
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private flashLane(laneId: string) {
    const el = document.querySelector(`.lane-item[data-lane-id="${laneId}"]`);
    if (el) {
      el.classList.add('is-playing');
      setTimeout(() => el.classList.remove('is-playing'), 140);
    }
  }

  private updateActiveLaneDomIndicators(activeIds: Set<string>) {
    const items = document.querySelectorAll<HTMLElement>('.lane-item');
    items.forEach((item) => {
      const laneId = item.getAttribute('data-lane-id');
      if (laneId && activeIds.has(laneId)) {
        item.classList.add('is-playing');
      } else {
        item.classList.remove('is-playing');
      }
    });
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
    this.scheduleAutoSave();
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
      } else {
        if (this.animFrameId !== null) {
          cancelAnimationFrame(this.animFrameId);
          this.animFrameId = null;
        }
        this.sequencer.setActivePlayingLanes(new Set());
        this.updateActiveLaneDomIndicators(new Set());
      }
    };
  }

  private updateTimeDisplay(ms: number) {
    const disp = document.getElementById('time-display');
    if (disp) {
      const totalSec = Math.max(0, ms / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = Math.floor(totalSec % 60);
      const millis = Math.floor(ms % 1000);

      const mStr = String(mins).padStart(2, '0');
      const sStr = String(secs).padStart(2, '0');
      const msStr = String(millis).padStart(3, '0');

      disp.textContent = `${mStr}:${sStr}.${msStr}`;
    }

    if (this.sequencer) {
      const bpmDisp = document.getElementById('bpm-display');
      if (bpmDisp) {
        const bpm = this.sequencer.getActiveBpm(ms);
        bpmDisp.textContent = `${bpm} BPM`;
      }
    }
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

    // Volumes: slider <-> numeric % input sync
    const volSongSlider = document.getElementById('vol-song') as HTMLInputElement;
    const numVolSong = document.getElementById('num-vol-song') as HTMLInputElement;
    const volHsSlider = document.getElementById('vol-hs') as HTMLInputElement;
    const numVolHs = document.getElementById('num-vol-hs') as HTMLInputElement;

    volSongSlider?.addEventListener('input', () => {
      const val = parseInt(volSongSlider.value, 10) || 0;
      if (numVolSong) numVolSong.value = String(val);
      this.audioEngine.setSongVolume(val / 100);
    });
    numVolSong?.addEventListener('input', () => {
      let val = parseInt(numVolSong.value, 10);
      if (isNaN(val)) val = 0;
      val = Math.max(0, Math.min(100, val));
      if (volSongSlider) volSongSlider.value = String(val);
      this.audioEngine.setSongVolume(val / 100);
    });
    numVolSong?.addEventListener('blur', () => {
      numVolSong.value = volSongSlider ? volSongSlider.value : '80';
    });

    volHsSlider?.addEventListener('input', () => {
      const val = parseInt(volHsSlider.value, 10) || 0;
      if (numVolHs) numVolHs.value = String(val);
      this.audioEngine.setHitsoundVolume(val / 100);
    });
    numVolHs?.addEventListener('input', () => {
      let val = parseInt(numVolHs.value, 10);
      if (isNaN(val)) val = 0;
      val = Math.max(0, Math.min(100, val));
      if (volHsSlider) volHsSlider.value = String(val);
      this.audioEngine.setHitsoundVolume(val / 100);
    });
    numVolHs?.addEventListener('blur', () => {
      numVolHs.value = volHsSlider ? volHsSlider.value : '90';
    });

    // Tabs
    document.getElementById('tab-studio')?.addEventListener('click', () => this.switchTab('studio'));
    document.getElementById('tab-copier')?.addEventListener('click', () => this.switchTab('copier'));

    // Toggle Compact Lanes Mode
    document.getElementById('btn-toggle-compact')?.addEventListener('click', () => {
      this.toggleCompactLanes();
    });

    // Add Lane Button and Dropdown Menu
    document.getElementById('btn-add-lane')?.addEventListener('click', () => this.addNewLane());

    const btnMenu = document.getElementById('btn-add-lane-menu');
    const addMenu = document.getElementById('add-lane-menu');
    btnMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (addMenu) {
        addMenu.style.display = addMenu.style.display === 'none' ? 'block' : 'none';
      }
    });

    document.querySelectorAll<HTMLElement>('.add-lane-menu-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const add = item.getAttribute('data-add') as any;
        if (add) {
          this.addNewLaneWithAddition(add);
        }
        if (addMenu) addMenu.style.display = 'none';
      });
    });

    document.addEventListener('click', (e) => {
      if (addMenu && !addMenu.contains(e.target as Node) && e.target !== btnMenu) {
        addMenu.style.display = 'none';
      }
    });

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
      // If dropped directly onto a lane item, let the lane handle the sample file
      if ((e.target as HTMLElement)?.closest('.lane-item')) {
        return;
      }
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

      // Toggle Additions on Selected Notes: W (Whistle), E (Finish), R (Clap)
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          this.toggleAdditionOnSelected('Whistle');
          return;
        }
        if (e.key === 'e' || e.key === 'E') {
          e.preventDefault();
          this.toggleAdditionOnSelected('Finish');
          return;
        }
        if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          this.toggleAdditionOnSelected('Clap');
          return;
        }
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

  public moveTriggers(moves: { id: string; laneId: string; time: number }[]) {
    const moveMap = new Map(moves.map((m) => [m.id, m]));
    for (const tr of this.triggers) {
      const m = moveMap.get(tr.id);
      if (m) {
        tr.laneId = m.laneId;
        tr.time = m.time;
      }
    }
    // Deduplicate in case notes land on exact same lane & time
    const seen = new Set<string>();
    this.triggers = this.triggers.filter((t) => {
      const key = `${t.laneId}_${t.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.triggers.sort((a, b) => a.time - b.time);
    this.updateSequencerData();
  }

  // --- Session Caching & Persistence ---

  private async checkRecentSessionOnStartup() {
    try {
      const cached = await loadSessionFromCache();
      if (!cached || !cached.project) return;

      const p = cached.project;
      const hasNotes = p.triggers && p.triggers.length > 0;
      const hasBeatmaps = p.allBeatmaps && p.allBeatmaps.length > 0;
      const hasAudio = Boolean(cached.songAudioBytes);
      const isCustomized = p.title !== 'New Project' || (p.lanes && p.lanes.length !== 3);

      if (!hasNotes && !hasBeatmaps && !hasAudio && !isCustomized) {
        return;
      }

      this.showResumeSessionModal(cached);
    } catch (err) {
      console.warn('[Cache] Error checking startup session:', err);
    }
  }

  private formatRelativeTime(timestamp: number): string {
    const diffMs = Date.now() - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}h ago`;
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private showResumeSessionModal(cached: CachedSessionRecord) {
    document.getElementById('session-resume-modal')?.remove();

    const p = cached.project;
    const projectTitle = p.artist && p.title ? `${p.artist} - ${p.title}` : (p.title || 'Untitled Project');
    const noteCount = p.triggers ? p.triggers.length : 0;
    const laneCount = p.lanes ? p.lanes.length : 0;
    const diffCount = p.allBeatmaps ? p.allBeatmaps.length : 0;
    const timeStr = this.formatRelativeTime(cached.savedAt);

    const backdrop = document.createElement('div');
    backdrop.id = 'session-resume-modal';
    backdrop.className = 'modal-backdrop';

    backdrop.innerHTML = `
      <div class="session-modal" role="dialog" aria-modal="true">
        <div class="session-modal-header">
          <span class="session-modal-tag">💾 Previous Session Found</span>
          <button class="btn-close-modal" id="btn-modal-close" title="Dismiss">✕</button>
        </div>
        <div class="session-modal-body">
          <h2 class="session-modal-title">Continue from previous session?</h2>
          <p class="session-modal-desc">
            We found your project from your previous studio session in your browser cache.
          </p>

          <div class="session-details-card">
            <div class="session-details-title" title="${projectTitle}">${projectTitle}</div>
            <div class="session-details-grid">
              <div class="session-details-item">
                <span>🔔</span>
                <span><strong>${noteCount}</strong> notes placed</span>
              </div>
              <div class="session-details-item">
                <span>🎚</span>
                <span><strong>${laneCount}</strong> lanes configured</span>
              </div>
              <div class="session-details-item">
                <span>📑</span>
                <span><strong>${diffCount}</strong> difficulties</span>
              </div>
              <div class="session-details-item">
                <span>🕒</span>
                <span>Saved <strong>${timeStr}</strong></span>
              </div>
            </div>
          </div>
        </div>
        <div class="session-modal-actions">
          <button id="btn-modal-fresh" class="btn btn-secondary">Start Fresh</button>
          <button id="btn-modal-resume" class="btn btn-primary btn-lg">⚡ Resume Session</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const closeModal = () => {
      backdrop.remove();
    };

    const handleResume = async () => {
      closeModal();
      await this.resumeSession(cached);
    };

    const handleFresh = async () => {
      closeModal();
      await clearSessionCache();
      this.showToast('✨ Started fresh project');
    };

    document.getElementById('btn-modal-resume')?.addEventListener('click', handleResume);
    document.getElementById('btn-modal-fresh')?.addEventListener('click', handleFresh);
    document.getElementById('btn-modal-close')?.addEventListener('click', closeModal);

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.removeEventListener('keydown', keyHandler);
        handleResume();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        window.removeEventListener('keydown', keyHandler);
        closeModal();
      }
    };
    window.addEventListener('keydown', keyHandler);
  }

  public async resumeSession(cached: CachedSessionRecord) {
    try {
      this.showToast('⏳ Resuming session...');
      const p = cached.project;

      this.title = p.title || this.title;
      this.artist = p.artist || this.artist;
      this.creator = p.creator || this.creator;
      this.audioFileName = p.audioFileName || this.audioFileName;

      this.lanes = p.lanes || this.lanes;
      this.triggers = p.triggers || [];
      this.timingPoints = p.timingPoints || this.timingPoints;
      this.allBeatmaps = p.allBeatmaps || [];
      this.undoStack = [];
      this.redoStack = [];

      // Restore raw zip files
      if (cached.zipEntries && cached.zipEntries.length > 0) {
        this.rawZipFiles = new Map(cached.zipEntries);
        this.audioEngine.setRawSampleFiles(this.rawZipFiles);
      }

      // Restore song audio
      if (cached.songAudioBytes) {
        this.rawSongAudioData = cached.songAudioBytes;
        await this.audioEngine.decodeSongAudio(cached.songAudioBytes);
      }

      // Restore custom samples dropped on lanes
      if (cached.laneSampleBytes) {
        for (const [laneId, bytes] of Object.entries(cached.laneSampleBytes)) {
          this.laneDroppedSamples.set(laneId, bytes);
          const lane = this.lanes.find((l) => l.id === laneId);
          if (lane) {
            try {
              const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
              lane.audioBuffer = await this.audioEngine.decodeSampleAudio(arrayBuf);
            } catch (e) {
              console.warn(`Could not decode custom sample for lane ${laneId}:`, e);
            }
          }
        }
      }

      // Restore reference beatmap
      if (p.referenceVersion) {
        this.referenceBeatmap = this.allBeatmaps.find((bm) => (bm.metadata.Version || '') === p.referenceVersion) || null;
      } else if (this.allBeatmaps.length > 0) {
        this.referenceBeatmap = this.allBeatmaps[0];
      }

      // Update UI components
      this.updateBeatmapSelectors();
      this.renderLanesList();
      this.updateSequencerData();
      this.updateCopierTargetsList();

      this.showToast(`✔ Resumed: ${this.artist} - ${this.title}`);
    } catch (err) {
      console.error('Failed to resume session:', err);
      this.showToast('❌ Error restoring previous session');
    }
  }

  public scheduleAutoSave() {
    if (this.autoSaveTimeout !== null) {
      window.clearTimeout(this.autoSaveTimeout);
    }

    this.autoSaveTimeout = window.setTimeout(async () => {
      this.autoSaveTimeout = null;
      await this.saveCurrentSession();
    }, 1500);
  }

  public async saveCurrentSession() {
    const hasNotes = this.triggers.length > 0;
    const hasBeatmaps = this.allBeatmaps.length > 0;
    const hasAudio = Boolean(this.rawSongAudioData);
    const isCustomized = this.title !== 'New Project' || this.lanes.length !== 3;

    if (!hasNotes && !hasBeatmaps && !hasAudio && !isCustomized) {
      return;
    }

    const serializableLanes = this.lanes.map((l) => ({
      id: l.id,
      name: l.name,
      sampleSet: l.sampleSet,
      addition: l.addition,
      additionSet: l.additionSet,
      customIndex: l.customIndex,
      volume: l.volume,
      color: l.color,
      muted: l.muted,
      solo: l.solo,
      customSampleName: l.customSampleName,
    }));

    const zipEntries: [string, Uint8Array][] = [];
    for (const [name, bytes] of this.rawZipFiles.entries()) {
      const lower = name.toLowerCase();
      if (lower.endsWith('.mp4') || lower.endsWith('.avi') || lower.endsWith('.flv') || lower.endsWith('.mkv')) {
        continue;
      }
      if (bytes.length > 25 * 1024 * 1024) continue;
      zipEntries.push([name, bytes]);
    }

    const laneSampleObj: Record<string, Uint8Array> = {};
    for (const [laneId, bytes] of this.laneDroppedSamples.entries()) {
      laneSampleObj[laneId] = bytes;
    }

    const record: CachedSessionRecord = {
      id: 'current',
      savedAt: Date.now(),
      project: {
        title: this.title,
        artist: this.artist,
        creator: this.creator,
        audioFileName: this.audioFileName,
        lanes: serializableLanes as Lane[],
        triggers: this.triggers,
        timingPoints: this.timingPoints,
        allBeatmaps: this.allBeatmaps,
        referenceVersion: this.referenceBeatmap?.metadata?.Version || null,
        savedAt: Date.now(),
      },
      songAudioBytes: this.rawSongAudioData || undefined,
      laneSampleBytes: Object.keys(laneSampleObj).length > 0 ? laneSampleObj : undefined,
      zipEntries: zipEntries.length > 0 ? zipEntries : undefined,
    };

    await saveSessionToCache(record);
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

  public toggleCompactLanes() {
    this.isCompactLanes = !this.isCompactLanes;
    const rack = document.querySelector('.channel-rack');
    const btn = document.getElementById('btn-toggle-compact');
    if (rack) {
      rack.classList.toggle('is-compact', this.isCompactLanes);
    }
    if (btn) {
      btn.textContent = this.isCompactLanes ? '⊞ Expand' : '⊟ Compact';
      btn.title = this.isCompactLanes ? 'Expand lanes to show all controls' : 'Compact lanes to see more tracks';
    }
    this.sequencer.setLaneHeight(this.isCompactLanes ? 28 : 58);
  }

  public addNewLaneWithAddition(addition: AdditionType) {
    const colors: Record<AdditionType, string> = {
      Whistle: '#00e5ff',
      Clap: '#ff4081',
      Finish: '#ffc400',
      None: '#76ff03',
    };
    const names: Record<AdditionType, string> = {
      Whistle: 'Soft Whistle',
      Clap: 'Soft Clap',
      Finish: 'Soft Finish',
      None: 'Soft Normal',
    };

    const count = this.lanes.filter((l) => l.addition === addition).length + 1;
    const newLane: Lane = {
      id: `lane-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${names[addition]} ${count}`,
      sampleSet: 'Soft',
      addition,
      additionSet: 'Auto',
      customIndex: 0,
      volume: 85,
      color: colors[addition] || '#ff4081',
      muted: false,
      solo: false,
    };

    this.lanes.push(newLane);
    this.renderLanesList();
    this.updateSequencerData();
    this.showToast(`Added lane: ${newLane.name}`);
  }

  public toggleAdditionOnSelected(addition: 'Whistle' | 'Finish' | 'Clap') {
    if (this.sequencer.selectedTriggerIds.size === 0) {
      this.showToast(`Select notes first to toggle ${addition} (W: Whistle, E: Finish, R: Clap)`);
      return;
    }

    // Find or create a target lane with this addition
    let targetLane = this.lanes.find((l) => l.addition === addition && !l.muted);
    if (!targetLane) {
      targetLane = this.lanes.find((l) => l.addition === addition);
    }
    if (!targetLane) {
      this.addNewLaneWithAddition(addition);
      targetLane = this.lanes[this.lanes.length - 1];
    }

    this.pushHistorySnapshot();

    const selectedTriggers = this.triggers.filter((t) => this.sequencer.selectedTriggerIds.has(t.id));
    const timestamps = Array.from(new Set(selectedTriggers.map((t) => t.time)));

    // Check if all selected timestamps already have this addition on targetLane
    const existingOnTarget = this.triggers.filter((t) => t.laneId === targetLane!.id);
    const existingTimes = new Set(existingOnTarget.map((t) => t.time));

    const allHaveIt = timestamps.every((time) => existingTimes.has(time));

    let addedCount = 0;
    let removedCount = 0;

    if (allHaveIt) {
      // Toggle off: remove triggers on targetLane at these timestamps
      const removeTimeSet = new Set(timestamps);
      this.triggers = this.triggers.filter((t) => !(t.laneId === targetLane!.id && removeTimeSet.has(t.time)));
      removedCount = timestamps.length;
    } else {
      // Toggle on: add triggers on targetLane for missing timestamps
      for (const time of timestamps) {
        if (!existingTimes.has(time)) {
          const newTr: Trigger = {
            id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            laneId: targetLane.id,
            time,
          };
          this.triggers.push(newTr);
          this.sequencer.selectedTriggerIds.add(newTr.id);
          addedCount++;
        }
      }
    }

    this.updateSequencerData();
    if (allHaveIt) {
      this.showToast(`Removed ${addition} from ${removedCount} note${removedCount > 1 ? 's' : ''}`);
    } else {
      this.showToast(`Added ${addition} to ${addedCount} note${addedCount > 1 ? 's' : ''}`);
    }
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
    this.laneDroppedSamples.delete(laneId);
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
      el.setAttribute('data-lane-id', lane.id);
      el.style.borderLeftColor = lane.color;

      const hasCustomSample = Boolean(lane.audioBuffer || lane.customSampleName);
      const customSampleBadge = hasCustomSample ? `<span class="badge-custom-sample" title="Custom sample loaded">SAMPLE</span>` : '';

      el.innerHTML = `
        <div class="lane-top-row">
          <div class="lane-name-wrapper">
            <span class="lane-activity-led" title="Active voice indicator"></span>
            <input type="text" class="lane-name-input" value="${lane.name}" title="Rename lane">
            ${customSampleBadge}
          </div>
          <div class="lane-btns">
            <button class="btn-mute ${lane.muted ? 'active' : ''}" title="Mute lane">MUTE</button>
            <button class="btn-solo ${lane.solo ? 'active' : ''}" title="Solo lane">SOLO</button>
            <button class="btn-play-sample" title="Test sample">🔊</button>
            <button class="btn-del-lane" title="Delete lane">✕</button>
          </div>
        </div>

        <div class="lane-controls-row">
          <select class="lane-sampleset dropdown mini" title="SampleSet">
            <option value="Soft" ${lane.sampleSet === 'Soft' ? 'selected' : ''}>Soft</option>
            <option value="Normal" ${lane.sampleSet === 'Normal' ? 'selected' : ''}>Normal</option>
            <option value="Drum" ${lane.sampleSet === 'Drum' ? 'selected' : ''}>Drum</option>
          </select>

          <select class="lane-addition dropdown mini" title="Addition">
            <option value="None" ${lane.addition === 'None' ? 'selected' : ''}>None</option>
            <option value="Clap" ${lane.addition === 'Clap' ? 'selected' : ''}>Clap</option>
            <option value="Whistle" ${lane.addition === 'Whistle' ? 'selected' : ''}>Whistle</option>
            <option value="Finish" ${lane.addition === 'Finish' ? 'selected' : ''}>Finish</option>
          </select>

          <div class="lane-idx-group" title="Custom sample index (e.g. 1 for soft-hitclap.wav, 2 for soft-hitclap2.wav)">
            <span>#</span>
            <input type="number" class="lane-custom-idx" min="0" max="99" value="${lane.customIndex}">
          </div>

          <div class="lane-vol-group" title="Lane volume percentage">
            <span class="vol-label">Vol</span>
            <input type="number" class="lane-volume-input" min="0" max="100" value="${lane.volume}">
            <span class="pct-sign">%</span>
          </div>
        </div>
      `;

      // Drag and drop audio sample directly onto this lane!
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        el.classList.add('drag-over');
      });

      el.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
      });

      el.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');

        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;

        const file = Array.from(files).find((f) => /\.(wav|ogg|mp3)$/i.test(f.name));
        if (!file) {
          this.showToast('Please drop a valid audio sample (.wav, .ogg, or .mp3)');
          return;
        }

        try {
          const arrayBuffer = await file.arrayBuffer();
          const buffer = await this.audioEngine.decodeSampleAudio(arrayBuffer);
          lane.audioBuffer = buffer;
          lane.customSampleName = file.name;
          this.laneDroppedSamples.set(lane.id, new Uint8Array(arrayBuffer.slice(0)));
          if (lane.name.startsWith('Lane ') || lane.name.startsWith('Soft ') || lane.name.startsWith('Normal ') || lane.name.startsWith('Drum ')) {
            lane.name = file.name.replace(/\.[^/.]+$/, '');
          }
          this.renderLanesList();
          this.updateSequencerData();
          this.audioEngine.playSingleSample(lane);
          this.flashLane(lane.id);
          this.showToast(`🎵 Loaded "${file.name}" to lane "${lane.name}"`);
        } catch (err) {
          console.error('Failed to decode dropped sample:', err);
          this.showToast(`❌ Could not decode audio: ${file.name}`);
        }
      });

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
        this.updateLaneItemStyles();
        this.updateSequencerData();
      });

      const btnSolo = el.querySelector('.btn-solo') as HTMLButtonElement;
      btnSolo.addEventListener('click', () => {
        lane.solo = !lane.solo;
        if (lane.solo) {
          lane.muted = false;
        }
        this.updateLaneItemStyles();
        this.updateSequencerData();
      });

      const btnPlaySample = el.querySelector('.btn-play-sample') as HTMLButtonElement;
      btnPlaySample.addEventListener('click', () => {
        const played = this.audioEngine.playSingleSample(lane);
        if (!played) {
          this.showToast(`No sample file loaded for "${lane.name}"`);
        } else {
          this.flashLane(lane.id);
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

      const volInput = el.querySelector('.lane-volume-input') as HTMLInputElement;
      volInput.addEventListener('input', () => {
        let val = parseInt(volInput.value, 10);
        if (isNaN(val)) val = 0;
        val = Math.max(0, Math.min(100, val));
        lane.volume = val;
        this.updateSequencerData();
      });
      volInput.addEventListener('blur', () => {
        volInput.value = String(lane.volume);
      });

      container.appendChild(el);
    }
  }

  private updateLaneItemStyles() {
    const container = document.getElementById('lanes-list');
    if (!container) return;
    const hasSolo = this.lanes.some((l) => l.solo);
    const items = container.querySelectorAll('.lane-item');
    for (let i = 0; i < this.lanes.length && i < items.length; i++) {
      const lane = this.lanes[i];
      const item = items[i] as HTMLElement;
      const isMuted = lane.muted;
      const isSoloInactive = hasSolo && !lane.solo;
      item.classList.toggle('is-muted', isMuted);
      item.classList.toggle('is-inactive', isSoloInactive);
      const muteBtn = item.querySelector('.btn-mute');
      const soloBtn = item.querySelector('.btn-solo');
      muteBtn?.classList.toggle('active', isMuted);
      soloBtn?.classList.toggle('active', lane.solo);
    }
  }

  // --- Convert Existing Hitsound Diff into Lanes ---

  public importDiffIntoLanes(beatmap: OsuBeatmap, showAlert: boolean = true) {
    const res = importHitsoundsFromBeatmap(beatmap, this.rawZipFiles);
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
    this.rawSongAudioData = null;
    this.laneDroppedSamples.clear();
    if (this.autoSaveTimeout !== null) {
      window.clearTimeout(this.autoSaveTimeout);
      this.autoSaveTimeout = null;
    }
    clearSessionCache().catch(() => {});

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
          this.rawSongAudioData = arrayBuf.slice(0);
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
            this.rawSongAudioData = arrayBuf.slice(0);
            await this.audioEngine.decodeSongAudio(arrayBuf);
            this.audioFileName = filename;
            foundSong = true;
            break;
          }
        }
      }

      // 4. Set raw samples in audioEngine for on-demand decoding
      this.audioEngine.setRawSampleFiles(this.rawZipFiles);

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
        // Automatically import hitsound diff straight into lanes
        this.importDiffIntoLanes(hsDiff, false);
        // Default ghost notes to top playable diff
        this.referenceBeatmap = playableDiffs[0] || hsDiff;
      } else {
        // Mapset without hitsound diff -> auto-separate top diff into lanes!
        const topDiff = playableDiffs[0] || this.allBeatmaps[0];
        this.referenceBeatmap = topDiff;
        this.importDiffIntoLanes(topDiff, false);
      }

      // 6. Fast Parallel Pre-decode for active lane samples
      const decodePromises: Promise<void>[] = [];
      const queuedKeys = new Set<string>();

      for (const lane of this.lanes) {
        const setStr = lane.sampleSet.toLowerCase();
        const addStr = lane.addition.toLowerCase();
        const idx = lane.customIndex || 0;
        const baseName = lane.addition === 'None' ? `${setStr}-hitnormal` : `${setStr}-hit${addStr}`;

        const candidates = [
          `${baseName}${idx > 1 ? idx : ''}.wav`,
          `${baseName}${idx > 1 ? idx : ''}.ogg`,
          `${baseName}.wav`,
          `${baseName}.ogg`,
          `${baseName}1.wav`,
          `${baseName}1.ogg`,
        ];

        for (const key of candidates) {
          if (this.rawZipFiles.has(key) && !queuedKeys.has(key) && !this.customSamples.has(key)) {
            queuedKeys.add(key);
            const bytes = this.rawZipFiles.get(key)!;
            // Skip 44-byte silent dummy slider wavs
            if (bytes.length > 44) {
              const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
              decodePromises.push(
                this.audioEngine.decodeSampleAudio(arrayBuf)
                  .then((buf) => {
                    this.customSamples.set(key, buf);
                  })
                  .catch(() => {})
              );
            }
          }
        }
      }

      await Promise.all(decodePromises);
      this.audioEngine.setCustomSamples(this.customSamples);

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
    this.rawSongAudioData = arrayBuffer.slice(0);
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
