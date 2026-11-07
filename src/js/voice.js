/* Voice. The visitor records up to two minutes of speech and the page measures it with SeniorMinder's voice-health
   code, on the visitor's own device.

   The microphone is opened with echo cancellation, noise suppression and automatic gain off, because each of them
   reshapes the very levels and pauses being measured. Capture runs in an AudioWorklet; on Stop the samples are
   resampled to 16 kHz with an OfflineAudioContext, transcribed by Whisper in one worker and measured by
   measureVoice in another, so the page never freezes. The meter is drawn from the same samples as they arrive and
   is display only: nothing it computes reaches the measurement.

   The recording is never uploaded or stored. The audio lives in this page's memory until Measure again or the page
   closes. The network traffic is downloading Whisper, once, after the first Stop, and, only while the visitor has
   ticked the sentiment box, the words Whisper heard, posted to the token Lambda, which scores them with
   SeniorMinder's sentiment prompt and model at OpenAI. */

import {
  MAX_SECONDS,
  countdown,
  createMeter,
  fileName,
  levelFraction,
  resampleTo16k,
  resultCards,
  resultsFile,
  sentimentCards,
  sentimentFromResponse,
  sentimentText,
} from "./voice-logic.js";
import { TOKEN_URL } from "./token-url.js";

// What the browser downloads for Whisper the first time (Hugging Face and jsDelivr, file sizes as published for
// Xenova/whisper-base.en and @xenova/transformers 2.17.2): the quantized encoder and merged decoder, the tokenizer
// and four small configs; then the ONNX runtime's wasm and the library itself.
const MODEL_BYTES = 79041253;
const RUNTIME_BYTES = 10912612;

const el = {
  record: document.getElementById("record"),
  countdown: document.getElementById("countdown"),
  meter: document.getElementById("meter"),
  levelFill: document.getElementById("level-fill"),
  speaking: document.getElementById("speaking"),
  tooQuiet: document.getElementById("too-quiet"),
  tooLoud: document.getElementById("too-loud"),
  model: document.getElementById("model"),
  modelBar: document.getElementById("model-bar"),
  modelText: document.getElementById("model-text"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  cards: document.getElementById("cards"),
  heard: document.getElementById("heard"),
  heardText: document.getElementById("heard-text"),
  again: document.getElementById("again"),
  download: document.getElementById("download"),
  consent: document.getElementById("sentiment-consent"),
  sentimentCards: document.getElementById("sentiment-cards"),
};

// The measurement on show, kept for the download and for scoring sentiment after the fact; Measure again drops it.
let shown = null;        // { result, transcript, taken, sentiment }
let generation = 0;      // bumped by every new result and by Measure again, so a late sentiment answer is dropped

const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;
el.modelText.textContent = `Whisper is about ${mb(MODEL_BYTES + RUNTIME_BYTES)} the first time.`;

function setStatus(text) { el.status.textContent = text; }

// ---------- recording ----------

let rec = null;     // { stream, ctx, node, chunks, frames, rate, meter }
let busy = false;   // between Stop and the results

function micMessage(err) {
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    return "The microphone was not allowed, so there is nothing to measure. To try again, allow the microphone for this page in your browser and press Start.";
  }
  if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError" || err.name === "NotReadableError")) {
    return "I could not find a microphone I can use. Connect one, or close whatever else is using it, and press Start.";
  }
  return "The microphone could not be opened in this browser.";
}

async function start() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioWorkletNode) {
    setStatus("This browser cannot record from a microphone here, so there is nothing to measure.");
    return;
  }
  el.record.disabled = true;
  setStatus("Opening the microphone…");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (err) {
    setStatus(micMessage(err));
    el.record.disabled = false;
    return;
  }
  try {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule("js/voice-capture-worklet.js");
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "voice-capture");
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
    rec = { stream, ctx, node, chunks: [], frames: 0, rate: ctx.sampleRate, meter: createMeter(ctx.sampleRate) };
    node.port.onmessage = ({ data }) => onBlock(data);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    setStatus("The microphone opened, but this browser could not record from it.");
    el.record.disabled = false;
    return;
  }
  el.record.textContent = "Stop";
  el.record.disabled = false;
  el.meter.hidden = false;
  el.countdown.textContent = countdown(MAX_SECONDS);
  setStatus("Recording. Read the passage, or talk about anything, then press Stop.");
}

