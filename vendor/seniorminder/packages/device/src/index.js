// Device layer exports.

// WHISPER_MODEL device-class resolver (Pi=tiny, desktop=base) — the single source of truth.
export { resolveWhisperModel, whisperModelForClass, isPiDeviceClass } from './WhisperModel.js';

// Export class and singleton
export { DeviceConfigManager, configManager } from './DeviceConfigManager.js';

// Export convenience functions
export { 
    clearCache,
    getDeviceToken,
    setDeviceToken,
    getUserInfo,
    setUserInfo,
    getDeviceFingerprint,
    resetConfig,
    main,
    // Directory getters
    getAppDataDirectory,
    getAudioDirectory,
    getVideoDirectory,
    getDataDirectory,
    getLogsDirectory,
    getTempDirectory,
    ensureDirectory,
    // The SYNCHRONOUS twin. Exported beside its async namesake deliberately — see its header: a sync
    // caller reaching for `ensureDirectory` gets a pending promise and an ENOENT on the next write.
    ensureDirectorySync
} from './DeviceConfigManager.js';