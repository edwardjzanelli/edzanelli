// scripts/run-voice-parity.mjs (npm run test:voice-parity)
//
// Runs SeniorMinder's parity bench, vendor/seniorminder/packages/voice/test/test-voice-browser-parity.js, unchanged,
// in this repository. The bench builds its own bundle with the vendored build and compares it, value for value, with
// the vendored source run under Node, whose @seniorminder/* imports scripts/seniorminder-resolve.mjs maps to the
// vendored packages. The bench needs esbuild under vendor/seniorminder/scripts/voice-browser, which npm run
// build:voice installs.

import { registerVendoredSeniorMinder, vendored } from './seniorminder-resolve.mjs';

registerVendoredSeniorMinder();
await import(vendored('packages/voice/test/test-voice-browser-parity.js'));
