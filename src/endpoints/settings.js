import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from '../constants.js';
import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

const ENABLE_EXTENSIONS = !!getConfigValue('extensions.enabled', true, 'boolean');
const ENABLE_EXTENSIONS_AUTO_UPDATE = !!getConfigValue('extensions.autoUpdate', true, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');

// 10 minutes
const AUTOSAVE_INTERVAL = 10 * 60 * 1000;

/**
 * Map of functions to trigger settings autosave for a user.
 * @type {Map<string, function>}
 */
const AUTOSAVE_FUNCTIONS = new Map();

/**
 * Triggers autosave for a user every 10 minutes.
 * @param {string} handle User handle
 * @returns {void}
 */
function triggerAutoSave(handle) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(() => backupUserSettings(handle, true), AUTOSAVE_INTERVAL);
        AUTOSAVE_FUNCTIONS.set(handle, throttledAutoSave);
    }

    const functionToCall = AUTOSAVE_FUNCTIONS.get(handle);
    if (functionToCall && typeof functionToCall === 'function') {
        functionToCall();
    }
}

/**
 * Reads and parses files from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {string} fileExtension File extension
 * @returns {Array} Parsed files
 */
function readAndParseFromDirectory(directoryPath, fileExtension = '.json') {
    const files = fs
        .readdirSync(directoryPath)
        .filter(x => path.parse(x).ext == fileExtension)
        .sort();

    const parsedFiles = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf-8');
            parsedFiles.push(fileExtension == '.json' ? JSON.parse(file) : file);
        }
        catch {
            // skip
        }
    });

    return parsedFiles;
}

/**
 * Gets a sort function for sorting strings.
 * @param {*} _
 * @returns {(a: string, b: string) => number} Sort function
 */
function sortByName(_) {
    return (a, b) => a.localeCompare(b);
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
}

function readPresetsFromDirectory(directoryPath, options = {}) {
    const {
        sortFunction,
        removeFileExtension = false,
        fileExtension = '.json',
    } = options;

    const files = fs.readdirSync(directoryPath).sort(sortFunction).filter(x => path.parse(x).ext == fileExtension);
    const fileContents = [];
    const fileNames = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf8');
            JSON.parse(file);
            fileContents.push(file);
            fileNames.push(removeFileExtension ? item.replace(/\.[^/.]+$/, '') : item);
        } catch {
            // skip
            console.warn(`${item} is not a valid JSON`);
        }
    });

    return { fileContents, fileNames };
}

