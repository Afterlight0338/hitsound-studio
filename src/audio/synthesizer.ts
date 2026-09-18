// Procedural audio synthesizer for standard osu! hitsound samples
// Guarantees zero latency and instantaneous out-of-the-box preview

export function createSynthesizedSample(
  ctx: AudioContext,
  type: 'soft-hitnormal' | 'soft-hitclap' | 'soft-hitwhistle' | 'soft-hitfinish' | 'drum-hitnormal' | 'drum-hitclap'
): AudioBuffer {
  const sampleRate = ctx.sampleRate;

  switch (type) {
    case 'soft-hitnormal': {
      // Gentle subtle tick/thump (60ms)
      const duration = 0.08;
      const length = Math.floor(sampleRate * duration);
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 60);
        // Soft sine tone with rapid pitch drop + subtle white noise
        const freq = 300 * Math.exp(-t * 40);
        const sine = Math.sin(2 * Math.PI * freq * t);
        const noise = (Math.random() * 2 - 1) * 0.15;
        data[i] = (sine * 0.85 + noise) * env * 0.7;
      }
      return buffer;
    }

    case 'soft-hitclap': {
      // Snappy, crisp electronic/pop clap (160ms)
      const duration = 0.18;
      const length = Math.floor(sampleRate * duration);
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        // Multi-stage burst simulating clap hands
        let burst = 0;
        if (t < 0.01) burst = Math.random() * 2 - 1;
        else if (t >= 0.015 && t < 0.025) burst = Math.random() * 2 - 1;
        else if (t >= 0.03) {
          const tailEnv = Math.exp(-(t - 0.03) * 25);
          burst = (Math.random() * 2 - 1) * tailEnv;
        }
        // Bandpass characteristic
        const tone = Math.sin(2 * Math.PI * 1200 * t) * 0.2;
        data[i] = (burst * 0.8 + tone) * 0.85;
      }
      return buffer;
    }

    case 'soft-hitwhistle': {
      // Sweet melodic chime / whistle bell (250ms)
      const duration = 0.25;
      const length = Math.floor(sampleRate * duration);
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 12);
        // Dual harmonic bell tone (880Hz + 1760Hz)
        const tone1 = Math.sin(2 * Math.PI * 880 * t);
        const tone2 = Math.sin(2 * Math.PI * 1760 * t) * 0.4;
        data[i] = (tone1 + tone2) * env * 0.6;
      }
      return buffer;
    }

    case 'soft-hitfinish': {
      // Shimmering metallic cymbal crash (500ms)
      const duration = 0.5;
      const length = Math.floor(sampleRate * duration);
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 7);
        const noise = Math.random() * 2 - 1;
        const metallic1 = Math.sin(2 * Math.PI * 3420 * t) * 0.2;
        const metallic2 = Math.sin(2 * Math.PI * 5210 * t) * 0.15;
        data[i] = (noise * 0.65 + metallic1 + metallic2) * env * 0.75;
      }
      return buffer;
    }

    case 'drum-hitnormal': {
      // Punchy acoustic kick drum (150ms)
      const duration = 0.15;
      const length = Math.floor(sampleRate * duration);
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 22);
        // Exponential pitch drop from 180Hz down to 50Hz
        const freq = 50 + 130 * Math.exp(-t * 60);
        const sine = Math.sin(2 * Math.PI * freq * t);
        const click = t < 0.005 ? (Math.random() * 2 - 1) * 0.4 : 0;
        data[i] = (sine * 0.9 + click) * env * 0.9;
      }
      return buffer;
    }

    case 'drum-hitclap': {
      // Fat punchy acoustic snare (200ms)
      const duration = 0.2;
      const length = Math.floor(sampleRate * duration);
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);

      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const bodyEnv = Math.exp(-t * 30);
        const noiseEnv = Math.exp(-t * 18);
        const body = Math.sin(2 * Math.PI * (180 * Math.exp(-t * 30)) * t) * bodyEnv * 0.6;
        const noise = (Math.random() * 2 - 1) * noiseEnv * 0.7;
        data[i] = (body + noise) * 0.85;
      }
      return buffer;
    }
  }
}
