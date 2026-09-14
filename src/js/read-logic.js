/* The Read page's decisions that need no DOM and no SDK, kept apart so they can be tested.
   read.js holds the wiring; this holds the rules. */

/* The largest text sent as one repeat() call. The SDK puts no length limit on repeat(), but a
   chunk is also the unit a bound expiry throws away, so a paragraph-sized chunk made the cost of
   one expiry a paragraph of speech. Smaller chunks keep that cost to a few sentences. */
export const CHUNK_LIMIT = 400;

/* Speaking rate used to size the waits. Roughly 150 words a minute at cadence 1.0. It is a floor
   rather than an average on purpose: a low rate estimates a long duration, which makes every bound
   longer, and a bound that is too generous only delays a failure while one that is too short cuts
   off speech that was going fine. */
export const CHARS_PER_SEC = 12;

// A wait is the estimate doubled, plus a fixed pad for connection and queueing. The floor is what
// the per-chunk bound used to be in total, so a very short chunk is still given real time.
export const SPEAK_BOUND_FACTOR = 2;
export const SPEAK_BOUND_PAD_MS = 10000;
export const SPEAK_BOUND_FLOOR_MS = 20000;
export const READ_BOUND_FACTOR = 2;
export const READ_BOUND_PAD_MS = 15000;

/* What the avatar actually says.

   A refused script is never spoken. The refusal is spoken in its place, in the same voice and down
   the same path as any other read, because a refusal delivered by the avatar is the point: the
   page's own note promises that the avatar tells you why. If a refusal somehow arrives with no
   message to say, the answer is silence, never the script that was just refused. */
export function textToSpeak({ script, refused, message }) {
  if (!refused) return script;
  return typeof message === "string" && message.trim() ? message.trim() : "";
}

// How long this many characters should take to say at this cadence.
export function estimateMs(chars, speed) {
  return (chars / CHARS_PER_SEC) * 1000 / speed;
}

// The longest one chunk may go without its avatar.speak_ended before the read moves past it.
export function speakBoundMs(chars, speed) {
  return Math.max(SPEAK_BOUND_FLOOR_MS, estimateMs(chars, speed) * SPEAK_BOUND_FACTOR + SPEAK_BOUND_PAD_MS);
}

/* The longest the whole read may hang after a chunk goes out, sized to everything still unsaid.
   It must always outlast the per-chunk bound of that same text: a hang guard that fires first
   would cut off a read that is progressing perfectly well, which is the bug this pair exists to
   prevent, only one level up. */
export function readBoundMs(remainingChars, speed) {
  const scaled = estimateMs(remainingChars, speed) * READ_BOUND_FACTOR + READ_BOUND_PAD_MS;
  return Math.max(scaled, speakBoundMs(remainingChars, speed) + READ_BOUND_PAD_MS);
}

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

/* Paragraphs first, then sentences regrouped into the largest pieces that still fit.

   A blank line always ends a chunk: a paragraph break is a real pause in the reading, so running
   two paragraphs into one chunk would flatten it. Within a paragraph, sentences are kept whole and
   packed up to the limit, so a chunk never ends mid-sentence unless a single sentence is itself
   longer than the limit, which is the only case hardSplit handles. */
export function splitScript(text, limit = CHUNK_LIMIT) {
  const clean = text.trim();
  if (!clean) return [];
  const chunks = [];

  for (const paragraph of clean.split(/\n\s*\n+/)) {
    const para = paragraph.trim();
    if (!para) continue;
    if (para.length <= limit) { chunks.push(para); continue; }

    let current = "";
    for (const sentence of para.split(/(?<=[.!?][)"'”’]?)\s+/)) {
      for (const piece of hardSplit(sentence.trim(), limit)) {
        if (current && current.length + 1 + piece.length > limit) { chunks.push(current); current = piece; }
        else current = current ? current + " " + piece : piece;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}
