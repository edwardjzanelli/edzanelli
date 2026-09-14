/* Ask Ed. Spec v1.2 sections 4, 7, 8, 9.
   The page controller: selectors, Start/Stop, the composer, and the transcript. The session itself
   lives in avatar-session.js, which the Read page shares.
   Any selector change while live restarts the session with the new settings. */

import { createAvatarSession } from "./avatar-session.js";

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

let currentLlm = null; // label for the avatar turns of the live session

// ---------- UI helpers ----------

function setStatus(text) { el.status.textContent = text; }

function setControls({ live, busy, speaking }) {
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

// ---------- session ----------

const avatar = createAvatarSession({
  video: el.video,
  sessionConfig: { voiceChat: true },
  request: selection,
  onState: setControls,
  onStatus: setStatus,
  onStarting: (sel) => {
    currentLlm = LLM_LABELS[sel.llm];
    addDivider("New conversation: " + describe(sel));
  },
  onConnected: () => setStatus("Listening. Speak, or type below."),
  onStartFailed: (err) => setStatus("The demo is unavailable right now. " + (err.message || "")),
  onUserSpeakStarted: () => setStatus("Hearing you"),
  onUserSpeakEnded: () => setStatus("Thinking"),
  onSpeakStarted: () => setStatus("Speaking (" + currentLlm + ")"),
  onSpeakEnded: () => setStatus("Listening"),
  onUserTurn: (text) => addTurn("user", text),
  onAvatarTurn: (text) => addTurn("avatar", text, currentLlm),
});

// ---------- wiring ----------

el.start.addEventListener("click", () => avatar.queueStart());
el.stop.addEventListener("click", () => avatar.queueStop("Ended"));

for (const sel of [el.avatar, el.language, el.llm, el.speed]) {
  sel.addEventListener("change", () => {
    if (!avatar.isLive() && !avatar.isBusy()) return;
    avatar.queueRestart("Switching");
  });
}

el.composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = el.text.value.trim();
  if (!text || !avatar.isLive() || avatar.isSpeaking()) return;
  // Not added to the transcript here: the SDK echoes typed text back as a user.transcription
  // event, which is what adds the turn (adding it here too printed it twice).
  avatar.message(text);
  el.text.value = "";
});

setControls({ live: false, busy: false, speaking: false });
setStatus("");
