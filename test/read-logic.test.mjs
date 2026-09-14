/* The Read page's rules: the one button's Go/Stop states, and how a long script is split.
   Both are pure, so they need no DOM and no SDK. Run with: npm test */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buttonState, splitScript, CHUNK_LIMIT } from "../src/js/read-logic.js";

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

test("the existing bounds are unchanged by the tail", () => {
  assert.match(READ_JS, /const SPEAK_TIMEOUT_MS = 20000;/);
  assert.match(READ_JS, /const READ_TIMEOUT_MS = 30000;/);
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
  assert.deepEqual(chunks.map((c) => c.length), [1000, 500]);
});

test("the page's own 1500-character cap is inside two chunks at most", () => {
  const atCap = "Sentence here. ".repeat(100).trim().slice(0, 1500);
  assert.ok(splitScript(atCap).length <= 2);
});
