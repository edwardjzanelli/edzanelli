/* The Voice page's rules: the resampler, the meter, and how a measurement becomes cards. All three are pure, so
   they need no DOM, no microphone and no worker. The resampler runs on node-web-audio-api's OfflineAudioContext,
   the same Web Audio interface the page calls in the browser. Run with: npm test */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OfflineAudioContext } from "node-web-audio-api";

import {
  CLIP_HOLD_SECONDS,
  GROUP_NOTES,
  METRICS,
  QUIET_SECONDS,
  createMeter,
  countdown,
  createFlow,
  fileName,
  localIso,
  resampleTo16k,
  SENTIMENT_MAX_CHARS,
  resultCards,
  resultsFile,
  sentimentCards,
  sentimentFromResponse,
  sentimentText,
  usableScores,
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
  assert.deepEqual([...new Set(METRICS.map((m) => m.group))], ["Rate and pauses", "Pitch", "Overall loudness", "Loudness variation", "Voice quality", "Inflection"]);
  assert.equal(resultCards(measurement()).length, 19);
});

test("results: loudness is two groups, overall loudness and its variation, each with its line once", () => {
  const keysIn = (group) => resultCards(measurement()).filter((c) => c.group === group).map((c) => c.key);
  assert.deepEqual(keysIn("Overall loudness"), ["volume.mean_db", "volume.p5_db", "volume.p95_db"]);
  assert.deepEqual(keysIn("Loudness variation"), ["volume.std_dev", "volume.p5_p95_range_db"]);
  assert.deepEqual(keysIn("Loudness"), []);
  assert.deepEqual(Object.keys(GROUP_NOTES), ["Overall loudness", "Loudness variation"]);
  assert.equal(GROUP_NOTES["Overall loudness"], "These mostly reflect how far you are from the microphone and how loud the room is. If they read low, move closer to the microphone, the same advice I’d give a caregiver setting up a device where a senior usually sits. Over time they only mean something if the microphone and where you sit stay the same.");
  assert.equal(GROUP_NOTES["Loudness variation"], "This is how much your loudness moves while you talk. Moving closer or farther from the microphone barely changes it, so it is the loudness reading that holds up from one recording to the next.");
});

