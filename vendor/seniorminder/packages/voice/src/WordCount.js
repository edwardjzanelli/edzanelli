// ==================================================
// 📄 src/voice/WordCount.js
// ==================================================
//
// ══ WORDS COME FROM A TRANSCRIPT OF THE SAME AUDIO, OR THERE ARE NO WORDS ══════════════════════════════════════════
//
// Ed's ruling (2026-11-06): a word rate is counted from words, never guessed. The syllables ÷ 1.5 estimate it replaced
// was off by ~130 wpm on 29 known-text clips; it is never stored as wpm again. analyzeAudio's word count is THIS
// function over the transcripts it has of that audio, best first; no transcript, no words, no wpm row.
//
// The rank is measured (29 known-text clips, 2026-11-06, words per clip against the hand-counted text):
//   whisper        exact 28/29 (base) and 27/29 (tiny, the Pi's model), mean |wpm − known| 1.7 / 3.3 — the
//                  transcript analyzeAudio runs itself, on this file (includeTranscription).
//   streaming_ear  exact 25/29, mean |wpm − known| 7.5 — the ear's sherpa-onnx streaming transcript of this audio
//                  ("IT'S PRETTY GOOD", "CHECK IN", "P M").
// HeyGen's speech-to-text is NOT here: it transcribes the vendor's own copy of the call, not this file.
//
// The best-ranked transcript PRESENT decides, even when it reads no words: a transcript that heard no speech
// ("(keyboard clicking)") is a reading, and falling through to a lower-ranked reader would trade a better reader's
// "nothing" for a worse reader's words. Pure, no imports.

/** Transcript sources this function counts from, best first. */
export const TRANSCRIPT_RANK = Object.freeze(['whisper', 'streaming_ear']);

/**
 * The words of one transcript: bracketed and parenthesised non-speech tags ("[BLANK_AUDIO]", "(keyboard clicking)",
 * "*music*") are dropped; every remaining whitespace-separated token with a letter or a digit is one word
 * ("check-in" is one, "2pm" is one).
 * @param {string} text
 * @returns {number}
 */
export function wordsIn(text) {
    return String(text ?? '')
        .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
        .split(/\s+/)
        .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * THE WORD COUNT of an utterance: the best-ranked transcript present (TRANSCRIPT_RANK), counted by wordsIn.
 * @param {Array<{text: string|null|undefined, source: string|null|undefined}>} transcripts - in any order.
 * @returns {{words: number, source: string, text: string}|null} null when no ranked transcript is present.
 */
export function wordCountOf(transcripts = []) {
    for (const source of TRANSCRIPT_RANK) {
        const t = transcripts.find((x) => x && x.source === source && typeof x.text === 'string');
        if (t) return { words: wordsIn(t.text), source, text: t.text };
    }
    return null;
}
