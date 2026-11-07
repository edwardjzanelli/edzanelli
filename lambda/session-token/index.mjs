// Token Lambda for the Ask and Read pages, and the Voice page's sentiment score. Spec v1.2 sections 7 and 8.
// POST { mode?, avatar, language?, llm?, speed?, script? } -> { session_id, session_token }
// POST { action: "sentiment", transcript } -> { polarity_score, subjectivity_score, magnitude, dominant_emotion }
//   or { skipped } under the word floor. See scoreSentiment below. transcript: 2000 characters at most.
//   mode:   "ask" (the default) mints a FULL session carrying the context and an LLM configuration:
//           the avatar listens and answers.
//           "read" mints a FULL session with NO context_id and NO llm_configuration_id. Omitting
//           the context is HeyGen's restricted mode: the avatar generates nothing of its own and
//           speaks only what the page sends with repeat(), while the vendor voice still does the
//           speaking. llm is ignored and not required.
//           LITE is deliberately NOT used. It validates only avatar_id and ignores voice_id, and a
//           LITE session carries no vendor text-to-speech at all: the client is expected to supply
//           its own PCM. repeat() on a LITE session produced no speech and no events.
//   language: required in ask mode, where it sets speech recognition. Optional in read mode and
//           defaults to en: the voice is multilingual and reads English or Italian either way, and
//           read mode never listens, so there is nothing for the field to govern. The Read page
//           has no language selector and sends none.
//   speed:  speaking speed 0.80 to 1.20 in steps of 0.05; defaults to config voiceSpeed, then 1.
//   script: read mode only, required there. The text the avatar will read; 1500 characters at most.
//
// In read mode the script is checked against moderation-policy.txt by an OpenAI call before the
// token is minted. A refused script still gets a session, answered 200 with refused: true and the
// message the avatar then says in its own voice; the script itself is never sent to the avatar.
// The check is still fail-closed: if it cannot be made, or comes back unreadable, there is no
// verdict to speak, so nothing is minted and the page shows the text itself.
//
// Environment:
//   LIVEAVATAR_API_KEY   required. The only secret this function holds.
//   OPENAI_API_KEY       required for read mode, where it reviews the script against moderation-policy.txt,
//                        and for the sentiment action.
//   ALLOWED_ORIGINS      comma-separated, e.g. "https://edzanelli.com,http://localhost:8080"
//   SANDBOX              "1" to mint sandbox sessions (no credits; stock avatars only), anything else for live.
//   DEBUG                "1" to include LiveAvatar's status and message in a 502 response. Unset for launch.
//
// CORS response headers are set on the function URL configuration, not here (see README).
// This code only refuses requests whose Origin is not on the list.

import { readFileSync } from "node:fs";

const CONFIG = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const TOKEN_URL = "https://api.liveavatar.com/v1/sessions/token";

// Read at cold start so the policy is a versioned file in the repo rather than a string in here.
const POLICY = readFileSync(new URL("./moderation-policy.txt", import.meta.url), "utf8");
const MODERATION_URL = "https://api.openai.com/v1/chat/completions";
const MODERATION_MODEL = "gpt-4o-mini";
const MODERATION_TIMEOUT_MS = 10000;
const MODERATION_UNAVAILABLE = "I can't check that script right now. Please try again in a moment.";

// Asks the policy whether this script may be read aloud. Returns { allowed: true },
// { allowed: false, reason } or { failed: true }. Anything unexpected is a failure, not an
// allowance: the caller mints nothing unless the answer is a clear yes.
async function moderate(script) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set; read mode cannot moderate and will refuse everything");
    return { failed: true };
  }

  let res, text;
  try {
    res = await fetch(MODERATION_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODERATION_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: POLICY },
          { role: "user", content: script },
        ],
      }),
      signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    console.error("moderation request failed", err.message);
    return { failed: true };
  }

  if (!res.ok) {
    console.error("moderation request rejected", res.status, text.slice(0, 300));
    return { failed: true };
  }

  let verdict;
  try {
    verdict = JSON.parse(JSON.parse(text).choices[0].message.content);
  } catch {
    console.error("moderation response could not be parsed", text.slice(0, 300));
    return { failed: true };
  }

  if (verdict.allowed === true) return { allowed: true };
  if (verdict.allowed === false && typeof verdict.reason === "string" && verdict.reason.trim()) {
    return { allowed: false, reason: verdict.reason.trim() };
  }
  console.error("moderation verdict was not usable", text.slice(0, 300));
  return { failed: true };
}