test("copy: the watch table splits loudness into two rows, variation first, each cell labelled for the phone cards", () => {
  const html = readFileSync(new URL("../src/pages/voice.html", import.meta.url), "utf8");
  const rows = [...html.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)];
  const names = rows.map((r) => r[1]);
  assert.ok(!names.includes("Volume level"), "the Volume level row is gone");
  const v = names.indexOf("Loudness variation"), o = names.indexOf("Overall loudness");
  assert.ok(v >= 0 && o === v + 1, "Loudness variation, then Overall loudness, in the old row's place");
  assert.equal(names[v - 1], "Average pitch");
  assert.equal(names[o + 1], "Harmonics-to-noise ratio");
  const text = (cell) => cell.replace(/<sup>.*?<\/sup>/g, (m) => " " + m.match(/\[\d+\]/)[0]).replace(/<[^>]+>/g, "");
  const cells = (row) => [...row[2].matchAll(/<td data-label="([^"]+)">(.*?)<\/td>/g)].map((c) => [c[1], text(c[2])]);
  assert.deepEqual(cells(rows[v]), [
    ["A lasting change can go with", "A flatter, less varied loudness can go with Parkinson’s [4], low mood [5], or tiredness."],
    ["What else moves it", "Barely affected by distance from the microphone; a noisy room can narrow it"],
  ]);
  assert.deepEqual(cells(rows[o]), [
    ["A lasting change can go with", "A voice that gets quieter over time can go with Parkinson’s, where voice changes are often an early sign [4], and with weakness, breathlessness or tiredness. It only means something when the microphone and where you sit stay the same; if it reads low, move the microphone closer first."],
    ["What else moves it", "Distance from the microphone, above all"],
  ]);
  // the phone cards label each cell from data-label, so every row's cells carry the two column names
  const head = [...html.match(/<thead>([\s\S]*?)<\/thead>/)[1].matchAll(/<th scope="col">(.*?)<\/th>/g)].map((m) => m[1]);
  for (const r of rows) assert.deepEqual(cells(r).map((c) => c[0]), head.slice(1), r[1]);
  const css = readFileSync(new URL("../src/css/styles.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*\.voice-watch td::before \{ content: attr\(data-label\)/);
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
  const partial = sentimentFromResponse(true, { polarity_score: 0.9, dominant_emotion: "joy" });
  assert.equal(partial.state, "failed", "a partial answer is a failure, not a score");
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

test("copy: every marker [1] to [5] reaches its reference, and every reference links out", () => {
  const html = readFileSync(new URL("../src/pages/voice.html", import.meta.url), "utf8");
  const markers = [...html.matchAll(/<sup><a href="#voice-ref-(\d+)" id="(voice-cite-[\d-]+)">\[(\d+)\]<\/a><\/sup>/g)];
  // every bracketed number on the page is one of these links, so none is left as plain text
  assert.equal((html.match(/\[\d+\]/g) || []).length, markers.length, "a marker that is not a link");
  const ids = markers.map((m) => m[2]);
  assert.equal(new Set(ids).size, ids.length, "marker ids are unique");
  for (const [, target, , shown] of markers) {
    assert.equal(target, shown, `marker [${shown}] points at its own number`);
    assert.ok(html.includes(`<li id="voice-ref-${target}">`), `marker [${shown}] has a reference`);
  }
  const refs = [...html.matchAll(/<li id="voice-ref-(\d+)">(.*?)<\/li>/g)];
  assert.deepEqual(refs.map((r) => Number(r[1])), [1, 2, 3, 4, 5], "references 1 to 5, in order");
  for (const [, n, body] of refs) {
    assert.match(body, /<a href="https:\/\/[^"]+" target="_blank" rel="noopener">Link<\/a>$/, `reference ${n} links out in a new tab`);
    assert.ok(markers.some((m) => m[1] === n), `reference ${n} is cited`);
  }
  const why = html.slice(html.indexOf('<section class="voice-why">'));
  const at = (s) => { const i = why.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("Why measure a voice over time") < at("What to watch for, and why"));
  assert.ok(at("That is why SeniorMinder compares") < at("What to watch for, and why"));
  assert.ok(at("What I would watch most closely") < at("This page measures once"));
  for (const once of ["That is why SeniorMinder compares", "This page measures once"]) assert.equal(why.split(once).length, 2, once);
});

// ---------- the Start button ----------

/* Walks a flow the way voice.js does, from a press of Start to the cards on show. */
function recordToResults(flow, measurement = { result: "r1", sentiment: { state: "off" } }) {
  assert.equal(flow.press(), flow.stage === "results" ? "restart" : "start");
  flow.to("opening");
  flow.to("recording");
  assert.equal(flow.press(), "stop");
  for (const busy of ["stopping", "whisper", "measuring"]) flow.to(busy);
  flow.show(measurement);
  return flow;
}

test("start button: on once the cards show, off while stopping, in Whisper and while measuring", () => {
  const flow = createFlow();
  assert.ok(flow.startEnabled());
  assert.equal(flow.startLabel(), "Start");
  assert.equal(flow.press(), "start");
  flow.to("opening");
  assert.ok(!flow.startEnabled(), "opening the microphone");
  assert.equal(flow.press(), "ignore");
  flow.to("recording");
  assert.ok(flow.startEnabled());
  assert.equal(flow.startLabel(), "Stop");
  assert.equal(flow.press(), "stop");
  for (const busy of ["stopping", "whisper", "measuring"]) {
    flow.to(busy);
    assert.ok(!flow.startEnabled(), busy);
    assert.equal(flow.startLabel(), "Start", busy);
    assert.equal(flow.press(), "ignore", `a press while ${busy} does nothing`);
    assert.equal(flow.stage, busy);
  }
  flow.show({ result: "r1", sentiment: { state: "pending" } });
  assert.equal(flow.stage, "results");
  assert.ok(flow.startEnabled(), "on as soon as the cards show, with sentiment still pending");
  assert.equal(flow.startLabel(), "Start");
});

test("start button: pressing Start on the results leaves the same state as Measure again", () => {
  const viaAgain = recordToResults(createFlow());
  const viaStart = recordToResults(createFlow());
  assert.deepEqual(viaStart.snapshot(), viaAgain.snapshot(), "the same before");
  viaAgain.clear();
  assert.equal(viaStart.press(), "restart");
  assert.deepEqual(viaStart.snapshot(), viaAgain.snapshot());
  assert.deepEqual(viaStart.snapshot().shown, null, "the previous result is discarded");
  assert.equal(viaStart.stage, "idle");
  assert.equal(viaStart.press(), "start", "then it records, as Start does after Measure again");
});

test("start button: a late sentiment reply from the previous recording is dropped", () => {
  const flow = recordToResults(createFlow(), { result: "old", sentiment: { state: "pending" } });
  const old = flow.ticket();   // the old recording's sentiment request, still out
  assert.ok(flow.isCurrent(old));
  assert.equal(flow.press(), "restart");
  assert.ok(!flow.isCurrent(old), "dropped the moment Start discards the result");
  flow.to("opening");
  flow.to("recording");
  assert.ok(!flow.isCurrent(old), "while the new one records");
  for (const busy of ["stopping", "whisper", "measuring"]) flow.to(busy);
  flow.show({ result: "new", sentiment: { state: "pending" } });
  const fresh = flow.ticket();
  assert.ok(!flow.isCurrent(old), "and once the new result is on show");
  assert.ok(flow.isCurrent(fresh), "the new recording's own reply still lands");
  // voice.js applies a reply only through this check.
  const js = readFileSync(new URL("../src/js/voice.js", import.meta.url), "utf8");
  assert.match(js, /const mine = flow\.ticket\(\);[\s\S]*if \(flow\.isCurrent\(mine\)\) showSentiment\(sentiment\);/);
  assert.ok(!/\bbusy\b|\bgeneration\b/.test(js), "no second copy of the state outside the flow");
});

test("sentiment: only four values inside the prompt's ranges are a score", () => {
  assert.deepEqual(usableScores(SCORES), SCORES);
  assert.deepEqual(usableScores({ ...SCORES, extra: 1 }), SCORES, "extra fields are dropped");
  assert.deepEqual(usableScores({ polarity_score: -1, subjectivity_score: 0, magnitude: 1, dominant_emotion: "neutral" }),
    { polarity_score: -1, subjectivity_score: 0, magnitude: 1, dominant_emotion: "neutral" }, "the ends of each range count");
  for (const bad of [
    null, undefined, "", 0, [], {}, [SCORES],
    { ...SCORES, polarity_score: null }, { ...SCORES, polarity_score: "0" }, { ...SCORES, polarity_score: 1.01 },
    { ...SCORES, polarity_score: NaN }, { ...SCORES, subjectivity_score: -0.1 }, { ...SCORES, magnitude: 2 },
    { ...SCORES, dominant_emotion: "boredom" }, { ...SCORES, dominant_emotion: "" }, { ...SCORES, dominant_emotion: null },
    { polarity_score: 0.9, dominant_emotion: "joy" },
  ]) {
    assert.equal(usableScores(bad), null, JSON.stringify(bad));
    assert.equal(sentimentFromResponse(true, bad).state, bad && typeof bad === "object" && "skipped" in bad ? "skipped" : "failed", JSON.stringify(bad));
  }
  assert.equal(sentimentFromResponse(false, SCORES).state, "failed", "an error status is a failure whatever the body says");
});

test("download: a sentiment that is not four usable values exports null, even if marked scored", () => {
  assert.equal(fileFor(measurement(), { sentiment: { state: "scored", scores: { ...SCORES, polarity_score: "0" }, truncated: false } }).sentiment, null);
  assert.equal(fileFor(measurement(), { sentiment: sentimentFromResponse(true, {}) }).sentiment, null);
});
