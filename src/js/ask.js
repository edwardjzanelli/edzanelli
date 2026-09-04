/* Ask Ed. Spec v1.2 sections 4, 7, 8, 9.
   One session at a time. Any selector change while live restarts the session with the new settings.
   The only server call is the token Lambda; everything after that is the LiveAvatar SDK. */

import {
  LiveAvatarSession,
  SessionEvent,
  AgentEventsEnum,
  SessionState,
  SessionDisconnectReason,
} from "./vendor/liveavatar.esm.js";

const TOKEN_URL = "https://bw7rxcyn7l47nrc2f3ors4bwzi0mqzhp.lambda-url.us-west-1.on.aws"; // Lambda function URL, see lambda/session-token/README.md

const LLM_LABELS = { openai: "OpenAI", claude: "Claude", gemini: "Gemini" };

const el = {
  avatar: document.getElementById("avatar"),
  language: document.getElementById("language"),
  llm: document.getElementById("llm"),
  speed: document.getElementById("speed"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  video: document.getElementById("video"),
  poster: document.getElementById("poster"),
  status: document.getElementById("status"),
  composer: document.getElementById("composer"),
  text: document.getElementById("text"),
  send: document.getElementById("send"),
  transcript: document.getElementById("transcript"),
};

let session = null;      // the live LiveAvatarSession, or null
let busy = false;        // true while starting or stopping
let currentLlm = null;   // label for the avatar turns of the live session
let speaking = false;    // true between avatar.speak_started and avatar.speak_ended

// ---------- UI helpers ----------

function setStatus(text) { el.status.textContent = text; }

function setControls(live) {
  el.start.hidden = live;
  el.stop.hidden = !live;
  el.poster.hidden = live;
  el.start.disabled = busy;
  el.stop.disabled = busy;
  // The text box is usable only in a live session; Send is also held while the avatar is talking.
  el.text.disabled = !live;
  el.send.disabled = !live || speaking;
}

function addTurn(role, text, label) {
  if (!text || !text.trim()) return;
  const turn = document.createElement("div");
  turn.className = "turn turn-" + role;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : label;
  const body = document.createElement("span");
  body.textContent = text.trim();
  turn.append(who, body);
  el.transcript.appendChild(turn);
  turn.scrollIntoView({ block: "nearest" });
}

function addDivider(text) {
  const d = document.createElement("div");
  d.className = "turn-divider";
  d.textContent = text;
  el.transcript.appendChild(d);
}

function selection() {
  return { avatar: el.avatar.value, language: el.language.value, llm: el.llm.value, speed: Number(el.speed.value) };
}

function describe(sel) {
  return `${el.avatar.options[el.avatar.selectedIndex].text}, ${el.language.options[el.language.selectedIndex].text}, answers by ${LLM_LABELS[sel.llm]}, speed ${sel.speed.toFixed(2)}`;
}

// ---------- session lifecycle ----------

async function fetchToken(sel) {
  if (!TOKEN_URL) throw new Error("token endpoint not configured");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sel),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.session_token) throw new Error(data.error || `token request failed (${res.status})`);
  return data.session_token;
}

async function start() {
  if (busy || session) return;
  busy = true;
  const sel = selection();
  currentLlm = LLM_LABELS[sel.llm];
  setControls(false);
  setStatus("Connecting");
  addDivider("New conversation: " + describe(sel));

  try {
    const token = await fetchToken(sel);
    const s = new LiveAvatarSession(token, { voiceChat: true });
    wire(s);
    session = s;
    await s.start();
    // stream_ready attaches the video; state CONNECTED flips the controls.
  } catch (err) {
    console.error("start failed", err);
    session = null;
    busy = false;
    setControls(false);
    setStatus("The demo is unavailable right now. " + (err.message || ""));
  }
}

async function stop(reason) {
  if (!session) return;
  const s = session;
  session = null;
  busy = true;
  speaking = false;
  setControls(true);
  setStatus(reason || "Ending");
  try { await s.stop(); } catch (err) { console.warn("stop error", err); }
  busy = false;
  el.video.srcObject = null;
  setControls(false);
  setStatus(reason || "Ended");
}

function wire(s) {
  s.on(SessionEvent.SESSION_STREAM_READY, () => {
    s.attach(el.video);
  });

  s.on(SessionEvent.SESSION_STATE_CHANGED, (state) => {
    if (state === SessionState.CONNECTED) {
      busy = false;
      setControls(true);
      setStatus("Listening. Speak, or type below.");
    }
  });

  s.on(SessionEvent.SESSION_DISCONNECTED, (why) => {
    if (session !== s) return; // we already stopped it
    session = null;
    busy = false;
    speaking = false;
    el.video.srcObject = null;
    setControls(false);
    setStatus(
      why === SessionDisconnectReason.SESSION_START_FAILED ? "The avatar could not start. Try again."
      : why === SessionDisconnectReason.SERVER_INITIATED ? "The session ended (three-minute limit)."
      : "Disconnected."
    );
  });

  s.on(AgentEventsEnum.USER_SPEAK_STARTED, () => setStatus("Hearing you"));
  s.on(AgentEventsEnum.USER_SPEAK_ENDED, () => setStatus("Thinking"));
  s.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => { speaking = true; el.send.disabled = true; setStatus("Speaking (" + currentLlm + ")"); });
  s.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => { speaking = false; el.send.disabled = false; setStatus("Listening"); });

  s.on(AgentEventsEnum.USER_TRANSCRIPTION, (e) => addTurn("user", e.text));
  s.on(AgentEventsEnum.AVATAR_TRANSCRIPTION, (e) => addTurn("avatar", e.text, currentLlm));
}

// ---------- wiring ----------

el.start.addEventListener("click", start);
el.stop.addEventListener("click", () => stop("Ended"));

for (const sel of [el.avatar, el.language, el.llm, el.speed]) {
  sel.addEventListener("change", async () => {
    if (!session) return;
    await stop("Switching");
    start();
  });
}

el.composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = el.text.value.trim();
  if (!text || !session || speaking) return;
  // Not added to the transcript here: the SDK echoes typed text back as a user.transcription
  // event, which is what adds the turn (adding it here too printed it twice).
  try { session.message(text); } catch (err) { console.warn("message failed", err); }
  el.text.value = "";
});

window.addEventListener("pagehide", () => { if (session) session.stop().catch(() => {}); });

setControls(false);
setStatus("");
