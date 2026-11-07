/* The Voice page's rules: the resampler, the meter, and how a measurement becomes cards. All three are pure, so
   they need no DOM, no microphone and no worker. The resampler runs on node-web-audio-api's OfflineAudioContext,
   the same Web Audio interface the page calls in the browser. Run with: npm test */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OfflineAudioContext } from "node-web-audio-api";

import {
  CLIP_HOLD_SECONDS,
  METRICS,
  QUIET_SECONDS,
  createMeter,
  countdown,
  fileName,
  localIso,
  resampleTo16k,
  SENTIMENT_MAX_CHARS,
  resultCards,
  resultsFile,
  sentimentCards,
  sentimentFromResponse,
  sentimentText,
} from "../src/js/voice-logic.js";
import { METRIC_PATHS } from "../vendor/seniorminder/packages/voice/src/ReliabilityFloors.js";

const sine = (seconds, rate, hz, amp) => {
  const x = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * hz * i / rate);
  return x;
};
// A block of a sine whose RMS is `db` dBFS.
const blockAt = (db, n = 2048, rate = 48000) => sine(n / rate, rate, 440, Math.SQRT2 * 10 ** (db / 20));

/* The frequency of a tone from its rising zero crossings, each placed between samples by interpolation. */
function frequencyOf(x, rate, from, to) {
  const crossings = [];
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((crossings.length - 1) * rate) / (crossings.at(-1) - crossings[0]);
}

// ---------- the resampler ----------

test("resampler: a 440 Hz tone at 48 kHz still reads 440 Hz at 16 kHz, and its length scales by 1/3", async () => {
  const input = sine(2, 48000, 440, 0.5);
  const out = await resampleTo16k(input, 48000, OfflineAudioContext);
  assert.equal(out.length, input.length / 3);
  const hz = frequencyOf(out, 16000, 4000, 28000);
  assert.ok(Math.abs(hz - 440) < 0.5, `read ${hz.toFixed(3)} Hz`);
  const peak = out.subarray(4000, 28000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - 0.5) < 0.02, `amplitude ${peak.toFixed(3)}`);
});

test("resampler: audio already at 16 kHz is returned as is", async () => {
  const input = sine(0.5, 16000, 440, 0.5);
  const out = await resampleTo16k(input, 16000, OfflineAudioContext);
  assert.deepEqual(out, input);
});

// ---------- the meter ----------

test("meter: speaking is on near the loudest level so far, off more than 26 dB below it", () => {
  const m = createMeter(48000);
  assert.equal(m.step(blockAt(-12)).speaking, true);
  assert.equal(m.step(blockAt(-30)).speaking, true, "18 dB below the loudest");
  assert.equal(m.step(blockAt(-37.5)).speaking, true, "25.5 dB below");
  assert.equal(m.step(blockAt(-39)).speaking, false, "27 dB below");
  assert.equal(m.step(blockAt(-20)).speaking, true);
});

test("meter: speaking is off under the -50 dBFS floor, even as the loudest level so far", () => {
  const m = createMeter(48000);
  assert.equal(m.step(blockAt(-55)).speaking, false);
  assert.equal(m.step(blockAt(-48)).speaking, true);
  assert.equal(m.step(new Float32Array(2048)).speaking, false, "digital silence");
});

test("meter: too quiet once the peak has stayed under -40 dBFS for 3 s, and not before", () => {
  const rate = 48000, m = createMeter(rate);
  const quiet = blockAt(-46);   // peak about -43 dBFS
  let seconds = 0, r;
  while (seconds + 2048 / rate < QUIET_SECONDS - 0.05) { r = m.step(quiet); seconds += 2048 / rate; }
  assert.equal(r.tooQuiet, false, `at ${seconds.toFixed(2)} s`);
  while (seconds < QUIET_SECONDS + 0.05) { r = m.step(quiet); seconds += 2048 / rate; }
  assert.equal(r.tooQuiet, true, `at ${seconds.toFixed(2)} s`);
  assert.equal(m.step(blockAt(-36)).tooQuiet, false, "a peak above -40 dBFS clears it");
});

test("meter: too loud on any sample at 0.99 or above, and not at 0.98", () => {
  const rate = 48000;
  const at = (v) => { const b = blockAt(-20); b[100] = v; return b; };
  assert.equal(createMeter(rate).step(at(0.98)).tooLoud, false);
  assert.equal(createMeter(rate).step(at(0.99)).tooLoud, true);
  assert.equal(createMeter(rate).step(at(-1)).tooLoud, true, "negative full scale");
  const m = createMeter(rate);
  m.step(at(0.995));
  let r, seconds = 0;
  while (seconds <= CLIP_HOLD_SECONDS + 0.1) { r = m.step(blockAt(-20)); seconds += 2048 / rate; }
  assert.equal(r.tooLoud, false, "clears once nothing has clipped for a while");
});

