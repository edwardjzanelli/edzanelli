/* The sentiment action in the token Lambda. Run with: npm test

   OpenAI is mocked. The reference for every check is SeniorMinder's own SentimentAnalyzer, the vendored file,
   run here against a stand-in LLM service: the prompt the Lambda sends must be the one the analyzer sends, byte
   for byte; the Lambda must skip exactly the transcripts the analyzer skips; and on every model answer, good or
   broken, the Lambda must end where SeniorMinder ends, in the values SeniorMinder would store. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerVendoredSeniorMinder, vendored } from "../../../scripts/seniorminder-resolve.mjs";

process.env.LIVEAVATAR_API_KEY = "live-key";
process.env.OPENAI_API_KEY = "openai-key";
process.env.ALLOWED_ORIGINS = "https://edzanelli.com";

registerVendoredSeniorMinder();
const { SentimentAnalyzer } = await import(vendored("packages/voice/src/SentimentAnalyzer.js"));
const { handler } = await import("../index.mjs");
const REQUEST = JSON.parse(readFileSync(new URL("../sentiment-request.json", import.meta.url), "utf8"));
const FIELDS = ["polarity_score", "subjectivity_score", "magnitude", "dominant_emotion"];

/* The vendored analyzer with an LLM service that records the call and answers `raw` (or throws, as
   OpenAIProvider does on an HTTP error). */
async function analyzer(transcript, raw = "{}", { throws = false } = {}) {
  const asked = [];
  const a = new SentimentAnalyzer({
    llmService: {
      generateCompletion: async (prompt, options) => {
        asked.push({ prompt, options });
        if (throws) throw new Error("OpenAI API error: 500");
        return raw;
      },
    },
  });
  return { result: await a.analyze(transcript), asked };
}

// A usable answer, the default for tests about the request rather than the reply.
const GOOD = '{"polarity_score": 0.1, "subjectivity_score": 0.2, "magnitude": 0.3, "dominant_emotion": "neutral"}';

/* fetch mocked: answers OpenAI with `raw` as the completion's content, or with an HTTP status. */
function mockOpenAI({ raw = GOOD, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: status < 400,
      status,
      json: async () => ({ choices: [{ message: { content: raw } }] }),
      text: async () => "",
    };
  };
  return calls;
}

const sentiment = (transcript, origin = "https://edzanelli.com") => handler({
  requestContext: { http: { method: "POST" } },
  headers: { origin },
  body: JSON.stringify({ action: "sentiment", transcript }),
});

/* What SeniorMinder stores for one analyzer result: each field, or null (VoiceMetricsRecorder's sentiment?.x). */
const stored = (result) => FIELDS.map((f) => result?.[f] ?? null);
const storedFromLambda = (res) => (res.statusCode === 200 ? stored(JSON.parse(res.body)) : stored(null));

test("the prompt sent is the vendored analyzer's prompt, byte for byte, with its model and max_tokens", async () => {
  const transcripts = [
    "It was the best of times, it was the worst of times.",
    "   leading and trailing space is trimmed, as the analyzer trims it   ",
    'a "quoted" word, a $& and a $1, and\na second line',
  ];
  for (const t of transcripts) {
    const calls = mockOpenAI();
    const res = await sentiment(t);
    assert.equal(res.statusCode, 200);
    const { asked } = await analyzer(t);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: asked[0].prompt }], "the one user message is the analyzer's prompt");
    assert.equal(Buffer.compare(Buffer.from(calls[0].body.messages[0].content), Buffer.from(asked[0].prompt)), 0, "byte for byte");
    assert.equal(calls[0].body.max_tokens, asked[0].options.maxTokens);
    assert.equal(calls[0].body.model, "gpt-4o-mini");
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["max_tokens", "messages", "model"], "no temperature, as OpenAIProvider sends none");
  }
});

test("under the analyzer's word floor, OpenAI is never called", async () => {
  for (const t of ["", "   ", "one", "one two", "one two three", "  one\ttwo\nthree  "]) {
    const calls = mockOpenAI();
    const res = await sentiment(t);
    const { asked } = await analyzer(t);
    assert.equal(asked.length, 0, `the analyzer skips ${JSON.stringify(t)}`);
    assert.equal(calls.length, 0, `the Lambda skips ${JSON.stringify(t)}`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { skipped: "fewer than 4 words" });
  }
  const calls = mockOpenAI();
  await sentiment("one two three four");
  assert.equal(calls.length, 1, "four words are scored");
  assert.equal(REQUEST.min_words, 4);
});