async function backupSettings() {
    try {
        const userHandles = await getAllUserHandles();

        for (const handle of userHandles) {
            backupUserSettings(handle, true);
        }
    } catch (err) {
        console.error('Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings file.
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {void}
 */
function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!fs.existsSync(userDirectories.root)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    const sourceFile = path.join(userDirectories.root, SETTINGS_FILE);

    if (preventDuplicates && isDuplicateBackup(handle, sourceFile)) {
        return;
    }

    if (!fs.existsSync(sourceFile)) {
        return;
    }

    fs.copyFileSync(sourceFile, backupFile);
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks if the backup would be a duplicate.
 * @param {string} handle User handle
 * @param {string} sourceFile Source file path
 * @returns {boolean} True if the backup is a duplicate
 */
function isDuplicateBackup(handle, sourceFile) {
    const latestBackup = getLatestBackup(handle);
    if (!latestBackup) {
        return false;
    }
    return areFilesEqual(latestBackup, sourceFile);
}

/**
 * Returns true if the two files are equal.
 * @param {string} file1 File path
 * @param {string} file2 File path
 */
function areFilesEqual(file1, file2) {
    if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
        return false;
    }

    const content1 = fs.readFileSync(file1);
    const content2 = fs.readFileSync(file2);
    return content1.toString() === content2.toString();
}

/**
 * Gets the latest backup file for a user.
 * @param {string} handle User handle
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle) {
    const userDirectories = getUserDirectories(handle);
    const backupFiles = fs.readdirSync(userDirectories.backups)
        .filter(x => x.startsWith(getSettingsBackupFilePrefix(handle)))
        .map(x => ({ name: x, ctime: fs.statSync(path.join(userDirectories.backups, x)).ctimeMs }));
    const latestBackup = backupFiles.sort((a, b) => b.ctime - a.ctime)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

export const router = express.Router();

router.post('/save', function (request, response) {
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        writeFileAtomicSync(pathToSettings, JSON.stringify(request.body, null, 4), 'utf8');
        triggerAutoSave(request.user.profile.handle);
        response.send({ result: 'ok' });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

/**
 * Keys in extension_settings that are metadata and should remain in settings.json.
 * All other keys are considered extension data and will be split into separate files.
 */
const EXTENSION_SETTINGS_METADATA_KEYS = new Set([
    'apiUrl',
    'apiKey',
    'autoConnect',
    'notifyUpdates',
    'disabledExtensions',
]);

const MIGRATION_MARKER = '.migration_complete';

/**
 * Gets a list of all active extension folder names from the filesystem.
 * Scans public/scripts/extensions (excluding third-party) and public/scripts/extensions/third-party.
 * @returns {string[]} Array of strictly cased folder names
 */
function getActiveExtensionFolders() {
    const extFolders = [];
    const baseDir = path.join(process.cwd(), 'public', 'scripts', 'extensions');
    const thirdPartyDir = path.join(baseDir, 'third-party');
    
    if (fs.existsSync(baseDir)) {
        fs.readdirSync(baseDir).forEach(f => {
            if (f === 'third-party') return;
            const fullPath = path.join(baseDir, f);
            if (fs.statSync(fullPath).isDirectory()) {
                extFolders.push(f);
            }
        });
    }
    
    if (fs.existsSync(thirdPartyDir)) {
        fs.readdirSync(thirdPartyDir).forEach(f => {
            const fullPath = path.join(thirdPartyDir, f);
            if (fs.statSync(fullPath).isDirectory()) {
                extFolders.push(f);
            }
        });
    }
    
    return extFolders;
}

/**
 * Finds the actual extension folder name that corresponds to a given key.
 * Tries case-insensitive exact matching first, then fuzzy prefix/substring matching.
 * @param {string} key The key to match
 * @param {string[]} activeFolders Array of valid folder names
 * @returns {string|null} The exact folder name if found, else null
 */
function findMatchingFolder(key, activeFolders) {
    const keyLower = key.toLowerCase();
    for (const folder of activeFolders) {
        if (folder.toLowerCase() === keyLower) return folder;
    }
    
    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(sillytavern|st|extension)/g, '');
    const normKey = normalize(key);
    
    if (normKey.length > 2) {
        for (const folder of activeFolders) {
            const normFolder = normalize(folder);
            if (normKey === normFolder || (normKey.length > 5 && normFolder.length > 5 && (normKey.includes(normFolder) || normFolder.includes(normKey)))) {
                return folder;
            }
        }
    }
    return null;
}

/**
 * Cleans up duplicate/outdated extension data files.
 * Removes files that have a normalized counterpart (spaces→underscores, case-insensitive match)
 * and files ending with '-old' that have a base counterpart.
 * @param {string} extDataDir Path to the extension_data directory
 */
function cleanupDuplicateExtensionFiles(extDataDir) {
    console.log(`[ExtDebug][Cleanup] Starting cleanup scan in: ${extDataDir}`);
    if (!fs.existsSync(extDataDir)) {
        console.log('[ExtDebug][Cleanup] Directory does not exist, skipping');
        return;
    }

    const files = fs.readdirSync(extDataDir).filter(f => f.endsWith('.json'));
    console.log(`[ExtDebug][Cleanup] Found ${files.length} .json files to scan`);
    const fileSet = new Set(files);
    const removed = [];

    for (const file of files) {
        const baseName = path.parse(file).name;

        // Check for space-vs-underscore duplicates (keep the underscore version)
        if (baseName.includes(' ')) {
            const normalizedName = baseName.replace(/\s+/g, '_').toLowerCase();
            const match = files.find(f => path.parse(f).name.toLowerCase() === normalizedName && f !== file);
            if (match && fileSet.has(file)) {
                console.log(`[ExtDebug][Cleanup] Removing space-duplicate: "${file}" (keeping "${match}")`);
                try {
                    fs.unlinkSync(path.join(extDataDir, file));
                    fileSet.delete(file);
                    removed.push(file);
                } catch (err) { console.warn(`[ExtDebug][Cleanup] Failed to delete "${file}":`, err.message); }
                continue;
            }
        }

        // Check for '-old' suffix duplicates (remove the -old version)
        if (baseName.endsWith('-old')) {
            const baseWithoutOld = baseName.slice(0, -4) + '.json';
            if (fileSet.has(baseWithoutOld)) {
                console.log(`[ExtDebug][Cleanup] Removing -old duplicate: "${file}" (base "${baseWithoutOld}" exists)`);
                try {
                    fs.unlinkSync(path.join(extDataDir, file));
                    fileSet.delete(file);
                    removed.push(file);
                } catch (err) { console.warn(`[ExtDebug][Cleanup] Failed to delete "${file}":`, err.message); }
            }
        }
    }

    if (removed.length > 0) {
        console.log(`[ExtDebug][Cleanup] ✅ Removed ${removed.length} duplicate/outdated files: ${removed.join(', ')}`);
    } else {
        console.log('[ExtDebug][Cleanup] ✅ No duplicates found');
    }
}

/**
 * Migrates extension_settings data from settings.json into per-extension files.
 * Uses a marker file to track migration state for crash resilience.
 * Also runs duplicate file cleanup after migration.
 * @param {object} directories User directories
 * @returns {boolean} Whether migration was performed
 */
function migrateExtensionSettings(directories) {
    console.log('[ExtDebug][Migration] ========== START migrateExtensionSettings ==========');
    const pathToSettings = path.join(directories.root, SETTINGS_FILE);
    console.log(`[ExtDebug][Migration] Settings file: ${pathToSettings}`);
    if (!fs.existsSync(pathToSettings)) {
        console.log('[ExtDebug][Migration] Settings file not found, aborting');
        return false;
    }

    let settings;
    try {
        settings = JSON.parse(fs.readFileSync(pathToSettings, 'utf8'));
    } catch (err) {
        console.log('[ExtDebug][Migration] Failed to parse settings.json:', err.message);
        return false;
    }

    const extensionSettings = settings?.extension_settings;
    if (!extensionSettings || typeof extensionSettings !== 'object') {
        console.log('[ExtDebug][Migration] No extension_settings object in settings, aborting');
        return false;
    }

    const allKeys = Object.keys(extensionSettings);
    const metadataKeys = allKeys.filter(k => EXTENSION_SETTINGS_METADATA_KEYS.has(k));
    const keysToMigrate = allKeys.filter(k => !EXTENSION_SETTINGS_METADATA_KEYS.has(k));
    console.log(`[ExtDebug][Migration] extension_settings has ${allKeys.length} keys total`);
    console.log(`[ExtDebug][Migration]   Metadata keys (stay in settings.json): [${metadataKeys.join(', ')}]`);
    console.log(`[ExtDebug][Migration]   Data keys (to migrate): ${keysToMigrate.length} keys`);
    if (keysToMigrate.length > 0) {
        console.log(`[ExtDebug][Migration]   Data keys list: [${keysToMigrate.join(', ')}]`);
    }

    if (keysToMigrate.length === 0) {
        console.log('[ExtDebug][Migration] No data keys to migrate, running cleanup only');
        cleanupDuplicateExtensionFiles(directories.extensionData);
        return false;
    }

    const extDataDir = directories.extensionData;
    const markerPath = path.join(extDataDir, MIGRATION_MARKER);
    console.log(`[ExtDebug][Migration] Extension data dir: ${extDataDir}`);
    console.log(`[ExtDebug][Migration] Migration marker: ${markerPath}`);
    console.log(`[ExtDebug][Migration] Marker exists: ${fs.existsSync(markerPath)}`);

    // Check if migration was already completed via marker file
    if (fs.existsSync(markerPath)) {
        console.log('[ExtDebug][Migration] ⏩ Marker found → already migrated');
        let modified = false;
        let strippedKeys = [];
        for (const key of keysToMigrate) {
            if (extensionSettings[key] !== undefined) {
                delete extensionSettings[key];
                modified = true;
                strippedKeys.push(key);
            }
        }
        if (modified) {
            console.log(`[ExtDebug][Migration] Stripping ${strippedKeys.length} leftover keys from settings.json: [${strippedKeys.join(', ')}]`);
            writeFileAtomicSync(pathToSettings, JSON.stringify(settings, null, 4), 'utf8');
        } else {
            console.log('[ExtDebug][Migration] No leftover keys to strip');
        }
        cleanupDuplicateExtensionFiles(extDataDir);
        console.log('[ExtDebug][Migration] ========== END (already migrated) ==========');
        return false;
    }

    if (!fs.existsSync(extDataDir)) {
        console.log(`[ExtDebug][Migration] Creating extension_data directory: ${extDataDir}`);
        fs.mkdirSync(extDataDir, { recursive: true });
    }

    console.log(`[ExtDebug][Migration] 🚀 Starting fresh migration of ${keysToMigrate.length} extensions...`);

    const activeFolders = getActiveExtensionFolders();

    // Write each extension's data to its own file
    let successCount = 0;
    for (const key of keysToMigrate) {
        try {
            const folderName = findMatchingFolder(key, activeFolders);
            if (!folderName) {
                console.log(`[ExtDebug][Migration]   ⚠ Key "${key}" does not match any active extension folder. Skipping.`);
                continue;
            }
            // USE STRICT FOLDER NAME, NEVER CUSTOM KEY
            const filePath = path.join(extDataDir, `${folderName}.json`);
            const dataSize = JSON.stringify(extensionSettings[key]).length;
            writeFileAtomicSync(filePath, JSON.stringify(extensionSettings[key], null, 4), 'utf8');
            console.log(`[ExtDebug][Migration]   ✓ -> ${folderName}.json (${dataSize} bytes)`);
            successCount++;
        } catch (err) {
            console.error(`[ExtDebug][Migration]   ✗ FAILED to migrate "${key}":`, err.message);
        }
    }

    // Write marker file BEFORE cleaning settings.json to ensure crash resilience
    console.log('[ExtDebug][Migration] Writing migration marker file...');
    writeFileAtomicSync(markerPath, new Date().toISOString(), 'utf8');

    // Remove migrated keys from settings.json
    for (const key of keysToMigrate) {
        delete extensionSettings[key];
    }
    writeFileAtomicSync(pathToSettings, JSON.stringify(settings, null, 4), 'utf8');
    console.log(`[ExtDebug][Migration] Stripped ${keysToMigrate.length} keys from settings.json`);

    console.log(`[ExtDebug][Migration] ✅ Migration complete: ${successCount}/${keysToMigrate.length} extensions migrated successfully`);

    // Clean up duplicates after fresh migration
    cleanupDuplicateExtensionFiles(extDataDir);
    console.log('[ExtDebug][Migration] ========== END (fresh migration done) ==========');
    return true;
}

/**
 * GET /api/settings/extension-settings
 * Reads all per-extension JSON files from extension_data/ directory.
 * Returns a merged object { extName: extData, ... }
 */
router.get('/extension-settings', (request, response) => {
    console.log('[ExtDebug][GET /extension-settings] ========== Loading per-extension data ==========');
    try {
        const extDataDir = request.user.directories.extensionData;
        console.log(`[ExtDebug][GET] Extension data dir: ${extDataDir}`);
        if (!fs.existsSync(extDataDir)) {
            console.log('[ExtDebug][GET] Directory does not exist, returning empty object');
            return response.json({});
        }

        let disabledExtensions = [];
        try {
            const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
            if (fs.existsSync(pathToSettings)) {
                const settingsData = JSON.parse(fs.readFileSync(pathToSettings, 'utf8'));
                if (Array.isArray(settingsData?.extension_settings?.disabledExtensions)) {
                    disabledExtensions = settingsData.extension_settings.disabledExtensions;
                }
            }
        } catch (err) {
            console.error('Error reading disabled extensions list:', err);
        }

        // Build a set of normalized disabled extension names for matching
        // disabledExtensions stores paths like 'third-party/ext-name', but extension_data uses just 'ext-name'
        const disabledSet = new Set(disabledExtensions.map(name => {
            const stripped = name.replace(/^third-party\//, '');
            return stripped;
        }));
        console.log(`[ExtDebug][GET] Disabled extensions (${disabledExtensions.length} raw → ${disabledSet.size} normalized): [${[...disabledSet].join(', ')}]`);

        const result = {};
        const files = fs.readdirSync(extDataDir).filter(f => f.endsWith('.json'));
        let loadedCount = 0;
        let skippedDisabled = [];
        let skippedInvalid = [];
        for (const file of files) {
            try {
                const key = path.parse(file).name;
                // Skip loading disabled extensions to reduce payload
                if (disabledSet.has(key)) {
                    skippedDisabled.push(key);
                    continue;
                }
                const content = fs.readFileSync(path.join(extDataDir, file), 'utf8');
                result[key] = JSON.parse(content);
                loadedCount++;
            } catch {
                skippedInvalid.push(file);
            }
        }
        console.log(`[ExtDebug][GET] ✅ Loaded ${loadedCount}/${files.length} extensions`);
        if (skippedDisabled.length > 0) {
            console.log(`[ExtDebug][GET]   Skipped (disabled): [${skippedDisabled.join(', ')}]`);
        }
        if (skippedInvalid.length > 0) {
            console.log(`[ExtDebug][GET]   Skipped (invalid): [${skippedInvalid.join(', ')}]`);
        }
        console.log(`[ExtDebug][GET] Loaded keys: [${Object.keys(result).join(', ')}]`);
        response.json(result);
    } catch (err) {
        console.error('[ExtDebug][GET] ❌ Error reading extension settings:', err);
        response.sendStatus(500);
    }
});

/**
 * POST /api/settings/extension-settings
 * Saves a single extension's data to a separate JSON file.
 * Body: { key: string, data: any }
 */
router.post('/extension-settings', (request, response) => {
    try {
        const { key, data } = request.body;
        if (!key || typeof key !== 'string') {
            return response.status(400).json({ error: 'Missing or invalid "key"' });
        }

        const extDataDir = request.user.directories.extensionData;
        if (!fs.existsSync(extDataDir)) {
            console.log(`[ExtDebug][POST /extension-settings] Creating directory: ${extDataDir}`);
            fs.mkdirSync(extDataDir, { recursive: true });
        }

        const activeFolders = getActiveExtensionFolders();
        const folderName = findMatchingFolder(key, activeFolders);
        const fileName = folderName || key; // Force file to be named exactly like the folder if it matches one
        
        const filePath = path.join(extDataDir, `${fileName}.json`);
        const dataSize = JSON.stringify(data).length;
        writeFileAtomicSync(filePath, JSON.stringify(data, null, 4), 'utf8');
        console.log(`[ExtDebug][POST /extension-settings] Saved: ${fileName}.json (${dataSize} bytes) [Mapped from key: ${key}]`);
        response.json({ result: 'ok', mappedFile: `${fileName}.json` });
    } catch (err) {
        console.error('[ExtDebug][POST /extension-settings] ❌ Error saving:', err);
        response.sendStatus(500);
    }
});

/**
 * POST /api/settings/extension-settings/delete
 * Deletes a single extension's data file.
 * Body: { key: string }
 */
router.post('/extension-settings/delete', (request, response) => {
    try {
        const { key } = request.body;
        if (!key || typeof key !== 'string' || key.includes('..') || key.includes('/') || key.includes('\\')) {
            return response.status(400).json({ error: 'Missing or invalid "key"' });
        }

        const extDataDir = request.user.directories.extensionData;
        if (fs.existsSync(extDataDir)) {
            const activeFolders = getActiveExtensionFolders();
            const folderName = findMatchingFolder(key, activeFolders) || key;
            const targetFile = `${folderName}.json`;
            const exactPath = path.join(extDataDir, targetFile);

            if (fs.existsSync(exactPath)) {
                fs.unlinkSync(exactPath);
                console.log(`[ExtDebug][POST /extension-settings/delete] Deleted exact match: ${targetFile}`);
            } else {
                console.warn(`[ExtDebug][POST /extension-settings/delete] File not found: ${targetFile}`);
            }
        }
        response.json({ result: 'ok' });
    } catch (err) {
        console.error('Error deleting extension settings:', err);
        response.sendStatus(500);
    }
});

// Wintermute's code
router.post('/get', (request, response) => {
    // Run migration on first load if needed
    console.log('[ExtDebug][POST /get] Settings requested, running migration check...');
    try {
        const migrated = migrateExtensionSettings(request.user.directories);
        console.log(`[ExtDebug][POST /get] Migration result: ${migrated ? 'PERFORMED' : 'skipped (already done or not needed)'}`);
    } catch (err) {
        console.error('[ExtDebug][POST /get] ❌ Extension settings migration failed:', err);
    }

    let settings;
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        settings = fs.readFileSync(pathToSettings, 'utf8');
    } catch (e) {
        return response.sendStatus(500);
    }

    // NovelAI Settings
    const { fileContents: novelai_settings, fileNames: novelai_setting_names }
        = readPresetsFromDirectory(request.user.directories.novelAI_Settings, {
            sortFunction: sortByName(request.user.directories.novelAI_Settings),
            removeFileExtension: true,
        });

    // OpenAI Settings
    const { fileContents: openai_settings, fileNames: openai_setting_names }
        = readPresetsFromDirectory(request.user.directories.openAI_Settings, {
            sortFunction: sortByName(request.user.directories.openAI_Settings), removeFileExtension: true,
        });

    // TextGenerationWebUI Settings
    const { fileContents: textgenerationwebui_presets, fileNames: textgenerationwebui_preset_names }
        = readPresetsFromDirectory(request.user.directories.textGen_Settings, {
            sortFunction: sortByName(request.user.directories.textGen_Settings), removeFileExtension: true,
        });

    //Kobold
    const { fileContents: koboldai_settings, fileNames: koboldai_setting_names }
        = readPresetsFromDirectory(request.user.directories.koboldAI_Settings, {
            sortFunction: sortByName(request.user.directories.koboldAI_Settings), removeFileExtension: true,
        });

    const worldFiles = fs
        .readdirSync(request.user.directories.worlds)
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));
    const world_names = worldFiles.map(item => path.parse(item).name);

    const themes = readAndParseFromDirectory(request.user.directories.themes);
    const movingUIPresets = readAndParseFromDirectory(request.user.directories.movingUI);
    const quickReplyPresets = readAndParseFromDirectory(request.user.directories.quickreplies);

    const instruct = readAndParseFromDirectory(request.user.directories.instruct);
    const context = readAndParseFromDirectory(request.user.directories.context);
    const sysprompt = readAndParseFromDirectory(request.user.directories.sysprompt);
    const reasoning = readAndParseFromDirectory(request.user.directories.reasoning);

    response.send({
        settings,
        koboldai_settings,
        koboldai_setting_names,
        world_names,
        novelai_settings,
        novelai_setting_names,
        openai_settings,
        openai_setting_names,
        textgenerationwebui_presets,
        textgenerationwebui_preset_names,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
        enable_extensions: ENABLE_EXTENSIONS,
        enable_extensions_auto_update: ENABLE_EXTENSIONS_AUTO_UPDATE,
        enable_accounts: ENABLE_ACCOUNTS,
    });
});