test("countdown: m:ss, never below 0:00", () => {
  assert.equal(countdown(120), "2:00");
  assert.equal(countdown(59.2), "1:00");
  assert.equal(countdown(9), "0:09");
  assert.equal(countdown(-1), "0:00");
});

// ---------- the results ----------

const measurement = (overrides = {}) => ({
  metrics: {
    cadence: { wpm: 152, pause_duration_avg: 0.33, speech_rate_variability: null, speaking_time_ratio: 0.733 },
    pitch: { mean_hz: null, std_dev: null, p5_hz: 108.2, p95_hz: 131.9, p5_p95_range_hz: 23.7 },
    volume: { mean_db: -23.9, std_dev: 4.3, p5_db: -34.3, p95_db: -21.2, p5_p95_range_db: 13.1 },
    voiceQuality: { harmonic_to_noise: 32.7, spectral_centroid: 678, jitter: 0.0123, shimmer: 0.027 },
    inflection: null,
  },
  floored: [
    { metric: "cadence.speech_rate_variability", evidence: "speechSegments", have: 9, need: 14 },
    { metric: "pitch.mean_hz", evidence: "voicedFrames", have: 410, need: 625 },
    { metric: "pitch.std_dev", evidence: "voicedFrames", have: 410, need: 2062 },
    { metric: "inflection", evidence: "inputs (pitch.mean_hz, pitch.std_dev)", have: null, need: 147 },
  ],
  evidence: { spanFound: true, spanSeconds: 19.98, words: 16, speechSegments: 9, voicedFrames: 410 },
  ...overrides,
});
const card = (cards, key) => cards.find((c) => c.key === key);

test("results: one card per row-B metric, in the page's order", () => {
  assert.deepEqual(METRICS.map((m) => m.key).sort(), Object.keys(METRIC_PATHS).sort());
  assert.deepEqual(METRICS.map((m) => m.path), METRICS.map((m) => METRIC_PATHS[m.key]));
  assert.deepEqual([...new Set(METRICS.map((m) => m.group))], ["Rate and pauses", "Pitch", "Loudness", "Voice quality", "Inflection"]);
  assert.equal(resultCards(measurement()).length, 19);
});

test("results: a floored metric shows Needs more speech, with its requirement and what it had", () => {
  const c = card(resultCards(measurement()), "pitch.mean_hz");
  assert.equal(c.state, "needs");
  assert.equal(c.value, "Needs more speech");
  assert.equal(c.detail, "Needs 625 voiced frames (short slices of voiced sound); this recording had 410.");
  assert.equal(c.unit, undefined, "no unit, because there is no number");
  assert.match(card(resultCards(measurement()), "cadence.speech_rate_variability").detail, /^Needs 14 stretches of speech between pauses; this recording had 9\.$/);
  assert.match(card(resultCards(measurement()), "inflection").detail, /average pitch, pitch variation/);
});

test("results: the real-speech rule's entry states its own requirement", () => {
  const m = measurement({
    floored: [{ metric: "volume.mean_db", evidence: "speech (words or voicedFrames)", have: "0 words, 4 voiced frames", need: "2 words or 10 voiced frames" }],
  });
  m.metrics.volume.mean_db = null;
  assert.equal(card(resultCards(m), "volume.mean_db").detail, "Needs real speech: 2 words or 10 voiced frames; this recording had 0 words, 4 voiced frames.");
});

test("results: a recorded metric shows its value and unit", () => {
  const cards = resultCards(measurement());
  assert.deepEqual([card(cards, "volume.mean_db").state, card(cards, "volume.mean_db").value, card(cards, "volume.mean_db").unit], ["value", "-23.9", "dBFS"]);
  assert.deepEqual([card(cards, "cadence.wpm").value, card(cards, "cadence.wpm").unit], ["152", "words a minute"]);
  assert.deepEqual([card(cards, "cadence.speaking_time_ratio").value, card(cards, "cadence.speaking_time_ratio").unit], ["73", "%"]);
  assert.deepEqual([card(cards, "voiceQuality.jitter").value, card(cards, "voiceQuality.shimmer").value], ["1.23", "2.7"]);
});

test("results: without Whisper, word rate is not available and everything else still shows", () => {
  const m = measurement();
  m.metrics.cadence.wpm = null;
  const cards = resultCards(m, { wordsAvailable: false });
  assert.equal(card(cards, "cadence.wpm").state, "unavailable");
  assert.equal(card(cards, "cadence.wpm").value, "not available");
  assert.equal(card(cards, "volume.mean_db").value, "-23.9");
  assert.equal(cards.filter((c) => c.state === "value").length, 14);
});

