// Build-time stand-in for @seniorminder/logger in dist/voice-health-browser.js (scripts/build-voice-browser.mjs).
// The real logger writes files; the measurement only calls it for debug lines. Every call is a no-op, and a source
// module that imports a name not exported here fails the build (esbuild: "No matching export"), so nothing is guessed.
const noop = () => {};
export const AppLogger = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop, log: noop, trace: noop });
export const guardChild = (child) => child;
