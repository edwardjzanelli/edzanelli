/* The Voice page's controller, voice.js, run for real against a fake browser: a DOM of plain objects, a microphone
   that delivers one block of samples, Whisper and measureVoice workers that answer with fixed text and a fixed
   result, and a fetch that records every request and answers it as the test says. Nothing here is a copy of the
   page's logic; each test imports voice.js afresh and drives it the way a visitor would. Run with: npm test */

import test from "node:test";
import assert from "node:assert/strict";

const RATE = 16000;   // the fake AudioContext's rate, so the resampler passes the samples straight through

const MEASUREMENT = {
  metrics: {
    cadence: { wpm: 152, pause_duration_avg: 0.33, speech_rate_variability: 0.21, speaking_time_ratio: 0.733 },
    pitch: { mean_hz: 120.4, std_dev: 11.2, p5_hz: 108.2, p95_hz: 131.9, p5_p95_range_hz: 23.7 },
    volume: { mean_db: -23.9, std_dev: 4.3, p5_db: -34.3, p95_db: -21.2, p5_p95_range_db: 13.1 },
    voiceQuality: { harmonic_to_noise: 32.7, spectral_centroid: 678, jitter: 0.0123, shimmer: 0.027 },
    inflection: 0.093,
  },
  floored: [],
  evidence: { spanFound: true, spanSeconds: 19.98, words: 16, speechSegments: 9, voicedFrames: 3000 },
};

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.value = 0;
    this.style = {};
    this.dataset = { commit: "f4d29b75806a4170698f5d79906d29cbf2a07eb7" };
    this.classList = { toggle() {} };
    this.children = [];
    this.listeners = {};
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this }); }
  click() { this.dispatch("click"); }
  replaceChildren(...kids) { this.children = kids; }
  append(...kids) { this.children.push(...kids); }
  remove() {}
  scrollIntoView() {}
  get text() {   // everything rendered inside, as one string, for reading a card
    const parts = [];
    const walk = (n) => { if (typeof n === "string") parts.push(n); else { if (n.textContent) parts.push(n.textContent); n.children.forEach(walk); } };
    walk(this);
    return parts.join(" ");
  }
}

/* A fresh fake browser and a fresh copy of voice.js. whisperText is what Whisper hears; answer(body) is the token
   Lambda: it returns { status, json }, or throws to stand for the network failing. */
async function page({ whisperText, answer }) {
  const els = new Map();
  const byId = (id) => { if (!els.has(id)) els.set(id, new FakeElement(id)); return els.get(id); };
  const posts = [];
  let worklet = null;

  globalThis.document = { getElementById: byId, createElement: (tag) => new FakeElement(tag), body: new FakeElement("body") };
  globalThis.window = globalThis;
  globalThis.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };
  globalThis.AudioWorkletNode = class { constructor() { this.port = {}; worklet = this; } connect(n) { return n; } };
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = RATE; this.state = "running"; this.audioWorklet = { addModule: async () => {} }; this.destination = {}; }
    createMediaStreamSource() { return { connect: (n) => n }; }
    createGain() { return { gain: {}, connect: (n) => n }; }
    close() {}
  };
  globalThis.Worker = class {
    constructor(url) { this.url = String(url); }
    postMessage(msg) {
      setTimeout(() => {
        if (this.url.includes("whisper")) {
          if (msg.type === "load") this.onmessage({ data: { type: "loaded" } });
          else this.onmessage({ data: { type: "text", text: whisperText } });
        } else {
          this.onmessage({ data: { ok: true, result: structuredClone(MEASUREMENT) } });
        }
      }, 0);
    }
    terminate() {}
  };
  globalThis.URL.createObjectURL = () => "blob:fake";
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ url: String(url), body });
    const { status = 200, json } = await answer(body);
    return { ok: status < 400, status, json: async () => (json === undefined ? Promise.reject(new SyntaxError("not JSON")) : json) };
  };

  await import(`../src/js/voice.js?case=${Math.random()}`);
  const el = (id) => byId(id);

  const settle = async (cond, what) => {
    for (let i = 0; i < 500; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 0)); }
    assert.fail(`timed out waiting for ${what}`);
  };

  return {
    el,
    posts,
    // Start, one second of speech, Stop, and wait for the cards.
    async record() {
      el("record").click();
      await settle(() => worklet && worklet.port.onmessage, "the microphone");
      worklet.port.onmessage({ data: new Float32Array(RATE).fill(0.1) });
      el("record").click();
      await settle(() => !el("results").hidden && el("status").textContent.startsWith("Done"), "the results");
    },
    async tick(on = true) { el("sentiment-consent").checked = on; el("sentiment-consent").dispatch("change"); },
    settle,
    sentimentText: () => el("sentiment-cards").text,
    // The file Download would save, read back.
    download() {
      let saved = null;
      const realBlob = globalThis.Blob;
      globalThis.Blob = class { constructor([s]) { saved = JSON.parse(s); } };
      try { el("download").click(); } finally { globalThis.Blob = realBlob; }
      return saved;
    },
  };
}

