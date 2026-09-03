// Ask Ed token Lambda. Spec v1.2 sections 7 and 8.
// POST { avatar, language, llm } -> { session_id, session_token }
//
// Environment:
//   LIVEAVATAR_API_KEY   required. The only secret this function holds.
//   ALLOWED_ORIGINS      comma-separated, e.g. "https://edzanelli.com,http://localhost:8080"
//   SANDBOX              "1" to mint sandbox sessions (no credits; stock avatars only), anything else for live.
//   DEBUG                "1" to include LiveAvatar's status and message in a 502 response. Unset for launch.
//
// CORS response headers are set on the function URL configuration, not here (see README).
// This code only refuses requests whose Origin is not on the list.

import { readFileSync } from "node:fs";

const CONFIG = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const TOKEN_URL = "https://api.liveavatar.com/v1/sessions/token";

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

  const apiKey = process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) return json(500, { error: "server not configured" });

  let req;
  try {
    req = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}");
  } catch {
    return json(400, { error: "body must be JSON" });
  }

  const avatar = CONFIG.avatars[req.avatar];
  const language = CONFIG.languages[req.language];
  const llm = CONFIG.llms[req.llm];
  if (!avatar || !language || !llm) return json(400, { error: "avatar, language, or llm not on the allow-list" });

  const voiceId = avatar.voice[req.language];
  if (!avatar.avatar_id || !voiceId || !CONFIG.context_id || !llm.llm_configuration_id) {
    return json(503, { error: "this combination is not configured yet" });
  }

  const body = {
    mode: "FULL",
    avatar_id: avatar.avatar_id,
    avatar_persona: {
      voice_id: voiceId,
      context_id: CONFIG.context_id,
      language: language.language,
    },
    llm_configuration_id: llm.llm_configuration_id,
    max_session_duration: CONFIG.maxSessionDurationSeconds,
    is_sandbox: process.env.SANDBOX === "1",
  };

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

  console.log(`minted session ${payload.session_id} avatar=${req.avatar} lang=${req.language} llm=${req.llm} sandbox=${body.is_sandbox}`);
  return json(200, { session_id: payload.session_id, session_token: payload.session_token });
};
