/**
 * Character Index Cache - Backend Endpoints
 *
 * Provides a pre-built JSON index of all character cards for fast startup
 * and server-side pagination, avoiding repeated PNG parsing.
 *
 * Index file location:  <user_data_root>/characters_index.json
 *
 * Enable via config.yaml:
 *   performance:
 *     characterIndexCache: true
 *
 * Index record format (per character):
 *   {
 *     avatar:            string   — PNG filename (identifier)
 *     name:              string   — Display name from data.name
 *     creator:           string   — From data.creator
 *     character_version: string   — From data.character_version
 *     fav:               boolean  — Favourite status
 *     date_added:        number   — PNG file mtime (ms since epoch)
 *     date_last_chat:    number   — From character data (ms), 0 if unknown
 *   }
 */

import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';
import yaml from 'yaml';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { getConfigValue } from '../util.js';
import { processCharacter } from './characters.js';
import { parse } from '../character-card-parser.js';
import { CharXParser } from '../charx.js';

export const router = express.Router();

/** Filename of the index cache inside the user's data root */
const INDEX_FILE_NAME = 'characters_index.json';

/** Number of PNGs processed per batch (avoid blocking the event loop) */
const BUILD_BATCH_SIZE = 50;

/** Schema version — bump to invalidate existing caches */
const INDEX_VERSION = 2;

/** Supported sort fields and their comparators */
const SORT_COMPARATORS = {
    'a-z': (a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }),
    'z-a': (a, b) => (b.name ?? '').localeCompare(a.name ?? '', undefined, { sensitivity: 'base' }),
    'date_added': (a, b) => (a.date_added ?? 0) - (b.date_added ?? 0),
    'date_added_asc': (a, b) => (b.date_added ?? 0) - (a.date_added ?? 0),
    'date_last_chat': (a, b) => (a.date_last_chat ?? 0) - (b.date_last_chat ?? 0),
    'date_last_chat_asc': (a, b) => (b.date_last_chat ?? 0) - (a.date_last_chat ?? 0),
    'fav': (a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0),
};

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string}
 */
function getIndexPath(directories) {
    return path.join(directories.root, INDEX_FILE_NAME);
}

/**
 * Reads and parses the index file, returning the characters array.
 * Returns null if the file doesn't exist or is malformed.
 * @param {string} indexPath
 * @returns {Promise<object[]|null>}
 */
async function readIndexCharacters(indexPath) {
    if (!fs.existsSync(indexPath)) return null;
    try {
        const raw = await fsPromises.readFile(indexPath, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data.characters) ? data.characters : null;
    } catch {
        return null;
    }
}

/**
 * @returns {boolean}
 */
export function isCharacterIndexEnabled() {
    return !!getConfigValue('performance.characterIndexCache', false, 'boolean');
}

/**
 * POST /api/characters/index/status
 * Returns { exists, count, builtAt, enabled }
 */
router.post('/status', async function (request, response) {
    try {
        const indexPath = getIndexPath(request.user.directories);
        const exists = fs.existsSync(indexPath);
        let count = 0;
        let builtAt = null;

        if (exists) {
            try {
                const raw = await fsPromises.readFile(indexPath, 'utf8');
                const data = JSON.parse(raw);
                count = Array.isArray(data.characters) ? data.characters.length : 0;
                builtAt = data.built_at ?? null;
            } catch { /* ignore */ }
        }

        return response.json({ exists, count, builtAt, enabled: isCharacterIndexEnabled() });
    } catch (err) {
        console.error('[CharacterIndex] status error:', err);
        return response.status(500).json({ error: true });
    }
});

/**
 * POST /api/characters/index/build
 *
 * Scans all PNG files in batches, extracts metadata, and saves the index.
 * Saved fields per character:
 *   avatar, name, creator, character_version, fav, date_added, date_last_chat
 *
 * Returns { success, count }.
 */
