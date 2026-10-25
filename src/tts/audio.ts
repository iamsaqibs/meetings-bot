export function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp((samples[index] ?? 0), -1, 1);
    out[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return out;
}

export function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    out[index] = (pcm[index] ?? 0) / 0x8000;
  }
  return out;
}

/** Linear resample into the AudioContext rate, then apply the AGC gain and clip. */
export function resamplePcm16(
  pcm: Int16Array,
  fromRate: number,
  toRate: number,
  gain: number,
): Float32Array {
  const floats = pcm16ToFloat32(pcm);
  if (fromRate <= 0 || toRate <= 0) throw new Error("sample rate must be positive");
  const length = Math.max(1, Math.round((floats.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const last = Math.max(0, floats.length - 1);
  for (let index = 0; index < length; index += 1) {
    const position = (index * fromRate) / toRate;
    const left = Math.floor(position);
    const fraction = position - left;
    const a = floats[Math.min(left, last)] ?? 0;
    const b = floats[Math.min(left + 1, last)] ?? a;
    out[index] = clamp((a + (b - a) * fraction) * gain, -1, 1);
  }
  return out;
}

export function playbackSeconds(chunks: Array<{ pcm: Int16Array; sampleRate: number }>): number {
  return chunks.reduce((sum, chunk) => {
    if (chunk.sampleRate <= 0) return sum;
    return sum + chunk.pcm.length / chunk.sampleRate;
  }, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