router.post('/get-snapshots', async (request, response) => {
    try {
        const snapshots = fs.readdirSync(request.user.directories.backups);
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);
        const userSnapshots = snapshots.filter(x => x.startsWith(userFilesPattern));

        const result = userSnapshots.map(x => {
            const stat = fs.statSync(path.join(request.user.directories.backups, x));
            return { date: stat.ctimeMs, name: x, size: stat.size };
        });

        response.json(result);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/load-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const content = fs.readFileSync(snapshotPath, 'utf8');

        response.send(content);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/make-snapshot', async (request, response) => {
    try {
        backupUserSettings(request.user.profile.handle, false);
        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/restore-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        console.log('[ExtDebug][RESTORE] ========== Restoring snapshot ==========');
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        console.log(`[ExtDebug][RESTORE] Replacing settings from snapshot: ${snapshotPath}`);
        fs.rmSync(pathToSettings, { force: true });
        fs.copyFileSync(snapshotPath, pathToSettings);

        // Remove migration marker so extension_data gets re-synced from the restored snapshot
        const extDataDir = request.user.directories.extensionData;
        const markerPath = path.join(extDataDir, MIGRATION_MARKER);
        if (fs.existsSync(markerPath)) {
            console.log('[ExtDebug][RESTORE] Removing migration marker to force re-migration');
            fs.unlinkSync(markerPath);
        } else {
            console.log('[ExtDebug][RESTORE] No migration marker found');
        }

        // Re-run migration to sync extension_data with the restored settings.json
        console.log('[ExtDebug][RESTORE] Re-running migration to sync extension_data...');
        try {
            migrateExtensionSettings(request.user.directories);
        } catch (err) {
            console.error('[ExtDebug][RESTORE] ❌ Re-migration failed:', err);
        }
        console.log('[ExtDebug][RESTORE] ========== Restore complete ==========');

        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

/**
 * Initializes the settings endpoint
 */
export async function init() {
    await backupSettings();
}
