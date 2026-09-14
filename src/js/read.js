/* Read. The visitor types a script and the avatar speaks it verbatim.

   The token is FULL with no context and no LLM, which is the only shape that both carries the
   vendor voice and leaves the avatar unable to say anything of its own; see the Lambda's README
   for why LITE cannot do this. The session opens with voiceChat off, so the microphone is never
   requested and nothing the visitor says is heard, transcribed or answered.

   Nothing here escapes or rewrites the script; repeat() takes plain text. The session is stopped as
   soon as the last line is spoken, because an open session bills at 2 credits a minute either way.
   No wait in here is unbounded, and none is a fixed number either. Both the per-chunk wait and the
   whole-read hang guard are sized from the text and the cadence, because a bound shorter than the
   speech it covers expires mid-sentence and the next line then talks over the one still playing.

   Nothing is sent at SessionState.CONNECTED. The SDK sets that at the end of its own start(), which
   can land before the avatar's tracks are subscribed, and a speak_text sent that early is a race
   the server can lose silently. The first line waits for SESSION_STREAM_READY instead. */

import { createAvatarSession } from "./avatar-session.js";
import {
  buttonState,
  estimateMs,
  readBoundMs,
  readyToSpeak,
  speakBoundMs,
  speakStartAction,
  splitScript,
  textToSpeak,
} from "./read-logic.js";

// The per-chunk and whole-read waits are not constants: they are sized to the text and the cadence
// by read-logic, because no bound may be shorter than the speech it is bounding.
// avatar.speak_ended tracks buffer processing, not playout, and leads the audio by about half a
// second (SeniorMinder spike 18445c98), so the last words are still playing when it arrives.
const TAIL_MS = 2000;
const STREAM_READY_MS = 10000;  // longest wait for SESSION_STREAM_READY before speaking regardless
const READY_SETTLE_MS = 500;    // after the stream is ready, before the first line goes out
const SPEAK_START_MS = 4000;    // longest wait for a chunk's avatar.speak_started before resending

// Field logging. The SDK's own console output is noise at this level, so every line the page cares
// about is stamped and prefixed, and no script text goes out beyond a short preview.
const log = (event, detail = "") =>
  console.log(`[read] +${Math.round(performance.now())}ms ${event}${detail ? " " + detail : ""}`);
const preview = (text) => text.slice(0, 40).replace(/\s+/g, " ");

const el = {
  avatar: document.getElementById("avatar"),
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

// A refusal is the outcome of the read, not a stage of it, so it holds the status line rather than
// being replaced by progress. Everything else falls back to the ordinary wording.
const statusLine = (fallback) => (refused && refusalMessage ? refusalMessage : fallback);

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
    speed: Number(el.speed.value),
    script: el.script.value.trim(),
  };
}

// ---------- reading ----------

let pendingSpeakEnd = null;   // settles the wait for the current chunk's avatar.speak_ended
let pendingSpeakStart = null; // settles the wait for the current chunk's avatar.speak_started
let pendingStreamReady = null;// settles the wait for SESSION_STREAM_READY
let streamReady = false;      // SESSION_STREAM_READY has fired for the live session
let speakingNow = false;      // between avatar.speak_started and avatar.speak_ended
let readDeadline = null;      // the whole-read bound, re-armed as each chunk goes out
let generation = 0;           // bumped to abandon a read in progress
let stopRequested = false;    // Stop was pressed before the session finished connecting

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForSpeakEnd(boundMs) {
  return new Promise((resolve) => {
    const settle = (how) => {
      clearTimeout(timer);
      if (pendingSpeakEnd === settle) pendingSpeakEnd = null;
      resolve(how);
    };
    const timer = setTimeout(() => settle("timeout"), boundMs);
    pendingSpeakEnd = settle;
  });
}

// The receipt that a chunk reached text-to-speech. Registered in the same tick as the send, so the
// event cannot arrive before anything is listening for it.
function waitForSpeakStart() {
  return new Promise((resolve) => {
    const settle = (started) => {
      clearTimeout(timer);
      if (pendingSpeakStart === settle) pendingSpeakStart = null;
      resolve(started);
    };
    const timer = setTimeout(() => settle(false), SPEAK_START_MS);
    pendingSpeakStart = settle;
  });
}

// Resolves true if the wait expired rather than the stream arriving.
function waitForStreamReady() {
  if (streamReady) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (expired) => {
      clearTimeout(timer);
      if (pendingStreamReady === settle) pendingStreamReady = null;
      resolve(expired);
    };
    const timer = setTimeout(() => settle(true), STREAM_READY_MS);
    pendingStreamReady = settle;
  });
}

