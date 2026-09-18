import type { HitObject, Lane, TimingPoint, Trigger } from '../types';

export interface SequencerEvents {
  onAddTrigger: (laneId: string, time: number) => void;
  onRemoveTrigger: (triggerId: string) => void;
  onSeek: (timeMs: number) => void;
  onPreviewSample: (lane: Lane) => void;
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

  // Viewport
  public zoomPxPerSec = 140; // Horizontal zoom
  public scrollLeftMs = 0; // Current view start in ms
  public laneHeight = 38;
  public rulerHeight = 52;
  public currentTimeMs = 0;
  public activeSnapDivisor = 4; // 1/4 default
  public followPlayhead = true;

  private events: SequencerEvents;
  private isScrubbingRuler = false;

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

    // Follow playhead if enabled
    if (this.followPlayhead) {
      const viewDurationMs = (this.canvas.getBoundingClientRect().width / this.zoomPxPerSec) * 1000;
      if (timeMs > this.scrollLeftMs + viewDurationMs * 0.85 || timeMs < this.scrollLeftMs) {
        this.scrollLeftMs = Math.max(0, timeMs - viewDurationMs * 0.2);
      }
    }

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
    this.ctx.fillStyle = '#14161d';
    this.ctx.fillRect(0, 0, width, height);

    const viewStartMs = this.scrollLeftMs;
    const viewEndMs = this.pxToMs(width);

    // 1. Draw Waveform in ruler area
    this.renderWaveform(width);

    // 2. Draw Lane backgrounds
    this.renderLaneRows(width, height);

    // 3. Draw Grid Lines (Beats & Sub-beats)
    this.renderGrid(viewStartMs, viewEndMs, height);

    // 4. Draw Ghost HitObjects from reference map
    this.renderGhostObjects(viewStartMs, viewEndMs);

    // 5. Draw Triggers
    this.renderTriggers(viewStartMs, viewEndMs);

    // 6. Draw Timeline Ruler
    this.renderRuler(width, viewStartMs, viewEndMs);

