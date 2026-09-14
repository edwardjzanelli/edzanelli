/* Read. The visitor types a script and the avatar speaks it verbatim.

   The session is minted in LITE mode, so there is no context and no LLM: repeat() hands the text
   straight to the voice. Nothing here escapes or rewrites the script; repeat() takes plain text.
   The session is stopped the moment the last line is spoken, because an open session bills. */

import { createAvatarSession } from "./avatar-session.js";

// The SDK puts no length limit on repeat(): it serialises the text into one command event over a
// reliable data channel, and 1500 characters is far inside that. The backend's own limit is not
// documented, so anything longer than this is sent as several calls rather than risk a silent
// truncation. A script inside the limit is one call and one continuous read.
const CHUNK_LIMIT = 1000;
const SPEAK_TIMEOUT_MS = 20000; // longest we wait for one chunk's avatar.speak_ended before moving on

const el = {
  avatar: document.getElementById("avatar"),
  language: document.getElementById("language"),
  speed: document.getElementById("speed"),
  script: document.getElementById("script"),
  counter: document.getElementById("counter"),
  go: document.getElementById("go"),
  video: document.getElementById("video"),
  poster: document.getElementById("poster"),
  status: document.getElementById("status"),
};

const MAX = Number(el.script.getAttribute("maxlength"));

// ---------- UI ----------

function setStatus(text) { el.status.textContent = text; }

let state = { live: false, busy: false, speaking: false };

function render() {
  el.poster.hidden = state.live;
  el.go.disabled = state.live || state.busy || el.script.value.trim() === "";
  el.counter.textContent = `${el.script.value.length} / ${MAX}`;
}

function setControls(next) { state = next; render(); }

function selection() {
  return {
    mode: "read",
    avatar: el.avatar.value,
    language: el.language.value,
    speed: Number(el.speed.value),
    script: el.script.value.trim(),
  };
}

// ---------- splitting a long script ----------

// Break one over-long sentence on a space rather than mid-word.
function hardSplit(sentence, limit) {
  const out = [];
  let rest = sentence;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Sentences, regrouped into the largest pieces that still fit. A script within the limit comes
// back untouched as a single piece.
export function splitScript(text, limit = CHUNK_LIMIT) {
  const clean = text.trim();
  if (clean.length <= limit) return clean ? [clean] : [];
  const chunks = [];
  let current = "";
  for (const sentence of clean.split(/(?<=[.!?][)"'”’]?)\s+/)) {
    for (const piece of hardSplit(sentence, limit)) {
      if (current && current.length + 1 + piece.length > limit) { chunks.push(current); current = piece; }
      else current = current ? current + " " + piece : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------- reading ----------

let pendingSpeakEnd = null; // settles the wait for the current chunk's avatar.speak_ended
let generation = 0;         // bumped to abandon a read in progress

function waitForSpeakEnd() {
  return new Promise((resolve) => {
    const settle = (how) => {
      clearTimeout(timer);
      if (pendingSpeakEnd === settle) pendingSpeakEnd = null;
      resolve(how);
    };
    const timer = setTimeout(() => settle("timeout"), SPEAK_TIMEOUT_MS);
    pendingSpeakEnd = settle;
  });
}

function cancelRead() {
  generation++;
  if (pendingSpeakEnd) pendingSpeakEnd("cancelled");
}

async function readScript(text) {
  const run = ++generation;
  for (const chunk of splitScript(text)) {
    if (run !== generation || !avatar.isLive()) return;
    if (!avatar.repeat(chunk)) return;
    const how = await waitForSpeakEnd();
    if (how === "cancelled") return;
    if (how === "timeout") {
      console.warn(`no avatar.speak_ended within ${SPEAK_TIMEOUT_MS / 1000} s; moving on:`, chunk.slice(0, 80));
    }
  }
  if (run !== generation || !avatar.isLive()) return;
  avatar.queueStop("Finished");
}

// ---------- session ----------

let script = ""; // the script the live session was started for

const avatar = createAvatarSession({
  video: el.video,
  request: selection,
  onState: setControls,
  onStatus: setStatus,
  onStarting: (req) => { script = req.script; },
  onConnected: () => { setStatus("Reading"); readScript(script); },
  // The Lambda's refusals are written for the visitor, so they are shown word for word.
  onStartFailed: (err) => setStatus(err.fromServer ? err.message : "The avatar is unavailable right now. " + (err.message || "")),
  onDisconnected: cancelRead,
  onSpeakStarted: () => setStatus("Reading"),
  onSpeakEnded: () => { if (pendingSpeakEnd) pendingSpeakEnd("ended"); },
});

// ---------- wiring ----------

el.go.addEventListener("click", () => {
  if (avatar.isLive() || avatar.isBusy() || !el.script.value.trim()) return;
  avatar.queueStart();
});

el.script.addEventListener("input", render);

// Changing a setting ends the read. Nothing restarts on its own: the visitor presses Go again.
for (const sel of [el.avatar, el.language, el.speed]) {
  sel.addEventListener("change", () => {
    if (!avatar.isLive() && !avatar.isBusy()) return;
    cancelRead();
    avatar.queueStop("Settings changed. Press Go to read again.");
  });
}

render();
setStatus("");
