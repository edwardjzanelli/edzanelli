/* The Read page's decisions that need no DOM and no SDK, kept apart so they can be tested.
   read.js holds the wiring; this holds the rules. */

// The largest script sent as a single repeat() call. The SDK puts no length limit on repeat(): it
// serialises the text into one command event over a reliable data channel, and 1500 characters is
// far inside that. The vendor's own limit is not documented, so anything longer is sent as several
// calls rather than risk a silent truncation. A script inside the limit is one continuous read.
export const CHUNK_LIMIT = 1000;

/* The one button is Go when nothing is running and Stop when something is.

   While a session is connecting or reading, Stop is always available: that is the visitor's only
   way out, so it is never disabled. Idle, the button is Go and is live only when there is
   something to read, which is what makes editing the box re-enable it. */
export function buttonState({ live, busy, hasText }) {
  if (live || busy) return { label: "Stop", disabled: false };
  return { label: "Go", disabled: !hasText };
}

/* When the first line may be sent.

   SessionState.CONNECTED is not readiness: the SDK sets it at the end of its start(), which can
   land before the avatar's tracks are subscribed, and a speak_text sent that early is a race the
   server may simply drop. SESSION_STREAM_READY is the SDK's only readiness signal and fires once
   both the audio and the video track have arrived, so that is what this waits for. The wait is
   bounded: if it expires, speak anyway and say so, because a silent page is worse than a gamble. */
export function readyToSpeak({ connected, streamReady, streamWaitExpired }) {
  if (!connected) return { ready: false };
  if (streamReady) return { ready: true };
  if (streamWaitExpired) return { ready: true, warn: "stream-not-ready" };
  return { ready: false };
}

// How many times one chunk may be sent: the original and a single resend.
export const MAX_SPEAK_SENDS = 2;

/* What to do when a chunk has been sent and its avatar.speak_started has not arrived in time.
   speak_started is the receipt that the text actually reached text-to-speech; without it the
   chunk may never have been taken up at all. `sends` counts how many times it has gone out. */
export function speakStartAction(sends) {
  if (sends < MAX_SPEAK_SENDS) return { action: "resend" };
  return { action: "proceed", warn: "no-speak-started" };
}

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
// back untouched as a single piece, which is the common case and reads without a seam.
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