function onBlock(block) {
  if (!rec) return;
  const cap = MAX_SECONDS * rec.rate;
  const keep = block.length <= cap - rec.frames ? block : block.subarray(0, cap - rec.frames);
  rec.chunks.push(keep);
  rec.frames += keep.length;
  const m = rec.meter.step(keep);
  el.levelFill.style.width = `${(levelFraction(m.level) * 100).toFixed(1)}%`;
  el.speaking.classList.toggle("on", m.speaking);
  el.tooQuiet.hidden = !m.tooQuiet;
  el.tooLoud.hidden = !m.tooLoud;
  el.countdown.textContent = countdown(MAX_SECONDS - rec.frames / rec.rate);
  if (rec.frames >= cap) stop();
}

async function stop() {
  if (!rec) return;
  const { stream, ctx, node, chunks, frames, rate } = rec;
  rec = null;
  busy = true;
  const taken = { measuredAt: new Date() };
  node.port.onmessage = null;
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();
  el.record.textContent = "Start";
  el.record.disabled = true;
  el.meter.hidden = true;

  const captured = new Float32Array(frames);
  let at = 0;
  for (const c of chunks) { captured.set(c, at); at += c.length; }
  chunks.length = 0;

  setStatus("Preparing the recording…");
  let pcm;
  try {
    pcm = await resampleTo16k(captured, rate);
  } catch {
    finish("This browser could not prepare the recording for measuring.");
    return;
  }

  const transcript = await words(pcm);
  setStatus("Measuring…");
  let result;
  try {
    result = await measure(pcm, transcript);
  } catch (err) {
    finish(`The measurement could not run in this browser (${err.message}).`);
    return;
  }
  showResults(result, transcript, taken);
}

function finish(message) {
  busy = false;
  setStatus(message);
  el.record.disabled = false;
  el.countdown.textContent = countdown(MAX_SECONDS);
}

// ---------- Whisper ----------

let whisper = null;   // a promise of the loaded worker, made on the first Stop

function loadWhisper() {
  el.model.hidden = false;
  el.modelBar.value = 0;
  setStatus("Loading Whisper, which turns your speech into words for the word rate…");
  const worker = new Worker("js/voice-whisper-worker.js", { type: "module" });
  const files = new Map();
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        files.set(data.file, { loaded: data.loaded || 0, total: data.total || 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        const of = Math.max(total, MODEL_BYTES);
        el.modelBar.value = loaded / of;
        el.modelText.textContent = `Downloading Whisper: ${mb(loaded)} of ${mb(of)} for the model, then ${mb(RUNTIME_BYTES)} for the runtime it runs on.`;
      } else if (data.type === "loaded") {
        el.model.hidden = true;
        resolve(worker);
      } else if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.error));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "the worker failed")); };
    worker.postMessage({ type: "load" });
  });
}

/* The transcript, or null when Whisper could not load or run; then word rate is "not available" and every other
   reading still shows. */
async function words(pcm) {
  try {
    whisper = whisper || loadWhisper();
    const worker = await whisper;
    setStatus("Listening for words…");
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === "text") resolve(data.text);
        else if (data.type === "error") reject(new Error(data.error));
      };
      worker.onerror = (e) => reject(new Error(e.message || "the worker failed"));
      worker.postMessage({ type: "transcribe", pcm });
    });
  } catch {
    whisper = null;   // try again on the next recording
    el.model.hidden = true;
    return null;
  }
}

// ---------- measuring ----------

