/* Read-mode moderation in the token Lambda. Run with: npm test

   fetch is mocked, so these do not exercise the model's judgement: the verdict each test feeds in
   is the one moderation-policy.txt calls for on that script. What is under test is the Lambda's
   half of the contract, which is the part that has to be right every time: a refusal answers 200
   with a session and the message the avatar then says, because the avatar is what delivers the
   refusal; an unreachable or unreadable moderation answer is a 502 that mints nothing, because
   there is no verdict to speak; and the script really is sent to OpenAI under the policy file that
   lives in this directory. */

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

// The Read page sends no language: there is no selector for it. Extra fields can be passed here to
// cover callers that do send one.
const read = (script, extra = {}) => handler({
  requestContext: { http: { method: "POST" } },
  headers: { origin: "https://edzanelli.com" },
  body: JSON.stringify({ mode: "read", avatar: "ed", script, ...extra }),
});

test("an allowed script is minted, and the script went out under the policy file", async () => {
  const calls = mockFetch({ text: completion({ allowed: true }) });
  const script = "I spent thirty years building data platforms, and the hard part was never the data.";

  const res = await read(script);

  assert.equal(res.statusCode, 200);
  const answer = JSON.parse(res.body);
  assert.equal(answer.session_token, "t1");
  assert.equal(answer.refused, false, "read mode always reports the verdict");
  assert.equal(answer.message, undefined, "nothing to say instead of an allowed script");

  assert.equal(calls.moderation.length, 1);
  const sent = calls.moderation[0];
  assert.equal(sent.model, "gpt-4o-mini");
  assert.equal(sent.temperature, 0);
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.deepEqual(sent.messages, [
    { role: "system", content: POLICY },
    { role: "user", content: script },
  ]);

  // And only then was a token minted: FULL, because only FULL carries the vendor voice, but
  // stripped of the context and the LLM so the avatar can say nothing of its own.
  assert.equal(calls.token.length, 1);
  const token = calls.token[0];
  assert.equal(token.mode, "FULL");
  assert.equal(token.avatar_persona.context_id, undefined);
  assert.equal(token.llm_configuration_id, undefined);
  // The voice still has to be there: it is what does the speaking.
  assert.ok(token.avatar_persona.voice_id);
  assert.equal(token.avatar_persona.language, "en", "read sends no language, so it defaults to en");
  assert.equal(token.avatar_persona.voice_settings.speed, 1);
});

test("read mode needs no language, and honours one if it is sent", async () => {
  // The page has no language selector; the field only governs speech recognition, which read mode
  // never uses, and the voice reads either language whatever this says.
  const withNone = mockFetch({ text: completion({ allowed: true }) });
  assert.equal((await read("Senza lingua.")).statusCode, 200);
  assert.equal(withNone.token[0].avatar_persona.language, "en");

  const withItalian = mockFetch({ text: completion({ allowed: true }) });
  assert.equal((await read("Con lingua.", { language: "it" })).statusCode, 200);
  assert.equal(withItalian.token[0].avatar_persona.language, "it");
});

test("a language that is sent is still checked, in read mode too", async () => {
  const calls = mockFetch({ text: completion({ allowed: true }) });

  const res = await read("Ordinary script.", { language: "klingon" });

  assert.equal(res.statusCode, 400);
  assert.equal(calls.moderation.length, 0, "a bad request must not cost a moderation call");
  assert.equal(calls.token.length, 0);
});

test("policy item 2, the c-word: refused, and the avatar is given a session to say so", async () => {
  const calls = mockFetch({ text: completion({ allowed: false, reason: "overly profane" }) });

  const res = await read("A script using the four-letter c-word once.");

  assert.equal(res.statusCode, 200, "a refusal still gets a session: the avatar delivers it");
  const answer = JSON.parse(res.body);
  assert.equal(answer.refused, true);
  assert.equal(answer.message, "I'm sorry, but I'm unable to say that because it is overly profane.");
  assert.ok(answer.session_token, "the avatar needs a session to say it in");
  assert.equal(calls.token.length, 1);
  // The refused text itself is never what the page will speak; read-logic swaps in the message.
  assert.equal(answer.error, undefined);
});

test("policy item 3: three profanities are refused", async () => {
  const calls = mockFetch({ text: completion({ allowed: false, reason: "overly profane" }) });

  const res = await read("This shit is broken, that shit is worse, and the whole shit show is late.");

  assert.equal(res.statusCode, 200, "a refusal still gets a session: the avatar delivers it");
  const answer = JSON.parse(res.body);
  assert.equal(answer.refused, true);
  assert.equal(answer.message, "I'm sorry, but I'm unable to say that because it is overly profane.");
  assert.ok(answer.session_token, "the avatar needs a session to say it in");
  assert.equal(calls.token.length, 1);
  // The refused text itself is never what the page will speak; read-logic swaps in the message.
  assert.equal(answer.error, undefined);
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

  assert.equal(res.statusCode, 200, "a refusal still gets a session: the avatar delivers it");
  const answer = JSON.parse(res.body);
  assert.equal(answer.refused, true);
  assert.equal(answer.message, "I'm sorry, but I'm unable to say that because it is something Ed has not said.");
  assert.ok(answer.session_token, "the avatar needs a session to say it in");
  assert.equal(calls.token.length, 1);
  // The refused text itself is never what the page will speak; read-logic swaps in the message.
  assert.equal(answer.error, undefined);
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

  // Ask keeps the two things read mode drops. This is the whole difference between the shapes,
  // and it is what stops a read session regaining an agent that could answer on its own.
  const token = calls.token[0];
  assert.equal(token.mode, "FULL");
  assert.ok(token.avatar_persona.context_id, "ask must carry the context");
  assert.ok(token.llm_configuration_id, "ask must carry the LLM configuration");
});

test("an over-length script is refused before any moderation call", async () => {
  const calls = mockFetch({ text: completion({ allowed: true }) });

  const res = await read("a".repeat(1501));

  assert.equal(res.statusCode, 400);
  assert.equal(calls.moderation.length, 0);
  assert.equal(calls.token.length, 0);
});