router.post('/build', async function (request, response) {
    try {
        const dirs = request.user.directories;
        const files = fs.readdirSync(dirs.characters);
        const pngFiles = files.filter(f => f.endsWith('.png'));
        const total = pngFiles.length;

        console.log(`[CharacterIndex] Building index for ${total} character(s)…`);

        const allCharacters = [];

        for (let i = 0; i < pngFiles.length; i += BUILD_BATCH_SIZE) {
            const batch = pngFiles.slice(i, i + BUILD_BATCH_SIZE);
            const results = await Promise.all(
                batch.map(async (file) => {
                    const char = await processCharacter(file, dirs, { shallow: true });
                    if (!char || !char.name) return null;

                    // Get file modification time as date_added
                    let date_added = 0;
                    try {
                        const stat = await fsPromises.stat(path.join(dirs.characters, file));
                        date_added = stat.mtimeMs;
                    } catch { /* ignore */ }

                    return {
                        avatar: char.avatar,
                        name: char.data?.name ?? char.name ?? '',
                        creator: char.data?.creator ?? '',
                        character_version: char.data?.character_version ?? '',
                        fav: !!(char.fav || char.data?.extensions?.fav),
                        date_added: date_added ? new Date(date_added).toISOString() : new Date(0).toISOString(),
                        date_last_chat: char.date_last_chat ? new Date(char.date_last_chat).toISOString() : new Date(0).toISOString(),
                    };
                }),
            );

            allCharacters.push(...results.filter(Boolean));
            console.log(`[CharacterIndex] Processed ${Math.min(i + BUILD_BATCH_SIZE, total)}/${total}`);
        }

        const indexData = {
            version: INDEX_VERSION,
            built_at: new Date().toISOString(),
            count: allCharacters.length,
            characters: allCharacters,
        };

        const indexPath = getIndexPath(dirs);
        await fsPromises.writeFile(indexPath, JSON.stringify(indexData), 'utf8');

        console.log(`[CharacterIndex] Index built: ${allCharacters.length} characters → ${indexPath}`);
        return response.json({ success: true, count: allCharacters.length });
    } catch (err) {
        console.error('[CharacterIndex] build error:', err);
        return response.status(500).json({ error: true, message: String(err) });
    }
});

/**
 * POST /api/characters/index/data
 * Returns the full characters array from the index file.
 */
router.post('/data', async function (request, response) {
    try {
        const indexPath = getIndexPath(request.user.directories);
        const characters = await readIndexCharacters(indexPath);
        if (!characters) {
            return response.status(404).json({ error: true, message: 'Index not found or malformed' });
        }
        return response.json(characters);
    } catch (err) {
        console.error('[CharacterIndex] data error:', err);
        return response.status(500).json({ error: true, message: String(err) });
    }
});

/**
 * POST /api/characters/index/page
 *
 * Returns a paginated, sorted slice of the index.
 *
 * Request body:
 *   {
 *     page:     number   (1-based, default: 1)
 *     pageSize: number   (default: 50)
 *     sortBy:   string   (default: 'a-z')
 *                        Supported: 'a-z', 'z-a', 'date_added', 'date_added_asc',
 *                                   'date_last_chat', 'date_last_chat_asc', 'fav'
 *   }
 *
 * Response:
 *   {
 *     characters: object[],
 *     total:      number,      — total characters in index
 *     page:       number,
 *     pageSize:   number,
 *     totalPages: number,
 *   }
 */
router.post('/page', async function (request, response) {
    try {
        const indexPath = getIndexPath(request.user.directories);
        const allCharacters = await readIndexCharacters(indexPath);

        if (!allCharacters) {
            return response.status(404).json({ error: true, message: 'Index not found. Call /build first.' });
        }

        const page = Math.max(1, parseInt(request.body.page ?? 1, 10) || 1);
        const pageSize = Math.max(1, Math.min(1000, parseInt(request.body.pageSize ?? 50, 10) || 50));
        const sortBy = String(request.body.sortBy ?? 'a-z');

        // Sort
        const sorted = [...allCharacters];
        const comparator = SORT_COMPARATORS[sortBy] ?? SORT_COMPARATORS['a-z'];
        sorted.sort(comparator);

        // Paginate
        const total = sorted.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * pageSize;
        const characters = sorted.slice(start, start + pageSize);

        return response.json({ characters, total, page: safePage, pageSize, totalPages });
    } catch (err) {
        console.error('[CharacterIndex] page error:', err);
        return response.status(500).json({ error: true, message: String(err) });
    }
});

