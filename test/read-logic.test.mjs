/* The Read page's rules: the one button's Go/Stop states, and how a long script is split.
   Both are pure, so they need no DOM and no SDK. Run with: npm test */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buttonState,
  estimateMs,
  readBoundMs,
  readyToSpeak,
  speakBoundMs,
  speakStartAction,
  splitScript,
  CHARS_PER_SEC,
  CHUNK_LIMIT,
  MAX_SPEAK_SENDS,
  SPEAK_BOUND_FLOOR_MS,
} from "../src/js/read-logic.js";

const READ_JS = readFileSync(new URL("../src/js/read.js", import.meta.url), "utf8");

const idle = { live: false, busy: false };
const connecting = { live: false, busy: true };
const reading = { live: true, busy: false };
const stopping = { live: true, busy: true };

test("idle with an empty box: Go, disabled", () => {
  assert.deepEqual(buttonState({ ...idle, hasText: false }), { label: "Go", disabled: true });
});

test("typing into the box re-enables Go", () => {
  // The defect this pins: after a read, editing the textarea left the button stuck disabled.
  assert.deepEqual(buttonState({ ...idle, hasText: false }), { label: "Go", disabled: true });
  assert.deepEqual(buttonState({ ...idle, hasText: true }), { label: "Go", disabled: false });
});

test("connecting and reading both show Stop, always enabled", () => {
  for (const [name, session] of [["connecting", connecting], ["reading", reading], ["stopping", stopping]]) {
    for (const hasText of [true, false]) {
      assert.deepEqual(
        buttonState({ ...session, hasText }),
        { label: "Stop", disabled: false },
        `${name} with hasText=${hasText} must offer an enabled Stop`,
      );
    }
  }
});

test("Stop is never disabled: it is the only way out of a session", () => {
  // An empty textarea must not be able to take the visitor's escape hatch away mid-read.
  assert.equal(buttonState({ ...reading, hasText: false }).disabled, false);
});

test("a finished read returns the button to Go", () => {
  const during = buttonState({ ...reading, hasText: true });
  const after = buttonState({ ...idle, hasText: true });
  assert.equal(during.label, "Stop");
  assert.equal(after.label, "Go");
  assert.equal(after.disabled, false);
});

/* The tail is control flow inside read.js, which needs a DOM and the bundled SDK and so cannot be
   imported here. These are source checks, not behavioural ones: they pin the constant and the fact
   that it is applied in exactly one place, on the natural end of a read and nowhere else. The
   behaviour itself is Ed's live check. */

test("TAIL_MS is 2000 and is actually used", () => {
  assert.match(READ_JS, /const TAIL_MS = 2000;/, "TAIL_MS must be declared as 2000 in read.js");
  const uses = READ_JS.match(/TAIL_MS/g) ?? [];
  assert.equal(uses.length, 2, "TAIL_MS should be declared once and applied once; a second use means a new delay");
});

test("the tail is on the natural end of a read, and Stop never waits", () => {
  const stopRead = READ_JS.match(/function stopRead\(\) \{[\s\S]*?\n\}/);
  assert.ok(stopRead, "stopRead must exist to be checked");
  assert.doesNotMatch(stopRead[0], /TAIL_MS|setTimeout/, "Stop must tear the session down immediately");

  const readScript = READ_JS.match(/async function readScript\([\s\S]*?\n\}/);
  assert.ok(readScript, "readScript must exist to be checked");
  assert.match(readScript[0], /TAIL_MS/, "the tail belongs on the natural end of the read");
});

test("the speech bounds are computed, never hard-coded in the controller", () => {
  // The defect this pins: a fixed 20 s per-chunk bound expired on a chunk holding 80 s of speech,
  // and the next chunk's repeat then talked over the one still playing.
  assert.doesNotMatch(READ_JS, /SPEAK_TIMEOUT_MS|READ_TIMEOUT_MS/, "the fixed bounds are gone");
  assert.match(READ_JS, /waitForSpeakEnd\(bounds\.speak\)/, "the chunk wait takes a computed bound");
  assert.match(READ_JS, /armReadDeadline\(bounds\.read\)/, "so does the hang guard");
  for (const fn of ["estimateMs", "speakBoundMs", "readBoundMs"]) {
    assert.match(READ_JS, new RegExp(`${fn}\\(`), `${fn} must be the source of the bound`);
  }
});

