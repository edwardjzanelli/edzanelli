/* Voice: Whisper in the browser, off the main thread. transformers.js 2.17.2, the version SeniorMinder transcribes
   with, running Xenova/whisper-base.en quantized, as SeniorMinder loads it (quantized: true). The model is fetched
   from Hugging Face and the runtime from jsDelivr; the browser caches both. Nothing of the audio leaves this worker.

   As in SeniorMinder's SpeechTranscriber: a clip under 5 s is padded with trailing silence to 5 s, and no language
   or task is passed, because base.en is English only. Unlike there, a recording here can run to 120 s, past
   Whisper's 30 s window, so a longer one is transcribed in 30 s chunks with a 5 s overlap. */

import { env, pipeline } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js";

const MODEL = "Xenova/whisper-base.en";
const MIN_SAMPLES = 80000;   // 5 s at 16 kHz
const WINDOW_SAMPLES = 30 * 16000;

env.allowLocalModels = false;

let asr = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      asr = await pipeline("automatic-speech-recognition", MODEL, {
        quantized: true,
        progress_callback: (p) => {
          if (p.status === "progress") self.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
        },
      });
      self.postMessage({ type: "loaded" });
    } else if (data.type === "transcribe") {
      let audio = data.pcm;
      if (audio.length < MIN_SAMPLES) {
        const padded = new Float32Array(MIN_SAMPLES);
        padded.set(audio);
        audio = padded;
      }
      const opts = audio.length > WINDOW_SAMPLES ? { chunk_length_s: 30, stride_length_s: 5 } : {};
      const out = await asr(audio, opts);
      self.postMessage({ type: "text", text: (out.text || "").trim() });
    }
  } catch (err) {
    self.postMessage({ type: "error", error: err.message || String(err) });
  }
};
