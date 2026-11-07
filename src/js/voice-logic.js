/* The Voice page's decisions that need no DOM, no microphone and no worker, kept apart so they can be tested.
   voice.js holds the wiring; this holds the rules: the resampler, the meter, and how a measurement becomes cards.

   The meter is display only. Nothing it computes reaches measureVoice; the measurement reads the recorded samples
   and nothing else. */

export const TARGET_RATE = 16000;   // measureVoice takes 16 kHz mono
export const MAX_SECONDS = 120;     // the recording stops itself here

/* Resample mono PCM to 16 kHz with an OfflineAudioContext: the browser's own resampler, which band-limits on the
   way down. A 48 kHz microphone is the norm, so this nearly always runs. The context class is a parameter so the
   test can hand it Node's implementation; the page uses the browser's. */
export async function resampleTo16k(samples, sampleRate, OfflineContext = globalThis.OfflineAudioContext) {
  if (sampleRate === TARGET_RATE) return Float32Array.from(samples);
  const length = Math.max(1, Math.round(samples.length * TARGET_RATE / sampleRate));
  const ctx = new OfflineContext(1, length, TARGET_RATE);
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  const rendered = await ctx.startRendering();
  return Float32Array.from(rendered.getChannelData(0));
}

/* ---------- the meter ---------- */

export const SPEAKING_WITHIN_DB = 26;   // speaking: within this of the loudest level so far
export const SPEAKING_FLOOR_DB = -50;   // and above this
export const QUIET_DB = -40;            // too quiet: the peak stays under this
export const QUIET_SECONDS = 3;         // for this long
export const CLIP_LEVEL = 0.99;         // too loud: any sample at or above this
export const CLIP_HOLD_SECONDS = 2;     // the warning stays up this long after the last clipped sample

const dbOf = (amplitude) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

/* One meter per recording. step() takes each block of samples as it arrives and returns what to show. The level is
   the block's RMS in dBFS; the quiet rule and the clip rule look at its peak. */
export function createMeter(sampleRate) {
  let loudest = -Infinity;
  let seconds = 0;
  let lastLoud = 0;           // when the peak was last at or above QUIET_DB (the start counts as loud)
  let lastClip = -Infinity;
  return {
    step(block) {
      let sum = 0, peak = 0;
      for (let i = 0; i < block.length; i++) {
        const a = Math.abs(block[i]);
        sum += a * a;
        if (a > peak) peak = a;
      }
      seconds += block.length / sampleRate;
      const level = dbOf(Math.sqrt(sum / Math.max(1, block.length)));
      const peakDb = dbOf(peak);
      if (level > loudest) loudest = level;
      if (peakDb >= QUIET_DB) lastLoud = seconds;
      if (peak >= CLIP_LEVEL) lastClip = seconds;
      return {
        level,
        peak: peakDb,
        speaking: level > SPEAKING_FLOOR_DB && level >= loudest - SPEAKING_WITHIN_DB,
        tooQuiet: seconds - lastLoud >= QUIET_SECONDS,
        tooLoud: seconds - lastClip <= CLIP_HOLD_SECONDS,
      };
    },
  };
}

/* How full the level bar is, 0 to 1, over a -60 to 0 dBFS scale. */
export const levelFraction = (db) => (Number.isFinite(db) ? Math.min(1, Math.max(0, (db + 60) / 60)) : 0);

