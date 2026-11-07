/* Voice: measureVoice off the main thread. It takes about 3.5 s on 45 s of speech, which would freeze the page.
   vendor/voice-health-browser.js is SeniorMinder's measurement, built by npm run build:voice. */

import { measureVoice } from "./vendor/voice-health-browser.js";

self.onmessage = ({ data }) => {
  try {
    const opts = typeof data.transcript === "string" ? { transcript: data.transcript, transcriptSource: "whisper" } : {};
    self.postMessage({ ok: true, result: measureVoice(data.pcm, opts) });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