test("the tail is still a fixed hold, and still 2 s", () => {
  assert.match(READ_JS, /const TAIL_MS = 2000;/);
});

test("two consecutive reads: Go, Stop while reading, Go again", () => {
  // The page is used this way: read, wait for Done, press Go again on the same text. The button
  // must come all the way back, not stay stuck on the first read's ending state.
  const text = { hasText: true };
  const sequence = [
    ["idle before the first read", { ...idle, ...text }, { label: "Go", disabled: false }],
    ["connecting", { ...connecting, ...text }, { label: "Stop", disabled: false }],
    ["reading", { ...reading, ...text }, { label: "Stop", disabled: false }],
    ["tearing down at Done", { ...stopping, ...text }, { label: "Stop", disabled: false }],
    ["idle at Done", { ...idle, ...text }, { label: "Go", disabled: false }],
    ["connecting again", { ...connecting, ...text }, { label: "Stop", disabled: false }],
    ["reading again", { ...reading, ...text }, { label: "Stop", disabled: false }],
    ["idle at the second Done", { ...idle, ...text }, { label: "Go", disabled: false }],
  ];
  for (const [step, input, expected] of sequence) {
    assert.deepEqual(buttonState(input), expected, `wrong button at: ${step}`);
  }
});

/* The reset itself is control flow in read.js and cannot be exercised here, so these pin that it
   exists, that it clears every piece of per-read state, and that it runs at the start of a read
   rather than only when one ends. A second read actually speaking is Ed's live check. */

test("resetReadState clears every piece of per-read state", () => {
  const fn = READ_JS.match(/function resetReadState\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "resetReadState must exist");
  for (const piece of ["generation", "readDeadline", "pendingSpeakEnd", "stopRequested"]) {
    assert.match(fn[0], new RegExp(piece), `resetReadState must clear ${piece}`);
  }
});

test("the reset runs at the start of a read, not only at the end", () => {
  // Go calls it before queueStart, so a start the session module declines still leaves clean state.
  const goHandler = READ_JS.match(/el\.go\.addEventListener\([\s\S]*?\n\}\);/);
  assert.ok(goHandler, "the Go handler must exist");
  assert.match(goHandler[0], /resetReadState\(\)[\s\S]*queueStart\(\)/, "reset must precede queueStart");

  // And onStarting covers any start that did not come from the button.
  assert.match(READ_JS, /onStarting:[^\n]*resetReadState\(\)/);
});

test("stopRequested is no longer cleared only on the way in to onStarting", () => {
  // The wedge this fixes: the flag was set by Stop and cleared in one place that a bailed start
  // skipped, so it stayed set and every later session connected without speaking.
  const setTrue = READ_JS.match(/stopRequested = true/g) ?? [];
  assert.equal(setTrue.length, 1, "only stopRead should set stopRequested");

  const stopRead = READ_JS.match(/function stopRead\(\) \{[\s\S]*?\n\}/);
  assert.match(stopRead[0], /stopRequested = true/, "stopRead is what sets it");

  const reset = READ_JS.match(/function resetReadState\(\) \{[\s\S]*?\n\}/);
  assert.match(reset[0], /stopRequested = false/, "the reset is what clears it");

  // onStarting must no longer be the only place it is cleared.
  assert.doesNotMatch(READ_JS, /onStarting:[^\n]*stopRequested = false/);
});

test("CONNECTED alone is not ready to speak", () => {
  // The defect this pins: repeat() was sent at SessionState.CONNECTED, which the SDK sets at the
  // end of its start(), before the avatar's tracks exist. The server dropped it.
  assert.deepEqual(readyToSpeak({ connected: true, streamReady: false, streamWaitExpired: false }), { ready: false });
});

test("connected and stream ready: speak, no warning", () => {
  assert.deepEqual(readyToSpeak({ connected: true, streamReady: true, streamWaitExpired: false }), { ready: true });
});

test("the stream wait expiring speaks anyway, with a warning", () => {
  // A silent page is worse than a gamble, but it must say which it did.
  assert.deepEqual(
    readyToSpeak({ connected: true, streamReady: false, streamWaitExpired: true }),
    { ready: true, warn: "stream-not-ready" },
  );
});

test("never ready while disconnected, whatever the stream says", () => {
  for (const streamReady of [true, false]) {
    for (const streamWaitExpired of [true, false]) {
      assert.deepEqual(
        readyToSpeak({ connected: false, streamReady, streamWaitExpired }),
        { ready: false },
        `disconnected must never be ready (streamReady=${streamReady}, expired=${streamWaitExpired})`,
      );
    }
  }
});