/* Sentiment for the Voice page: SeniorMinder's own scoring, so the page's numbers mean what SeniorMinder stores.
   Nothing here is retyped from SeniorMinder. scripts/sync-seniorminder-voice.mjs writes sentiment-prompt.txt (the
   prompt SeniorMinder's SentimentAnalyzer sends, with {{transcript}} where it puts the trimmed transcript) and
   sentiment-request.json (the model, max_tokens and the fewest words it scores), both read out of the vendored
   SentimentAnalyzer at the commit in vendor/seniorminder/VENDORED.json. The request has the shape SeniorMinder's
   OpenAIProvider.generateCompletion sends: model, max_tokens and the prompt as the one user message, with no
   temperature and no system message. The parse is the analyzer's own line: strip ```json fences, trim, JSON.parse.

   The transcript is never logged: a log line carries its length and the outcome, nothing else. Nothing is stored. */
const SENTIMENT_PROMPT = readFileSync(new URL("./sentiment-prompt.txt", import.meta.url), "utf8");
const SENTIMENT_REQUEST = JSON.parse(readFileSync(new URL("./sentiment-request.json", import.meta.url), "utf8"));
const SENTIMENT_URL = "https://api.openai.com/v1/chat/completions";
const SENTIMENT_TIMEOUT_MS = 8000;   // SeniorMinder's LLM_FETCH_TIMEOUT_MS
const SENTIMENT_MAX_CHARS = 2000;
const SENTIMENT_EMOTIONS = ["joy", "sadness", "anger", "fear", "neutral"];   // the five the prompt allows

/* The four scores, or null unless the model gave all four within the ranges the prompt asks for. SentimentAnalyzer
   returns whatever parses, {} and [] included, and SeniorMinder stores it field by field; here anything short of
   four usable values is a failure, so a broken answer is never passed on as a score. */
const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
export function usableScores(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { polarity_score, subjectivity_score, magnitude, dominant_emotion } = parsed;
  if (!inRange(polarity_score, -1, 1) || !inRange(subjectivity_score, 0, 1) || !inRange(magnitude, 0, 1)) return null;
  if (!SENTIMENT_EMOTIONS.includes(dominant_emotion)) return null;
  return { polarity_score, subjectivity_score, magnitude, dominant_emotion };
}

// The prompt for one transcript, as SentimentAnalyzer builds it. split/join, not replace, so a "$" in the
// transcript is never read as a replacement pattern.
export const sentimentPrompt = (transcript) => SENTIMENT_PROMPT.split(SENTIMENT_REQUEST.placeholder).join(transcript.trim());

// SentimentAnalyzer's skip: no transcript, or fewer words than it scores.
const tooFewWords = (transcript) => !transcript || transcript.trim().split(/\s+/).length < SENTIMENT_REQUEST.min_words;