/**
 * POST /api/characters/index/delete
 * Deletes the index file, forcing a rebuild on next /build call.
 */
router.post('/delete', async function (request, response) {
    try {
        const indexPath = getIndexPath(request.user.directories);
        if (fs.existsSync(indexPath)) {
            await fsPromises.unlink(indexPath);
            console.log('[CharacterIndex] Index deleted:', indexPath);
            return response.json({ success: true });
        }
        return response.json({ success: false, message: 'Index file not found' });
    } catch (err) {
        console.error('[CharacterIndex] delete error:', err);
        return response.status(500).json({ error: true });
    }
});

/**
 * POST /api/characters/index/peek
 *
 * Accepts a character file upload (PNG, JSON, YAML, CharX) and returns its
 * name and character_version WITHOUT importing/persisting anything.
 *
 * Used by the frontend to detect duplicates before applying an import strategy.
 *
 * Request: multipart/form-data with field `avatar` (file) and `file_type` (string)
 * Response: { name: string, character_version: string } or { error: true }
 */
router.post('/peek', async function (request, response) {
    if (!request.file) return response.status(400).json({ error: true, message: 'No file uploaded' });

    const uploadPath = path.join(request.file.destination, request.file.filename);
    const format = String(request.body?.file_type ?? '').toLowerCase();

    /** Cleanup helper — always remove temp file */
    const cleanup = () => {
        try { if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch { /* ignore */ }
    };

    try {
        let name = '';
        let character_version = '';

        if (format === 'png') {
            // Use PNG metadata parser
            const rawJson = await parse(uploadPath, 'png').catch(() => null);
            cleanup();
            if (!rawJson) return response.status(400).json({ error: true, message: 'Could not parse PNG' });
            const data = JSON.parse(rawJson);
            name = data?.data?.name ?? data?.name ?? '';
            character_version = data?.data?.character_version ?? data?.character_version ?? '';
        } else if (format === 'charx') {
            // CharX is a ZIP archive — use CharXParser to extract card.json
            const data = (await fsPromises.readFile(uploadPath)).buffer;
            cleanup();
            const charxResult = await new CharXParser(data).parse();
            name = charxResult.card?.data?.name ?? charxResult.card?.name ?? '';
            character_version = charxResult.card?.data?.character_version ?? charxResult.card?.character_version ?? '';
        } else if (format === 'json') {
            const raw = await fsPromises.readFile(uploadPath, 'utf8');
            cleanup();
            const parsed = JSON.parse(raw);
            name = parsed?.data?.name ?? parsed?.name ?? parsed?.ch_name ?? parsed?.char_name ?? '';
            character_version = parsed?.data?.character_version ?? parsed?.character_version ?? '';
        } else if (format === 'yaml' || format === 'yml') {
            const raw = await fsPromises.readFile(uploadPath, 'utf8');
            cleanup();
            const parsed = yaml.parse(raw) ?? {};
            name = parsed?.data?.name ?? parsed?.name ?? parsed?.ch_name ?? '';
            character_version = parsed?.data?.character_version ?? parsed?.character_version ?? '';
        } else {
            cleanup();
            return response.status(400).json({ error: true, message: `Unsupported format for peek: ${format}` });
        }

        name = sanitize(String(name)).trim();
        character_version = String(character_version ?? '').trim();

        console.log(`[CharacterIndex] Peek: name="${name}" version="${character_version}"`);
        return response.json({ name, character_version });
    } catch (err) {
        cleanup();
        console.error('[CharacterIndex] peek error:', err);
        return response.status(500).json({ error: true, message: String(err) });
    }
});


/**
 * POST /api/characters/index/favorites
 * Returns an array of all favorited characters from the index.
 */
router.post('/favorites', async function (request, response) {
    try {
        const indexPath = getIndexPath(request.user.directories);
        const allCharacters = await readIndexCharacters(indexPath);

        if (!allCharacters) {
            return response.json([]);
        }

        const favs = allCharacters.filter(x => x.fav === true);
        return response.json(favs);
    } catch (err) {
        console.error('[CharacterIndex] favorites error:', err);
        return response.json([]);
    }
});

let indexWriteMutex = Promise.resolve();

/**
 * Safely update the characters index file, using a mutex to prevent concurrent read/writes.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {function(object[]): boolean} modifierFn Returns true if changes were made
 */
async function modifyIndexFile(directories, modifierFn) {
    const indexPath = getIndexPath(directories);
    if (!fs.existsSync(indexPath)) return;

    // Queue this operation behind any ongoing writes to prevent EPERM on Windows
    /** @type {() => void} */
    const unlock = await new Promise(resolveOuter => {
        const next = indexWriteMutex.then(() => new Promise((resolveInner) => resolveOuter(() => resolveInner(undefined))));
        indexWriteMutex = next.catch(() => {}); // Ensure errors don't stall the queue
    });

    try {
        const raw = await fsPromises.readFile(indexPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.characters)) {
            if (modifierFn(data.characters)) {
                writeFileAtomicSync(indexPath, JSON.stringify(data, null, 2), 'utf8');
            }
        }
    } catch (e) {
        console.error('[CharacterIndex] Failed to modify index file:', e);
    } finally {
        unlock();
    }
}