test("a chunk with no speak_started is resent exactly once, then given up on", () => {
  assert.deepEqual(speakStartAction(1), { action: "resend" });
  assert.deepEqual(speakStartAction(2), { action: "proceed", warn: "no-speak-started" });
  assert.equal(MAX_SPEAK_SENDS, 2, "one original send and one resend");
});

test("the retry never loops: every send count past the limit proceeds", () => {
  for (let sends = MAX_SPEAK_SENDS; sends <= MAX_SPEAK_SENDS + 3; sends++) {
    assert.equal(speakStartAction(sends).action, "proceed", `sends=${sends} must not resend again`);
  }
});

test("the readiness and receipt bounds are declared", () => {
  assert.match(READ_JS, /const STREAM_READY_MS = 10000;/);
  assert.match(READ_JS, /const READY_SETTLE_MS = 500;/);
  assert.match(READ_JS, /const SPEAK_START_MS = 4000;/);
});

test("there is exactly one place a chunk is sent", () => {
  // The retry lives in sendChunk; a second call site would mean a send that skips the receipt.
  const sends = READ_JS.match(/avatar\.repeat\(/g) ?? [];
  assert.equal(sends.length, 1, "avatar.repeat should only be called from sendChunk");

  const sendChunk = READ_JS.match(/async function sendChunk\([\s\S]*?\n\}/);
  assert.ok(sendChunk, "sendChunk must exist");
  assert.match(sendChunk[0], /avatar\.repeat\(/, "the one send site is inside sendChunk");
  assert.match(sendChunk[0], /waitForSpeakStart\(\)/, "and it waits for the receipt");
});

test("a chunk that is already speaking is never spoken over", () => {
  // The invariant: no repeat goes out while speak_started has arrived and speak_ended has not.
  // The resend is the only send that could violate it, so it is guarded on speakingNow.
  const sendChunk = READ_JS.match(/async function sendChunk\([\s\S]*?\n\}/)[0];
  const guard = sendChunk.indexOf("if (speakingNow)");
  const resend = sendChunk.indexOf("continue;");
  assert.ok(guard > -1, "the resend must be guarded on speakingNow");
  assert.ok(guard < resend, "and the guard must come before the resend");

  // The next chunk is only sent after the current one's speak_ended or its bound, never sooner.
  assert.match(READ_JS, /const sent = await sendChunk\([\s\S]{0,400}?await waitForSpeakEnd\(bounds\.speak\)/);
});

test("nothing is spoken straight from onConnected any more", () => {
  const onConnected = READ_JS.match(/onConnected: \(\) => \{[\s\S]*?\n  \},/);
  assert.ok(onConnected, "onConnected must exist");
  assert.doesNotMatch(onConnected[0], /avatar\.repeat\(/, "the send must go through the readiness gate");
});

test("the estimate is characters over the rate, divided by cadence", () => {
  // 1200 characters at 12 a second is 100 s of speech at cadence 1.0.
  assert.equal(estimateMs(1200, 1.0), 100000);
  assert.equal(estimateMs(CHARS_PER_SEC, 1.0), 1000, "one second's worth is one second");
  assert.equal(estimateMs(0, 1.0), 0);
});

test("a slower cadence estimates longer, a faster one shorter", () => {
  const slow = estimateMs(1200, 0.8);
  const normal = estimateMs(1200, 1.0);
  const fast = estimateMs(1200, 1.2);
  assert.ok(slow > normal && normal > fast, `expected ${slow} > ${normal} > ${fast}`);
  assert.equal(slow, 125000);
  assert.equal(Math.round(fast), 83333);
});

test("the per-chunk bound always outlasts the speech it covers, at every cadence", () => {
  for (const speed of [0.8, 1.0, 1.2]) {
    for (const chars of [1, 50, CHUNK_LIMIT, 1000, 1500]) {
      const bound = speakBoundMs(chars, speed);
      const speech = estimateMs(chars, speed);
      assert.ok(bound > speech, `bound ${bound} must exceed ${speech} (${chars}ch at ${speed})`);
      assert.ok(bound >= SPEAK_BOUND_FLOOR_MS, `bound ${bound} must respect the floor`);
    }
  }
});

test("the bound that failed in the field would now be generous", () => {
  // The receipt: a ~1000-character chunk at cadence 1.0 was cut off by a fixed 20 s bound after
  // about 370 characters. That chunk is ~83 s of speech.
  const speech = estimateMs(1000, 1.0);
  assert.ok(speech > SPEAK_BOUND_FLOOR_MS, "the old fixed bound was shorter than the speech");
  assert.ok(speakBoundMs(1000, 1.0) > speech, "the new bound is not");
});

test("a short chunk still gets the floor, not a trivially small bound", () => {
  assert.equal(speakBoundMs(1, 1.0), SPEAK_BOUND_FLOOR_MS);
});

test("the hang guard always outlasts the per-chunk bound of what is left", () => {
  // Otherwise the guard would fire on a read that is progressing perfectly well.
  for (const speed of [0.8, 1.0, 1.2]) {
    for (const chars of [1, 50, CHUNK_LIMIT, 1000, 1500]) {
      assert.ok(
        readBoundMs(chars, speed) > speakBoundMs(chars, speed),
        `read bound must exceed the chunk bound (${chars}ch at ${speed})`,
      );
    }
  }
});

test("the hang guard shrinks as the read progresses", () => {
  assert.ok(readBoundMs(1200, 1.0) > readBoundMs(400, 1.0));
});

test("a blank line always ends a chunk", () => {
  const chunks = splitScript("First paragraph.\n\nSecond paragraph.");
  assert.deepEqual(chunks, ["First paragraph.", "Second paragraph."]);
});

test("paragraphs are split even when both would fit in one chunk", () => {
  // A paragraph break is a real pause; running them together would flatten the reading.
  const chunks = splitScript("Short one.\n\n\nShort two.\n\nShort three.");
  assert.deepEqual(chunks, ["Short one.", "Short two.", "Short three."]);
});

test("a 1200-character script chunks without ever breaking a sentence", () => {
  const sentence = "This is a sentence of a reasonable length that a person might actually write. ";
  const script = (sentence.repeat(8) + "\n\n" + sentence.repeat(8)).trim().slice(0, 1200);
  const chunks = splitScript(script);

  assert.ok(chunks.length > 1, "1200 characters must not be one chunk");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= CHUNK_LIMIT, `chunk of ${chunk.length} exceeds the limit`);
    assert.ok(chunk.trim() === chunk, "chunks must not carry surrounding whitespace");
  }
  // Every chunk boundary falls after a full stop, so none of them cuts a sentence in half.
  for (const chunk of chunks.slice(0, -1)) {
    assert.match(chunk, /[.!?][)"'”’]?$/, `chunk ends mid-sentence: "${chunk.slice(-40)}"`);
  }
});

test("a script within the limit is one piece, untouched", () => {
  const script = "Hello there. This is a short script.";
  assert.deepEqual(splitScript(script), [script]);
});

test("an empty or blank script is no pieces at all", () => {
  assert.deepEqual(splitScript(""), []);
  assert.deepEqual(splitScript("   \n  "), []);
});

test("a long script splits on sentence boundaries and loses no words", () => {
  const long = "This is sentence number N and it runs on for a while to take up room. ".repeat(30).trim();
  const chunks = splitScript(long);

  assert.ok(long.length > CHUNK_LIMIT, "fixture must actually exceed the limit");
  assert.ok(chunks.length > 1, "expected more than one chunk");
  for (const chunk of chunks) assert.ok(chunk.length <= CHUNK_LIMIT, `chunk of ${chunk.length} exceeds the limit`);
  assert.equal(chunks.join(" "), long, "rejoining the chunks must give the script back");
});

test("text with no sentence punctuation still splits, and never mid-word", () => {
  const runOn = "word ".repeat(400).trim(); // 1999 characters, not one full stop in it
  const chunks = splitScript(runOn);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= CHUNK_LIMIT);
  assert.equal(chunks.join(" "), runOn);
  for (const chunk of chunks) assert.deepEqual([...new Set(chunk.split(" "))], ["word"], "a word was cut in half");
});

test("a single word longer than the limit is still emitted", () => {
  const chunks = splitScript("a".repeat(1500));
  assert.deepEqual(chunks.map((c) => c.length), [400, 400, 400, 300]);
});

test("every chunk of a full-length script is inside the limit", () => {
  const atCap = "Sentence here. ".repeat(100).trim().slice(0, 1500);
  for (const chunk of splitScript(atCap)) assert.ok(chunk.length <= CHUNK_LIMIT);
});
