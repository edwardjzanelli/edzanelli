/* Voice: the capture AudioWorklet. It runs on the audio thread, mixes the microphone's channels to mono, and hands
   the samples to the page in blocks of BLOCK frames, untouched otherwise: no gain, no filter. The page keeps them
   for the measurement and shows the meter from them. */

const BLOCK = 2048;   // about 43 ms at 48 kHz: often enough for a smooth meter, few enough messages

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels.length; c++) v += channels[c][i];
      this.block[this.filled++] = v / channels.length;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCapture);
