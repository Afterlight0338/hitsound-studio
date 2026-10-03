import JSZip from 'jszip';
import { AudioEngine } from '../audio/audioEngine';
import { Sequencer } from '../editor/sequencer';
import { copyHitsounds } from '../osu/copier';
import { generateHitsoundBeatmap } from '../osu/hitsoundGenerator';
import { importHitsoundsFromBeatmap } from '../osu/hitsoundImporter';
import { parseOsu } from '../osu/parser';
import {
  findNonStandardSamples,
  renameSamplesInOsuText,
  sampleStem,
  suggestStandardNames,
  validateRename,
} from '../osu/sampleNaming';
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

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

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

  // 'hitsounds': picking a diff loads its hitsounds into the lanes and ghosts it.
  // 'ghost': picking a diff only changes the ghost; lanes stay as they are.
  private diffMode: 'hitsounds' | 'ghost' = 'hitsounds';
  private hsSourceVersion: string | null = null; // diff the current lanes were loaded from
  private diffLaneCache = new Map<string, { lanes: Lane[]; triggers: Trigger[] }>(); // unsaved edits per diff

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

  // Conservative defaults: the old 80/90 blasted people on first visit
  private songVolume = App.savedVolume('song', 40);
  private hsVolume = App.savedVolume('hs', 35);

  private static savedVolume(kind: 'song' | 'hs', fallback: number): number {
    try {
      const v = parseInt(localStorage.getItem(`hs-vol-${kind}`) ?? '', 10);
      return isNaN(v) ? fallback : Math.max(0, Math.min(100, v));
    } catch {
      return fallback;
    }
  }

  constructor() {
    this.audioEngine = new AudioEngine();
    this.audioEngine.setSongVolume(this.songVolume / 100);
    this.audioEngine.setHitsoundVolume(this.hsVolume / 100);
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
        <header class="top-bar">
          <div class="bar-group">
            <span class="brand">hitsound<span>studio</span></span>
            <nav class="tabs">
              <button id="tab-studio" class="tab-btn active">Studio</button>
              <button id="tab-copier" class="tab-btn">Copier</button>
            </nav>
          </div>

          <div class="bar-group transport">
            <button id="btn-play" class="icon-btn play" title="Play / Pause (Space)" aria-label="Play">
              <svg id="play-icon" viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>
            </button>
            <button id="btn-stop" class="icon-btn" title="Back to start (Home)" aria-label="Back to start">
              <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 3h2v10H3zM14 3v10L6 8z" fill="currentColor"/></svg>
            </button>
            <div class="readout">
              <span class="time-display" id="time-display">00:00.000</span>
              <span class="bpm-display" id="bpm-display" title="BPM at playhead">120 BPM</span>
            </div>
            <label class="field rate-field">Rate
              <select id="select-rate" class="dropdown">
                <option value="0.5">0.5×</option>
                <option value="0.75">0.75×</option>
                <option value="1.0" selected>1×</option>
              </select>
            </label>
            <label class="field">Snap
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
            </label>
            <label class="field zoom-field">Zoom
              <input type="range" id="slider-zoom" min="30" max="3000" value="220" class="range-slider zoom">
            </label>
            <div class="field volumes">
              <label title="Song volume">Song
                <input type="range" id="vol-song" min="0" max="100" value="${this.songVolume}" class="range-slider mini">
              </label>
              <input type="number" id="num-vol-song" min="0" max="100" value="${this.songVolume}" class="vol-num-input" aria-label="Song volume %">
              <label title="Hitsound volume">Hitsounds
                <input type="range" id="vol-hs" min="0" max="100" value="${this.hsVolume}" class="range-slider mini">
              </label>
              <input type="number" id="num-vol-hs" min="0" max="100" value="${this.hsVolume}" class="vol-num-input" aria-label="Hitsound volume %">
            </div>
          </div>

          <div class="bar-group">
            <label class="btn file-btn">
              Import
              <input type="file" id="file-input" accept=".osz,.zip,.osu,.mp3,.ogg,.wav" multiple hidden>
            </label>
            <button id="btn-export-diff" class="btn" title="Download the [Hitsounds] diff">Export .osu</button>
            <button id="btn-download-osz" class="btn btn-primary" title="Copy hitsounds into the checked diffs and download the mapset">Save .osz</button>
            <button id="btn-reset" class="icon-btn" title="Reset project" aria-label="Reset project">
              <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3a5 5 0 1 1-4.9 6h1.6A3.5 3.5 0 1 0 8 4.5V7L4.5 3.75 8 .5z" fill="currentColor"/></svg>
            </button>
          </div>
        </header>

        <main class="main-workspace">
          <div id="view-studio" class="view-panel active">
            <aside class="channel-rack">
              <!-- exactly 64px: must match the canvas rulerHeight -->
              <div class="rack-header-container">
                <div class="rack-top-line">
                  <span id="rack-lanes-title" class="rack-title">Lanes</span>
                  <div class="rack-top-actions">
                    <button id="btn-toggle-compact" class="btn btn-sm btn-ghost" title="Compact lanes">Compact</button>
                    <div class="add-lane-btn-group">
                      <button id="btn-add-lane" class="btn btn-sm">+ Lane</button>
                      <button id="btn-add-lane-menu" class="btn btn-sm btn-arrow" title="Add a specific addition lane" aria-label="More lane types">▾</button>
                      <div id="add-lane-menu" class="add-lane-menu" style="display: none;">
                        <div class="add-lane-menu-item" data-add="None">Soft hitnormal</div>
                        <div class="add-lane-menu-item" data-add="Whistle">Soft whistle</div>
                        <div class="add-lane-menu-item" data-add="Finish">Soft finish</div>
                        <div class="add-lane-menu-item" data-add="Clap">Soft clap</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="rack-sub-line">
                  <select id="select-reference-diff" class="dropdown" title="Difficulty">
                    <option value="">No diff</option>
                  </select>
                  <div class="segmented" role="group" aria-label="What selecting a diff shows">
                    <button data-diff-mode="hitsounds" class="active" title="Selecting a diff loads its hitsounds into the lanes and shows its notes as ghosts">Hitsounds</button>
                    <button data-diff-mode="ghost" title="Selecting a diff only changes the ghost notes; lanes stay as they are">Ghost only</button>
                  </div>
                  <button id="btn-toggle-ghost" class="icon-btn sm active" title="Show ghost notes (G)" aria-label="Show ghost notes">
                    <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3C4 3 1.5 8 1.5 8S4 13 8 13s6.5-5 6.5-5S12 3 8 3zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6z" fill="currentColor"/></svg>
                  </button>
                </div>
              </div>
              <div id="lanes-list" class="lanes-list"></div>
            </aside>

            <div class="sequencer-container">
              <canvas id="sequencer-canvas"></canvas>
              <div class="hint-bar">
                <span><kbd>Click</kbd> place</span><span><kbd>Drag</kbd> select</span><span><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd> additions</span><span><kbd>C</kbd><kbd>V</kbd> copy/paste</span><span>Drop audio on a lane to load a sample</span>
              </div>
            </div>
          </div>

          <div id="view-copier" class="view-panel">
            <div class="copier-container">
              <div class="copier-card">
                <h2>Hitsound copier</h2>
                <p class="subtitle">
                  Copies the studio hitsounds into your difficulties. Slider velocity is left untouched.
                </p>

                <div class="copier-grid">
                  <div class="copier-col">
                    <div class="form-group">
                      <div class="flex-between">
                        <label>Target difficulties</label>
                        <div>
                          <button id="btn-select-all-diffs" class="btn-link">All</button>
                          <button id="btn-deselect-all-diffs" class="btn-link">None</button>
                        </div>
                      </div>
                      <div id="copier-targets-list" class="checkbox-list">
                        <div class="empty-state">Import an .osz to pick target difficulties.</div>
                      </div>
                    </div>
                  </div>

                  <div class="copier-col">
                    <div class="form-group inline">
                      <label for="copier-snap">Snap tolerance</label>
                      <input type="number" id="copier-snap" value="5" min="0" max="25" class="input-num">
                      <span class="muted">ms</span>
                    </div>

                    <div class="options-list">
                      <label class="checkbox-label"><input type="checkbox" id="opt-additions" checked> Additions (whistle, finish, clap)</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-samplesets" checked> Sample sets</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-indices" checked> Custom indices</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-volumes" checked> Volumes and green lines</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-heads" checked> Slider heads</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-repeats" checked> Slider repeats</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-tails" checked> Slider tails</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-spinners" checked> Spinners</label>
                      <label class="checkbox-label"><input type="checkbox" id="opt-clean"> Clear hitsounds on unmatched notes</label>
                    </div>

                    <div class="copier-actions">
                      <button id="btn-run-copier" class="btn btn-primary btn-lg">Copy and download .osz</button>
                      <button id="btn-download-diffs-zip" class="btn btn-lg">Download .osu files only</button>
                    </div>
                  </div>
                </div>

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
    this.updateTimeDisplay(this.sequencer.currentTimeMs);
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
        icon.innerHTML = isPlaying ? '<path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor"/>' : '<path d="M4 2.5v11l9-5.5z" fill="currentColor"/>';
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

    // Volumes: slider <-> numeric % input sync, remembered per browser
    const bindVolume = (kind: 'song' | 'hs', apply: (v: number) => void) => {
      const slider = document.getElementById(`vol-${kind}`) as HTMLInputElement;
      const num = document.getElementById(`num-vol-${kind}`) as HTMLInputElement;
      const set = (raw: string) => {
        const val = Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
        slider.value = num.value = String(val);
        apply(val / 100);
        try { localStorage.setItem(`hs-vol-${kind}`, String(val)); } catch {}
      };
      slider.addEventListener('input', () => set(slider.value));
      num.addEventListener('change', () => set(num.value));
    };
    bindVolume('song', (v) => this.audioEngine.setSongVolume(v));
    bindVolume('hs', (v) => this.audioEngine.setHitsoundVolume(v));

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

    // Diff selector + what selecting a diff does
    document.getElementById('select-reference-diff')?.addEventListener('change', (e) => {
      const ver = (e.target as HTMLSelectElement).value;
      this.referenceBeatmap = this.allBeatmaps.find((bm) => this.versionOf(bm) === ver) || null;
      if (this.diffMode === 'hitsounds' && this.referenceBeatmap) this.loadDiffHitsounds(this.referenceBeatmap);
      this.updateSequencerData();
    });
    document.querySelectorAll<HTMLButtonElement>('[data-diff-mode]').forEach((btn) =>
      btn.addEventListener('click', () => this.setDiffMode(btn.dataset.diffMode as 'hitsounds' | 'ghost'))
    );

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
    this.showToast('Undone');
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
    this.showToast('Redone');
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
    this.showToast(`Copied ${this.clipboard.length} note${this.clipboard.length > 1 ? 's' : ''}`);
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
    this.showToast(`Pasted ${newSelectedIds.size} note${newSelectedIds.size > 1 ? 's' : ''}`);
  }

  public deleteSelected() {
    if (this.sequencer.selectedTriggerIds.size === 0) return;
    this.pushHistorySnapshot();
    const count = this.sequencer.selectedTriggerIds.size;
    const idSet = new Set(this.sequencer.selectedTriggerIds);
    this.triggers = this.triggers.filter((t) => !idSet.has(t.id));
    this.sequencer.selectedTriggerIds.clear();
    this.updateSequencerData();
    this.showToast(`Deleted ${count} note${count > 1 ? 's' : ''}`);
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
    if (diffSec < 60) return 'just now';
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
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="resume-title">
        <header class="modal-header">
          <h2 id="resume-title">Resume last session?</h2>
          <button class="icon-btn" id="btn-modal-close" aria-label="Close">✕</button>
        </header>
        <div class="modal-body">
          <div class="session-card">
            <div class="session-title" title="${esc(projectTitle)}">${esc(projectTitle)}</div>
            <div class="session-meta">
              <span><strong>${noteCount}</strong> notes</span>
              <span><strong>${laneCount}</strong> lanes</span>
              <span><strong>${diffCount}</strong> diffs</span>
              <span>saved ${timeStr}</span>
            </div>
          </div>
        </div>
        <footer class="modal-actions">
          <button id="btn-modal-fresh" class="btn btn-ghost">Start fresh</button>
          <button id="btn-modal-resume" class="btn btn-primary">Resume</button>
        </footer>
      </div>
    `;

    document.body.appendChild(backdrop);

    const closeModal = () => {
      window.removeEventListener('keydown', keyHandler);
      backdrop.remove();
    };

    const handleResume = async () => {
      closeModal();
      await this.resumeSession(cached);
    };

    const handleFresh = async () => {
      closeModal();
      await clearSessionCache();
      this.showToast('Started fresh project');
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
      this.showToast('Resuming session…');
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
        this.referenceBeatmap = this.allBeatmaps.find((bm) => this.versionOf(bm) === p.referenceVersion) || null;
      } else if (this.allBeatmaps.length > 0) {
        this.referenceBeatmap = this.allBeatmaps[0];
      }
      this.diffLaneCache.clear();
      this.hsSourceVersion = p.hsSourceVersion ?? null;
      this.setDiffMode(p.diffMode ?? 'ghost');

      // Update UI components
      this.updateBeatmapSelectors();
      this.renderLanesList();
      this.updateSequencerData();
      this.updateCopierTargetsList();

      this.showToast(`Resumed: ${this.artist} - ${this.title}`);
    } catch (err) {
      console.error('Failed to resume session:', err);
      this.showToast('Error restoring previous session');
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
        referenceVersion: this.referenceBeatmap ? this.versionOf(this.referenceBeatmap) : null,
        diffMode: this.diffMode,
        hsSourceVersion: this.hsSourceVersion,
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
      btn.textContent = this.isCompactLanes ? 'Expand' : 'Compact';
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
    if (titleEl) titleEl.textContent = `Lanes · ${this.lanes.length}`;

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
      const customSampleBadge = hasCustomSample
        ? `<span class="badge-custom-sample" title="Custom sample: ${esc(lane.customSampleName || 'dropped audio')}. Click to remove and use standard hitsounds">${esc(lane.customSampleName || 'sample')} ✕</span>`
        : '';

      el.innerHTML = `
        <div class="lane-top-row">
          <div class="lane-name-wrapper">
            <span class="lane-activity-led"></span>
            <input type="text" class="lane-name-input" value="${esc(lane.name)}" title="Rename lane">
            ${customSampleBadge}
          </div>
          <div class="lane-btns">
            <button class="btn-mute ${lane.muted ? 'active' : ''}" title="Mute lane">M</button>
            <button class="btn-solo ${lane.solo ? 'active' : ''}" title="Solo lane">S</button>
            <button class="btn-play-sample" title="Preview sample" aria-label="Preview sample"><svg viewBox="0 0 16 16" width="11" height="11"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></button>
            <button class="btn-del-lane" title="Delete lane"><svg viewBox="0 0 16 16" width="10" height="10"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.8"/></svg></button>
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
          this.showToast(`Loaded "${file.name}" to lane "${lane.name}"`);
        } catch (err) {
          console.error('Failed to decode dropped sample:', err);
          this.showToast(`Could not decode audio: ${file.name}`);
        }
      });

      // Event bindings for this lane
      const badgeSample = el.querySelector('.badge-custom-sample') as HTMLElement | null;
      if (badgeSample) {
        badgeSample.addEventListener('click', (e) => {
          e.stopPropagation();
          const oldName = lane.customSampleName || 'custom sample';
          delete lane.customSampleName;
          delete lane.audioBuffer;
          this.laneDroppedSamples.delete(lane.id);
          this.audioEngine.clearLaneCache();
          this.renderLanesList();
          this.updateSequencerData();
          this.showToast(`Cleared "${oldName}" from lane. Standard hitsound controls active.`);
        });
      }

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

  private versionOf(bm: OsuBeatmap): string {
    return bm.metadata.Version || bm.fileName;
  }

  public importDiffIntoLanes(beatmap: OsuBeatmap) {
    const res = importHitsoundsFromBeatmap(beatmap, this.rawZipFiles);
    this.hsSourceVersion = this.versionOf(beatmap);
    this.diffLaneCache.delete(this.hsSourceVersion);
    if (res.lanes.length === 0) {
      this.showToast(`No hitsounds in [${this.hsSourceVersion}]`);
      return;
    }
    this.setLanes(res.lanes, res.triggers);
  }

  private setLanes(lanes: Lane[], triggers: Trigger[]) {
    this.lanes = lanes;
    this.triggers = triggers;
    this.undoStack = [];
    this.redoStack = [];
    this.sequencer?.selectedTriggerIds.clear();
    this.renderLanesList();
    this.updateSequencerData();
  }

  /** Swaps the lanes to `bm`'s hitsounds, keeping edits made to the previous diff for when it comes back. */
  private loadDiffHitsounds(bm: OsuBeatmap) {
    const ver = this.versionOf(bm);
    if (this.hsSourceVersion === ver) return;
    if (this.hsSourceVersion) {
      this.diffLaneCache.set(this.hsSourceVersion, { lanes: this.lanes, triggers: this.triggers });
    }
    const cached = this.diffLaneCache.get(ver);
    if (cached) {
      this.hsSourceVersion = ver;
      this.setLanes(cached.lanes, cached.triggers);
    } else {
      this.importDiffIntoLanes(bm);
    }
  }

  private setDiffMode(mode: 'hitsounds' | 'ghost') {
    this.diffMode = mode;
    document.querySelectorAll<HTMLElement>('[data-diff-mode]').forEach((b) =>
      b.classList.toggle('active', b.dataset.diffMode === mode)
    );
    if (mode === 'hitsounds' && this.referenceBeatmap) this.loadDiffHitsounds(this.referenceBeatmap);
    this.updateSequencerData();
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
    this.diffLaneCache.clear();
    this.hsSourceVersion = null;

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
          this.importDiffIntoLanes(parsed);
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

      this.diffLaneCache.clear();
      this.hsSourceVersion = null;
      if (hsDiff && playableDiffs.length > 0) {
        // Dedicated hitsound diff: edit it, ghost the densest playable diff
        this.importDiffIntoLanes(hsDiff);
        this.referenceBeatmap = playableDiffs[0];
        this.setDiffMode('ghost');
      } else {
        // Every diff carries its own hitsounds: selecting a diff shows its hitsounds
        const topDiff = playableDiffs[0] || hsDiff || this.allBeatmaps[0];
        this.referenceBeatmap = topDiff;
        this.importDiffIntoLanes(topDiff);
        this.setDiffMode('hitsounds');
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

      // 7. Check for non-standard hitsound sample filenames
      this.checkNonStandardHitsounds();
    } catch (err) {
      console.error('Error importing .osz:', err);
      alert(`Failed to import .osz: ${err}`);
    }
  }

  /** Non-standard sample names still waiting for a rename; export is blocked while this is non-empty. */
  private pendingSampleRenames(): string[] {
    return findNonStandardSamples(this.rawZipFiles, this.allBeatmaps, this.lanes, this.audioFileName);
  }

  /** Returns true when export may proceed; otherwise opens the rename dialog. */
  private ensureStandardSampleNames(): boolean {
    const pending = this.pendingSampleRenames();
    if (pending.length === 0) return true;
    this.showRenameSamplesModal(pending, true);
    return false;
  }

  private checkNonStandardHitsounds() {
    const pending = this.pendingSampleRenames();
    if (pending.length > 0) this.showRenameSamplesModal(pending, false);
  }

  /** Renames sample files in the archive and every reference to them (all diffs, storyboard, lanes). */
  private applySampleRenames(renames: Map<string, string>) {
    const enc = new TextEncoder();
    const dec = new TextDecoder('utf-8');
    for (const [name, bytes] of [...this.rawZipFiles]) {
      if (/\.(wav|ogg|mp3)$/i.test(name) && renames.has(sampleStem(name))) {
        this.rawZipFiles.delete(name);
        this.rawZipFiles.set(renames.get(sampleStem(name))!, bytes);
      } else if (/\.(osu|osb)$/i.test(name)) {
        this.rawZipFiles.set(name, enc.encode(renameSamplesInOsuText(dec.decode(bytes), renames)));
      }
    }

    const refVer = this.referenceBeatmap ? this.versionOf(this.referenceBeatmap) : null;
    this.allBeatmaps = this.allBeatmaps.map((bm) => parseOsu(renameSamplesInOsuText(bm.rawText, renames), bm.fileName));
    this.referenceBeatmap = this.allBeatmaps.find((bm) => this.versionOf(bm) === refVer) || null;

    const laneSets = [this.lanes, ...[...this.diffLaneCache.values()].map((c) => c.lanes)];
    for (const lanes of laneSets) {
      for (const lane of lanes) {
        const next = lane.customSampleName && renames.get(sampleStem(lane.customSampleName));
        if (next) lane.customSampleName = next;
      }
    }

    this.audioEngine.setRawSampleFiles(this.rawZipFiles);
    this.updateBeatmapSelectors();
    this.renderLanesList();
    this.updateSequencerData();
  }

  private showRenameSamplesModal(files: string[], fromExport: boolean) {
    document.getElementById('hitsound-naming-modal')?.remove();
    const suggestions = suggestStandardNames(files, this.rawZipFiles, this.allBeatmaps);

    const backdrop = document.createElement('div');
    backdrop.id = 'hitsound-naming-modal';
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title">
        <header class="modal-header">
          <h2 id="rename-title">Rename custom hitsounds</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </header>
        <div class="modal-body">
          <p class="muted">
            ${fromExport ? 'Export is blocked until these samples are renamed.' : `${files.length} sample${files.length > 1 ? 's don’t' : ' doesn’t'} follow osu! naming. Rename before exporting.`}
            Files and every reference in the mapset are renamed together.
          </p>
          <div class="rename-list">
            ${files
              .map(
                (f, i) => `
              <label class="rename-row">
                <span class="rename-old" title="${esc(f)}">${esc(f)}</span>
                <span class="rename-arrow">→</span>
                <input class="input mono" name="r${i}" value="${esc(suggestions.get(f)!)}" spellcheck="false" autocomplete="off">
                <span class="rename-err" data-err="${i}"></span>
              </label>`
              )
              .join('')}
          </div>
          <p class="hint mono">{soft|normal|drum}-hit{normal|whistle|finish|clap}[index].wav</p>
        </div>
        <footer class="modal-actions">
          <button type="button" class="btn btn-ghost" data-close>Later</button>
          <button type="submit" class="btn btn-primary">Rename</button>
        </footer>
      </form>
    `;
    document.body.appendChild(backdrop);

    const form = backdrop.querySelector('form')!;
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input')];
    const close = () => backdrop.remove();
    backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    backdrop.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    inputs[0]?.focus();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const renaming = new Set(files.map(sampleStem));
      const taken = new Set([...this.rawZipFiles.keys()].map(sampleStem).filter((s) => !renaming.has(s)));
      const renames = new Map<string, string>();
      let ok = true;
      inputs.forEach((input, i) => {
        let next = input.value.trim().toLowerCase();
        if (next && !/\.(wav|ogg|mp3)$/.test(next)) next += files[i].match(/\.(wav|ogg|mp3)$/i)?.[0].toLowerCase() ?? '.wav';
        const err = validateRename(next, taken);
        form.querySelector(`[data-err="${i}"]`)!.textContent = err ?? '';
        input.classList.toggle('invalid', Boolean(err));
        if (err) ok = false;
        taken.add(sampleStem(next));
        renames.set(sampleStem(files[i]), next);
      });
      if (!ok) return;
      this.applySampleRenames(renames);
      close();
      this.showToast(`Renamed ${renames.size} sample${renames.size > 1 ? 's' : ''}`);
    });
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
      refSelect.innerHTML = '<option value="">No diff</option>';
      for (const bm of this.allBeatmaps) {
        const opt = document.createElement('option');
        const ver = this.versionOf(bm);
        opt.value = ver;
        opt.textContent = `${ver} (${bm.hitObjects.length})`;
        opt.selected = this.referenceBeatmap === bm;
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

  /** Write back into the hitsound diff the lanes came from; never overwrite a playable diff. */
  private exportDiffName(): string {
    const src = this.hsSourceVersion;
    return src && /hitsound|^hs$/i.test(src) ? src : 'Hitsounds';
  }

  private generateExportDiff() {
    const name = this.exportDiffName();
    const result = generateHitsoundBeatmap(this.lanes, this.triggers, this.getBaseBeatmap(), name);
    // Reuse the existing file name so the .osz replaces that diff instead of adding a copy
    const existing = this.allBeatmaps.find((bm) => this.versionOf(bm) === name);
    if (existing) result.beatmap.fileName = existing.fileName;
    return result;
  }

  public async executeCopier(saveAsOsz: boolean) {
    if (!this.ensureStandardSampleNames()) return;
    const consoleEl = document.getElementById('copier-console')!;
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = '<div class="log-line">Running hitsound copier…</div>';

    // 1. Prepare Source Beatmap
    const sourceResult = this.generateExportDiff();
    const sourceBeatmap = sourceResult.beatmap;

    // 2. Collect selected target diffs
    const selectedFileNames = new Set<string>();
    document.querySelectorAll<HTMLInputElement>('.target-diff-cb:checked').forEach((cb) => {
      selectedFileNames.add(cb.value);
    });

    // The source diff is written as-is below; copying onto it would clobber it
    const targetBeatmaps = this.allBeatmaps.filter((bm) => selectedFileNames.has(bm.fileName) && bm.fileName !== sourceBeatmap.fileName);

    if (targetBeatmaps.length === 0) {
      consoleEl.innerHTML += `<div class="log-line">No target difficulties checked, only the [${esc(sourceBeatmap.metadata.Version)}] diff is written.</div>`;
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
          <strong>${res.version}</strong>: matched ${res.stats.matchedObjects}/${res.stats.totalObjects} objects
          (${res.stats.sliderEdgesMatched} slider edges), merged ${res.stats.timingPointsMerged} timing points.
        </div>
      `;
    }

    // 4. Package output
    const zip = new JSZip();
    if (saveAsOsz) {
      for (const [fname, bytes] of this.rawZipFiles) zip.file(fname, bytes);
    }
    for (const [fname, bytes] of this.laneSampleFiles()) zip.file(fname, bytes);
    zip.file(sourceBeatmap.fileName, sourceResult.osuString);
    for (const res of results) zip.file(res.fileName, res.osuString);

    const name = saveAsOsz ? `${this.artist} - ${this.title}.osz` : 'hitsounded_diffs.zip';
    this.download(await zip.generateAsync({ type: 'blob' }), name);
    consoleEl.innerHTML += `<div class="log-line success">Downloaded ${name}</div>`;
  }

  /** Sample files the lanes reference by name (renamed archive samples and samples dropped on lanes). */
  private laneSampleFiles(): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    const byStem = new Map([...this.rawZipFiles].map(([n, b]) => [sampleStem(n), [n, b] as const]));
    for (const lane of this.lanes) {
      if (!lane.customSampleName) continue;
      const dropped = this.laneDroppedSamples.get(lane.id);
      const zipped = byStem.get(sampleStem(lane.customSampleName));
      if (dropped) files.set(lane.customSampleName, dropped);
      else if (zipped && /\.(wav|ogg|mp3)$/i.test(zipped[0])) files.set(zipped[0], zipped[1]);
    }
    return files;
  }

  private download(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Stacked lanes that one circle can't fully express (mixed sets/indices, several custom files). */
  private lossyNote(n: number): string {
    return n > 0 ? `. ${n} stacked spot${n > 1 ? 's' : ''} merged lossy (mixed sample sets, indices or files)` : '';
  }

  public exportHitsoundDiff() {
    if (!this.ensureStandardSampleNames()) return;
    const result = this.generateExportDiff();
    const samples = this.laneSampleFiles();

    if (samples.size === 0) {
      this.download(new Blob([result.osuString], { type: 'text/plain;charset=utf-8' }), result.beatmap.fileName);
      this.showToast(`Exported ${result.totalNotes} hitsound notes${this.lossyNote(result.lossyMerges)}`);
      return;
    }
    // The diff references custom sample files by name, so they ship together
    const zip = new JSZip();
    zip.file(result.beatmap.fileName, result.osuString);
    for (const [fname, bytes] of samples) zip.file(fname, bytes);
    zip.generateAsync({ type: 'blob' }).then((blob) => {
      this.download(blob, result.beatmap.fileName.replace(/\.osu$/, '.zip'));
      this.showToast(`Exported ${result.totalNotes} hitsound notes + ${samples.size} sample file${samples.size > 1 ? 's' : ''}${this.lossyNote(result.lossyMerges)}`);
    });
  }

  public async downloadFullOsz() {
    await this.executeCopier(true);
  }
}
