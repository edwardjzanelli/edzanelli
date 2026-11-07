// Build-time stand-in for the Node module AudioProcessor imports spawn from (scripts/build-voice-browser.mjs).
// Only AudioProcessor.getAudioData spawns (ffmpeg decode); measureVoice is handed PCM and never reaches it.
export function spawn() {
    throw new Error('voice-health-browser: decoding a file is not available here; pass 16 kHz mono Float32Array PCM to measureVoice');
}
