// The one entry of dist/voice-health-browser.js (scripts/build-voice-browser.mjs).
//
// measureVoice is analyzeAudio's measure-and-floor stage and nothing else: the same VoiceAnalyticsService.measurePcm
// over the PCM, then the same applyReliabilityFloors. analyzeAudio decodes a file with ffmpeg and runs Whisper first;
// here the caller hands over the PCM and, when it has one, the transcript of the same audio.

import { VoiceAnalyticsService } from '../../packages/voice/src/VoiceAnalyticsService.js';
import { applyReliabilityFloors } from '../../packages/voice/src/ReliabilityFloors.js';

// The constructor only stores the locator; nothing here decodes a file.
const service = new VoiceAnalyticsService({ ffmpegLocator: { getPath: () => '' } });

/**
 * Every row-B voice-health reading of one utterance, after the reliability floors.
 * @param {Float32Array} float32Pcm16k - 16 kHz mono PCM, samples in [-1, 1].
 * @param {{transcript?: string, transcriptSource?: 'whisper'|'streaming_ear'}} [opts] - a transcript of THIS audio.
 *   Words (and so wpm, and the words half of the real-speech rule) come only from it; none, no words. Its source
 *   ranks it as WordCount does; default 'whisper', the rank analyzeAudio gives its own transcript.
 * @returns {{metrics: object, floored: Array<object>, evidence: object}} `metrics` is applyReliabilityFloors' result
 *   (it carries `evidence` too), `floored` what was nulled and why, `evidence` what each metric stands on.
 */
export function measureVoice(float32Pcm16k, { transcript, transcriptSource = 'whisper' } = {}) {
    if (!(float32Pcm16k instanceof Float32Array)) throw new TypeError('measureVoice: expected a Float32Array of 16 kHz mono PCM');
    const transcripts = typeof transcript === 'string' ? [{ text: transcript, source: transcriptSource }] : [];
    const raw = service.measurePcm(float32Pcm16k, { transcripts });
    const { result, floored } = applyReliabilityFloors(raw);
    return { metrics: result, floored, evidence: result.evidence };
}
