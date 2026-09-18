import type { HitObject, Lane, TimingPoint, Trigger } from '../types';

export interface SequencerEvents {
  onAddTrigger: (laneId: string, time: number) => void;
  onRemoveTrigger: (triggerId: string) => void;
  onDeleteSelected: (triggerIds: string[]) => void;
  onSeek: (timeMs: number) => void;
  onPreviewSample: (lane: Lane) => void;
  onScrollVertical: (scrollTop: number) => void;
  onZoomChange?: (newZoom: number) => void;
  onPushHistory?: () => void;
}

export class Sequencer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private lanes: Lane[] = [];
  private triggers: Trigger[] = [];
  private timingPoints: TimingPoint[] = [];
  public kiaiIntervals: { start: number; end: number }[] = [];
  private ghostHitObjects: HitObject[] = [];

  private waveformPeaks: Float32Array | null = null;
  private transientPeaks: Float32Array | null = null;
  private durationMs = 0;

  // Exact Layout Dimensions matching the Left Channel Rack
  public zoomPxPerSec = 220; // Horizontal zoom
  public scrollLeftMs = 0; // Current view start in ms
  public scrollTopPx = 0; // Vertical scroll
  public laneHeight = 58; // Exactly matches HTML lane card height
  public rulerHeight = 64; // Exactly matches left rack header height
  public scrollbarHeight = 14; // Bottom overview scrollbar height
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
  private isPanning = false;
  private isDraggingScrollbar = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartScrollLeft = 0;
  private panStartScrollTop = 0;
  private selectionStart = { x: 0, y: 0 };
  private selectionCurrent = { x: 0, y: 0 };

  private pendingClickNote: { lane: Lane; time: number } | null = null;
  private mouseDownPos = { x: 0, y: 0 };
  private initialSelection = new Set<string>();
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
    this.timingPoints = [...timingPoints].sort((a, b) => a.time - b.time || (a.uninherited ? -1 : 1));
    this.ghostHitObjects = ghostNotes;
    this.waveformPeaks = waveform.peaks;
    this.transientPeaks = waveform.transients;
    this.durationMs = Math.max(waveform.duration * 1000, 10000);
    this.kiaiIntervals = this.computeKiaiIntervals();
    this.render();
  }

  private computeKiaiIntervals(): { start: number; end: number }[] {
    const intervals: { start: number; end: number }[] = [];
    let currentStart: number | null = null;

    for (let i = 0; i < this.timingPoints.length; i++) {
      const tp = this.timingPoints[i];
      const isKiai = (tp.effects & 1) !== 0;

      if (isKiai && currentStart === null) {
        currentStart = tp.time;
      } else if (!isKiai && currentStart !== null) {
        intervals.push({ start: currentStart, end: tp.time });
        currentStart = null;
      }
    }

    if (currentStart !== null) {
      intervals.push({ start: currentStart, end: Math.max(currentStart + 10000, this.durationMs) });
    }

    return intervals;
  }

  public isKiaiAtTime(timeMs: number): boolean {
    for (const interval of this.kiaiIntervals) {
      if (timeMs >= interval.start && timeMs <= interval.end) {
        return true;
      }
    }
    return false;
  }

  public getActiveBpm(timeMs: number): number {
    const rl = this.findActiveRedLine(timeMs);
    if (!rl || rl.beatLength <= 0) return 120;
    return Math.round(60000 / rl.beatLength);
  }

  public setTime(timeMs: number, triggerRender: boolean = true) {
    this.currentTimeMs = timeMs;

    if (this.followPlayhead) {
      const viewDurationMs = (this.canvas.getBoundingClientRect().width / this.zoomPxPerSec) * 1000;
      if (timeMs > this.scrollLeftMs + viewDurationMs * 0.85 || timeMs < this.scrollLeftMs) {
        this.scrollLeftMs = Math.max(0, timeMs - viewDurationMs * 0.2);
      }
    }

    if (triggerRender) {
      this.render();
    }
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
    this.zoomPxPerSec = Math.max(20, Math.min(4000, zoom));
    this.render();
  }

  public resetView() {
    this.currentTimeMs = 0;
    this.scrollLeftMs = 0;
    this.scrollTopPx = 0;
    this.selectedTriggerIds.clear();
    this.render();
  }

  public selectAll() {
    this.selectedTriggerIds.clear();
    for (const tr of this.triggers) {
      this.selectedTriggerIds.add(tr.id);
    }
    this.render();
  }

  public deselectAll() {
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
    const redLines = this.timingPoints.filter((tp) => tp.uninherited);
    if (redLines.length === 0) return Math.max(0, timeMs);

    let activeIdx = 0;
    for (let i = 0; i < redLines.length; i++) {
      if (redLines[i].time <= timeMs) {
        activeIdx = i;
      } else {
        break;
      }
    }

    const rl = redLines[activeIdx];
    const snapInterval = rl.beatLength / this.activeSnapDivisor;
    const diff = timeMs - rl.time;
    const snappedDiff = Math.round(diff / snapInterval) * snapInterval;
    const snappedTime = Math.max(0, Math.round(rl.time + snappedDiff));

    // Evaluate multiple BPM boundary: check if next red line snap is closer
    const nextRl = redLines[activeIdx + 1];
    if (nextRl && snappedTime >= nextRl.time) {
      const nextSnapInterval = nextRl.beatLength / this.activeSnapDivisor;
      const nextDiff = timeMs - nextRl.time;
      const nextSnappedDiff = Math.round(nextDiff / nextSnapInterval) * nextSnapInterval;
      const nextSnappedTime = Math.max(0, Math.round(nextRl.time + nextSnappedDiff));

      if (Math.abs(timeMs - nextSnappedTime) < Math.abs(timeMs - snappedTime)) {
        return nextSnappedTime;
      }
    }

    return snappedTime;
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
    const trackAreaHeight = Math.max(0, height - this.rulerHeight - this.scrollbarHeight);

    // 1. Draw Lane rows in scrollable area (clipped between ruler and bottom scrollbar)
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(0, this.rulerHeight, width, trackAreaHeight);
    this.ctx.clip();

    this.renderLaneRows(width, height - this.scrollbarHeight);
    this.renderGrid(viewStartMs, viewEndMs, height - this.scrollbarHeight);
    this.renderGhostObjects(viewStartMs, viewEndMs);
    this.renderTriggers(viewStartMs, viewEndMs);

    // Render Box Selection rectangle
    if (this.isBoxSelecting) {
      this.renderSelectionBox();
    }

    this.ctx.restore();

    // 2. Draw Sticky Top Timeline Ruler & Waveform (always on top)
    this.renderRulerAndWaveform(width, viewStartMs, viewEndMs);

    // 3. Draw Bottom Overview Scrollbar
    this.renderBottomScrollbar(width, height);

    // 4. Draw Playhead
    this.renderPlayhead(height - this.scrollbarHeight);
  }

  private renderRulerAndWaveform(width: number, viewStartMs: number, viewEndMs: number) {
    const rulerH = this.rulerHeight;

    // Ruler Background
    this.ctx.fillStyle = '#14171f';
    this.ctx.fillRect(0, 0, width, rulerH);

    // 0. Highlight Kiai Time zones on ruler (warm glowing amber wash with top border)
    for (const kiai of this.kiaiIntervals) {
      if (kiai.end < viewStartMs || kiai.start > viewEndMs) continue;
      const startX = Math.max(0, this.msToPx(kiai.start));
      const endX = Math.min(width, this.msToPx(kiai.end));
      const w = Math.max(2, endX - startX);

      // Warm amber glow wash
      this.ctx.fillStyle = 'rgba(255, 170, 0, 0.20)';
      this.ctx.fillRect(startX, 0, w, rulerH);

      // Top highlight border
      this.ctx.fillStyle = '#ffaa00';
      this.ctx.fillRect(startX, 0, w, 3);

      // Stylish label at kiai start if visible
      if (startX >= 0 && startX <= width - 50) {
        this.ctx.fillStyle = 'rgba(255, 170, 0, 0.95)';
        this.ctx.font = 'bold 9px monospace';
        this.ctx.fillText('🔥 KIAI', startX + 4, 12);
      }
    }

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
      let cumulativeBeats = 0;

      for (let i = 0; i < redLines.length; i++) {
        const rl = redLines[i];
        const nextRl = redLines[i + 1];
        const segmentEndMs = nextRl ? nextRl.time : Math.max(viewEndMs, this.durationMs);

        const beatLength = rl.beatLength;
        const meter = rl.meter || 4;
        const measureMs = beatLength * meter;
        const segmentDur = segmentEndMs - rl.time;
        const beatsInSegment = Math.max(1, Math.round(segmentDur / beatLength));

        // Skip timing segments that are entirely out of view
        if (segmentEndMs < viewStartMs || rl.time > viewEndMs) {
          cumulativeBeats += beatsInSegment;
          continue;
        }

        const segStartMs = Math.max(rl.time, viewStartMs);
        const segEndMs = Math.min(segmentEndMs, viewEndMs);

        const startM = Math.max(0, Math.floor((segStartMs - rl.time) / measureMs));
        const endM = Math.ceil((segEndMs - rl.time) / measureMs);

        // Dynamic density to strictly prevent text collision
        const measurePx = (measureMs / 1000) * this.zoomPxPerSec;
        let labelStep = 1;
        if (measurePx < 55) labelStep = 2;
        if (measurePx < 28) labelStep = 4;
        if (measurePx < 14) labelStep = 8;
        if (measurePx < 7) labelStep = 16;
        if (measurePx < 3.5) labelStep = 32;

        let lastDrawnX = -9999;

        for (let m = startM; m <= endM; m++) {
          const mTime = rl.time + m * measureMs;
          if (mTime > segmentEndMs) break;
          if (mTime < viewStartMs || mTime > viewEndMs) continue;

          const x = Math.round(this.msToPx(mTime)) + 0.5;

          // Measure marker tick
          this.ctx.strokeStyle = '#4a9eff';
          this.ctx.lineWidth = 2;
          this.ctx.beginPath();
          this.ctx.moveTo(x, rulerH - 22);
          this.ctx.lineTo(x, rulerH);
          this.ctx.stroke();

          // Only draw text if spaced enough and matches step
          const measureNum = 1 + Math.floor((cumulativeBeats + m * meter) / meter);
          const isMajor = (m % labelStep === 0);
          if (isMajor && (x > lastDrawnX + 50)) {
            // Measure text label
            this.ctx.fillStyle = '#8ab4f8';
            this.ctx.font = 'bold 12px monospace';
            this.ctx.fillText(`${measureNum}`, x + 5, 20);

            // Millisecond label
            const sec = (mTime / 1000).toFixed(2);
            this.ctx.fillStyle = '#7a869a';
            this.ctx.font = '10px monospace';
            this.ctx.fillText(`${sec}s`, x + 5, 34);

            lastDrawnX = x;
          }
        }

        cumulativeBeats += beatsInSegment;
      }

      // Draw Red Timing Lines (BPM Changes) on Ruler
      for (let i = 0; i < redLines.length; i++) {
        const rl = redLines[i];
        if (rl.time < viewStartMs - 1000 || rl.time > viewEndMs + 1000) continue;
        const x = Math.round(this.msToPx(rl.time)) + 0.5;
        const bpm = Math.round(60000 / rl.beatLength);

        // Distinct Red Line
        this.ctx.strokeStyle = '#ff3344';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, rulerH);
        this.ctx.stroke();

        // Red BPM badge tag
        const tagText = `${bpm} BPM`;
        this.ctx.font = 'bold 9px monospace';
        const textW = this.ctx.measureText(tagText).width;

        this.ctx.fillStyle = 'rgba(239, 68, 68, 0.92)';
        this.ctx.beginPath();
        this.ctx.roundRect(x + 2, rulerH - 16, textW + 6, 14, 3);
        this.ctx.fill();

        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillText(tagText, x + 5, rulerH - 5);
      }
    }
  }

  private renderLaneRows(width: number, height: number) {
    let y = this.rulerHeight - this.scrollTopPx;
    const hasSolo = this.lanes.some((l) => l.solo);

    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      const isInactive = lane.muted || (hasSolo && !lane.solo);

      if (y + this.laneHeight > this.rulerHeight && y < height) {
        // Alternating row background (darker if inactive)
        this.ctx.fillStyle = isInactive
          ? '#111319'
          : (i % 2 === 0 ? '#161922' : '#1a1e28');
        this.ctx.fillRect(0, y, width, this.laneHeight);

        // Subtle lane accent tint
        if (!isInactive) {
          this.ctx.fillStyle = lane.color + '0d';
          this.ctx.fillRect(0, y, width, this.laneHeight);
        }

        // Lane bottom divider
        this.ctx.strokeStyle = isInactive ? '#1e2330' : '#272d3d';
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

    // Kiai background wash in lane tracks area
    const viewStartMs = this.scrollLeftMs;
    const viewEndMs = this.pxToMs(width);
    for (const kiai of this.kiaiIntervals) {
      if (kiai.end < viewStartMs || kiai.start > viewEndMs) continue;
      const startX = Math.max(0, this.msToPx(kiai.start));
      const endX = Math.min(width, this.msToPx(kiai.end));
      const w = Math.max(2, endX - startX);

      this.ctx.fillStyle = 'rgba(255, 170, 0, 0.035)';
      this.ctx.fillRect(startX, this.rulerHeight, w, height - this.rulerHeight);

      // Kiai start vertical dashed marker
      if (kiai.start >= viewStartMs && kiai.start <= viewEndMs) {
        this.ctx.strokeStyle = 'rgba(255, 170, 0, 0.45)';
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([4, 4]);
        this.ctx.beginPath();
        this.ctx.moveTo(startX, this.rulerHeight);
        this.ctx.lineTo(startX, height);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
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
        if (timeMs >= segmentEndMs) break; // Strictly prevent leaking into next BPM segment
        if (timeMs < viewStartMs || timeMs > viewEndMs) continue;

        const x = Math.round(this.msToPx(timeMs)) + 0.5;
        const isMeasure = b % (this.activeSnapDivisor * meter) === 0;
        const isWholeBeat = b % this.activeSnapDivisor === 0;
        const isHalfBeat = (b * 2) % this.activeSnapDivisor === 0;
        const isQuarterBeat = (b * 4) % this.activeSnapDivisor === 0;
        const isTripletBeat = (b * 3) % this.activeSnapDivisor === 0;
        const isSextupletBeat = (b * 6) % this.activeSnapDivisor === 0;
        const isEighthBeat = (b * 8) % this.activeSnapDivisor === 0;

        if (isMeasure) {
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          this.ctx.lineWidth = 1.5;
        } else if (isWholeBeat) {
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
          this.ctx.lineWidth = 1;
        } else if (isHalfBeat) {
          this.ctx.strokeStyle = 'rgba(255, 80, 80, 0.40)'; // 1/2 beat (Red)
          this.ctx.lineWidth = 1;
        } else if (isQuarterBeat) {
          this.ctx.strokeStyle = 'rgba(64, 180, 255, 0.32)'; // 1/4 beat (Cyan)
          this.ctx.lineWidth = 1;
        } else if (isTripletBeat) {
          this.ctx.strokeStyle = 'rgba(190, 100, 255, 0.35)'; // 1/3 beat (Purple)
          this.ctx.lineWidth = 1;
        } else if (isSextupletBeat) {
          this.ctx.strokeStyle = 'rgba(255, 90, 200, 0.28)'; // 1/6 beat (Magenta)
          this.ctx.lineWidth = 1;
        } else if (isEighthBeat) {
          this.ctx.strokeStyle = 'rgba(255, 210, 50, 0.30)'; // 1/8 beat (Gold)
          this.ctx.lineWidth = 1;
        } else {
          this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
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

        // Head guideline
        this.ctx.strokeStyle = 'rgba(74, 158, 255, 0.25)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(x, baseY);
        this.ctx.lineTo(x, baseY + totalLanesHeight);
        this.ctx.stroke();

        // Edge / repeat guidelines and tail guideline
        if (ho.edgeTimes && ho.edgeTimes.length > 1) {
          for (let e = 1; e < ho.edgeTimes.length; e++) {
            const edgeT = ho.edgeTimes[e];
            const edgeX = Math.round(this.msToPx(edgeT)) + 0.5;
            const isTail = e === ho.edgeTimes.length - 1;

            this.ctx.strokeStyle = isTail ? 'rgba(74, 158, 255, 0.25)' : 'rgba(255, 170, 0, 0.35)';
            this.ctx.beginPath();
            this.ctx.moveTo(edgeX, baseY);
            this.ctx.lineTo(edgeX, baseY + totalLanesHeight);
            this.ctx.stroke();

            if (!isTail) {
              // Repeat arrow marker at top
              this.ctx.fillStyle = 'rgba(255, 170, 0, 0.85)';
              this.ctx.beginPath();
              this.ctx.moveTo(edgeX, topMarkerY - 4);
              this.ctx.lineTo(edgeX + 3, topMarkerY);
              this.ctx.lineTo(edgeX, topMarkerY + 4);
              this.ctx.lineTo(edgeX - 3, topMarkerY);
              this.ctx.closePath();
              this.ctx.fill();
            }
          }
        } else {
          // Fallback tail guideline
          this.ctx.strokeStyle = 'rgba(74, 158, 255, 0.25)';
          this.ctx.beginPath();
          this.ctx.moveTo(endX, baseY);
          this.ctx.lineTo(endX, baseY + totalLanesHeight);
          this.ctx.stroke();
        }

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

    const hasSolo = this.lanes.some((l) => l.solo);

    // Dynamic width with strict margin so notes never overlap in dense streams
    const triggerW = Math.max(6, Math.min(26, this.zoomPxPerSec * 0.035));

    for (const tr of this.triggers) {
      if (tr.time < viewStartMs - 500 || tr.time > viewEndMs + 500) continue;

      const lIdx = laneIndexMap.get(tr.laneId);
      if (lIdx === undefined) continue;

      const lane = this.lanes[lIdx];
      const isInactive = lane.muted || (hasSolo && !lane.solo);

      const x = Math.round(this.msToPx(tr.time) - triggerW / 2);
      const y = this.rulerHeight - this.scrollTopPx + lIdx * this.laneHeight + 6;
      const h = this.laneHeight - 12;

      // Vertical culling: skip triggers on lanes scrolled off-screen
      if (y + h < this.rulerHeight || y > this.canvas.height) continue;

      const isSelected = this.selectedTriggerIds.has(tr.id);

      this.ctx.save();
      if (isInactive) {
        this.ctx.globalAlpha = 0.28;
      }

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

      this.ctx.restore();
    }
  }

  private renderBottomScrollbar(width: number, height: number) {
    const barY = height - this.scrollbarHeight;

    // Track
    this.ctx.fillStyle = '#0a0c10';
    this.ctx.fillRect(0, barY, width, this.scrollbarHeight);

    this.ctx.strokeStyle = '#1e2330';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, barY + 0.5);
    this.ctx.lineTo(width, barY + 0.5);
    this.ctx.stroke();

    const viewDurationMs = (width / this.zoomPxPerSec) * 1000;
    const totalMs = Math.max(viewDurationMs, this.durationMs);

    const thumbW = Math.max(30, (viewDurationMs / totalMs) * width);
    const maxScrollMs = Math.max(0, totalMs - viewDurationMs);
    const thumbX = maxScrollMs > 0 ? (this.scrollLeftMs / maxScrollMs) * (width - thumbW) : 0;

    // Kiai zones on overview scrollbar
    if (totalMs > 0) {
      this.ctx.fillStyle = 'rgba(255, 170, 0, 0.45)';
      for (const kiai of this.kiaiIntervals) {
        const kX = (kiai.start / totalMs) * width;
        const kW = Math.max(2, ((kiai.end - kiai.start) / totalMs) * width);
        this.ctx.fillRect(kX, barY + 2, kW, this.scrollbarHeight - 4);
      }
    }

    // Thumb
    this.ctx.fillStyle = this.isDraggingScrollbar ? '#4a9eff' : 'rgba(255, 255, 255, 0.28)';
    this.ctx.beginPath();
    this.ctx.roundRect(thumbX, barY + 2, thumbW, this.scrollbarHeight - 4, 3);
    this.ctx.fill();
  }

  private handleScrollbarClick(clickX: number, width: number) {
    const viewDurationMs = (width / this.zoomPxPerSec) * 1000;
    const totalMs = Math.max(viewDurationMs, this.durationMs);
    const thumbW = Math.max(30, (viewDurationMs / totalMs) * width);
    const maxScrollMs = Math.max(0, totalMs - viewDurationMs);

    const targetRatio = Math.max(0, Math.min(1, (clickX - thumbW / 2) / (width - thumbW)));
    this.scrollLeftMs = targetRatio * maxScrollMs;
    this.render();
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

    // Shortcuts: Zoom +/-, PageUp/PageDown
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') {
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.setZoom(this.zoomPxPerSec * 1.25);
        if (this.events.onZoomChange) this.events.onZoomChange(this.zoomPxPerSec);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        this.setZoom(this.zoomPxPerSec * 0.8);
        if (this.events.onZoomChange) this.events.onZoomChange(this.zoomPxPerSec);
      } else if (e.code === 'PageUp') {
        e.preventDefault();
        const viewDurationMs = (this.canvas.getBoundingClientRect().width / this.zoomPxPerSec) * 1000;
        this.scrollLeftMs = Math.max(0, this.scrollLeftMs - viewDurationMs * 0.75);
        this.render();
      } else if (e.code === 'PageDown') {
        e.preventDefault();
        const viewDurationMs = (this.canvas.getBoundingClientRect().width / this.zoomPxPerSec) * 1000;
        this.scrollLeftMs = Math.max(0, this.scrollLeftMs + viewDurationMs * 0.75);
        this.render();
      }
    });
  }

  private onMouseDown(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Bottom scrollbar interaction
    if (clickY >= rect.height - this.scrollbarHeight) {
      this.isDraggingScrollbar = true;
      this.handleScrollbarClick(clickX, rect.width);
      return;
    }

    // Middle Click OR Alt + Left Click -> Hand Pan Tool
    if (e.button === 1 || (e.altKey && e.button === 0)) {
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panStartScrollLeft = this.scrollLeftMs;
      this.panStartScrollTop = this.scrollTopPx;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // Top Ruler interaction
    if (clickY <= this.rulerHeight) {
      if (e.button === 2) {
        // Right click on ruler: pan horizontally
        this.isPanning = true;
        this.panStartX = e.clientX;
        this.panStartY = e.clientY;
        this.panStartScrollLeft = this.scrollLeftMs;
        this.panStartScrollTop = this.scrollTopPx;
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      // Left click on ruler: scrub timeline
      this.isScrubbingRuler = true;
      const targetTime = Math.max(0, this.pxToMs(clickX));
      this.events.onSeek(targetTime);
      return;
    }

    const gridY = clickY - this.rulerHeight + this.scrollTopPx;
    const laneIdx = Math.floor(gridY / this.laneHeight);
    if (laneIdx < 0 || laneIdx >= this.lanes.length) return;

    const lane = this.lanes[laneIdx];
    const rawTime = this.pxToMs(clickX);
    const snappedTime = this.snapTimeToGrid(rawTime);

    // Tolerance for clicking on an existing trigger (16px)
    const toleranceMs = (16 / this.zoomPxPerSec) * 1000;
    const existing = this.triggers.find(
      (tr) => tr.laneId === lane.id && Math.abs(tr.time - rawTime) <= toleranceMs
    );

    // Right Click -> Delete note or start drag-erase mode
    if (e.button === 2) {
      if (existing) {
        this.events.onPushHistory?.();
        this.events.onRemoveTrigger(existing.id);
        this.selectedTriggerIds.delete(existing.id);
        this.render();
        return;
      }
      this.isErasing = true;
      this.events.onPushHistory?.();
      this.eraseTriggerAt(clickX, gridY);
      return;
    }

    // Ctrl + Left Click -> Paint Mode
    if (e.ctrlKey && e.button === 0) {
      this.isPainting = true;
      this.events.onPushHistory?.();
      this.paintTriggerAt(clickX, gridY);
      return;
    }

    // Left Click
    if (e.button === 0) {
      if (existing) {
        if (e.shiftKey) {
          // Toggle selection
          if (this.selectedTriggerIds.has(existing.id)) {
            this.selectedTriggerIds.delete(existing.id);
          } else {
            this.selectedTriggerIds.add(existing.id);
          }
        } else {
          // Keep selection if already part of group, otherwise select only this note
          if (!this.selectedTriggerIds.has(existing.id)) {
            this.selectedTriggerIds.clear();
            this.selectedTriggerIds.add(existing.id);
          }
        }
        this.events.onPreviewSample(lane);
        this.render();
        return;
      }

      // Left click on empty space:
      // Defer note placement until mouseup so drag-selection does NOT drop an accidental note
      if (!e.shiftKey) {
        this.selectedTriggerIds.clear();
        this.render();
      }

      this.pendingClickNote = { lane, time: snappedTime };
      this.mouseDownPos = { x: clickX, y: clickY };
      this.selectionStart = { x: clickX, y: clickY };
      this.selectionCurrent = { x: clickX, y: clickY };
      this.isBoxSelecting = false;
      this.initialSelection = new Set(this.selectedTriggerIds);
    }
  }

  private onMouseMove(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (this.isDraggingScrollbar) {
      this.handleScrollbarClick(mouseX, rect.width);
      return;
    }

    if (this.isPanning) {
      const dx = e.clientX - this.panStartX;
      const dy = e.clientY - this.panStartY;
      const deltaMs = (dx / this.zoomPxPerSec) * 1000;
      this.scrollLeftMs = Math.max(0, this.panStartScrollLeft - deltaMs);
      const maxScrollTop = Math.max(0, this.lanes.length * this.laneHeight - (rect.height - this.rulerHeight - this.scrollbarHeight));
      this.scrollTopPx = Math.max(0, Math.min(maxScrollTop, this.panStartScrollTop - dy));
      this.events.onScrollVertical(this.scrollTopPx);
      this.render();
      return;
    }

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

    // Threshold check for drag marquee selection
    if (this.pendingClickNote) {
      const dist = Math.hypot(mouseX - this.mouseDownPos.x, mouseY - this.mouseDownPos.y);
      if (dist >= 5) {
        // User dragged: cancel pending single click placement, start box select!
        this.pendingClickNote = null;
        this.isBoxSelecting = true;
      }
    }

    // Box selection update
    if (this.isBoxSelecting) {
      this.selectionCurrent = { x: mouseX, y: mouseY };
      this.updateBoxSelection(e.shiftKey);
      this.render();
    }
  }

  private onMouseUp() {
    this.isScrubbingRuler = false;
    this.isPainting = false;
    this.isErasing = false;
    this.isDraggingScrollbar = false;
    this.lastPaintedCell = null;

    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = '';
    }

    // If mouse released without dragging, place note
    if (this.pendingClickNote) {
      this.events.onPushHistory?.();
      this.events.onAddTrigger(this.pendingClickNote.lane.id, this.pendingClickNote.time);
      this.events.onPreviewSample(this.pendingClickNote.lane);
      this.pendingClickNote = null;
      this.render();
    }

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
      this.selectedTriggerIds.delete(existing.id);
    }
  }

  private updateBoxSelection(keepExisting = false) {
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

    this.selectedTriggerIds = keepExisting ? new Set(this.initialSelection) : new Set();

    const triggerW = Math.max(6, Math.min(26, this.zoomPxPerSec * 0.035));
    const halfWTime = ((triggerW / 2) / this.zoomPxPerSec) * 1000;

    for (const tr of this.triggers) {
      if (tr.time + halfWTime >= minTime && tr.time - halfWTime <= maxTime) {
        const lIdx = laneIndexMap.get(tr.laneId);
        if (lIdx === undefined) continue;

        const noteTop = this.rulerHeight - this.scrollTopPx + lIdx * this.laneHeight + 6;
        const noteBottom = noteTop + this.laneHeight - 12;

        if (noteBottom >= minY && noteTop <= maxY) {
          this.selectedTriggerIds.add(tr.id);
        }
      }
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();

    // 1. Zoom with Ctrl + Wheel OR Alt + Wheel
    if (e.ctrlKey || e.altKey) {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseTime = this.pxToMs(mouseX);

      const zoomFactor = e.deltaY < 0 ? 1.18 : 0.82;
      const newZoom = Math.max(20, Math.min(4000, this.zoomPxPerSec * zoomFactor));

      this.zoomPxPerSec = newZoom;
      this.scrollLeftMs = Math.max(0, mouseTime - (mouseX / newZoom) * 1000);
      if (this.events.onZoomChange) {
        this.events.onZoomChange(newZoom);
      }
      this.render();
      return;
    }

    // 2. Horizontal scroll with Shift + Wheel
    if (e.shiftKey) {
      const deltaMs = (e.deltaY / this.zoomPxPerSec) * 600;
      this.scrollLeftMs = Math.max(0, this.scrollLeftMs + deltaMs);
      this.render();
      return;
    }

    // 3. Trackpad 2-finger horizontal swipe or horizontal mouse wheel
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const deltaMs = (e.deltaX / this.zoomPxPerSec) * 800;
      this.scrollLeftMs = Math.max(0, this.scrollLeftMs + deltaMs);
      this.render();
      return;
    }

    // 4. Mouse wheel on Ruler bar -> horizontal timeline scroll
    const rect = this.canvas.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    if (mouseY <= this.rulerHeight) {
      const deltaMs = (e.deltaY / this.zoomPxPerSec) * 600;
      this.scrollLeftMs = Math.max(0, this.scrollLeftMs + deltaMs);
      this.render();
      return;
    }

    // 5. Normal Wheel on track grid -> vertical track scroll
    const maxScrollTop = Math.max(0, this.lanes.length * this.laneHeight - (rect.height - this.rulerHeight - this.scrollbarHeight));
    this.scrollTopPx = Math.max(0, Math.min(maxScrollTop, this.scrollTopPx + e.deltaY));
    this.events.onScrollVertical(this.scrollTopPx);
    this.render();
  }
}
