// packages/common/src/EnvState.js
/**
 * @module common/EnvState
 *
 * The frozen environment state and its accessors. A LEAF MODULE — it imports nothing, deliberately.
 *
 * ── WHY THIS IS SEPARATE FROM Environment.js (2026-08-16) ────────────────────────────────────────
 * The accessors originally lived in Environment.js, and Paths.js imported them from there. That
 * closed an import cycle:
 *
 *     Paths.js -> Environment.js -> EnvironmentValidator.js -> Env.js -> Paths.js
 *
 * ESM evaluates a module's dependencies before its own body, so entering that ring at Paths.js meant
 * Env.js's module-scope `const envPath = getEnvFilePath()` ran while Paths.js had not yet defined
 * APP_NAME:
 *
 *     ReferenceError: Cannot access 'APP_NAME' before initialization
 *         at getUserDataDirectory (packages/common/src/Paths.js:50:52)
 *         at file:///.../packages/common/src/Env.js:6:17
 *
 * Which entry point hits it depends on import order, so main.js's graph survived while
 * cli/UploadSync.js — spawned 15s after every conversation ends — did not.
 *
 * Splitting the state into a leaf breaks the ring: Paths.js now imports only this file, which
 * imports nothing, so there is no path back into it. Environment.js keeps the validation and the
 * resolve/adopt entry points and re-exports these accessors, so every caller's import site is
 * unchanged.
 */

/**
 * Frozen resolution. `null` until resolveEnvironment()/adoptEnvironment() runs.
 * @type {Readonly<{env: string, runMode: string, origin: string}>|null}
 */
let _resolved = null;

/** Human-readable call site for error messages. Best effort; never throws. */
function callerHint() {
    const line = (new Error().stack || '').split('\n')[3] || '';
    return line.trim().replace(/^at\s+/, '') || 'unknown call site';
}

/**
 * Guard shared by every accessor: the environment must be resolved, and nothing may have changed
 * process.env since. The drift check is what makes an unidentified writer harmless — it cannot
 * silently reroute traffic, because the next read fails loudly and names both values.
 * @param {string} what - which accessor is asking, for the message
 */
export function assertIntact(what) {
    if (!_resolved) {
        throw new Error(
            `${what}() called before the environment was resolved (from: ${callerHint()}). ` +
            'resolveEnvironment() must run as the first statement of main, before any module ' +
            'resolves a URL or a database path. This is not a default-able condition.'
        );
    }
    const liveEnv = process.env.SENIORMINDER_ENV;
    const liveRunMode = process.env.RUN_MODE;
    if (liveEnv !== _resolved.env || liveRunMode !== _resolved.runMode) {
        throw new Error(
            'Environment MUTATED after resolution — refusing to serve a value that would cross ' +
            `environments (from: ${callerHint()}).\n` +
            `  resolved: SENIORMINDER_ENV='${_resolved.env}', RUN_MODE='${_resolved.runMode}' (${_resolved.origin})\n` +
            `  now:      SENIORMINDER_ENV='${liveEnv ?? '(unset)'}', RUN_MODE='${liveRunMode ?? '(unset)'}'\n` +
            'Something wrote process.env after boot. Find that writer; do not relax this check.'
        );
    }
}

/**
 * Freeze the resolved pair. Called only by Environment.resolveEnvironment/adoptEnvironment, which
 * own the validation — this module deliberately holds no rules, only state.
 * @param {{env: string, runMode: string, origin: string}} state
 */
export function setResolved(state) {
    _resolved = Object.freeze({ ...state });
}

/** @returns {boolean} true once the environment has been resolved. Never throws. */
export function isEnvironmentResolved() {
    return _resolved !== null;
}

/** @returns {string|null} the resolved env without asserting — for error messages only. */
export function resolvedEnvOrNull() {
    return _resolved ? _resolved.env : null;
}

/** @returns {boolean} true if a second resolution would be a re-resolution. */
export function hasResolution() {
    return _resolved !== null;
}

/**
 * The canonical environment (prod | dev | demo | qa | remote-demo | sandbox<N>).
 * @returns {string}
 * @throws {Error} if unresolved, or if process.env drifted since resolution.
 */
export function getEnv() {
    assertIntact('getEnv');
    return _resolved.env;
}

/**
 * The canonical run mode (live | dev | demo | remote-demo).
 * @returns {string}
 * @throws {Error} if unresolved, or if process.env drifted since resolution.
 */
export function getRunMode() {
    assertIntact('getRunMode');
    return _resolved.runMode;
}

/**
 * The resolved pair, for handing to a Worker / renderer.
 * @returns {{ env: string, runMode: string }}
 */
export function environmentHandoff() {
    assertIntact('environmentHandoff');
    return { env: _resolved.env, runMode: _resolved.runMode };
}

/**
 * TEST ONLY — clear the frozen resolution so a suite can exercise the unresolved and drift paths.
 * Never call from application code.
 */
export function __resetEnvironmentForTests() {
    _resolved = null;
}
