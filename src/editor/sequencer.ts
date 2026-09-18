import type { HitObject, Lane, TimingPoint, Trigger } from '../types';

export interface SequencerEvents {
  onAddTrigger: (laneId: string, time: number) => void;
  onRemoveTrigger: (triggerId: string) => void;
  onDeleteSelected: (triggerIds: string[]) => void;
  onSeek: (timeMs: number) => void;
  onPreviewSample: (lane: Lane) => void;
  onScrollVertical: (scrollTop: number) => void;
}

export class Sequencer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private lanes: Lane[] = [];
  private triggers: Trigger[] = [];
  private timingPoints: TimingPoint[] = [];
  private ghostHitObjects: HitObject[] = [];

  private waveformPeaks: Float32Array | null = null;
  private transientPeaks: Float32Array | null = null;
  private durationMs = 0;

  // Exact Layout Dimensions matching the Left Channel Rack
  public zoomPxPerSec = 140; // Horizontal zoom
  public scrollLeftMs = 0; // Current view start in ms
  public scrollTopPx = 0; // Vertical scroll
  public laneHeight = 58; // Exactly matches HTML lane card height
  public rulerHeight = 64; // Exactly matches left rack header height
  public currentTimeMs = 0;
  public activeSnapDivisor = 4; // 1/4 default
  public followPlayhead = true;
  public showGhostNotes = true;

  // Selection & Mouse States
  public selectedTriggerIds = new Set<string>();
  private isScrubbingRuler = false;
  private isBoxSelecting = false;
  private isPainting = false;
  private isErasing = false;
  private selectionStart = { x: 0, y: 0 };
  private selectionCurrent = { x: 0, y: 0 };

  private lastPaintedCell: string | null = null;
  private events: SequencerEvents;

  constructor(canvas: HTMLCanvasElement, events: SequencerEvents) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.events = events;

    this.setupEvents();
    this.resize();

    window.addEventListener('resize', () => this.resize());
  }

  public resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);

    this.ctx.resetTransform?.();
    this.ctx.scale(dpr, dpr);
    this.render();
  }

  public updateData(
    lanes: Lane[],
    triggers: Trigger[],
    timingPoints: TimingPoint[],
    ghostNotes: HitObject[],
    waveform: { peaks: Float32Array | null; transients: Float32Array | null; duration: number }
  ) {
    this.lanes = lanes;
    this.triggers = triggers;
    this.timingPoints = timingPoints;
    this.ghostHitObjects = ghostNotes;
    this.waveformPeaks = waveform.peaks;
    this.transientPeaks = waveform.transients;
    this.durationMs = Math.max(waveform.duration * 1000, 10000);
    this.render();
  }

  public setTime(timeMs: number) {
    this.currentTimeMs = timeMs;

    if (this.followPlayhead) {
      const viewDurationMs = (this.canvas.getBoundingClientRect().width / this.zoomPxPerSec) * 1000;
      if (timeMs > this.scrollLeftMs + viewDurationMs * 0.85 || timeMs < this.scrollLeftMs) {
        this.scrollLeftMs = Math.max(0, timeMs - viewDurationMs * 0.2);
      }
    }

    this.render();
  }

  public setScrollTop(scrollTop: number) {
    this.scrollTopPx = scrollTop;
    this.render();
  }

  public setSnapDivisor(divisor: number) {
    this.activeSnapDivisor = divisor;
    this.render();
  }

  public setZoom(zoom: number) {
    this.zoomPxPerSec = Math.max(40, Math.min(600, zoom));
    this.render();
  }

  public resetView() {
    this.currentTimeMs = 0;
    this.scrollLeftMs = 0;
    this.scrollTopPx = 0;
    this.selectedTriggerIds.clear();
    this.render();
  }

  // --- Geometry Helpers ---

  private msToPx(ms: number): number {
    return ((ms - this.scrollLeftMs) / 1000) * this.zoomPxPerSec;
  }

  private pxToMs(px: number): number {
    return this.scrollLeftMs + (px / this.zoomPxPerSec) * 1000;
  }

  public findActiveRedLine(timeMs: number): TimingPoint {
    const redLines = this.timingPoints.filter((tp) => tp.uninherited);
    if (redLines.length === 0) {
      return {
        time: 0,
        beatLength: 500, // 120 bpm
        meter: 4,
        sampleSet: 2,
        sampleIndex: 0,
        volume: 100,
        uninherited: true,
        effects: 0,
      };
    }
    let active = redLines[0];
    for (const rl of redLines) {
      if (rl.time <= timeMs) {
        active = rl;
      } else {
        break;
      }
    }
    return active;
  }

  public snapTimeToGrid(timeMs: number): number {
    const redLine = this.findActiveRedLine(timeMs);
    const beatLength = redLine.beatLength;
    const snapInterval = beatLength / this.activeSnapDivisor;

    const offset = redLine.time;
    const diff = timeMs - offset;
    const snappedDiff = Math.round(diff / snapInterval) * snapInterval;
    return Math.max(0, Math.round(offset + snappedDiff));
  }

  // --- Main Render ---

  public render() {
    const width = this.canvas.getBoundingClientRect().width;
    const height = this.canvas.getBoundingClientRect().height;

    this.ctx.clearRect(0, 0, width, height);

    // Background
    this.ctx.fillStyle = '#0f1115';
    this.ctx.fillRect(0, 0, width, height);

    const viewStartMs = this.scrollLeftMs;
    const viewEndMs = this.pxToMs(width);

    // 1. Draw Lane rows in scrollable area (clipped under ruler)
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(0, this.rulerHeight, width, height - this.rulerHeight);
    this.ctx.clip();

    this.renderLaneRows(width, height);
    this.renderGrid(viewStartMs, viewEndMs, height);
    this.renderGhostObjects(viewStartMs, viewEndMs);
    this.renderTriggers(viewStartMs, viewEndMs);

    // Render Box Selection rectangle
    if (this.isBoxSelecting) {
      this.renderSelectionBox();
    }

    this.ctx.restore();

    // 2. Draw Sticky Top Timeline Ruler & Waveform (always on top)
    this.renderRulerAndWaveform(width, viewStartMs, viewEndMs);

    // 3. Draw Playhead
    this.renderPlayhead(height);
  }

  private renderRulerAndWaveform(width: number, viewStartMs: number, viewEndMs: number) {
    const rulerH = this.rulerHeight;

    // Ruler Background
    this.ctx.fillStyle = '#14171f';
    this.ctx.fillRect(0, 0, width, rulerH);

    // Draw Audio Waveform inside ruler
    if (this.waveformPeaks) {
      const pointsPerSec = 150;
      const totalPoints = this.waveformPeaks.length;

      this.ctx.fillStyle = 'rgba(74, 158, 255, 0.16)';
      const startIdx = Math.max(0, Math.floor((this.scrollLeftMs / 1000) * pointsPerSec));
      const endIdx = Math.min(totalPoints, Math.ceil((this.pxToMs(width) / 1000) * pointsPerSec));

      this.ctx.beginPath();
      for (let i = startIdx; i < endIdx; i++) {
        const timeMs = (i / pointsPerSec) * 1000;
        const x = this.msToPx(timeMs);
        const peak = this.waveformPeaks[i] || 0;
        const h = peak * (rulerH * 0.7);
        this.ctx.rect(x, rulerH - h, 2, h);
      }
      this.ctx.fill();

      // Render Transient beats as gold spikes
      if (this.transientPeaks) {
        this.ctx.fillStyle = 'rgba(255, 196, 0, 0.4)';
        for (let i = startIdx; i < endIdx; i++) {
          const trans = this.transientPeaks[i];
          if (trans > 0.08) {
            const timeMs = (i / pointsPerSec) * 1000;
            const x = this.msToPx(timeMs);
            const h = Math.min(rulerH, trans * rulerH * 1.5);
            this.ctx.fillRect(x, rulerH - h, 1.5, h);
          }
        }
      }
    }

    // Ruler bottom border (seamless alignment with left header)
    this.ctx.strokeStyle = '#2b3142';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, rulerH - 0.5);
    this.ctx.lineTo(width, rulerH - 0.5);
    this.ctx.stroke();

    // Measure & Beat ticks on ruler
    const redLines = this.timingPoints.filter((tp) => tp.uninherited);
    if (redLines.length > 0) {
      for (const rl of redLines) {
        const beatLength = rl.beatLength;
        const meter = rl.meter || 4;
        const measureMs = beatLength * meter;

        const startMeasure = Math.floor((viewStartMs - rl.time) / measureMs);
        const endMeasure = Math.ceil((viewEndMs - rl.time) / measureMs);

        for (let m = startMeasure; m <= endMeasure; m++) {
          const mTime = rl.time + m * measureMs;
          if (mTime < viewStartMs || mTime > viewEndMs) continue;

          const x = Math.round(this.msToPx(mTime)) + 0.5;

          // Measure marker tick
          this.ctx.strokeStyle = '#4a9eff';
          this.ctx.lineWidth = 2;
          this.ctx.beginPath();
          this.ctx.moveTo(x, rulerH - 22);
          this.ctx.lineTo(x, rulerH);
          this.ctx.stroke();

          // Measure text label
          this.ctx.fillStyle = '#8ab4f8';
          this.ctx.font = 'bold 12px monospace';
          this.ctx.fillText(`${m + 1}`, x + 5, 20);

          // Millisecond label
          const sec = (mTime / 1000).toFixed(2);
          this.ctx.fillStyle = '#7a869a';
          this.ctx.font = '10px monospace';
          this.ctx.fillText(`${sec}s`, x + 5, 34);
        }
      }
    }
  }

  private renderLaneRows(width: number, height: number) {
    let y = this.rulerHeight - this.scrollTopPx;

    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];

      if (y + this.laneHeight > this.rulerHeight && y < height) {
        // Alternating row background
        this.ctx.fillStyle = i % 2 === 0 ? '#161922' : '#1a1e28';
        this.ctx.fillRect(0, y, width, this.laneHeight);

        // Subtle lane accent tint
        this.ctx.fillStyle = lane.color + '0d';
        this.ctx.fillRect(0, y, width, this.laneHeight);

        // Lane bottom divider
        this.ctx.strokeStyle = '#272d3d';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, y + this.laneHeight - 0.5);
        this.ctx.lineTo(width, y + this.laneHeight - 0.5);
        this.ctx.stroke();
      }

      y += this.laneHeight;
    }

    // Fill remaining area below last lane
    if (y < height) {
      this.ctx.fillStyle = '#0f1115';
      this.ctx.fillRect(0, y, width, height - y);
    }
  }

  private renderGrid(viewStartMs: number, viewEndMs: number, totalHeight: number) {
    const redLines = this.timingPoints.filter((tp) => tp.uninherited);
    if (redLines.length === 0) return;

    const topY = this.rulerHeight;

    for (let i = 0; i < redLines.length; i++) {
      const rl = redLines[i];
      const nextRl = redLines[i + 1];
      const segmentEndMs = nextRl ? nextRl.time : Math.max(viewEndMs, this.durationMs);

      const segmentStart = Math.max(rl.time, viewStartMs - rl.beatLength * 2);
      const segmentEnd = Math.min(segmentEndMs, viewEndMs + rl.beatLength * 2);

      if (segmentStart >= segmentEnd) continue;

      const beatLength = rl.beatLength;
      const meter = rl.meter || 4;
      const subInterval = beatLength / this.activeSnapDivisor;

      const startBeat = Math.floor((segmentStart - rl.time) / subInterval);
      const endBeat = Math.ceil((segmentEnd - rl.time) / subInterval);

      for (let b = startBeat; b <= endBeat; b++) {
        const timeMs = Math.round(rl.time + b * subInterval);
        if (timeMs < viewStartMs || timeMs > viewEndMs) continue;

        const x = Math.round(this.msToPx(timeMs)) + 0.5;
        const isMeasure = b % (this.activeSnapDivisor * meter) === 0;
        const isWholeBeat = b % this.activeSnapDivisor === 0;
        const isHalfBeat = (b * 2) % this.activeSnapDivisor === 0;

        if (isMeasure) {
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
          this.ctx.lineWidth = 1.5;
        } else if (isWholeBeat) {
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
          this.ctx.lineWidth = 1;
        } else if (isHalfBeat) {
          this.ctx.strokeStyle = 'rgba(100, 180, 255, 0.1)';
          this.ctx.lineWidth = 1;
        } else {
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
          this.ctx.lineWidth = 1;
        }

        this.ctx.beginPath();
        this.ctx.moveTo(x, topY);
        this.ctx.lineTo(x, totalHeight);
        this.ctx.stroke();
      }
    }
  }

  private renderGhostObjects(viewStartMs: number, viewEndMs: number) {
    if (!this.showGhostNotes || this.ghostHitObjects.length === 0) return;

    const totalLanesHeight = this.lanes.length * this.laneHeight;
    const baseY = this.rulerHeight - this.scrollTopPx;
    const topMarkerY = this.rulerHeight + 8;

    for (const ho of this.ghostHitObjects) {
      if (ho.time < viewStartMs - 2000 || ho.time > viewEndMs + 2000) continue;

      const x = Math.round(this.msToPx(ho.time)) + 0.5;
      const isCircle = (ho.type & 1) !== 0;
      const isSlider = (ho.type & 2) !== 0;
      const isSpinner = (ho.type & 8) !== 0;

      if (isCircle) {
        // Thin elegant vertical guideline through lanes
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(x, baseY);
        this.ctx.lineTo(x, baseY + totalLanesHeight);
        this.ctx.stroke();

        // Subtle circular pip at top of grid
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
        this.ctx.beginPath();
        this.ctx.arc(x, topMarkerY, 3, 0, Math.PI * 2);
        this.ctx.fill();
      } else if (isSlider) {
        const endTime = ho.endTime || ho.time + 300;
        const endX = Math.round(this.msToPx(endTime)) + 0.5;
        const w = Math.max(4, endX - x);

        // Very soft background span wash
        this.ctx.fillStyle = 'rgba(74, 158, 255, 0.04)';
        this.ctx.fillRect(x, baseY, w, totalLanesHeight);

        // Head and tail guidelines
        this.ctx.strokeStyle = 'rgba(74, 158, 255, 0.2)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(x, baseY);
        this.ctx.lineTo(x, baseY + totalLanesHeight);
        this.ctx.moveTo(endX, baseY);
        this.ctx.lineTo(endX, baseY + totalLanesHeight);
        this.ctx.stroke();

        // Compact pill at top of grid
        this.ctx.fillStyle = 'rgba(74, 158, 255, 0.55)';
        this.ctx.beginPath();
        this.ctx.roundRect(x, topMarkerY - 3, w, 6, 3);
        this.ctx.fill();
      } else if (isSpinner) {
        const endTime = ho.endTime || ho.time + 1000;
        const endX = Math.round(this.msToPx(endTime)) + 0.5;
        const w = Math.max(4, endX - x);

        this.ctx.fillStyle = 'rgba(230, 64, 255, 0.03)';
        this.ctx.fillRect(x, baseY, w, totalLanesHeight);

        this.ctx.fillStyle = 'rgba(230, 64, 255, 0.5)';
        this.ctx.fillRect(x, topMarkerY - 2, w, 4);
      }
    }
  }

  private renderTriggers(viewStartMs: number, viewEndMs: number) {
    const laneIndexMap = new Map<string, number>();
    for (let i = 0; i < this.lanes.length; i++) {
      laneIndexMap.set(this.lanes[i].id, i);
    }

    const triggerW = Math.max(10, this.zoomPxPerSec * 0.065);

    for (const tr of this.triggers) {
      if (tr.time < viewStartMs - 500 || tr.time > viewEndMs + 500) continue;

      const lIdx = laneIndexMap.get(tr.laneId);
      if (lIdx === undefined) continue;

      const lane = this.lanes[lIdx];
      const x = this.msToPx(tr.time) - triggerW / 2;
      const y = this.rulerHeight - this.scrollTopPx + lIdx * this.laneHeight + 6;
      const h = this.laneHeight - 12;

      const isSelected = this.selectedTriggerIds.has(tr.id);

      // Trigger Block
      this.ctx.fillStyle = lane.color;
      this.ctx.beginPath();
      this.ctx.roundRect(x, y, triggerW, h, 4);
      this.ctx.fill();

      // Border & Selection Highlight
      if (isSelected) {
        this.ctx.strokeStyle = '#fffb00';
        this.ctx.lineWidth = 2.5;
        this.ctx.stroke();

        // Extra selection glow
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        this.ctx.fillRect(x + 2, y + 2, triggerW - 4, h - 4);
      } else {
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 1.2;
        this.ctx.stroke();

        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        this.ctx.fillRect(x + 2, y + 2, triggerW - 4, 2);
      }
    }
  }

  private renderSelectionBox() {
    const x = Math.min(this.selectionStart.x, this.selectionCurrent.x);
    const y = Math.min(this.selectionStart.y, this.selectionCurrent.y);
    const w = Math.abs(this.selectionCurrent.x - this.selectionStart.x);
    const h = Math.abs(this.selectionCurrent.y - this.selectionStart.y);

    this.ctx.fillStyle = 'rgba(74, 158, 255, 0.15)';
    this.ctx.fillRect(x, y, w, h);

    this.ctx.strokeStyle = '#4a9eff';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);
    this.ctx.strokeRect(x, y, w, h);
    this.ctx.setLineDash([]);
  }

  private renderPlayhead(totalHeight: number) {
    const x = Math.round(this.msToPx(this.currentTimeMs)) + 0.5;

    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(x, 0);
    this.ctx.lineTo(x, totalHeight);
    this.ctx.stroke();

    this.ctx.fillStyle = '#4a9eff';
    this.ctx.beginPath();
    this.ctx.moveTo(x - 7, 0);
    this.ctx.lineTo(x + 7, 0);
    this.ctx.lineTo(x, 12);
    this.ctx.closePath();
    this.ctx.fill();
  }

  // --- Interaction & Events ---

  private setupEvents() {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.onMouseUp());

    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Delete selected triggers with Delete / Backspace
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') {
        return;
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (this.selectedTriggerIds.size > 0) {
          e.preventDefault();
          this.events.onDeleteSelected(Array.from(this.selectedTriggerIds));
          this.selectedTriggerIds.clear();
          this.render();
        }
      }
    });
  }

  private onMouseDown(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (clickY <= this.rulerHeight) {
      // Scrub timeline on ruler
      this.isScrubbingRuler = true;
      const targetTime = Math.max(0, this.pxToMs(clickX));
      this.events.onSeek(targetTime);
      return;
    }

    const gridY = clickY - this.rulerHeight + this.scrollTopPx;
    const laneIdx = Math.floor(gridY / this.laneHeight);

    // Ctrl + Right Click Drag -> Erase Brush Mode
    if (e.button === 2 || (e.ctrlKey && e.button === 2)) {
      this.isErasing = true;
      this.eraseTriggerAt(clickX, gridY);
      return;
    }

    // Ctrl + Left Click Drag -> Paint Mode
    if (e.ctrlKey && e.button === 0) {
      this.isPainting = true;
      this.paintTriggerAt(clickX, gridY);
      return;
    }

    // Standard Left Click on empty space -> Start Marquee Box Selection
    if (e.button === 0) {
      if (laneIdx >= 0 && laneIdx < this.lanes.length) {
        const lane = this.lanes[laneIdx];
        const rawTime = this.pxToMs(clickX);
        const snappedTime = this.snapTimeToGrid(rawTime);

        // Check if clicking directly on an existing trigger
        const toleranceMs = (14 / this.zoomPxPerSec) * 1000;
        const existing = this.triggers.find(
          (tr) => tr.laneId === lane.id && Math.abs(tr.time - snappedTime) <= toleranceMs
        );

        if (existing) {
          if (e.shiftKey) {
            // Toggle selection
            if (this.selectedTriggerIds.has(existing.id)) {
              this.selectedTriggerIds.delete(existing.id);
            } else {
              this.selectedTriggerIds.add(existing.id);
            }
          } else {
            // Delete existing on click, or select
            this.events.onRemoveTrigger(existing.id);
          }
          this.render();
          return;
        } else {
          // If clicked without dragging, clear selection
          if (!e.shiftKey) {
            this.selectedTriggerIds.clear();
          }

          // Single click place trigger
          this.events.onAddTrigger(lane.id, snappedTime);
          this.events.onPreviewSample(lane);
        }
      }

      // Start box selection on drag
      this.isBoxSelecting = true;
      this.selectionStart = { x: clickX, y: clickY };
      this.selectionCurrent = { x: clickX, y: clickY };
    }
  }

  private onMouseMove(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (this.isScrubbingRuler) {
      const targetTime = Math.max(0, this.pxToMs(mouseX));
      this.events.onSeek(targetTime);
      return;
    }

    const gridY = mouseY - this.rulerHeight + this.scrollTopPx;

    // Paint mode: continuously place triggers as mouse drags
    if (this.isPainting) {
      this.paintTriggerAt(mouseX, gridY);
      return;
    }

    // Erase mode: continuously delete triggers under mouse
    if (this.isErasing) {
      this.eraseTriggerAt(mouseX, gridY);
      return;
    }

    // Box selection update
    if (this.isBoxSelecting) {
      this.selectionCurrent = { x: mouseX, y: mouseY };
      this.updateBoxSelection();
      this.render();
    }
  }

  private onMouseUp() {
    this.isScrubbingRuler = false;
    this.isPainting = false;
    this.isErasing = false;
    this.lastPaintedCell = null;

    if (this.isBoxSelecting) {
      this.isBoxSelecting = false;
      this.render();
    }
  }

  private paintTriggerAt(x: number, gridY: number) {
    const laneIdx = Math.floor(gridY / this.laneHeight);
    if (laneIdx < 0 || laneIdx >= this.lanes.length) return;

    const lane = this.lanes[laneIdx];
    const rawTime = this.pxToMs(x);
    const snappedTime = this.snapTimeToGrid(rawTime);

    const cellKey = `${lane.id}_${snappedTime}`;
    if (this.lastPaintedCell === cellKey) return;
    this.lastPaintedCell = cellKey;

    // Check if trigger already exists at this snap point
    const toleranceMs = (10 / this.zoomPxPerSec) * 1000;
    const existing = this.triggers.find(
      (tr) => tr.laneId === lane.id && Math.abs(tr.time - snappedTime) <= toleranceMs
    );

    if (!existing) {
      this.events.onAddTrigger(lane.id, snappedTime);
      this.events.onPreviewSample(lane);
    }
  }

  private eraseTriggerAt(x: number, gridY: number) {
    const laneIdx = Math.floor(gridY / this.laneHeight);
    if (laneIdx < 0 || laneIdx >= this.lanes.length) return;

    const lane = this.lanes[laneIdx];
    const rawTime = this.pxToMs(x);
    const toleranceMs = (16 / this.zoomPxPerSec) * 1000;

    const existing = this.triggers.find(
      (tr) => tr.laneId === lane.id && Math.abs(tr.time - rawTime) <= toleranceMs
    );

    if (existing) {
      this.events.onRemoveTrigger(existing.id);
    }
  }

  private updateBoxSelection() {
    const minX = Math.min(this.selectionStart.x, this.selectionCurrent.x);
    const maxX = Math.max(this.selectionStart.x, this.selectionCurrent.x);
    const minY = Math.min(this.selectionStart.y, this.selectionCurrent.y);
    const maxY = Math.max(this.selectionStart.y, this.selectionCurrent.y);

    const minTime = this.pxToMs(minX);
    const maxTime = this.pxToMs(maxX);

    const laneIndexMap = new Map<string, number>();
    for (let i = 0; i < this.lanes.length; i++) {
      laneIndexMap.set(this.lanes[i].id, i);
    }

    this.selectedTriggerIds.clear();

    for (const tr of this.triggers) {
      if (tr.time >= minTime && tr.time <= maxTime) {
        const lIdx = laneIndexMap.get(tr.laneId);
        if (lIdx === undefined) continue;

        const triggerY = this.rulerHeight - this.scrollTopPx + lIdx * this.laneHeight + this.laneHeight / 2;
        if (triggerY >= minY && triggerY <= maxY) {
          this.selectedTriggerIds.add(tr.id);
        }
      }
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();

    if (e.ctrlKey) {
      // Zoom centered at mouse cursor
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseTime = this.pxToMs(mouseX);

      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const newZoom = Math.max(40, Math.min(600, this.zoomPxPerSec * zoomFactor));

      this.zoomPxPerSec = newZoom;
      this.scrollLeftMs = Math.max(0, mouseTime - (mouseX / newZoom) * 1000);
      this.render();
    } else if (e.shiftKey) {
      // Shift + Wheel = Horizontal scroll
      const deltaMs = (e.deltaY / this.zoomPxPerSec) * 300;
      this.scrollLeftMs = Math.max(0, this.scrollLeftMs + deltaMs);
      this.render();
    } else {
      // Vertical scroll (synchronized with left rack)
      const maxScrollTop = Math.max(0, this.lanes.length * this.laneHeight - (this.canvas.height / (window.devicePixelRatio || 1) - this.rulerHeight));
      this.scrollTopPx = Math.max(0, Math.min(maxScrollTop, this.scrollTopPx + e.deltaY));
      this.events.onScrollVertical(this.scrollTopPx);
      this.render();
    }
  }
}