    // 7. Draw Playhead
    this.renderPlayhead(height);
  }

  private renderWaveform(width: number) {
    if (!this.waveformPeaks) return;

    const rulerH = this.rulerHeight;
    const pointsPerSec = 150;
    const totalPoints = this.waveformPeaks.length;

    this.ctx.fillStyle = 'rgba(74, 158, 255, 0.12)';

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

    // Render transients (punchy beats) as gold spikes
    if (this.transientPeaks) {
      this.ctx.fillStyle = 'rgba(255, 196, 0, 0.35)';
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

  private renderLaneRows(width: number, height: number) {
    let y = this.rulerHeight;

    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      // Alternating row tone
      this.ctx.fillStyle = i % 2 === 0 ? '#181b24' : '#1c202b';
      this.ctx.fillRect(0, y, width, this.laneHeight);

      // Subtle lane accent tint
      this.ctx.fillStyle = lane.color + '0a';
      this.ctx.fillRect(0, y, width, this.laneHeight);

      // Lane bottom divider
      this.ctx.strokeStyle = '#272c3b';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y + this.laneHeight);
      this.ctx.lineTo(width, y + this.laneHeight);
      this.ctx.stroke();

      y += this.laneHeight;
    }

    // Remaining empty space
    if (y < height) {
      this.ctx.fillStyle = '#111319';
      this.ctx.fillRect(0, y, width, height - y);
    }
  }

  private renderGrid(viewStartMs: number, viewEndMs: number, totalHeight: number) {
    const redLines = this.timingPoints.filter((tp) => tp.uninherited);
    if (redLines.length === 0) return;

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

      // Calculate first beat index
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
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
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
        this.ctx.moveTo(x, this.rulerHeight);
        this.ctx.lineTo(x, totalHeight);
        this.ctx.stroke();
      }
    }
  }

  private renderGhostObjects(viewStartMs: number, viewEndMs: number) {
    if (this.ghostHitObjects.length === 0) return;

    const totalLanesHeight = this.lanes.length * this.laneHeight;
    const baseY = this.rulerHeight;

    for (const ho of this.ghostHitObjects) {
      if (ho.time < viewStartMs - 2000 || ho.time > viewEndMs + 2000) continue;

      const x = this.msToPx(ho.time);
      const isCircle = (ho.type & 1) !== 0;
      const isSlider = (ho.type & 2) !== 0;

      if (isCircle) {
        // Vertical ghost marker for circle
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        this.ctx.fillRect(x - 2, baseY, 4, totalLanesHeight);

        // Center hit marker
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        this.ctx.lineWidth = 1.5;
        this.ctx.strokeRect(x - 5, baseY + 2, 10, totalLanesHeight - 4);
      } else if (isSlider) {
        const endTime = ho.endTime || ho.time + 300;
        const endX = this.msToPx(endTime);
        const w = Math.max(6, endX - x);

        // Slider span block
        this.ctx.fillStyle = 'rgba(120, 170, 255, 0.08)';
        this.ctx.fillRect(x, baseY, w, totalLanesHeight);

        // Head and tail borders
        this.ctx.strokeStyle = 'rgba(120, 170, 255, 0.4)';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x, baseY, w, totalLanesHeight);
      }
    }
  }

  private renderTriggers(viewStartMs: number, viewEndMs: number) {
    const laneIndexMap = new Map<string, number>();
    for (let i = 0; i < this.lanes.length; i++) {
      laneIndexMap.set(this.lanes[i].id, i);
    }

    const triggerW = Math.max(8, this.zoomPxPerSec * 0.06);

    for (const tr of this.triggers) {
      if (tr.time < viewStartMs - 500 || tr.time > viewEndMs + 500) continue;

      const lIdx = laneIndexMap.get(tr.laneId);
      if (lIdx === undefined) continue;

      const lane = this.lanes[lIdx];
      const x = this.msToPx(tr.time) - triggerW / 2;
      const y = this.rulerHeight + lIdx * this.laneHeight + 4;
      const h = this.laneHeight - 8;

      // Trigger Block
      this.ctx.fillStyle = lane.color;
      this.ctx.beginPath();
      this.ctx.roundRect(x, y, triggerW, h, 4);
      this.ctx.fill();

      // Trigger Glow / Border
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 1.2;
      this.ctx.stroke();

      // Inner highlight line
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      this.ctx.fillRect(x + 2, y + 2, triggerW - 4, 2);
    }
  }

  private renderRuler(width: number, viewStartMs: number, viewEndMs: number) {
    const rulerH = this.rulerHeight;

    // Ruler Background
    this.ctx.fillStyle = '#101217';
    this.ctx.fillRect(0, 0, width, rulerH);

    // Bottom border
    this.ctx.strokeStyle = '#2b3040';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(0, rulerH);
    this.ctx.lineTo(width, rulerH);
    this.ctx.stroke();

    // Red lines & Measures
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
          this.ctx.moveTo(x, rulerH - 18);
          this.ctx.lineTo(x, rulerH);
          this.ctx.stroke();

          // Measure text label
          this.ctx.fillStyle = '#8ab4f8';
          this.ctx.font = '11px monospace';
          this.ctx.fillText(`${m + 1}`, x + 4, 16);

          // Millisecond label
          const sec = (mTime / 1000).toFixed(1);
          this.ctx.fillStyle = '#667085';
          this.ctx.font = '9px monospace';
          this.ctx.fillText(`${sec}s`, x + 4, 28);
        }
      }
    }
  }

  private renderPlayhead(totalHeight: number) {
    const x = Math.round(this.msToPx(this.currentTimeMs)) + 0.5;

    // Playhead Line
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(x, 0);
    this.ctx.lineTo(x, totalHeight);
    this.ctx.stroke();

    // Playhead glowing pointer head
    this.ctx.fillStyle = '#4a9eff';
    this.ctx.beginPath();
    this.ctx.moveTo(x - 6, 0);
    this.ctx.lineTo(x + 6, 0);
    this.ctx.lineTo(x, 10);
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
  }

  private onMouseDown(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (clickY <= this.rulerHeight) {
      // Ruler scrubbing
      this.isScrubbingRuler = true;
      const targetTime = Math.max(0, this.pxToMs(clickX));
      this.events.onSeek(targetTime);
      return;
    }

    // Grid interaction
    const laneIdx = Math.floor((clickY - this.rulerHeight) / this.laneHeight);
    if (laneIdx < 0 || laneIdx >= this.lanes.length) return;

    const lane = this.lanes[laneIdx];
    const rawTime = this.pxToMs(clickX);
    const snappedTime = this.snapTimeToGrid(rawTime);

    // Check if clicked near an existing trigger in this lane
    const toleranceMs = (12 / this.zoomPxPerSec) * 1000;
    const existing = this.triggers.find(
      (tr) => tr.laneId === lane.id && Math.abs(tr.time - snappedTime) <= toleranceMs
    );

    if (e.button === 2 || (e.button === 0 && existing)) {
      // Right click or click existing -> delete
      if (existing) {
        this.events.onRemoveTrigger(existing.id);
      }
    } else if (e.button === 0 && !existing) {
      // Left click empty -> create
      this.events.onAddTrigger(lane.id, snappedTime);
      this.events.onPreviewSample(lane);
    }
  }

  private onMouseMove(e: MouseEvent) {
    if (this.isScrubbingRuler) {
      const rect = this.canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const targetTime = Math.max(0, this.pxToMs(clickX));
      this.events.onSeek(targetTime);
    }
  }

  private onMouseUp() {
    this.isScrubbingRuler = false;
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
    } else {
      // Horizontal scroll
      const deltaMs = ((e.deltaY || e.deltaX) / this.zoomPxPerSec) * 300;
      this.scrollLeftMs = Math.max(0, this.scrollLeftMs + deltaMs);
      this.render();
    }
  }
}
