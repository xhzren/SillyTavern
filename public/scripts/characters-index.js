/**
 * Character Index Cache — Frontend
 *
 * Startup flow (when performance.characterIndexCache = true in config.yaml):
 *
 *   1. POST /api/characters/index/status  — check if index exists.
 *   2a. Exists  → load page 1 from POST /api/characters/index/page.
 *   2b. Missing → notify user → POST /api/characters/index/build → load page 1.
 *   3. Any failure → return false → caller falls back to getCharacters().
 *
 * After the initial load, pagination and sort changes call loadCharacterIndexPage()
 * directly instead of triggering getCharacters().
 *
 * @module characters-index
 */

/* global toastr */

export { initCharacterIndex, loadCharacterIndexAll };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Entry point called from script.js during startup (before getCharacters).
 *
 * @param {object} deps
 * @param {Array}    deps.characters        Global characters[] (mutated in-place)
 * @param {Function} deps.getRequestHeaders Standard fetch headers
 * @param {Function} deps.humanizedDateTime Human-readable timestamp helper
 * @param {Function} deps.DOMPurify        Sanitiser
 * @returns {Promise<boolean>}
 *   true  → loaded from index, skip getCharacters()
 *   false → fall back to getCharacters()
 */
async function initCharacterIndex({ characters, getRequestHeaders, humanizedDateTime, DOMPurify }) {
    // Store injected deps for later page-change calls
    _deps = { characters, getRequestHeaders, humanizedDateTime, DOMPurify };

    try {
        const statusRes = await fetch('/api/characters/index/status', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!statusRes.ok) return false;

        const status = await statusRes.json();
        if (!status.enabled) return false;

        globalThis.characterIndexEnabled = true;

        if (status.exists && status.count > 0) {
            console.log(`[CharacterIndex] Found index: ${status.count} chars (built: ${status.builtAt})`);
            return await loadCharacterIndexAll();
        }

        return await _buildAndLoad();
    } catch (err) {
        console.error('[CharacterIndex] init error:', err);
        return false;
    }
}

/**
 * Loads the full lightweight character index into the global characters[].
 * @returns {Promise<boolean>}
 */
async function loadCharacterIndexAll() {
    if (!_deps) return false;

    try {
        const res = await fetch('/api/characters/index/data', {
            method: 'POST',
            headers: _deps.getRequestHeaders(),
        });
        if (!res.ok) {
            console.warn('[CharacterIndex] data request failed:', res.status);
            return false;
        }

        const charactersData = await res.json();
        if (!Array.isArray(charactersData)) {
            console.warn('[CharacterIndex] data response malformed');
            return false;
        }

        // Populate characters[]
        _populateCharacters(charactersData);

        return true;
    } catch (err) {
        console.error('[CharacterIndex] data load error:', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Injected dependencies (set once in initCharacterIndex) */
let _deps = null;

/** Triggers build endpoint with user notifications, then loads page 1. */
async function _buildAndLoad() {
    const toast = toastr.info(
        '正在初始化角色卡索引，首次启动需要扫描所有角色卡，请稍候…',
        '角色卡索引',
        { timeOut: 0, extendedTimeOut: 0, closeButton: false, progressBar: false },
    );

    try {
        const buildRes = await fetch('/api/characters/index/build', {
            method: 'POST',
            headers: _deps.getRequestHeaders(),
        });
        toastr.clear(toast);

        if (!buildRes.ok) {
            let msg = `HTTP ${buildRes.status}`;
            try { msg = (await buildRes.json()).message ?? msg; } catch { /* ignore */ }
            toastr.error(`角色卡索引构建失败（${msg}），已切换为普通加载模式。`, '角色卡索引');
            return false;
        }

        const result = await buildRes.json();
        toastr.success(`角色卡索引构建完成，共 ${result.count} 张角色卡。`, '角色卡索引', { timeOut: 4000 });

        return await loadCharacterIndexAll();
    } catch (err) {
        toastr.clear(toast);
        toastr.error('角色卡索引构建时发生异常，已切换为普通加载模式。', '角色卡索引');
        console.error('[CharacterIndex] build error:', err);
        return false;
    }
}

/**
 * Fills target array with the given data.
 * Sets shallow=true so unshallowCharacter() fetches full data on select.
 * @param {object[]} data
 * @param {object[]} [target] The array to populate, defaults to global characters
 */
function _populateCharacters(data, target) {
    const { characters, humanizedDateTime, DOMPurify } = _deps;
    const dest = target || characters;
    dest.splice(0, dest.length);
    for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        const name = DOMPurify.sanitize(entry.name ?? '');
        // avatar: use the stored value, or derive from name as fallback
        const avatar = entry.avatar || `${entry.name}.png`;
        dest[i] = {
            avatar,
            name,
            creator: entry.creator ?? '',
            character_version: entry.character_version ?? '',
            fav: !!entry.fav,
            date_added: entry.date_added ?? 0,
            date_last_chat: entry.date_last_chat ?? 0,
            chat: `${name} - ${humanizedDateTime()}`,
            chat_size: 0,
            data_size: 0,
            tags: [],
            shallow: true,
            data: {
                name,
                creator: entry.creator ?? '',
                character_version: entry.character_version ?? '',
                creator_notes: '',
                tags: [],
                extensions: { fav: !!entry.fav },
            },
        };
    }
}