// Even with every chunk bounded, the loop itself must not be able to sit there: if the read has not
// finished this long after the last chunk went out, it is over regardless of what the SDK is doing.
function armReadDeadline(boundMs) {
  clearTimeout(readDeadline);
  readDeadline = setTimeout(() => {
    console.warn(`[read] read did not finish within ${Math.round(boundMs / 1000)} s of the last chunk; stopping`);
    cancelRead();
    finish(statusLine("Done"));
  }, boundMs);
}

function cancelRead() {
  generation++;
  clearTimeout(readDeadline);
  readDeadline = null;
  if (pendingSpeakEnd) pendingSpeakEnd("cancelled");
  if (pendingSpeakStart) pendingSpeakStart(false);
  if (pendingStreamReady) pendingStreamReady(true);
  speakingNow = false;
}

/* Every piece of per-read state, cleared at the start of a read rather than only when one ends.

   Clearing on the way out is not enough: it assumes every exit path runs, and one does not.
   stopRequested was only ever reset in onStarting, which runs inside the session module's start()
   and so sits behind its "already busy or live" guard. Any start that hit that guard left the flag
   set with nothing to clear it again, and from then on every session connected and then declined to
   speak, because onConnected reads that flag. Resetting here instead cannot be skipped. */
function resetReadState() {
  generation++;                                   // abandon anything a previous read left running
  clearTimeout(readDeadline);
  readDeadline = null;
  if (pendingSpeakEnd) pendingSpeakEnd("cancelled");
  if (pendingSpeakStart) pendingSpeakStart(false);
  if (pendingStreamReady) pendingStreamReady(true);
  pendingSpeakEnd = null;
  pendingSpeakStart = null;
  pendingStreamReady = null;
  streamReady = false;                            // the next session has its own stream
  speakingNow = false;
  refused = false;
  refusalMessage = "";
  stopRequested = false;
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

/* Sends one chunk and waits for its avatar.speak_started, which is the receipt that the text
   actually went into text-to-speech. Watching only speak_ended cannot tell a chunk that was never
   taken up from one that is still being spoken. If the receipt does not arrive the chunk goes out
   once more; if it still does not, the caller falls through to the speak_ended bound as before. */
async function sendChunk(chunk, run, bounds) {
  for (let sends = 1; ; sends++) {
    if (run !== generation || !avatar.isLive()) return "cancelled";
    if (!avatar.repeat(chunk)) return "failed";
    log("sent", `${sends > 1 ? `(send ${sends}) ` : ""}${chunk.length}ch est=${Math.round(bounds.estimate / 1000)}s `
      + `bound=${Math.round(bounds.speak / 1000)}s read=${Math.round(bounds.read / 1000)}s "${preview(chunk)}"`);
    armReadDeadline(bounds.read);

    if (await waitForSpeakStart()) return "started";
    if (run !== generation) return "cancelled";

    // A late speak_started means the chunk did reach text-to-speech after all and is being spoken
    // now. Resending over it would make the avatar say the same line twice, so it never happens.
    if (speakingNow) { log("speak_started late; not resending"); return "started"; }

    const next = speakStartAction(sends);
    if (next.action === "resend") {
      console.warn(`[read] no avatar.speak_started within ${SPEAK_START_MS / 1000} s; resending: "${preview(chunk)}"`);
      continue;
    }
    console.warn(`[read] ${next.warn}: nothing after a resend; waiting out the speak_ended bound`);
    return "unconfirmed";
  }
}

async function readScript(text) {
  const run = ++generation;

  // Readiness, not CONNECTED. Wait for the stream, bounded; if the bound expires, speak anyway
  // rather than leave the page silent, and say so in the log.
  const expired = await waitForStreamReady();
  if (run !== generation) return;
  const gate = readyToSpeak({ connected: avatar.isLive(), streamReady, streamWaitExpired: expired });
  if (!gate.ready) { log("not ready, nothing sent"); return; }
  if (gate.warn) {
    console.warn(`[read] ${gate.warn}: no session.stream_ready within ${STREAM_READY_MS / 1000} s; speaking anyway`);
  }

  await pause(READY_SETTLE_MS);
  if (run !== generation || !avatar.isLive()) return;

  // Both bounds are sized per chunk: the chunk's own speech for the speak_ended wait, and
  // everything still unsaid for the hang guard, which is re-armed as each chunk goes out.
  const chunks = splitScript(text);
  let unsaid = chunks.reduce((n, c) => n + c.length, 0);

  for (const chunk of chunks) {
    if (run !== generation || !avatar.isLive()) { clearTimeout(readDeadline); return; }

    const bounds = {
      estimate: estimateMs(chunk.length, speed),
      speak: speakBoundMs(chunk.length, speed),
      read: readBoundMs(unsaid, speed),
    };

    const sent = await sendChunk(chunk, run, bounds);
    if (sent === "cancelled") return;
    if (sent === "failed") { cancelRead(); finish("Stopped"); return; }

    const how = await waitForSpeakEnd(bounds.speak);
    if (how === "cancelled") return; // cancelRead already cleared the deadline
    if (how === "timeout") {
      console.warn(`[read] no avatar.speak_ended within ${Math.round(bounds.speak / 1000)} s; moving on: "${preview(chunk)}"`);
    }
    unsaid -= chunk.length;
  }
  clearTimeout(readDeadline);
  readDeadline = null;
  if (run !== generation) return;

  // The read is over as far as the SDK is concerned, but the audio is not. Hold the session open
  // for the tail so the last words finish playing, then end it. This is the natural end only:
  // Stop tears the session down at once and never waits for this.
  await new Promise((resolve) => setTimeout(resolve, TAIL_MS));
  if (run !== generation) return; // Stop landed during the tail; it has already ended the session

  finish(statusLine("Done"));
}

// ---------- session ----------

let script = "";          // the script the live session was started for
let refused = false;      // the moderation policy turned this script down
let refusalMessage = "";  // what the avatar says instead, in its own voice
let speed = 1;   // the cadence it was started at, which is what the waits are sized against

const avatar = createAvatarSession({
  video: el.video,
  // No microphone: this page only speaks. voiceChat false is what stops the SDK starting one.
  sessionConfig: { voiceChat: false },
  request: selection,
  onState: setControls,
  onStatus: setStatus,
  // A start really is happening: take the script it was started for, and clear the state again in
  // case this start came from anywhere but the Go button.
  onStarting: (req) => { script = req.script; speed = req.speed; resetReadState(); },
  // A refused script still gets a session, because the avatar is what delivers the refusal.
  onToken: (answer) => {
    refused = Boolean(answer.refused);
    refusalMessage = refused ? String(answer.message ?? "") : "";
    if (refused) {
      log("script refused", `"${preview(refusalMessage)}"`);
      setStatus(statusLine("Reading"));
    }
  },
  onSessionState: (state) => log("session.state_changed", String(state)),
  onStreamReady: () => {
    streamReady = true;
    log("session.stream_ready");
    if (pendingStreamReady) pendingStreamReady(false);
  },
  onConnected: () => {
    if (stopRequested) return; // Stop landed while connecting; the queued stop does the rest
    setStatus(statusLine("Reading"));
    // Waits for the stream itself; CONNECTED alone is not enough to speak. A refused script is
    // never what goes out: the refusal takes its place, down this same path.
    readScript(textToSpeak({ script, refused, message: refusalMessage }));
  },
  // The Lambda's refusals are written for the visitor, so they are shown word for word.
  onStartFailed: (err) => setStatus(err.fromServer ? err.message : "The avatar is unavailable right now. " + (err.message || "")),
  onDisconnected: cancelRead,
  onSpeakStarted: () => {
    speakingNow = true;
    log("avatar.speak_started");
    setStatus(statusLine("Reading"));
    if (pendingSpeakStart) pendingSpeakStart(true);
  },
  onSpeakEnded: () => {
    speakingNow = false;
    log("avatar.speak_ended");
    if (pendingSpeakEnd) pendingSpeakEnd("ended");
  },
});

// ---------- wiring ----------

// One button. Go while idle, Stop while connecting or reading.
el.go.addEventListener("click", () => {
  if (isActive()) { stopRead(); return; }
  if (!el.script.value.trim()) return;
  // The start of a read, and the one place a reset cannot be skipped: the module's start() can
  // decline to run, and the second Go of a session that did so must not inherit the first's state.
  resetReadState();
  avatar.queueStart();
});

el.script.addEventListener("input", render);

// Changing a setting while a read is running is a Stop. Nothing restarts on its own.
for (const sel of [el.avatar, el.speed]) {
  sel.addEventListener("change", () => { if (isActive()) stopRead(); });
}

render();
setStatus("");
