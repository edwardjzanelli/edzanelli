// DeviceConfigManager.js

import { promises as fs, mkdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import readline from 'readline';

import {
    getUserDataDirectory,
    getDataDirectory as getPathsDataDirectory,
    getAudiosDirectory,
    getVideosDirectory,
    getConfigFilePath as getPathsConfigFilePath,
    getLogsDirectory as getPathsLogsDirectory,
    getTempDirectory as getPathsTempDirectory
} from '@seniorminder/common/Paths';

export class DeviceConfigManager {
    constructor() {
        this.configFile = this.getConfigFilePath();
        this.cache = null;
    }

    async configFileExists() {
        try {
            await fs.access(this.configFile);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get the base application data directory
     * @returns {string} Path to SeniorMinder app data folder
     */
    getAppDataDirectory() {
        return getUserDataDirectory();
    }

    getConfigFilePath() {
        return getPathsConfigFilePath();
    }

    getAudioDirectory() {
        return getAudiosDirectory();
    }

    getVideoDirectory() {
        return getVideosDirectory();
    }

    getDataDirectory() {
        return getPathsDataDirectory();
    }

    getLogsDirectory() {
        return getPathsLogsDirectory();
    }

    getTempDirectory() {
        return getPathsTempDirectory();
    }

    /**
     * Ensure a directory exists, creating it if necessary
     * @param {string} dirPath - Directory path to ensure exists
     */
    async ensureDirectory(dirPath) {
        try {
            await fs.access(dirPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await fs.mkdir(dirPath, { recursive: true });
            } else {
                throw error;
            }
        }
    }

    clearCache() {
        this.cache = null;
    }

    async ensureDirectoryExists() {
        const dir = path.dirname(this.configFile);
        await this.ensureDirectory(dir);
    }

    async readConfig() {
        if (this.cache) return this.cache;
        try {
            const data = await fs.readFile(this.configFile, 'utf8');
            this.cache = JSON.parse(data);
            return this.cache;
        } catch (err) {
            if (err.code === 'ENOENT') return {};
            throw err;
        }
    }

    async writeConfig(newConfig) {
        await this.ensureDirectoryExists();
        await fs.writeFile(this.configFile, JSON.stringify(newConfig, null, 2), 'utf8');
        this.cache = newConfig;
    }

    generateUUID() {
        return crypto.randomUUID();
    }

    getPlatformCode() {
        if (process.env.ALEXA_SKILL_ID || process.env.AWS_LAMBDA_FUNCTION_NAME) return 'ALEXA';
        const platform = os.platform();
        switch (platform) {
            case 'win32': return 'WIN10';
            case 'darwin': return 'MACOS';
            case 'linux': return 'LINUX';
            default: return 'OTHER';
        }
    }

    getDeviceFingerprint() {
        const platform = os.platform();
        const arch = os.arch();
        const hostname = os.hostname();
        const cpus = os.cpus();

        const fingerprintData = {
            platform,
            arch,
            hostname,
            cpuModel: cpus[0]?.model || 'unknown',
            cpuCount: cpus.length,
            totalMem: os.totalmem(),
            alexaSkillId: process.env.ALEXA_SKILL_ID,
            awsRegion: process.env.AWS_REGION
        };

        const fingerprintString = JSON.stringify(fingerprintData);
        return crypto.createHash('sha256').update(fingerprintString).digest('hex');
    }

    async getDeviceToken() {
        const config = await this.readConfig();
        return config.deviceToken || null;
    }

    async setDeviceToken(deviceToken = null) {
        const config = await this.readConfig();
        config.deviceToken = deviceToken || this.generateUUID();
        await this.writeConfig(config);
        return config.deviceToken;
    }

    async getUserInfo() {
        const config = await this.readConfig();
        return {
            firstName: config.firstName || null,
            personId: config.personId || null,
            deviceToken: config.deviceToken || null
        };
    }

    async setUserInfo({ firstName, personId }) {
        // Ed's ruling F (2026-10-21): the same rule as setupDevice. The first name is required and stored trimmed.
        if (!firstName || String(firstName).trim().length === 0) {
            throw new Error('First name is required');
        }
        const config = await this.readConfig();
        config.firstName = String(firstName).trim();
        config.personId = personId;
        await this.writeConfig(config);
    }

    async getUserInput() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        return new Promise((resolve) => {
            rl.question('', (answer) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    }

    async setupDevice() {
        try {
            console.log('\n' + '='.repeat(60));
            console.log('SeniorMinder Device Setup');
            console.log('='.repeat(60));
            console.log('Platform:', this.getPlatformCode());
            console.log('Storage path:', this.configFile);
            console.log('');

            // Check if already configured
            const existing = await this.readConfig();
            if (existing.deviceToken && existing.personId) {
                console.log('⚠️  Device already configured:');
                console.log(`   Person ID: ${existing.personId}`);
                console.log(`   First Name: ${existing.firstName || 'Not set'}`);
                console.log(`   Device Token: ${existing.deviceToken}`);
                console.log('\nType "RECONFIGURE" to overwrite or press Enter to cancel:');
                
                const confirm = await this.getUserInput();
                if (confirm !== 'RECONFIGURE') {
                    console.log('Setup cancelled.');
                    return existing;
                }
            }

            // Prompt for person ID
            console.log('\nEnter Person ID (number):');
            const personIdInput = await this.getUserInput();
            const personId = parseInt(personIdInput, 10);
            
            if (!personId || isNaN(personId)) {
                throw new Error('Invalid Person ID - must be a number');
            }

            // Prompt for first name
            console.log('\nEnter First Name:');
            const firstName = await this.getUserInput();
            
            if (!firstName || firstName.trim().length === 0) {
                throw new Error('First name is required');
            }

            // Generate simple UUID device token
            const deviceToken = this.generateUUID();

            // Write config
            const config = {
                deviceToken: deviceToken,
                personId: personId,
                firstName: firstName.trim()
            };

            await this.writeConfig(config);

            console.log('\n✅ Device configured successfully!');
            console.log('='.repeat(60));
            console.log(`Person ID: ${personId}`);
            console.log(`First Name: ${firstName}`);
            console.log(`Device Token: ${deviceToken}`);
            console.log(`Config File: ${this.configFile}`);
            console.log('='.repeat(60));
            console.log('\n⚠️  IMPORTANT: Use this SQL to register in database:');
            console.log('\nINSERT INTO secure_data.device (person_id, device_token, device_name, device_type_id, os_platform_id, runtime_environment_id, browser_type_id, is_active)');
            console.log(`VALUES (${personId}, '${deviceToken}', '${firstName}''s Device', 1, 1, 1, 1, true);\n`);

            return config;

        } catch (error) {
            console.error('Setup failed:', error.message);
            throw error;
        }
    }

    async resetConfig() {
        try {
            await fs.unlink(this.configFile);
            this.cache = null;
            console.log('Config file reset successfully');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    async main() {
        return await this.setupDevice();
    }
}

// Export individual functions
export const clearCache = () => configManager.clearCache();
export const getDeviceToken = () => configManager.getDeviceToken();
export const setDeviceToken = (deviceToken) => configManager.setDeviceToken(deviceToken);
export const getUserInfo = () => configManager.getUserInfo();
export const setUserInfo = (userInfo) => configManager.setUserInfo(userInfo);
export const getDeviceFingerprint = () => configManager.getDeviceFingerprint();
export const resetConfig = () => configManager.resetConfig();
export const main = () => configManager.main();

// NEW: Directory getters
export const getAppDataDirectory = () => configManager.getAppDataDirectory();
export const getAudioDirectory = () => configManager.getAudioDirectory();
export const getVideoDirectory = () => configManager.getVideoDirectory();
export const getDataDirectory = () => configManager.getDataDirectory();
export const getLogsDirectory = () => configManager.getLogsDirectory();
export const getTempDirectory = () => configManager.getTempDirectory();
export const ensureDirectory = (dirPath) => configManager.ensureDirectory(dirPath);

/**
 * ── THE SYNCHRONOUS TWIN (Ed, field dev1 2026-09-01) — AND WHY IT HAD TO EXIST ─────────────────────
 *
 * `ensureDirectory` above is ASYNC (fs.promises). Calling it from a SYNCHRONOUS function does not fail
 * loudly — it returns a pending promise, execution continues, and the very next `writeFileSync` lands
 * before the mkdir has run:
 *
 *     22:35:34.386  ERROR [EpisodeEvidence:openEpisode] Could not write an episode directory
 *                   (non-fatal): ENOENT ... 'episodes/2026-09-01/wake_help-153534-8rrj1a/trip.wav'
 *
 * A microtask later the mkdir COMPLETES, so the directory appears — empty. That is the whole of the
 * 09-01 evidence loss: three episode directories created, correctly named, containing nothing, while
 * the ring held the audio and the harvest had already been paid for. The symptom is maximally
 * misleading: the directory's existence is proof the code ran, and it is also proof of the bug.
 *
 * ⚠ THE FIX IS NOT "await IT" AT THE CALL SITES, AND THAT IS THE POINT OF ADDING A TWIN RATHER THAN A
 * LINT RULE. All three callers are synchronous BY DESIGN — `openEpisode` carves perishable audio out of
 * a 90-second ring and must not yield, and `_retainIdleScanClip` sits on the wake path. Making them
 * async to satisfy a directory call would put an await into exactly the two places that must not have
 * one. They need a synchronous mkdir; there simply was not one, so they reached for the async name
 * because it was the only name.
 *
 * Exported beside its async twin ON PURPOSE: the next sync caller sees both and picks, instead of
 * finding one and assuming.
 *
 * @param {string} dirPath
 * @returns {void}
 */
export const ensureDirectorySync = (dirPath) => { mkdirSync(dirPath, { recursive: true }); };

// Singleton instance
export const configManager = new DeviceConfigManager();

// Run main if executed directly
import { fileURLToPath } from 'url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    await configManager.main().catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
    });
}