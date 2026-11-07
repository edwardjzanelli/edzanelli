// packages/common/src/WavDecoder.js
//
// ══ THE ONE WAV DECODER OF THE VOICE PATH: THE SAMPLE FORMAT COMES FROM THE HEADER ═══════════════════════════════════
//
// Every WAV the voice path reads as samples — Whisper's input (SpeechTranscriber), the ear's boot self-test clip
// (EarBootSelfTest), an enrollment take (EnrollmentTake), the voiceprint embedder's file reader (VoiceprintEmbedder) —
// is decoded here. The format is read from the `fmt ` chunk, never assumed: SpeechTranscriber cast every WAV to Int16,
// so a 32-bit float WAV (an enrollment take, AF11) reached Whisper as noise — dev1's nine takes read "(explosion)",
// "(music)", "(dramatic music)" until converted to 16-bit (2026-11-06).
//
// Handles PCM (format 1) at 8, 16, 24 and 32 bits, IEEE float (format 3) at 32 and 64 bits, and WAVE_FORMAT_EXTENSIBLE
// (0xFFFE) whose sub-format is either. Channels are averaged to mono. Pure; Node's Buffer or any Uint8Array. Loaded
// by its own subpath (@seniorminder/common/WavDecoder) so the ear child does not load the package index.

const FORMAT = Object.freeze({ PCM: 1, FLOAT: 3, EXTENSIBLE: 0xfffe });

/**
 * The header of a WAV: its sample format and where its samples are.
 * @param {Uint8Array} buf
 * @returns {{format: 'u8'|'s16'|'s24'|'s32'|'f32'|'f64', tag: number, bits: number, channels: number, sampleRate: number,
 *   dataOffset: number, dataBytes: number}}
 * @throws {Error} not RIFF/WAVE, no fmt or data chunk, or a format this decoder does not read
 */
export function wavHeader(buf) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tag4 = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
    if (buf.length < 12 || tag4(0) !== 'RIFF' || tag4(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
    let o = 12, fmt = null;
    while (o + 8 <= buf.length) {
        const id = tag4(o), size = v.getUint32(o + 4, true);
        if (id === 'fmt ') {
            let tag = v.getUint16(o + 8, true);
            const bits = v.getUint16(o + 22, true);
            if (tag === FORMAT.EXTENSIBLE && size >= 40) tag = v.getUint16(o + 32, true);   // the sub-format GUID's first two bytes
            fmt = { tag, bits, channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true) };
        } else if (id === 'data') {
            if (!fmt) throw new Error('data chunk before fmt chunk');
            const format = fmt.tag === FORMAT.PCM ? ({ 8: 'u8', 16: 's16', 24: 's24', 32: 's32' })[fmt.bits]
                : fmt.tag === FORMAT.FLOAT ? ({ 32: 'f32', 64: 'f64' })[fmt.bits] : undefined;
            if (!format) throw new Error(`unsupported WAV sample format: tag ${fmt.tag}, ${fmt.bits}-bit`);
            return { format, ...fmt, dataOffset: o + 8, dataBytes: Math.min(size, buf.length - o - 8) };
        }
        o += 8 + size + (size % 2);
    }
    throw new Error(fmt ? 'no data chunk' : 'no fmt chunk');
}

/**
 * Decode a WAV to mono Float32 samples in its own sample rate. Integer PCM is scaled to [-1, 1); float is kept as
 * written (an AF11 take may peak over 1.0, and is kept as heard).
 * @param {Uint8Array} buf
 * @returns {{samples: Float32Array, sampleRate: number, channels: number, format: string}}
 */
export function decodeWav(buf) {
    const h = wavHeader(buf);
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const bytes = h.bits / 8, frame = bytes * h.channels;
    const n = Math.floor(h.dataBytes / frame);
    const read = {
        u8: (at) => (v.getUint8(at) - 128) / 128,
        s16: (at) => v.getInt16(at, true) / 32768,
        s24: (at) => ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16))) / 8388608,
        s32: (at) => v.getInt32(at, true) / 2147483648,
        f32: (at) => v.getFloat32(at, true),
        f64: (at) => v.getFloat64(at, true),
    }[h.format];
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const at = h.dataOffset + i * frame;
        if (h.channels === 1) { samples[i] = read(at); continue; }
        let s = 0;
        for (let c = 0; c < h.channels; c++) s += read(at + c * bytes);
        samples[i] = s / h.channels;
    }
    return { samples, sampleRate: h.sampleRate, channels: h.channels, format: h.format };
}