/**
 * Synchronously adds or updates a character in the index file
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatarUrl
 */
export async function addOrUpdateCharacterInIndex(directories, avatarUrl) {
    if (!isCharacterIndexEnabled()) return;
    try {
        const char = await processCharacter(avatarUrl, directories, { shallow: true });
        if (!char || !char.name) return;
        
        const avatarPath = path.join(directories.characters, String(avatarUrl));
        const date_added = fs.existsSync(avatarPath) ? fs.statSync(avatarPath).mtimeMs : Date.now();
        
        const indexRecord = {
            avatar: avatarUrl,
            name: char.name,
            creator: char.data?.creator ?? char.creator ?? '',
            character_version: char.data?.character_version ?? char.character_version ?? '',
            fav: !!(char.fav || char.data?.extensions?.fav),
            date_added: date_added ? new Date(date_added).toISOString() : new Date(0).toISOString(),
            date_last_chat: char.date_last_chat ? new Date(char.date_last_chat).toISOString() : new Date(0).toISOString(),
        };

        await modifyIndexFile(directories, (characters) => {
            const idx = characters.findIndex(c => c.avatar === avatarUrl);
            if (idx >= 0) characters[idx] = indexRecord;
            else characters.push(indexRecord);
            return true;
        });
    } catch (err) {
        console.error('[CharacterIndex] addOrUpdate error:', err);
    }
}

/**
 * Splices a deleted character's avatar out of the index file array
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatarUrl
 */
export async function removeCharacterFromIndex(directories, avatarUrl) {
    if (!isCharacterIndexEnabled()) return;
    await modifyIndexFile(directories, (characters) => {
        const idx = characters.findIndex(c => c.avatar === avatarUrl);
        if (idx >= 0) {
            characters.splice(idx, 1);
            return true;
        }
        return false;
    });
}

/**
 * Sets date_last_chat in the index file array when chat logs are saved
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatarUrl
 * @param {number|string} dateTimestamp
 */
export async function updateCharacterChatDateInIndex(directories, avatarUrl, dateTimestamp) {
    if (!isCharacterIndexEnabled()) return;
    await modifyIndexFile(directories, (characters) => {
        const idx = characters.findIndex(c => c.avatar === avatarUrl);
        if (idx >= 0) {
            characters[idx].date_last_chat = new Date(dateTimestamp).toISOString();
            return true;
        }
        return false;
    });
}