test("results: no speech at all gives no numbers", () => {
  const empty = { metrics: { cadence: {}, pitch: {}, volume: {}, voiceQuality: {}, inflection: null }, floored: [], evidence: { spanFound: false } };
  const cards = resultCards(empty);
  assert.ok(cards.every((c) => c.state === "needs" && c.detail === "No speech was found in this recording."));
});

test("results: jitter and shimmer say connected speech reads higher than the clinical sustained-vowel figures", () => {
  for (const key of ["voiceQuality.jitter", "voiceQuality.shimmer"]) {
    assert.match(METRICS.find((m) => m.key === key).note, /Connected speech reads higher than the sustained-vowel figures published in clinical literature/);
  }
});

test("copy: the page invites reading or talking, with no text-mode switch", () => {
  const html = readFileSync(new URL("../src/pages/voice.html", import.meta.url), "utf8");
  assert.ok(html.includes(">Read this aloud, or just talk about anything you like. You can go off script whenever you want.</label>"));
  for (const gone of ["free-speech", "Text to read", "just talk about anything</label>"]) assert.ok(!html.includes(gone), gone);
  const js = readFileSync(new URL("../src/js/voice.js", import.meta.url), "utf8");
  assert.ok(!/freeSpeech|textMode/.test(js));
});

test("copy: no em dashes in the Voice page or its strings", () => {
  for (const file of ["../src/pages/voice.html", "../src/js/voice.js", "../src/js/voice-logic.js"]) {
    assert.ok(!readFileSync(new URL(file, import.meta.url), "utf8").includes("—"), file);
  }
});

// ---------- the download ----------

const COMMIT = "f4d29b75806a4170698f5d79906d29cbf2a07eb7";
const AT = new Date(2026, 10, 6, 9, 5, 7);   // local time
const fileFor = (m, opts = {}) => JSON.parse(JSON.stringify(resultsFile(m, { commit: COMMIT, measuredAt: AT, ...opts })));

test("download: the file's metrics match the cards one for one, and floored metrics are null", () => {
  for (const wordsAvailable of [true, false]) {
    const m = measurement();
    if (!wordsAvailable) m.metrics.cadence.wpm = null;
    const cards = resultCards(m, { wordsAvailable });
    const file = fileFor(m, { wordsAvailable });
    assert.deepEqual(Object.keys(file.metrics), cards.map((c) => c.key), "same metrics, same order");
    for (const c of cards) {
      const { value } = file.metrics[c.key];
      const spec = METRICS.find((x) => x.key === c.key);
      if (c.state === "value") {
        assert.equal(value, spec.path.reduce((v, k) => v[k], m.metrics), `${c.key}: measureVoice's own number`);
        assert.equal(spec.format(value), c.value, `${c.key}: the card shows this number`);
      } else {
        assert.equal(value, null, `${c.key}: no reading on the card, none in the file`);
      }
    }
    for (const f of m.floored) assert.equal(file.metrics[f.metric].value, null, `${f.metric} is floored`);
  }
});

test("download: names are measureVoice's, units say what the number is, floored and evidence pass through", () => {
  const m = measurement();
  const file = fileFor(m);
  assert.deepEqual(Object.keys(file.metrics).sort(), Object.keys(METRIC_PATHS).sort());
  assert.deepEqual(file.metrics["volume.mean_db"], { value: -23.9, unit: "dBFS" });
  assert.deepEqual(file.metrics["cadence.speaking_time_ratio"], { value: 0.733, unit: "fraction (0 to 1)" });
  assert.deepEqual(file.metrics["voiceQuality.jitter"], { value: 0.0123, unit: "fraction (0 to 1)" });
  assert.deepEqual(file.metrics["cadence.speech_rate_variability"], { value: null, unit: "coefficient of variation" });
  assert.deepEqual(file.floored, m.floored);
  assert.deepEqual(file.evidence, m.evidence);
});

test("download: measuredAt, source and the file name, and no text mode", () => {
  const file = fileFor(measurement());
  assert.match(file.measuredAt, /^2026-11-06T09:05:07[+-]\d\d:\d\d$/);
  assert.equal(new Date(file.measuredAt).getTime(), AT.getTime(), "the offset makes it the same instant");
  assert.deepEqual(file.source, { name: "SeniorMinder voice-health", commit: COMMIT });
  assert.deepEqual(Object.keys(file), ["measuredAt", "source", "metrics", "floored", "evidence", "sentiment"]);
  assert.equal(fileName(AT), "voice-metrics-2026-11-06-0905.json");
  assert.equal(localIso(new Date(2026, 0, 2, 23, 59, 0)).slice(0, 19), "2026-01-02T23:59:00");
});

// ---------- sentiment ----------

const SCORES = { polarity_score: -0.4, subjectivity_score: 0.7, magnitude: 0.5, dominant_emotion: "sadness" };