function measure(pcm, transcript) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("js/voice-measure-worker.js", { type: "module" });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.ok) resolve(data.result); else reject(new Error(data.error));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "the worker failed")); };
    worker.postMessage({ pcm, transcript }, [pcm.buffer]);
  });
}

// ---------- results ----------

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function renderCards(container, cards) {
  container.replaceChildren();
  let group = null, grid = null;
  for (const c of cards) {
    if (c.group !== group) {
      group = c.group;
      container.append(node("h3", "metric-group", group));
      grid = node("div", "metric-grid");
      container.append(grid);
    }
    const card = node("article", `card metric metric-${c.state}`);
    card.append(node("h4", null, c.title));
    const value = node("p", "metric-value", c.value);
    if (c.state === "value" && c.unit) value.append(" ", node("span", "metric-unit", c.unit));
    card.append(value);
    if (c.detail) card.append(node("p", "metric-need", c.detail));
    card.append(node("p", null, c.definition));
    const why = node("p");
    why.append(node("strong", null, "Why it matters. "), c.why);
    card.append(why);
    const moves = node("p");
    moves.append(node("strong", null, "What moves it. "), c.moves);
    card.append(moves);
    if (c.note) card.append(node("p", "metric-note", c.note));
    grid.append(card);
  }
}

function showResults(result, transcript, taken) {
  generation += 1;
  shown = { result, transcript, taken, sentiment: { state: "off" } };
  renderCards(el.cards, resultCards(result, { wordsAvailable: transcript !== null }));
  el.heard.hidden = transcript === null;
  el.heardText.textContent = transcript === "" ? "(no words)" : transcript || "";
  el.results.hidden = false;
  busy = false;
  setStatus("Done. Your reading is below.");
  el.results.scrollIntoView({ behavior: "smooth", block: "start" });
  updateSentiment();
}

// ---------- sentiment ----------

function showSentiment(sentiment) {
  shown.sentiment = sentiment;
  renderCards(el.sentimentCards, sentimentCards(sentiment));
}

/* Brings the Sentiment card in line with the box: unticked, it is off and any score is dropped; ticked, the
   current result's words are scored, without recording again. */
async function updateSentiment() {
  if (!shown) return;
  if (!el.consent.checked) { generation += 1; showSentiment({ state: "off" }); return; }
  if (shown.sentiment.state === "scored" || shown.sentiment.state === "pending") return;
  if (shown.transcript === null) {
    showSentiment({ state: "failed", why: "Whisper could not hear any words in this recording, so there were none to score." });
    return;
  }
  const mine = ++generation;
  showSentiment({ state: "pending" });
  const { text, truncated } = sentimentText(shown.transcript);
  let sentiment;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sentiment", transcript: text }),
    });
    sentiment = sentimentFromResponse(res.ok, await res.json().catch(() => null), { truncated });
  } catch {
    sentiment = sentimentFromResponse(false, null);
  }
  if (mine === generation) showSentiment(sentiment);
}

/* Saves the results as a file from the browser itself: a Blob and a download link, nothing sent anywhere. */
function saveResults() {
  if (!shown) return;
  const { result, transcript, taken, sentiment } = shown;
  const file = resultsFile(result, { wordsAvailable: transcript !== null, commit: el.results.dataset.commit, ...taken, sentiment });
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + "\n"], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(taken.measuredAt);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function measureAgain() {
  shown = null;
  generation += 1;
  el.cards.replaceChildren();
  el.sentimentCards.replaceChildren();
  el.heardText.textContent = "";
  el.results.hidden = true;
  el.record.disabled = false;
  el.countdown.textContent = countdown(MAX_SECONDS);
  setStatus("");
  el.record.scrollIntoView({ behavior: "smooth", block: "center" });
}

el.record.addEventListener("click", () => {
  if (busy) return;
  if (rec) stop(); else start();
});
el.again.addEventListener("click", measureAgain);
el.download.addEventListener("click", saveResults);
el.consent.addEventListener("change", updateSentiment);
el.record.disabled = false;
