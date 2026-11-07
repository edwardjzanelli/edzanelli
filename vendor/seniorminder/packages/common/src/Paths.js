// packages/common/src/Paths.js
/**
 * @module common/Paths
 *
 * Single source of truth for all SeniorMinder filesystem paths.
 *
 * Cross-platform user data conventions:
 *   - Windows: %LOCALAPPDATA%\SeniorMinder
 *   - macOS:   ~/Library/Application Support/SeniorMinder
 *   - Linux:   ~/.config/SeniorMinder
 *
 * Pure Node — no Electron dependency, so it works in orchestrator,
 * worker threads, and other non-Electron contexts.
 */

import path from 'path';
import os from 'os';

// LEAF import — must NOT be './Environment.js'. That closed a cycle back through Env.js and threw
// 'Cannot access APP_NAME before initialization' on any entry that reached Paths.js first.
import { getEnv, getRunMode } from './EnvState.js';

const APP_NAME = 'SeniorMinder';

/**
 * Maps SENIORMINDER_ENV values to SQLite database filenames.
 *
 * The bare 'seniorminder' fallback is used only when SENIORMINDER_ENV is
 * unset (legacy/installer-pre-Phase-4 builds). All current installations
 * should set SENIORMINDER_ENV explicitly.
 *
* Pattern: <env>.db across all environments. Sandbox environments follow
 * the same pattern (e.g., sandbox4 -> sandbox4.db).
 *
 * Note: SENIORMINDER_ENV is expected to be a canonical short form
 * (prod/dev/demo/remote-demo/sandbox<N>) at this point — EnvironmentValidator
 * normalizes legacy long forms (production/development) before this is called.
 */
function databaseFileNameForEnv(env) {
    // NO FALLBACK. The old `if (!env) return 'seniorminder.db'` silently pointed an unconfigured
    // box at a database no environment owns. An unset env is a boot failure, and getEnv() (the only
    // caller's source) already throws before we get here.
    return `${env}.db`;
}

/**
 * Get the SeniorMinder user data base directory for the current platform.
 * @returns {string} Absolute path to the SeniorMinder base folder.
 */
export function getUserDataDirectory() {
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA, APP_NAME);
    } else if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    } else {
        // Linux/Pi and other Unix-like systems
        return path.join(os.homedir(), '.config', APP_NAME);
    }
}

/**
 * Get the SeniorMinder data directory (for SQLite databases, etc.).
 * @returns {string} Absolute path to <userData>/data
 */
export function getDataDirectory() {
    return path.join(getUserDataDirectory(), 'data');
}

/**
 * Get the SeniorMinder env directory (for .env file).
 * @returns {string} Absolute path to <userData>/env
 */
export function getEnvDirectory() {
    return path.join(getUserDataDirectory(), 'env');
}

/**
 * Get the path to the .env file.
 * @returns {string} Absolute path to <userData>/env/.env
 */
export function getEnvFilePath() {
    return path.join(getEnvDirectory(), '.env');
}

/**
 * Get the SeniorMinder videos directory.
 * @returns {string} Absolute path to <userData>/videos
 */
export function getVideosDirectory() {
    return path.join(getUserDataDirectory(), 'videos');
}

/**
 * Get the SeniorMinder audios directory, scoped to the current RUN_MODE.
 *
 * Per-RUN_MODE scoping (live, dev, demo, qa, sandbox, etc.) keeps audio
 * files from different run modes from colliding on a dev machine and lets
 * the storage sweep stay scoped to the active mode's own subtree.
 *
 * For seniors running only in live mode this is invisible — everything
 * lands under `audios/live/`.
 *
 * RUN_MODE is read from process.env (normalized by EnvironmentValidator
 * at startup). Falls back to 'unknown' if unset, which should never happen
 * in practice.
 *
 * @returns {string} Absolute path to <userData>/audios/<RUN_MODE>
 */
export function getAudiosDirectory() {
    const runMode = getRunMode();
    return path.join(getUserDataDirectory(), 'audios', runMode);
}

/**
 * Get the SeniorMinder icon directory.
 * @returns {string} Absolute path to <userData>/icon
 */
export function getIconDirectory() {
    return path.join(getUserDataDirectory(), 'icon');
}

/**
 * Get the SeniorMinder logs directory, scoped to the current RUN_MODE.
 *
 * Per-RUN_MODE scoping (live, dev, demo, qa, sandbox, etc.) keeps log
 * files from different run modes from colliding on a dev machine and lets
 * the storage sweep stay scoped to the active mode's own subtree.
 *
 * For seniors running only in live mode this is invisible — everything
 * lands under `logs/live/`.
 *
 * RUN_MODE is read from process.env (normalized by EnvironmentValidator
 * at startup). Falls back to 'unknown' if unset, which should never happen
 * in practice.
 *
 * @returns {string} Absolute path to <userData>/logs/<RUN_MODE>
 */
export function getLogsDirectory() {
    const runMode = getRunMode();
    return path.join(getUserDataDirectory(), 'logs', runMode);
}

/**
 * Get the SeniorMinder temp directory.
 * @returns {string} Absolute path to <userData>/temp
 */
export function getTempDirectory() {
    return path.join(getUserDataDirectory(), 'temp');
}

/**
 * Get the path to the SQLite database file.
 *
 * Filename is derived from SENIORMINDER_ENV:
 *   prod               -> prod.db
 *   dev                -> dev.db
 *   demo               -> demo.db
 *   remote-demo        -> remote-demo.db
 *   sandbox<N>         -> sandbox<N>.db
 *   (unset)            -> seniorminder.db (legacy fallback)
 *
 * @returns {string} Absolute path to <userData>/data/<dbname>
 */
export function getDatabasePath() {
    return path.join(getDataDirectory(), getDatabaseFileName());
}

/**
 * Get just the database filename derived from SENIORMINDER_ENV.
 * @returns {string} Database filename (e.g., 'prod.db', 'demo.db')
 */
export function getDatabaseFileName() {
    return databaseFileNameForEnv(getEnv());
}

/**
 * Get the path to the seniorMinder_config.json file.
 * @returns {string} Absolute path to <userData>/seniorMinder_config.json
 */
export function getConfigFilePath() {
    return path.join(getUserDataDirectory(), 'seniorMinder_config.json');
}

/**
 * Get the SeniorMinder secure directory (for at-rest-encrypted local caches,
 * e.g. the provisioned-API-key cache). Distinct from the data/env dirs so it
 * can carry stricter filesystem permissions (0700) on the device.
 * @returns {string} Absolute path to <userData>/secure
 */
export function getSecureDirectory() {
    return path.join(getUserDataDirectory(), 'secure');
}

/**
 * Get the path to the encrypted last-known-good provisioned API-key cache.
 *
 * Written after a successful online provisioning; read as a fallback when
 * boot-time provisioning can't reach the cloud, so the device comes up armed
 * after a power-blip reboot instead of hanging on the network. See
 * ProvisioningService / SecretsCache.
 *
 * @returns {string} Absolute path to <userData>/secure/provisioned-keys.enc
 */
export function getProvisionedKeysCachePath() {
    return path.join(getSecureDirectory(), 'provisioned-keys.enc');
}