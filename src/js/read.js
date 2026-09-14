/* Read. The visitor types a script and the avatar speaks it verbatim.

   The token is FULL with no context and no LLM, which is the only shape that both carries the
   vendor voice and leaves the avatar unable to say anything of its own; see the Lambda's README
   for why LITE cannot do this. The session opens with voiceChat off, so the microphone is never
   requested and nothing the visitor says is heard, transcribed or answered.

   Nothing here escapes or rewrites the script; repeat() takes plain text. The session is stopped as
   soon as the last line is spoken, because an open session bills at 2 credits a minute either way.
   No wait in here is unbounded: a chunk waits at most SPEAK_TIMEOUT_MS for its speak_ended, and the
   read as a whole is abandoned READ_TIMEOUT_MS after the last chunk went out. */

import { createAvatarSession } from "./avatar-session.js";
import { buttonState, splitScript } from "./read-logic.js";

const SPEAK_TIMEOUT_MS = 20000; // longest wait for one chunk's avatar.speak_ended before moving on
const READ_TIMEOUT_MS = 30000;  // longest the whole read may hang after the last chunk was sent
// avatar.speak_ended tracks buffer processing, not playout, and leads the audio by about half a
// second (SeniorMinder spike 18445c98), so the last words are still playing when it arrives.
const TAIL_MS = 2000;

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

const isActive = () => state.live || state.busy;

function render() {
  const button = buttonState({ live: state.live, busy: state.busy, hasText: el.script.value.trim() !== "" });
  el.go.textContent = button.label;
  el.go.disabled = button.disabled;
  el.poster.hidden = state.live;
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

// ---------- reading ----------

let pendingSpeakEnd = null; // settles the wait for the current chunk's avatar.speak_ended
let readDeadline = null;    // the whole-read bound, re-armed as each chunk goes out
let generation = 0;         // bumped to abandon a read in progress
let stopRequested = false;  // Stop was pressed before the session finished connecting

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

// Even with every chunk bounded, the loop itself must not be able to sit there: if the read has not
// finished this long after the last chunk went out, it is over regardless of what the SDK is doing.
function armReadDeadline() {
  clearTimeout(readDeadline);
  readDeadline = setTimeout(() => {
    console.warn(`read did not finish within ${READ_TIMEOUT_MS / 1000} s of the last chunk; stopping`);
    cancelRead();
    finish("Done");
  }, READ_TIMEOUT_MS);
}

function cancelRead() {
  generation++;
  clearTimeout(readDeadline);
  readDeadline = null;
  if (pendingSpeakEnd) pendingSpeakEnd("cancelled");
}

// Ends the session and settles the status line. A stop asked for while the token is still being
// fetched is queued behind the start, so busy counts as something to stop; with nothing running at
// all there is only the status line to set.
function finish(reason) {
  if (avatar.isLive() || avatar.isBusy()) avatar.queueStop(reason);
  else setStatus(reason);
}

// The visitor pressing Stop, or a selector change while a read is running.
function stopRead() {
  cancelRead();
  // Stop can land while the token is still in flight, before there is a session to stop or a read
  // to cancel. The queued stop tears the session down once it exists, and this stops the read ever
  // starting: without it, connecting would still fire onConnected and begin speaking.
  stopRequested = true;
  avatar.interrupt(); // cut off the current line rather than letting it play out
  finish("Stopped");
}

async function readScript(text) {
  const run = ++generation;
  for (const chunk of splitScript(text)) {
    if (run !== generation || !avatar.isLive()) { clearTimeout(readDeadline); return; }
    if (!avatar.repeat(chunk)) { cancelRead(); finish("Stopped"); return; }
    armReadDeadline();
    const how = await waitForSpeakEnd();
    if (how === "cancelled") return; // cancelRead already cleared the deadline
    if (how === "timeout") {
      console.warn(`no avatar.speak_ended within ${SPEAK_TIMEOUT_MS / 1000} s; moving on:`, chunk.slice(0, 80));
    }
  }
  clearTimeout(readDeadline);
  readDeadline = null;
  if (run !== generation) return;

  // The read is over as far as the SDK is concerned, but the audio is not. Hold the session open
  // for the tail so the last words finish playing, then end it. This is the natural end only:
  // Stop tears the session down at once and never waits for this.
  await new Promise((resolve) => setTimeout(resolve, TAIL_MS));
  if (run !== generation) return; // Stop landed during the tail; it has already ended the session

  finish("Done");
}

// ---------- session ----------

let script = ""; // the script the live session was started for

const avatar = createAvatarSession({
  video: el.video,
  // No microphone: this page only speaks. voiceChat false is what stops the SDK starting one.
  sessionConfig: { voiceChat: false },
  request: selection,
  onState: setControls,
  onStatus: setStatus,
  onStarting: (req) => { script = req.script; stopRequested = false; },
  onConnected: () => {
    if (stopRequested) return; // Stop landed while connecting; the queued stop does the rest
    setStatus("Reading");
    readScript(script);
  },
  // The Lambda's refusals are written for the visitor, so they are shown word for word.
  onStartFailed: (err) => setStatus(err.fromServer ? err.message : "The avatar is unavailable right now. " + (err.message || "")),
  onDisconnected: cancelRead,
  onSpeakStarted: () => setStatus("Reading"),
  onSpeakEnded: () => { if (pendingSpeakEnd) pendingSpeakEnd("ended"); },
});

// ---------- wiring ----------

// One button. Go while idle, Stop while connecting or reading.
el.go.addEventListener("click", () => {
  if (isActive()) { stopRead(); return; }
  if (!el.script.value.trim()) return;
  avatar.queueStart();
});

el.script.addEventListener("input", render);

// Changing a setting while a read is running is a Stop. Nothing restarts on its own.
for (const sel of [el.avatar, el.language, el.speed]) {
  sel.addEventListener("change", () => { if (isActive()) stopRead(); });
}

render();
setStatus("");