test("a good model answer ends where SeniorMinder ends; anything else is a failure, never a score", async () => {
  const t = "I slept badly and I am tired of waiting for the doctor.";
  // Four usable values: the Lambda returns exactly what SeniorMinder stores.
  const good = [
    '{"polarity_score": -0.4, "subjectivity_score": 0.7, "magnitude": 0.5, "dominant_emotion": "sadness"}',
    '```json\n{"polarity_score": 0.2, "subjectivity_score": 0.3, "magnitude": 0.1, "dominant_emotion": "neutral"}\n```',
    '{"polarity_score": 0, "subjectivity_score": 0, "magnitude": 0, "dominant_emotion": "neutral"}',
    '{"polarity_score": 1, "subjectivity_score": 1, "magnitude": 1, "dominant_emotion": "joy", "extra": true}',
  ];
  for (const raw of good) {
    mockOpenAI({ raw });
    const lambda = await sentiment(t);
    const { result } = await analyzer(t, raw);
    assert.equal(lambda.statusCode, 200, raw);
    assert.deepEqual(stored(JSON.parse(lambda.body)), stored(result), raw);
    assert.deepEqual(Object.keys(JSON.parse(lambda.body)), FIELDS, "only the four fields");
  }
  // SeniorMinder's analyzer returns null for these too.
  for (const raw of ["Sure! Here is the sentiment: positive.", '{"polarity_score": 0.5,', "", "null"]) {
    mockOpenAI({ raw });
    const lambda = await sentiment(t);
    const { result } = await analyzer(t, raw);
    assert.equal(result, null, raw);
    assert.equal(lambda.statusCode, 502, raw);
    assert.deepEqual(JSON.parse(lambda.body), { error: "sentiment unavailable" });
  }
  // Since SeniorMinder 28020b78 the analyzer refuses these too, returning null so SeniorMinder stores nothing; the
  // Lambda refuses them as well, so a partial, empty, mistyped or out-of-range answer can never reach the page as a score.
  for (const raw of [
    "{}", "[]",
    '  {"polarity_score": 0.9, "dominant_emotion": "joy"}  ',
    '{"polarity_score": "0", "subjectivity_score": "0", "magnitude": "0", "dominant_emotion": "neutral"}',
    '{"polarity_score": 4, "subjectivity_score": 0.5, "magnitude": 0.5, "dominant_emotion": "joy"}',
    '{"polarity_score": 0.2, "subjectivity_score": -0.1, "magnitude": 0.5, "dominant_emotion": "joy"}',
    '{"polarity_score": 0.2, "subjectivity_score": 0.5, "magnitude": 0.5, "dominant_emotion": "boredom"}',
    '{"polarity_score": null, "subjectivity_score": null, "magnitude": null, "dominant_emotion": null}',
  ]) {
    mockOpenAI({ raw });
    const lambda = await sentiment(t);
    const { result } = await analyzer(t, raw);
    assert.equal(result, null, `the analyzer refuses ${raw}`);
    assert.equal(lambda.statusCode, 502, raw);
    assert.deepEqual(JSON.parse(lambda.body), { error: "sentiment unavailable" });
  }
  // An HTTP error: OpenAIProvider throws, the analyzer returns null, SeniorMinder stores nothing.
  mockOpenAI({ status: 500 });
  const lambda = await sentiment(t);
  const { result } = await analyzer(t, "", { throws: true });
  assert.equal(result, null);
  assert.equal(lambda.statusCode, 502);
  assert.deepEqual(storedFromLambda(lambda), stored(null));
});

test("an empty or all-space transcript is skipped, never sent", async () => {
  for (const t of ["", " ", "\n\t "]) {
    const calls = mockOpenAI({ raw: '{"polarity_score": 0, "subjectivity_score": 0, "magnitude": 0, "dominant_emotion": "neutral"}' });
    const res = await sentiment(t);
    assert.equal(calls.length, 0, JSON.stringify(t));
    assert.deepEqual(JSON.parse(res.body), { skipped: "fewer than 4 words" });
  }
});

test("the transcript never appears in a log line; its length and the outcome do", async () => {
  const t = "Zanzibar marmalade quietly confesses everything at midnight";
  const lines = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(keep)) console[k] = (...args) => lines.push(args.map(String).join(" "));
  try {
    mockOpenAI({ raw: '{"polarity_score": 0.1, "subjectivity_score": 0.2, "magnitude": 0.3, "dominant_emotion": "neutral"}' });
    await sentiment(t);
    mockOpenAI({ raw: `not json, and it echoes: ${t}` });
    await sentiment(t);
    mockOpenAI({ raw: "{}" });
    await sentiment(t);
    mockOpenAI({ status: 429 });
    await sentiment(t);
    await sentiment("Zanzibar marmalade");
    await sentiment(`${t} `.repeat(60));
    delete process.env.OPENAI_API_KEY;
    await sentiment(t);
  } finally {
    process.env.OPENAI_API_KEY = "openai-key";
    Object.assign(console, keep);
  }
  assert.ok(lines.length >= 5, `${lines.length} lines`);
  for (const line of lines) {
    for (const word of ["Zanzibar", "marmalade", "confesses", "midnight"]) assert.ok(!line.includes(word), `logged: ${line}`);
  }
  assert.ok(lines.some((l) => l === `sentiment chars=${t.length} outcome=scored`), lines.join("\n"));
  assert.ok(lines.some((l) => l === `sentiment chars=${t.length} outcome=failed (unparseable model output)`));
  assert.ok(lines.some((l) => l === `sentiment chars=${t.length} outcome=failed (OpenAI status 429)`));
  assert.ok(lines.some((l) => l === `sentiment chars=${t.length} outcome=failed (no usable scores)`));
  assert.ok(lines.some((l) => l === "sentiment chars=18 outcome=skipped"));
});

test("over 2000 characters is refused before any call, and the origin list applies", async () => {
  const calls = mockOpenAI();
  const long = await sentiment("word ".repeat(401));
  assert.equal(long.statusCode, 400);
  assert.equal(calls.length, 0);
  const foreign = await sentiment("one two three four", "https://example.com");
  assert.equal(foreign.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("the sentiment action needs no LiveAvatar key and mints nothing", async () => {
  delete process.env.LIVEAVATAR_API_KEY;
  try {
    const calls = mockOpenAI({ raw: '{"polarity_score": 0, "subjectivity_score": 0, "magnitude": 0, "dominant_emotion": "neutral"}' });
    const res = await sentiment("one two three four");
    assert.equal(res.statusCode, 200);
    assert.ok(calls.every((c) => c.url.includes("openai.com")));
    assert.deepEqual(JSON.parse(res.body), { polarity_score: 0, subjectivity_score: 0, magnitude: 0, dominant_emotion: "neutral" });
  } finally {
    process.env.LIVEAVATAR_API_KEY = "live-key";
  }
});
