// Build-time stand-in for SpeechTranscriber.js and EnhancedProcessingService.js (scripts/build-voice-browser.mjs).
// VoiceAnalyticsService constructs them lazily (Whisper, diarization workers); measurePcm never does.
class Unavailable {
    constructor() {
        throw new Error('voice-health-browser: transcription and diarization are not in this bundle; pass the transcript to measureVoice');
    }
}
export class SpeechTranscriber extends Unavailable {}
export class EnhancedProcessingService extends Unavailable {}