const SCORES = { polarity_score: -0.4, subjectivity_score: 0.7, magnitude: 0.5, dominant_emotion: "sadness" };
// Whisper's own output starts with a space; the page must send it as heard, as the ticked-before path does.
const HEARD = " It was the best of times, it was the worst of times, it was the age of wisdom.";

test("late tick: ticking after the results sends exactly the transcript the ticked-before path sends", async () => {
  const before = await page({ whisperText: HEARD, answer: () => ({ json: SCORES }) });
  await before.tick();
  await before.record();
  await before.settle(() => before.posts.length === 1 && /sadness/.test(before.sentimentText()), "the score");

  const late = await page({ whisperText: HEARD, answer: () => ({ json: SCORES }) });
  await late.record();
  assert.equal(late.posts.length, 0, "unticked: nothing is sent");
  assert.match(late.sentimentText(), /Sentiment scoring is off/);
  await late.tick();
  await late.settle(() => late.posts.length === 1 && /sadness/.test(late.sentimentText()), "the late score");

  console.log("ticked before sends:", JSON.stringify(before.posts[0].body));
  console.log("ticked late sends:  ", JSON.stringify(late.posts[0].body));
  assert.deepEqual(late.posts[0].body, before.posts[0].body);
  assert.deepEqual(late.posts[0].body, { action: "sentiment", transcript: HEARD });
  assert.deepEqual(late.download().sentiment, before.download().sentiment);
  assert.deepEqual(late.download().sentiment, { ...SCORES, truncated: false });
});

test("late tick: unticking and ticking again sends the same transcript again", async () => {
  const p = await page({ whisperText: HEARD, answer: () => ({ json: SCORES }) });
  await p.record();
  await p.tick();
  await p.settle(() => p.posts.length === 1 && /sadness/.test(p.sentimentText()), "the first score");
  await p.tick(false);
  assert.match(p.sentimentText(), /Sentiment scoring is off/);
  assert.equal(p.download().sentiment, null);
  await p.tick();
  await p.settle(() => p.posts.length === 2 && /sadness/.test(p.sentimentText()), "the second score");
  assert.deepEqual(p.posts[1].body, p.posts[0].body);
});

/* Every way scoring can fail. Each must show the card's couldn't-score text and export null, never a number. */
const FAILURES = [
  ["the Lambda answers 502", () => ({ status: 502, json: { error: "sentiment unavailable" } })],
  ["the Lambda answers 403", () => ({ status: 403, json: { error: "origin not allowed" } })],
  ["the Lambda answers 200 with no JSON", () => ({ status: 200 })],
  ["the Lambda answers 200 with an empty object", () => ({ json: {} })],
  ["the Lambda answers 200 with every field null", () => ({ json: { polarity_score: null, subjectivity_score: null, magnitude: null, dominant_emotion: null } })],
  ["the Lambda answers 200 with numbers as strings", () => ({ json: { polarity_score: "0", subjectivity_score: "0", magnitude: "0", dominant_emotion: "neutral" } })],
  ["the Lambda answers 200 with an emotion outside the five", () => ({ json: { ...SCORES, dominant_emotion: "boredom" } })],
  ["the Lambda answers 200 with a score out of range", () => ({ json: { ...SCORES, polarity_score: 4 } })],
  ["the network fails", () => { throw new TypeError("Failed to fetch"); }],
];

for (const [what, answer] of FAILURES) {
  test(`failure is never a score: ${what}`, async () => {
    const p = await page({ whisperText: HEARD, answer });
    await p.record();
    await p.tick();
    await p.settle(() => /Not available/.test(p.sentimentText()), "the failed card");
    assert.match(p.sentimentText(), /couldn't get a sentiment score/);
    assert.doesNotMatch(p.sentimentText(), /\b0\.00\b|neutral/);
    assert.equal(p.download().sentiment, null);
  });
}

test("too few words: nothing is scored, the card says so and the export has null", async () => {
  const p = await page({ whisperText: " Thank you.", answer: () => ({ json: { skipped: "fewer than 4 words" } }) });
  await p.record();
  await p.tick();
  await p.settle(() => /Too few words/.test(p.sentimentText()), "the too-few-words card");
  assert.equal(p.download().sentiment, null);
});

test("an empty transcript is never sent: the card says there were no words, the export has null", async () => {
  const p = await page({ whisperText: "", answer: () => ({ json: SCORES }) });
  await p.record();
  await p.tick();
  await p.settle(() => /Not available|Too few words/.test(p.sentimentText()), "the card");
  assert.equal(p.posts.length, 0, "nothing to score, so nothing is sent");
  assert.doesNotMatch(p.sentimentText(), /\b0\.00\b|neutral/);
  assert.equal(p.download().sentiment, null);
});

test("a genuine neutral score from the model still shows as a score", async () => {
  const neutral = { polarity_score: 0, subjectivity_score: 0.1, magnitude: 0, dominant_emotion: "neutral" };
  const p = await page({ whisperText: HEARD, answer: () => ({ json: neutral }) });
  await p.record();
  await p.tick();
  await p.settle(() => /neutral/.test(p.sentimentText()), "the score");
  assert.deepEqual(p.download().sentiment, { ...neutral, truncated: false });
});
