import type { Page } from "puppeteer";
import { resamplePcm16 } from "../tts/audio.js";
import type { TtsAudio } from "../tts/provider.js";
import { logger } from "../logging/logger.js";
import { MIC_MUTE_LABEL, MIC_UNMUTE_LABEL } from "./selectors.js";

export { resamplePcm16 };

/** One reply at a time. A second speak waits until the first has re-muted. */
export class SpeakLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export const speakLock = new SpeakLock();

export const AUDIO_BRIDGE_SCRIPT = `(() => {
  if (window.__mbAudio) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  window.__mbAudio = ctx;
  window.__mbDest = dest;
  const keep = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const silent = ctx.createBufferSource();
  silent.buffer = keep;
  silent.loop = true;
  silent.connect(ctx.destination);
  silent.start();
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.audio) return dest.stream;
    return original(constraints);
  };
  window.__mbSpeak = (pcm, sampleRate, gain) => new Promise((resolve) => {
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) floats[i] = pcm[i] / 32768;
    const length = Math.max(1, Math.round(floats.length * ctx.sampleRate / sampleRate));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    const last = Math.max(0, floats.length - 1);
    for (let i = 0; i < length; i += 1) {
      const position = i * sampleRate / ctx.sampleRate;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = floats[Math.min(index, last)] || 0;
      const b = floats[Math.min(index + 1, last)] || a;
      const sample = (a + (b - a) * fraction) * gain;
      channel[i] = Math.max(-1, Math.min(1, sample));
    }
    const source = ctx.createBufferSource();
    const amp = ctx.createGain();
    amp.gain.value = 1;
    source.buffer = buffer;
    source.connect(amp);
    amp.connect(dest);
    source.onended = () => resolve();
    source.start();
  });
})();`;

export async function installAudioBridge(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(AUDIO_BRIDGE_SCRIPT);
  await page.evaluate(AUDIO_BRIDGE_SCRIPT).catch(() => undefined);
}

export interface SpeakHooks {
  setSpeaking?: (active: boolean) => void;
  wait?: (ms: number) => Promise<void>;
}

export async function speakSequence(
  page: Page,
  chunks: TtsAudio[],
  gain: number,
  hooks: SpeakHooks = {},
): Promise<void> {
  return speakLock.run(async () => {
    const wait = hooks.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    hooks.setSpeaking?.(true);
    const unmuted = await clickMic(page, MIC_UNMUTE_LABEL);
    if (!unmuted) {
      logger.warn("mic unmute button missing; falling back to track.enabled");
      await setTrackEnabled(page, true);
    }
    try {
      await wait(200);
      for (const chunk of chunks) {
        await page.evaluate(
          `(async () => {
            if (!window.__mbSpeak) throw new Error("audio bridge missing");
            const pcm = ${JSON.stringify(Array.from(chunk.pcm))};
            await window.__mbSpeak(pcm, ${chunk.sampleRate}, ${gain});
          })()`,
        );
      }
    } finally {
      const muted = await clickMic(page, MIC_MUTE_LABEL);
      if (!muted) {
        logger.warn("mic mute button missing; falling back to track.enabled");
        await setTrackEnabled(page, false);
      }
      hooks.setSpeaking?.(false);
    }
  });
}

async function clickMic(page: Page, label: string): Promise<boolean> {
  const clicked = await page.evaluate(`(() => {
    const wanted = ${JSON.stringify(label)};
    const nodes = Array.from(document.querySelectorAll("button, [role='button']"));
    const match = nodes.find((node) => (node.getAttribute("aria-label") || "").trim() === wanted);
    if (!match) return false;
    match.click();
    return true;
  })()`);
  return clicked === true;
}

async function setTrackEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(`(() => {
    const dest = window.__mbDest;
    if (!dest) return false;
    for (const track of dest.stream.getAudioTracks()) track.enabled = ${enabled ? "true" : "false"};
    return true;
  })()`);
}