/* The countdown, as m:ss. */
export function countdown(secondsLeft) {
  const s = Math.max(0, Math.ceil(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------- the results ---------- */

const fixed = (digits) => (v) => v.toFixed(digits);
// A card shows these as a percent; the downloaded file keeps measureVoice's own number, a fraction.
const percent = (digits) => Object.assign((v) => (v * 100).toFixed(digits), { fileUnit: "fraction (0 to 1)" });

const PERIODS_NOTE = "A glottal period is one vibration of the vocal folds.";
const CONNECTED = "Connected speech reads higher than the sustained-vowel figures published in clinical literature, so a number here is not comparable with those.";

/* One entry per row-B metric, in the order the cards are shown: rate and pauses, pitch, loudness, voice quality,
   inflection. `path` is where measureVoice puts it; `format` turns its number into the shown value. */
export const METRICS = [
  {
    key: "cadence.wpm", path: ["cadence", "wpm"], group: "Rate and pauses", title: "Speaking rate",
    format: fixed(0), unit: "words a minute",
    definition: "How many words you said per minute of speech, counted from what Whisper heard.",
    why: "Rate is easy to hear and easy to count, and it tends to shift when someone is tired or unwell.",
    moves: "Tiredness and illness slow it; reading usually runs steadier than talking; mic distance barely touches it, unless Whisper starts missing words.",
  },
  {
    key: "cadence.pause_duration_avg", path: ["cadence", "pause_duration_avg"], group: "Rate and pauses", title: "Average pause",
    format: fixed(2), unit: "s",
    definition: "The average length of the silences between stretches of speech.",
    why: "Longer pauses can mean more effort finding words or catching breath.",
    moves: "Tiredness and illness lengthen them; talking off the cuff has longer pauses than reading; a noisy room can hide short ones.",
  },
  {
    key: "cadence.speaking_time_ratio", path: ["cadence", "speaking_time_ratio"], group: "Rate and pauses", title: "Time spent speaking",
    format: percent(0), unit: "%",
    definition: "The share of the time from your first word to your last that was speech rather than pause.",
    why: "It sums up rate and pauses in one number: how much of the time you kept going.",
    moves: "Tiredness lowers it; reading keeps it higher than talking; background noise can raise it by filling the gaps.",
  },
  {
    key: "cadence.speech_rate_variability", path: ["cadence", "speech_rate_variability"], group: "Rate and pauses", title: "Rate variability",
    format: fixed(2), unit: "(coefficient of variation)",
    definition: "How much your syllable rate changes from one stretch of speech to the next, as the spread divided by the average.",
    why: "Natural speech speeds up and slows down; a rate that goes flat, or swings more than usual, is a change worth noticing.",
    moves: "Reading flattens it; talking raises it; tiredness can push it either way.",
  },
  {
    key: "pitch.mean_hz", path: ["pitch", "mean_hz"], group: "Pitch", title: "Average pitch",
    format: fixed(0), unit: "Hz",
    definition: "The average frequency your vocal folds vibrated at while you were voicing.",
    why: "Everyone has their own; a shift away from yours is what carries meaning.",
    moves: "Colds and a sore throat lower it; tiredness lowers it a little; excitement and effort raise it; mic distance does not change it.",
  },
  {
    key: "pitch.std_dev", path: ["pitch", "std_dev"], group: "Pitch", title: "Pitch variation",
    format: fixed(1), unit: "Hz",
    definition: "How far your pitch moved around its average, as a standard deviation.",
    why: "It is the melody of speech; a voice that goes flat moves less.",
    moves: "Tiredness and low mood narrow it; reading aloud with expression widens it; talking casually is in between.",
  },
  {
    key: "pitch.p5_hz", path: ["pitch", "p5_hz"], group: "Pitch", title: "Low end of pitch",
    format: fixed(0), unit: "Hz",
    definition: "The pitch your voice was above 95% of the time: the low end of your range, without the odd stray low note.",
    why: "The bottom of the range shows where the voice settles, often at the ends of phrases.",
    moves: "Tiredness and hoarseness pull it down; a quiet, low reading voice lowers it too.",
  },
  {
    key: "pitch.p95_hz", path: ["pitch", "p95_hz"], group: "Pitch", title: "High end of pitch",
    format: fixed(0), unit: "Hz",
    definition: "The pitch your voice was below 95% of the time: the high end of your range, without the odd stray high note.",
    why: "The top of the range shows how far the voice still reaches when it rises.",
    moves: "Effort, emphasis and questions raise it; tiredness and illness bring it down.",
  },
  {
    key: "pitch.p5_p95_range_hz", path: ["pitch", "p5_p95_range_hz"], group: "Pitch", title: "Pitch range",
    format: fixed(0), unit: "Hz",
    definition: "The distance between the low end and the high end above.",
    why: "A narrower range is what makes a voice sound flatter.",
    moves: "Tiredness narrows it; reading with expression widens it; the passage itself matters, which is why the same text helps.",
  },
  {
    key: "volume.mean_db", path: ["volume", "mean_db"], group: "Loudness", title: "Average loudness",
    format: fixed(1), unit: "dBFS",
    definition: "How loud your speech was on average, in decibels below the loudest level the recording can hold.",
    why: "Loudness takes breath support; a voice that has grown quieter can mean less energy.",
    moves: "Mic distance moves it more than anything else; then tiredness, illness and the room.",
  },
  {
    key: "volume.std_dev", path: ["volume", "std_dev"], group: "Loudness", title: "Loudness variation",
    format: fixed(1), unit: "dB",
    definition: "How much your loudness moved around its average, as a standard deviation.",
    why: "Emphasis lives in loudness as much as pitch; less movement means a flatter delivery.",
    moves: "Tiredness narrows it; moving toward and away from the mic widens it; expressive reading widens it too.",
  },
  {
    key: "volume.p5_db", path: ["volume", "p5_db"], group: "Loudness", title: "Quiet end of loudness",
    format: fixed(1), unit: "dBFS",
    definition: "The level your speech was above 95% of the time: the quiet end, such as the ends of phrases.",
    why: "Trailing off at the ends of phrases shows up here first.",
    moves: "Tiredness lowers it; mic distance lowers it; a noisy room raises it.",
  },
  {
    key: "volume.p95_db", path: ["volume", "p95_db"], group: "Loudness", title: "Loud end of loudness",
    format: fixed(1), unit: "dBFS",
    definition: "The level your speech was below 95% of the time: the loud end, without the odd shout.",
    why: "It shows how much push the voice still has when it needs it.",
    moves: "Mic distance moves it most; then effort, emphasis and tiredness.",
  },
  {
    key: "volume.p5_p95_range_db", path: ["volume", "p5_p95_range_db"], group: "Loudness", title: "Loudness range",
    format: fixed(1), unit: "dB",
    definition: "The distance between the quiet end and the loud end above.",
    why: "Like pitch range, it narrows when a voice goes flat.",
    moves: "Tiredness narrows it; a noisy room narrows it by raising the quiet end; mic distance changes it less than it changes the levels.",
  },
  {
    key: "voiceQuality.harmonic_to_noise", path: ["voiceQuality", "harmonic_to_noise"], group: "Voice quality", title: "Harmonics to noise",
    format: fixed(1), unit: "dB",
    definition: "How much of your voiced sound was clean tone rather than breath and noise.",
    why: "A breathier or hoarser voice has more noise in it, and this falls.",
    moves: "Colds, hoarseness and tiredness lower it; background noise and a distant mic lower it too.",
  },
  {
    key: "voiceQuality.spectral_centroid", path: ["voiceQuality", "spectral_centroid"], group: "Voice quality", title: "Brightness",
    format: fixed(0), unit: "Hz",
    definition: "The balance point of your voice's frequencies: higher is brighter, lower is darker or more muffled.",
    why: "A voice that has gone dull or muffled shifts its balance down.",
    moves: "The mic and the room move it a lot; then effort, tiredness and a blocked nose.",
  },
  {
    key: "voiceQuality.jitter", path: ["voiceQuality", "jitter"], group: "Voice quality", title: "Jitter",
    format: percent(2), unit: "%",
    definition: `How much the length of one vocal fold vibration differs from the next, on average. ${PERIODS_NOTE}`,
    why: "A steadier voice has less of it; roughness and strain add to it.",
    moves: "Hoarseness, illness and tiredness raise it; it rises at the starts and ends of words, so talking reads higher than reading.",
    note: CONNECTED,
  },
  {
    key: "voiceQuality.shimmer", path: ["voiceQuality", "shimmer"], group: "Voice quality", title: "Shimmer",
    format: percent(1), unit: "%",
    definition: `How much the strength of one vocal fold vibration differs from the next, on average. ${PERIODS_NOTE}`,
    why: "A steadier voice has less of it; breathiness and weakness add to it.",
    moves: "Hoarseness, illness and tiredness raise it; background noise and a distant mic raise it too.",
    note: CONNECTED,
  },
  {
    key: "inflection", path: ["inflection"], group: "Inflection", title: "Inflection",
    format: fixed(1), unit: "out of 10",
    definition: "One score for how much your voice moved, built from the pitch, loudness and voice-quality readings above.",
    why: "It is a single summary of liveliness, useful for seeing a trend at a glance.",
    moves: "Everything that moves its inputs: tiredness and mood above all, then reading versus talking.",
  },
];

/* What each kind of evidence is, in words, for the "Needs more speech" line. */
const EVIDENCE = {
  spanSeconds: { what: "seconds of speech from your first word to your last", value: (n) => n.toFixed(1) },
  words: { what: "words heard", value: String },
  speechSegments: { what: "stretches of speech between pauses", value: String },
  voicedFrames: { what: "voiced frames (short slices of voiced sound)", value: String },
  glottalPeriods: { what: "glottal periods", value: String },
  volumeWindows: { what: "loudness windows", value: String },
  centroidWindows: { what: "brightness windows", value: String },
};

const titleOf = (key) => METRICS.find((m) => m.key === key)?.title.toLowerCase() ?? key;

/* The requirement a floored entry states, in words. Every number in it comes from the entry itself. */
export function needText(entry) {
  const known = EVIDENCE[entry.evidence];
  if (known && typeof entry.need === "number") {
    const had = Number.isFinite(entry.have) ? known.value(entry.have) : "0";
    return `Needs ${known.value(entry.need)} ${known.what}; this recording had ${had}.`;
  }
  if (entry.evidence.startsWith("speech")) {
    return `Needs real speech: ${entry.need}; this recording had ${entry.have}.`;
  }
  const inputs = entry.evidence.match(/^inputs \((.*)\)$/);
  if (inputs) {
    const names = inputs[1].split(", ").map(titleOf);
    return `Built from other readings, and these needed more speech: ${names.join(", ")}.`;
  }
  return `Needs more ${entry.evidence}: ${entry.need}; this recording had ${entry.have ?? "none"}.`;
}

/* One card per metric. state is "value" (a reading), "needs" (under its floor, or nothing to read) or "unavailable"
   (word rate when Whisper could not run). A card never carries a number the measurement did not produce. */
export function resultCards({ metrics, floored, evidence }, { wordsAvailable = true } = {}) {
  const flooredBy = new Map(floored.map((f) => [f.metric, f]));
  return METRICS.map((m) => {
    const raw = m.path.reduce((v, k) => (v == null ? undefined : v[k]), metrics);
    const base = { key: m.key, group: m.group, title: m.title, definition: m.definition, why: m.why, moves: m.moves, note: m.note };
    if (raw != null && Number.isFinite(raw)) {
      return { ...base, state: "value", value: m.format(raw), unit: m.unit };
    }
    if (m.key === "cadence.wpm" && !wordsAvailable) {
      return { ...base, state: "unavailable", value: "not available", detail: "Whisper could not run in this browser, so there were no words to count." };
    }
    const entry = flooredBy.get(m.key);
    if (entry) return { ...base, state: "needs", value: "Needs more speech", detail: needText(entry) };
    const detail = evidence && evidence.spanFound === false
      ? "No speech was found in this recording."
      : "There was nothing in this recording to measure it on.";
    return { ...base, state: "needs", value: "Needs more speech", detail };
  });
}

/* ---------- the download ---------- */

const pad = (n) => String(n).padStart(2, "0");

/* Local time as ISO 8601 with the offset, e.g. 2026-11-06T23:41:05-08:00. */
export function localIso(date) {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/* voice-metrics-YYYY-MM-DD-HHMM.json, in local time. */
export const fileName = (date) =>
  `voice-metrics-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;

/* What the download holds. Built from the same cards the page shows, so the two cannot disagree: a card with a
   reading carries measureVoice's own number (unrounded, in the unit measureVoice gives it), and every other card,
   floored or not measured, is null. Metric names are measureVoice's, as in its floored list. floored and evidence
   are passed through as measureVoice returned them. */
export function resultsFile(result, { wordsAvailable = true, commit, measuredAt, sentiment = null }) {
  const cards = resultCards(result, { wordsAvailable });
  const metrics = {};
  for (const m of METRICS) {
    const card = cards.find((c) => c.key === m.key);
    const value = card.state === "value" ? m.path.reduce((v, k) => v[k], result.metrics) : null;
    metrics[m.key] = { value, unit: m.format.fileUnit ?? m.unit.replace(/^\((.*)\)$/, "$1") };
  }
  return {
    measuredAt: localIso(measuredAt),
    source: { name: "SeniorMinder voice-health", commit },
    metrics,
    floored: result.floored,
    evidence: result.evidence,
    sentiment: sentimentFile(sentiment),
  };
}

/* The export's sentiment: the four values as scored, and whether only the first 2,000 characters were; null
   whenever there is no score (off, waiting, too few words, failed). */
export function sentimentFile(sentiment) {
  if (!sentiment || sentiment.state !== "scored" || !usableScores(sentiment.scores)) return null;
  return { ...sentiment.scores, truncated: sentiment.truncated };
}

/* ---------- sentiment ---------- */

/* SeniorMinder's sentiment, scored by the token Lambda with SeniorMinder's own prompt and model, on the words
   Whisper heard. Only the words go, and only when the visitor ticks the box. The state is one of:
     { state: "off" }                                   the box is not ticked
     { state: "pending" }                               sent, waiting for the answer
     { state: "scored", scores, truncated }             scores: the four fields as the Lambda returned them
     { state: "skipped", why }                          under SeniorMinder's word floor; why is the Lambda's text
     { state: "failed", why }                           the Lambda failed, or there were no words to send */

export const SENTIMENT_MAX_CHARS = 2000;   // the Lambda refuses more

/* The words to send: the transcript, or its first 2,000 characters cut at a word boundary. */
export function sentimentText(transcript) {
  if (transcript.length <= SENTIMENT_MAX_CHARS) return { text: transcript, truncated: false };
  const cut = transcript.slice(0, SENTIMENT_MAX_CHARS + 1);
  const end = cut.search(/\s+\S*$/);
  return { text: (end > 0 ? cut.slice(0, end) : cut.slice(0, SENTIMENT_MAX_CHARS)).trimEnd(), truncated: true };
}

export const SENTIMENT_EMOTIONS = ["joy", "sadness", "anger", "fear", "neutral"];   // the five the prompt allows

/* The four scores, or null unless all four are there and within the prompt's ranges: polarity -1 to 1, subjectivity
   and magnitude 0 to 1, and one of the five emotions. The Lambda applies the same rule; the page checks again so a
   broken answer can never be drawn, or saved, as a score. */
const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
export function usableScores(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { polarity_score, subjectivity_score, magnitude, dominant_emotion } = data;
  if (!inRange(polarity_score, -1, 1) || !inRange(subjectivity_score, 0, 1) || !inRange(magnitude, 0, 1)) return null;
  if (!SENTIMENT_EMOTIONS.includes(dominant_emotion)) return null;
  return { polarity_score, subjectivity_score, magnitude, dominant_emotion };
}

/* The state a Lambda answer leaves the card in: scored only with four usable values, skipped when the Lambda says
   so, and failed for everything else, an error status, a body that is not JSON, or an answer short of a score. */
export function sentimentFromResponse(ok, data, { truncated = false } = {}) {
  if (ok && data && typeof data.skipped === "string") return { state: "skipped", why: data.skipped };
  const scores = ok ? usableScores(data) : null;
  if (scores) return { state: "scored", scores, truncated };
  return { state: "failed", why: "I couldn't get a sentiment score this time." };
}

export const SENTIMENT_METRICS = [
  {
    key: "polarity_score", title: "Polarity", unit: "from -1 to 1", format: (v) => v.toFixed(2),
    definition: "How positive or negative your words were, from -1 (very negative) to 1 (very positive), as a language model reads the transcript.",
    why: "It sums up what you said rather than how you said it, and in your own words a drift over time says more than any one score.",
    moves: "What you talk about, above all; reading a set passage scores the passage, not you; words Whisper misheard can move it too.",
  },
  {
    key: "subjectivity_score", title: "Subjectivity", unit: "from 0 to 1", format: (v) => v.toFixed(2),
    definition: "How much your words were opinion and feeling rather than plain fact, from 0 (factual) to 1 (personal).",
    why: "It shows whether you were reporting or sharing; the same polarity carries more when it comes with feeling.",
    moves: "The topic, and whether you talk about yourself; a passage you read has its own fixed level.",
  },
  {
    key: "magnitude", title: "Magnitude", unit: "from 0 to 1", format: (v) => v.toFixed(2),
    definition: "How strongly feeling came through, whichever way it pointed, from 0 (flat) to 1 (strong).",
    why: "A polarity near zero can mean calm or can mean mixed feelings; magnitude tells the two apart.",
    moves: "Emphatic words and strong topics raise it; a long, even passage tends to read lower.",
  },
  {
    key: "dominant_emotion", title: "Dominant emotion", unit: null, format: String,
    definition: "The one emotion the model judged strongest in your words, chosen from joy, sadness, anger, fear and neutral.",
    why: "It turns the scores into one word you can follow over time; SeniorMinder stores it beside the numbers.",
    moves: "What you said; reading the Dickens passage mostly tells you about Dickens.",
  },
];

const SENTIMENT_WAITING = {
  off: { value: "Off", detail: "Sentiment scoring is off. Tick the box at the top and I will score the words from this recording, without recording again." },
  pending: { value: "Scoring…", detail: "Sending the words the page heard to OpenAI." },
};

/* The Sentiment group's cards for one state. Scored: one card per field, each with the line that says what was
   scored. Otherwise: one card that says plainly why there is no score. */
export function sentimentCards(sentiment) {
  if (sentiment.state === "scored") {
    const lines = ["Scored on the words you spoke, including any you read."];
    if (sentiment.truncated) lines.push(`Scored on the first ${SENTIMENT_MAX_CHARS.toLocaleString("en-US")} characters of what the page heard.`);
    return SENTIMENT_METRICS.map((m) => ({
      key: `sentiment.${m.key}`, group: "Sentiment", title: m.title, definition: m.definition, why: m.why, moves: m.moves,
      state: "value",
      value: m.format(sentiment.scores[m.key]),
      unit: m.unit,
      detail: null,
      note: lines.join(" "),
    }));
  }
  const waiting = SENTIMENT_WAITING[sentiment.state];
  const value = waiting ? waiting.value : sentiment.state === "skipped" ? "Too few words" : "Not available";
  const detail = waiting ? waiting.detail
    : sentiment.state === "skipped"
      ? `SeniorMinder only scores sentiment on enough words, and the page heard ${sentiment.why}. Everything else above still stands.`
      : `${sentiment.why} Everything else above still stands.`;
  return [{
    key: "sentiment", group: "Sentiment", title: "Sentiment", state: sentiment.state === "off" ? "off" : "needs", value, detail,
    definition: "How positive or negative, how personal and how strong your words were, and the emotion they carried most, scored the way SeniorMinder scores its seniors' answers.",
    why: "It reads what you said, where everything above reads how you said it.",
    moves: "The words themselves; a passage you read is scored on its words, not on you.",
  }];
}

/* ---------- the Start button ---------- */

/* Where the page is, and so what Start does. Stages, in order:
     idle        nothing on show; Start records
     opening     asking for the microphone; Start is off
     recording   Start reads Stop and stops
     stopping    the recording is being stopped and prepared; Start is off
     whisper     Whisper is loading or running; Start is off
     measuring   measureVoice is running; Start is off
     results     the cards are on show; Start does what Measure again does, then records
   generation is the ticket a sentiment request carries: anything that drops or replaces the result on show bumps it,
   so a reply that comes back for an older result is ignored. */
export function createFlow() {
  let stage = "idle";
  let shown = null;
  let generation = 0;

  const clear = () => { shown = null; generation += 1; stage = "idle"; };

  return {
    get stage() { return stage; },
    get shown() { return shown; },
    snapshot: () => ({ stage, shown, generation }),
    startEnabled: () => stage === "idle" || stage === "recording" || stage === "results",
    startLabel: () => (stage === "recording" ? "Stop" : "Start"),
    to(next) { stage = next; },
    show(measurement) { shown = measurement; generation += 1; stage = "results"; },
    // Measure again.
    clear,
    /* What a press of Start does now: "start", "stop", "restart" (the result was dropped exactly as Measure again
       drops it; then record) or "ignore" while the page is busy. */
    press() {
      if (stage === "idle") return "start";
      if (stage === "recording") return "stop";
      if (stage === "results") { clear(); return "restart"; }
      return "ignore";
    },
    // A new sentiment request, or the box unticked: the ticket for whatever is asked next.
    ticket: () => (generation += 1),
    isCurrent: (t) => t === generation,
  };
}
