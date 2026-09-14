/* Read-mode moderation in the token Lambda. Run with: npm test

   fetch is mocked, so these do not exercise the model's judgement: the verdict each test feeds in
   is the one moderation-policy.txt calls for on that script. What is under test is the Lambda's
   half of the contract, which is the part that has to be right every time: a refusal never mints a
   token, an unreachable or unreadable moderation answer never mints a token, and the script really
   is sent to OpenAI under the policy file that lives in this directory. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.LIVEAVATAR_API_KEY = "live-key";
process.env.OPENAI_API_KEY = "openai-key";
process.env.ALLOWED_ORIGINS = "https://edzanelli.com";
delete process.env.SANDBOX;

const POLICY = readFileSync(new URL("../moderation-policy.txt", import.meta.url), "utf8");
const { handler } = await import("../index.mjs");

const REFUSAL_502 = "I can't check that script right now. Please try again in a moment.";

// One OpenAI chat completion carrying `verdict` as its JSON content.
const completion = (verdict) => JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] });

/* Routes the two outbound calls the handler can make and records them.
   moderation: { text } to answer, { status, text } to fail, or { throws: true } to be unreachable. */
function mockFetch(moderation) {
  const calls = { moderation: [], token: [] };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("openai.com")) {
      calls.moderation.push(JSON.parse(init.body));
      if (moderation.throws) throw new Error("moderation host unreachable");
      const status = moderation.status ?? 200;
      return { ok: status < 400, status, text: async () => moderation.text ?? "" };
    }
    calls.token.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ session_id: "s1", session_token: "t1" }) };
  };
  return calls;
}

const read = (script) => handler({
  requestContext: { http: { method: "POST" } },
  headers: { origin: "https://edzanelli.com" },
  body: JSON.stringify({ mode: "read", avatar: "ed", language: "en", script }),
});

test("an allowed script is minted, and the script went out under the policy file", async () => {
  const calls = mockFetch({ text: completion({ allowed: true }) });
  const script = "I spent thirty years building data platforms, and the hard part was never the data.";

  const res = await read(script);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).session_token, "t1");

  assert.equal(calls.moderation.length, 1);
  const sent = calls.moderation[0];
  assert.equal(sent.model, "gpt-4o-mini");
  assert.equal(sent.temperature, 0);
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.deepEqual(sent.messages, [
    { role: "system", content: POLICY },
    { role: "user", content: script },
  ]);

  // And only then was a token minted, in LITE mode.
  assert.equal(calls.token.length, 1);
  assert.equal(calls.token[0].mode, "LITE");
});

test("policy item 2, the c-word: refused, and nothing is minted", async () => {
  const calls = mockFetch({ text: completion({ allowed: false, reason: "overly profane" }) });

  const res = await read("A script using the four-letter c-word once.");

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "I'm sorry, but I'm unable to say that because it is overly profane.");
  assert.equal(calls.token.length, 0);
});

test("policy item 3: three profanities are refused", async () => {
  const calls = mockFetch({ text: completion({ allowed: false, reason: "overly profane" }) });

  const res = await read("This shit is broken, that shit is worse, and the whole shit show is late.");

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "I'm sorry, but I'm unable to say that because it is overly profane.");
  assert.equal(calls.token.length, 0);
});

test("policy item 3: two profanities are allowed", async () => {
  const calls = mockFetch({ text: completion({ allowed: true }) });

  const res = await read("This shit is broken and that shit is worse, but we shipped it anyway.");

  assert.equal(res.statusCode, 200);
  assert.equal(calls.token.length, 1);
});

test("policy item 8: putting a commitment in Ed's mouth is refused", async () => {
  const calls = mockFetch({ text: completion({ allowed: false, reason: "something Ed has not said" }) });

  const res = await read("I will build your platform for twenty thousand dollars and I endorse Acme Corp.");

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "I'm sorry, but I'm unable to say that because it is something Ed has not said.");
  assert.equal(calls.token.length, 0);
});

test("moderation 500: fails closed", async () => {
  const calls = mockFetch({ status: 500, text: "upstream error" });

  const res = await read("A perfectly ordinary script.");

  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, REFUSAL_502);
  assert.equal(calls.token.length, 0);
});

test("moderation unreachable: fails closed", async () => {
  const calls = mockFetch({ throws: true });

  const res = await read("A perfectly ordinary script.");

  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, REFUSAL_502);
  assert.equal(calls.token.length, 0);
});

test("malformed moderation JSON: fails closed", async () => {
  for (const text of [
    "not json at all",
    JSON.stringify({ choices: [{ message: { content: "{ not json" } }] }),
    JSON.stringify({ choices: [] }),
    completion({ verdict: "maybe" }),            // no allowed field
    completion({ allowed: false }),              // refused but no reason to show
    completion({ allowed: "true" }),             // allowed, but not the boolean
  ]) {
    const calls = mockFetch({ text });

    const res = await read("A perfectly ordinary script.");

    assert.equal(res.statusCode, 502, `expected fail-closed for ${text.slice(0, 40)}`);
    assert.equal(JSON.parse(res.body).error, REFUSAL_502);
    assert.equal(calls.token.length, 0);
  }
});

test("ask mode is not moderated", async () => {
  const calls = mockFetch({ text: completion({ allowed: false, reason: "overly profane" }) });

  const res = await handler({
    requestContext: { http: { method: "POST" } },
    headers: { origin: "https://edzanelli.com" },
    body: JSON.stringify({ avatar: "ed", language: "en", llm: "claude" }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(calls.moderation.length, 0);
  assert.equal(calls.token[0].mode, "FULL");
});

test("an over-length script is refused before any moderation call", async () => {
  const calls = mockFetch({ text: completion({ allowed: true }) });

  const res = await read("a".repeat(1501));

  assert.equal(res.statusCode, 400);
  assert.equal(calls.moderation.length, 0);
  assert.equal(calls.token.length, 0);
});