test("sentiment: scored shows polarity, subjectivity and magnitude as values and the emotion as a label", () => {
  const s = sentimentFromResponse(true, SCORES);
  assert.deepEqual(s, { state: "scored", scores: SCORES, truncated: false });
  const cards = sentimentCards(s);
  assert.deepEqual(cards.map((c) => c.title), ["Polarity", "Subjectivity", "Magnitude", "Dominant emotion"]);
  assert.ok(cards.every((c) => c.group === "Sentiment" && c.state === "value"));
  assert.deepEqual(cards.map((c) => c.value), ["-0.40", "0.70", "0.50", "sadness"]);
  assert.equal(cards[3].unit, null);
  for (const c of cards) for (const k of ["definition", "why", "moves"]) assert.ok(c[k].length > 20, `${c.title} ${k}`);
});

test("sentiment: every scored card says it scored the words you spoke, including any you read", () => {
  const cards = sentimentCards(sentimentFromResponse(true, SCORES));
  assert.ok(cards.every((c) => c.note === "Scored on the words you spoke, including any you read."));
  const long = sentimentCards(sentimentFromResponse(true, SCORES, { truncated: true }));
  assert.ok(long.every((c) => c.note === "Scored on the words you spoke, including any you read. Scored on the first 2,000 characters of what the page heard."));
});

test("sentiment: off says so, and that ticking scores this recording without recording again", () => {
  const [card] = sentimentCards({ state: "off" });
  assert.equal(card.state, "off");
  assert.equal(card.value, "Off");
  assert.match(card.detail, /Tick the box/);
  assert.match(card.detail, /without recording again/);
});

test("sentiment: too few words says so plainly", () => {
  const s = sentimentFromResponse(true, { skipped: "fewer than 4 words" });
  assert.deepEqual(s, { state: "skipped", why: "fewer than 4 words" });
  const [card] = sentimentCards(s);
  assert.equal(card.value, "Too few words");
  assert.match(card.detail, /heard fewer than 4 words/);
  assert.match(card.detail, /Everything else above still stands/);
});

test("sentiment: a failed Lambda, an unreadable answer or a network error says so plainly", () => {
  for (const s of [
    sentimentFromResponse(false, { error: "sentiment unavailable" }),
    sentimentFromResponse(true, null),
    sentimentFromResponse(true, {}),
    sentimentFromResponse(false, null),
  ]) {
    assert.equal(s.state, "failed");
    const [card] = sentimentCards(s);
    assert.equal(card.value, "Not available");
    assert.match(card.detail, /couldn't get a sentiment score/);
  }
  const partial = sentimentCards(sentimentFromResponse(true, { polarity_score: 0.9, dominant_emotion: "joy" }));
  assert.deepEqual(partial.map((c) => c.state), ["value", "needs", "needs", "value"], "a field the model left out says so");
});

test("sentiment: over 2,000 characters is cut at a word boundary, never over the Lambda's cap", () => {
  assert.deepEqual(sentimentText("four short words here"), { text: "four short words here", truncated: false });
  const words = "remember ".repeat(400);
  const { text, truncated } = sentimentText(words);
  assert.ok(truncated);
  assert.ok(text.length <= SENTIMENT_MAX_CHARS);
  assert.ok(text.endsWith("remember") && !text.endsWith(" "));
  assert.equal(words.startsWith(text), true);
});

test("download: sentiment is the scores when scored and null otherwise", () => {
  const scored = fileFor(measurement(), { sentiment: sentimentFromResponse(true, SCORES) });
  assert.deepEqual(scored.sentiment, { ...SCORES, truncated: false });
  for (const s of [undefined, { state: "off" }, { state: "pending" }, { state: "skipped", why: "fewer than 4 words" }, sentimentFromResponse(false, null)]) {
    assert.equal(fileFor(measurement(), { sentiment: s }).sentiment, null, JSON.stringify(s));
  }
});

test("copy: each reference marker links to its entry, and each entry links out in a new tab", () => {
  const html = readFileSync(new URL("../src/pages/voice.html", import.meta.url), "utf8");
  for (const n of [1, 2, 3]) {
    assert.ok(html.includes(`<sup><a href="#voice-ref-${n}" id="voice-cite-${n}">[${n}]</a></sup>`), `marker ${n}`);
    const entry = html.match(new RegExp(`<li id="voice-ref-${n}">(.*?)</li>`));
    assert.ok(entry, `entry ${n}`);
    assert.match(entry[1], /<a href="https:\/\/[^"]+" target="_blank" rel="noopener">Link<\/a>$/);
  }
  const why = html.slice(html.indexOf('<section class="voice-why">'));
  assert.ok(why.indexOf("That is why SeniorMinder compares") < why.indexOf("This page measures once"), "the new copy comes before the measures-once line");
});