async function scoreSentiment(transcript) {
  const chars = transcript.length;
  const outcome = (what) => console.log(`sentiment chars=${chars} outcome=${what}`);
  const failed = (why) => { outcome(`failed (${why})`); return json(502, { error: "sentiment unavailable" }); };

  if (tooFewWords(transcript)) {   // also an empty or all-space transcript: never sent to OpenAI
    outcome("skipped");
    return json(200, { skipped: `fewer than ${SENTIMENT_REQUEST.min_words} words` });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return failed("OPENAI_API_KEY not set");

  let res, data;
  try {
    res = await fetch(SENTIMENT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: SENTIMENT_REQUEST.model,
        max_tokens: SENTIMENT_REQUEST.max_tokens,
        messages: [{ role: "user", content: sentimentPrompt(transcript) }],
      }),
      signal: AbortSignal.timeout(SENTIMENT_TIMEOUT_MS),
    });
    if (!res.ok) return failed(`OpenAI status ${res.status}`);
    data = await res.json();
  } catch (err) {
    return failed(err.name === "TimeoutError" ? "timed out" : "request failed");
  }

  // SentimentAnalyzer: raw = the completion's content ('' when absent); a parse error is no result.
  let parsed;
  try {
    const raw = data?.choices?.[0]?.message?.content || "";
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return failed("unparseable model output");
  }
  const scores = usableScores(parsed);
  if (!scores) return failed("no usable scores");
  outcome("scored");
  return json(200, scores);
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  if (method !== "POST") return json(405, { error: "POST only" });

  const origin = event.headers?.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return json(403, { error: "origin not allowed" });

  let req;
  try {
    req = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}");
  } catch {
    return json(400, { error: "body must be JSON" });
  }

  // The Voice page's sentiment score. It needs no LiveAvatar key and mints nothing.
  if (req.action === "sentiment") {
    if (typeof req.transcript !== "string") return json(400, { error: "transcript is required" });
    if (req.transcript.length > SENTIMENT_MAX_CHARS) {
      return json(400, { error: `transcript must be ${SENTIMENT_MAX_CHARS} characters or fewer` });
    }
    return scoreSentiment(req.transcript);
  }
  if (req.action !== undefined) return json(400, { error: "unknown action" });

  const apiKey = process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) return json(500, { error: "server not configured" });

  const mode = req.mode ?? "ask";
  if (mode !== "ask" && mode !== "read") return json(400, { error: "mode must be ask or read" });

  // The Read page speaks the visitor's own words, so the script is part of the request. The page
  // caps it at 1500 characters; nothing stops a caller from ignoring that, so the cap is here too.
  if (mode === "read") {
    if (typeof req.script !== "string" || !req.script.trim()) {
      return json(400, { error: "script is required in read mode" });
    }
    if (req.script.length > 1500) {
      return json(400, { error: "script must be 1500 characters or fewer" });
    }
  }

  // Read mode has no language selector: the voice is multilingual and reads whatever it is given,
  // and the token's language field only governs speech recognition, which read mode never uses.
  // So language is optional there and defaults to en. A language that is sent is still checked.
  const languageKey = mode === "read" ? req.language ?? "en" : req.language;

  const avatar = CONFIG.avatars[req.avatar];
  const language = CONFIG.languages[languageKey];
  const llm = mode === "read" ? null : CONFIG.llms[req.llm];
  if (!avatar || !language || (mode === "ask" && !llm)) {
    return json(400, { error: "avatar, language, or llm not on the allow-list" });
  }

  // Speaking speed: LiveAvatar accepts 0.8 to 1.2; the page offers 0.05 steps. Anything else is rejected.
  let speed = req.speed ?? CONFIG.voiceSpeed ?? 1;
  if (typeof speed !== "number" || speed < 0.8 || speed > 1.2 || Math.round(speed * 100) % 5 !== 0) {
    return json(400, { error: "speed must be 0.80 to 1.20 in steps of 0.05" });
  }
  speed = Math.round(speed * 100) / 100;

  const voiceId = avatar.voice[languageKey];
  const configured = mode === "read"
    ? avatar.avatar_id && voiceId
    : avatar.avatar_id && voiceId && CONFIG.context_id && llm.llm_configuration_id;
  if (!configured) return json(503, { error: "this combination is not configured yet" });

  /* A refused script still gets a session, because the avatar is the one that delivers the refusal:
     it says the message below in its own voice rather than the page printing a line. What it never
     does is read the script itself, which the page enforces by speaking the message in its place.

     Only the fail-closed path mints nothing: if the policy could not be applied at all, there is no
     verdict to speak and the page shows the text instead. */
  let refusal = null;
  if (mode === "read") {
    const verdict = await moderate(req.script);
    if (verdict.failed) return json(502, { error: MODERATION_UNAVAILABLE });
    if (!verdict.allowed) {
      console.log(`refused a script: ${verdict.reason}`);
      refusal = `I'm sorry, but I'm unable to say that because it is ${verdict.reason}.`;
    }
  }

  // Both modes are FULL, because only FULL carries the vendor voice. Read leaves out the context
  // and the LLM, which is what stops the avatar answering on its own; it then speaks nothing
  // except what the page hands it through repeat().
  const body = {
    mode: "FULL",
    avatar_id: avatar.avatar_id,
    avatar_persona: {
      voice_id: voiceId,
      language: language.language,
      voice_settings: { speed },
    },
    max_session_duration: CONFIG.maxSessionDurationSeconds,
    is_sandbox: process.env.SANDBOX === "1",
  };
  if (mode === "ask") {
    body.avatar_persona.context_id = CONFIG.context_id;
    body.llm_configuration_id = llm.llm_configuration_id;
  }

  let res, text;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    console.error("token request failed", err.message);
    return json(502, { error: "avatar service unreachable" });
  }

  if (!res.ok) {
    // Log the vendor's message; the visitor gets nothing vendor-specific unless DEBUG is set,
    // which returns the detail to make setup problems visible without CloudWatch.
    console.error("token request rejected", res.status, text.slice(0, 500));
    const detail = process.env.DEBUG === "1" ? { vendor_status: res.status, vendor_message: text.slice(0, 300) } : {};
    return json(502, { error: "avatar service refused the session", ...detail });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("token response not JSON", text.slice(0, 200));
    return json(502, { error: "unexpected response from avatar service" });
  }
  // LiveAvatar responses arrive either flat or wrapped in { code, data, message }.
  const payload = data.data && typeof data.data === "object" ? data.data : data;
  if (!payload.session_token) {
    console.error("token response missing session_token", JSON.stringify(data).slice(0, 300));
    return json(502, { error: "unexpected response from avatar service" });
  }

  console.log(`minted session ${payload.session_id} mode=${mode} token=${body.mode}${mode === "read" ? " (no context)" : ""} avatar=${req.avatar} lang=${languageKey} llm=${mode === "read" ? "-" : req.llm} sandbox=${body.is_sandbox}${refusal ? " refused" : ""}`);

  const answer = { session_id: payload.session_id, session_token: payload.session_token };
  if (mode === "read") {
    answer.refused = refusal !== null;
    if (refusal) answer.message = refusal;
  }
  return json(200, answer);
};
