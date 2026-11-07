// packages/device/src/WhisperModel.js
//
// WHISPER_MODEL device-class default (RULING, Ed 2026-07-23). The Pi runs `tiny`; the desktop keeps `base`.
//
// THE DRIFT: the shared installer .env (installer/shared/.env) carried a single `WHISPER_MODEL=base` since
// the installer's inception — a DESKTOP-calibrated value. Env.js bootstraps the per-user .env by copying that
// shared file verbatim, so every Pi inherited `base`. On the Pi, `base` (whisper-base.en) is ~5x the compute
// of `tiny` and saturates the CPU — the suspected precondition for the mid-flow "network" symptoms (resolver
// timeouts, one-sided turns) that are actually LOCAL CPU STARVATION. Before the installer added that line, the
// Jan Windows runs used the CODE default `tiny`.
//
// THE FIX (settings-resolution policy — SettingsResolutionPolicy.md): WHISPER_MODEL is a DEPLOYMENT-specific
// (.env-tier) value that varies by device class, so its per-class DEFAULT is resolved HERE, in ONE place — the
// single resolver the policy mandates. Precedence (the policy's "sensible default + narrower override" chain):
//
//     explicit env override (process.env.WHISPER_MODEL, the bench/tuning tier)  →  device-class default
//
// The shared .env no longer carries a class-specific value (no snowflake): a Pi resolves `tiny`, a desktop
// resolves `base`, and an operator/bench can still pin WHISPER_MODEL explicitly to override either.
//
// DEVICE CLASS: Pi = linux on ARM (the only linux-ARM target in this deployment — a Pi 5 reports arch
// 'arm64'). Everything else — Windows (win32), macOS (darwin, incl. Apple-silicon arm64), and a linux-x64
// dev box — is "desktop" and keeps `base`. (darwin is excluded from the Pi class so a Mac M1 stays desktop.)

/**
 * PURE (pinned): is this platform/arch the Pi device class (linux on ARM)?
 * @param {string} platform - process.platform ('linux' | 'win32' | 'darwin' | …)
 * @param {string} arch     - process.arch ('arm64' | 'arm' | 'x64' | …)
 * @returns {boolean}
 */
export function isPiDeviceClass(platform, arch) {
    return platform === 'linux' && (arch === 'arm64' || arch === 'arm');
}

/**
 * PURE (pinned): resolve WHISPER_MODEL by device class, honoring an explicit override first.
 * @param {{platform?: string, arch?: string, envValue?: string}} [p]
 * @returns {'tiny'|'base'|string} the resolved model size ('tiny' Pi / 'base' desktop, or the override verbatim)
 */
export function whisperModelForClass({ platform, arch, envValue } = {}) {
    const override = typeof envValue === 'string' ? envValue.trim() : '';
    if (override) return override;                                   // explicit env override wins (bench/tuning)
    return isPiDeviceClass(platform, arch) ? 'tiny' : 'base';        // device-class default
}

/**
 * Resolve the effective WHISPER_MODEL for THIS device — the SINGLE read site shared by SpeechTranscriber,
 * WakeWordDetector, and CommandListener. Reads process.platform/arch + the env override.
 * @returns {string}
 */
export function resolveWhisperModel() {
    return whisperModelForClass({
        platform: process.platform,
        arch: process.arch,
        envValue: process.env.WHISPER_MODEL,
    });
}
