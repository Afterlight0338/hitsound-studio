# ⚡ Hitsound Studio (osu!)

A lightweight, blazing-fast, web-based DAW and hitsounding environment designed specifically for osu! standard mappers.

---

## 🎯 The Vision & Philosophy

Hitsounding in osu! has traditionally been an exercise in frustration: juggling legacy sample sets (`Normal`, `Soft`, `Drum`), additions (`Whistle`, `Finish`, `Clap`), volumes, and custom override indices across hundreds of timing lines. The community's current workaround—creating dummy 18-key Mania diffs in Mapping Tools—proves that mappers want a lane-based tracker/DAW, but the workflow has been fragmented and clunky.

**Hitsound Studio** replaces the entire mania-hack pipeline with a native, zero-install, client-side web application built for speed and functionality.

### Core Principles
* **Lightweight & Fast:** Zero heavy 3D or bloated UI frameworks. Pure TypeScript + fast 2D Canvas + Web Audio API. Builds in under 100ms.
* **100% Client-Side:** No server required. Runs locally in your browser. All `.osz` and `.osu` files remain private on your machine.
* **Non-Destructive Hitsound Diff Standard:** Exports a clean `[Hitsounds].osu` diff with all notes placed dead-center at `(256, 192)`, fully compatible with the official osu! editor.
* **Built-in Hitsound Copier:** Merges hitsounds directly into your mapset's difficulties while **strictly preserving Slider Velocity (SV)**.

---

## ✨ Features

### 1. Dynamic Lanes (FL Studio-Style Channel Rack)
* Add, remove, rename, and reorder lanes dynamically.
* Assign osu! bindings per lane:
  * **SampleSet:** `Soft` | `Normal` | `Drum`
  * **Addition:** `None` | `Clap` | `Whistle` | `Finish`
  * **Custom Index:** `#0` (default) or custom sample number `#1, #2, #3...`
  * **Lane Volume:** 0% – 100%
* Solo (S) and Mute (M) buttons for isolated monitoring.
* Drop custom `.wav` files directly onto lanes or use built-in procedural synthesis.

### 2. High-Performance Canvas Sequencer
* **Waveform & Transients:** Downsampled audio waveform showing song transients (punchy beats, kicks, snares) highlighted in gold.
* **Beat Snapping:** Dynamic grid lines based on the song's BPM and timing points (1/1, 1/2, 1/4, 1/3, 1/6, 1/8, 1/12, 1/16).
* **Ghost Notes:** Overlay hit objects (circles, sliders, repeats) from any difficulty in your mapset in translucent grey so you can align hitsounds directly with the player's inputs.
* **Lookahead Audio Scheduler:** High-precision Web Audio clock with lookahead scheduling ensures zero audio jitter or lag.

### 3. Dedicated `[Hitsounds].osu` Generator
* Combines simultaneous lane triggers at the same timestamp into valid hitsound bitmasks (e.g., Clap `8` + Whistle `2` = `10`).
* Emits hit circles at coordinates `x=256, y=192`.
* Automatically generates uninherited timing points (green lines) for volume and sample set changes.

### 4. Built-In Hitsound Copier
* Select your target difficulties (`Easy`, `Normal`, `Hard`, `Insane`, `Expert`).
* Configurable snap tolerance (e.g. ±5ms).
* Precision transfer:
  * HitObject additions and sample sets
  * Slider heads, repeat arrows, and slider tails
  * Spinners
  * Green timing point volumes
* **Preserves target diff's Slider Velocity (SV)** without overwriting them.
* One-click download as an updated `.osz` or `.osu` bundle.

### 5. Built-in Demo Beatmap
* Click **"Load Demo"** in the top bar to immediately explore the interface with a procedurally generated 175 BPM synth-pop track, jump circles, sliders, and pre-placed hitsound triggers.

---

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/) (v18+)

### Install & Run Locally

```bash
# Clone or navigate to directory
cd hitsound-studio

# Install dependencies
npm install

# Start local dev server
npm run dev
```

Open `http://localhost:5173` in your browser.

### Run Tests

```bash
npm test
```

### Build for Production

```bash
npm run build
```

The production output is generated in `dist/` and can be hosted statically on GitHub Pages, Cloudflare Pages, or Netlify.

---

## ⌨ Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / Pause |
| `Home` | Return to start (00:00.000) |
| `Left / Right Arrow` | Step backward / forward by 1 snap divisor |
| `1` – `6` | Quick switch snap divisor (`1/1`, `1/2`, `1/4`, `1/3`, `1/6`, `1/8`) |
| `Ctrl + Mouse Wheel` | Zoom timeline in / out |
| `Mouse Wheel` | Scroll timeline horizontally |
| `Left Click` | Place trigger on grid / scrub on ruler |
| `Right Click` | Delete trigger |
