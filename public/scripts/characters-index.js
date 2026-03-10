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
 * After the initial load, pagination and sort changes call loadCharacterIndexAll()
 * directly instead of triggering getCharacters().
 *
 * Settings are stored under extension_settings.characterIndex and persisted
 * via saveSettingsDebounced().
 *
 * @module characters-index
 */

/* global toastr */

import { renderTemplateAsync } from './templates.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { extension_settings } from './extensions.js';
import { saveSettingsDebounced, characters, getCharacters } from '../script.js';

export { initCharacterIndex, loadCharacterIndexAll };

// ---------------------------------------------------------------------------
// Settings defaults & helpers
// ---------------------------------------------------------------------------

/** @returns {import('./extensions.js').extension_settings['characterIndex']} */
function getSettings() {
    if (!extension_settings.characterIndex) {
        extension_settings.characterIndex = {
            rebuildOnStartup: false,
            importDuplicateStrategy: 'overwrite',
            debug: false,
        };
    }
    return extension_settings.characterIndex;
}

/**
 * Debug-mode log helper.
 * @param {string} msg
 * @param {...any} data
 */
function dbgLog(msg, ...data) {
    if (!getSettings().debug) return;
    console.log(`[CharacterIndex][DEBUG] ${msg}`, ...data);
    toastr.info(msg, '角色索引 Debug', { timeOut: 3000 });
}

/**
 * Debug-mode warn helper.
 * @param {string} msg
 * @param {...any} data
 */
function dbgWarn(msg, ...data) {
    if (!getSettings().debug) return;
    console.warn(`[CharacterIndex][DEBUG] ${msg}`, ...data);
}

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
        dbgLog('Index status received', status);

        const settings = getSettings();

        // If rebuildOnStartup is requested, delete and rebuild
        if (settings.rebuildOnStartup) {
            dbgLog('rebuildOnStartup is ON — forcing rebuild');
            toastr.info('配置为每次启动重建索引，正在重建…', '角色卡索引', { timeOut: 4000 });
            await fetch('/api/characters/index/delete', { method: 'POST', headers: getRequestHeaders() });
            return await _buildAndLoad();
        }

        if (status.exists && status.count > 0) {
            console.log(`[CharacterIndex] Found index: ${status.count} chars (built: ${status.builtAt})`);
            dbgLog(`Index found with ${status.count} chars, built at ${status.builtAt}`);
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
            dbgWarn('Data request failed', res.status);
            return false;
        }

        const charactersData = await res.json();
        if (!Array.isArray(charactersData)) {
            console.warn('[CharacterIndex] data response malformed');
            dbgWarn('Data response malformed', charactersData);
            return false;
        }

        dbgLog(`Loaded ${charactersData.length} characters from index`, charactersData);

        // Populate characters[]
        _populateCharacters(charactersData);

        return true;
    } catch (err) {
        console.error('[CharacterIndex] data load error:', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Settings popup
// ---------------------------------------------------------------------------

/**
 * Opens the character management settings popup and wires up all interactions.
 */
export async function openCharacterIndexSettings() {
    const template = $(await renderTemplateAsync('characterIndexSettings'));
    const settings = getSettings();

    // --- Populate current values ---
    template.find('#ci_rebuild_startup').prop('checked', !!settings.rebuildOnStartup);
    template.find('#ci_debug_mode').prop('checked', !!settings.debug);
    template.find(`input[name="ci_import_strategy"][value="${settings.importDuplicateStrategy}"]`).prop('checked', true);

    // --- Fetch & display index status ---
    _updateStatusLine(template);

    // --- Wire up: Rebuild button ---
    template.find('#ci_action_rebuild').on('click', async function () {
        const $btn = $(this);
        $btn.prop('disabled', true);
        const $status = template.find('#ci_index_status');
        $status.text('正在重建索引，请稍候…');

        dbgLog('Manual rebuild triggered');

        try {
            // Delete existing index first
            await fetch('/api/characters/index/delete', {
                method: 'POST',
                headers: _deps?.getRequestHeaders() ?? _getHeaders(),
            });
            dbgLog('Old index deleted');

            // Build new index
            const buildRes = await fetch('/api/characters/index/build', {
                method: 'POST',
                headers: _deps?.getRequestHeaders() ?? _getHeaders(),
            });

            if (!buildRes.ok) {
                const err = await buildRes.json().catch(() => ({}));
                const msg = err.message ?? `HTTP ${buildRes.status}`;
                toastr.error(`索引重建失败: ${msg}`, '角色索引');
                dbgWarn('Build failed', err);
                $status.text(`重建失败: ${msg}`);
            } else {
                const result = await buildRes.json();
                toastr.success(`索引重建完成，共 ${result.count} 张角色卡。`, '角色索引', { timeOut: 4000 });
                dbgLog('Build succeeded', result);
                $status.text(`索引重建完成: 共 ${result.count} 张角色卡`);

                await loadCharacterIndexAll();
            }
        } catch (err) {
            toastr.error('索引重建时发生异常。', '角色索引');
            console.error('[CharacterIndex] Manual rebuild error:', err);
            $status.text('重建时发生异常，请检查控制台');
        } finally {
            $btn.prop('disabled', false);
        }
    });

    // --- Wire up: Rebuild on startup checkbox ---
    template.find('#ci_rebuild_startup').on('change', function () {
        settings.rebuildOnStartup = !!$(this).prop('checked');
        saveSettingsDebounced();
        dbgLog('rebuildOnStartup changed', settings.rebuildOnStartup);
    });

    // --- Wire up: Debug mode checkbox ---
    template.find('#ci_debug_mode').on('change', function () {
        settings.debug = !!$(this).prop('checked');
        saveSettingsDebounced();
        console.log(`[CharacterIndex] Debug mode: ${settings.debug}`);
        if (settings.debug) toastr.info('Debug 模式已开启', '角色索引', { timeOut: 2000 });
    });

    // --- Wire up: Import duplicate strategy ---
    template.find('input[name="ci_import_strategy"]').on('change', function () {
        settings.importDuplicateStrategy = $(this).val();
        saveSettingsDebounced();
        dbgLog('importDuplicateStrategy changed', settings.importDuplicateStrategy);
    });

    // --- Wire up: Scan duplicates button ---
    template.find('#ci_scan_duplicates_btn').on('click', async function () {
        // Close the settings popup to make way for the scan and subsequent delete popup
        const $popup = template.closest('.popup');
        if ($popup.length) {
            $popup.find('.popup-button-close, .popup-button-cancel, .popup-button-ok').first().trigger('click');
        }
        await _scanDuplicatesAndCleanup(template);
    });

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        wide: false,
        large: false,
        allowVerticalScrolling: true,
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Injected dependencies (set once in initCharacterIndex) */
let _deps = null;

/** Fallback: build request headers without deps. */
function _getHeaders() {
    return { 'Content-Type': 'application/json' };
}

/**
 * Fetches index status and updates the status line in the popup template.
 * @param {JQuery} template
 */
async function _updateStatusLine(template) {
    const $status = template.find('#ci_index_status');
    try {
        const res = await fetch('/api/characters/index/status', {
            method: 'POST',
            headers: _deps?.getRequestHeaders() ?? _getHeaders(),
        });
        if (!res.ok) { $status.text('无法获取索引状态'); return; }

        const status = await res.json();
        if (!status.enabled) {
            $status.text('索引缓存功能未启用 (config.yaml: performance.characterIndexCache)');
            return;
        }
        if (!status.exists || status.count === 0) {
            $status.text('索引文件不存在，点击"重建缓存"初始化');
        } else {
            const builtAt = status.builtAt ? new Date(status.builtAt).toLocaleString() : '未知';
            $status.text(`当前索引: ${status.count} 张角色卡，构建于 ${builtAt}`);
        }
        dbgLog('Status line data', status);
    } catch (err) {
        $status.text('索引状态查询失败');
        console.error('[CharacterIndex] status check error:', err);
    }
}

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
        dbgLog('Auto-build succeeded', result);

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

// ---------------------------------------------------------------------------
// Import Duplicate Strategy
// ---------------------------------------------------------------------------

/**
 * Intercepts `importCharacter` to apply the configured duplicate strategy.
 *
 * Called from `importCharacter()` in `script.js` when `characterIndexEnabled` is true.
 *
 * Returns a (possibly modified) `{file, options}` descriptor:
 *   - `file`:    The File object to upload (may be the same or a renamed blob)
 *   - `options`: Options to pass to `importCharacter` (e.g. `{ preserveFileName }`)
 *   - `skip`:    If true, the caller should abort the import (no-op after pre-delete)
 *   - `preDeleted`: avatar key of a character already deleted before import
 *
 * @param {File} file              The file the user is importing
 * @param {object} characters      Reference to the global `characters[]` array
 * @param {Function} getRequestHeaders
 * @param {Function} deleteCharacterFn  `deleteCharacter(avatar, opts)` from script.js
 * @returns {Promise<{file: File, options: object, preDeleted?: string}|null>}
 *   null → abort import silently (error already shown)
 */
export async function handleImportDuplicate(file, characters, getRequestHeaders, deleteCharacterFn) {
    const settings = getSettings();
    const strategy = settings.importDuplicateStrategy ?? 'overwrite';

    dbgLog(`handleImportDuplicate: strategy="${strategy}", file="${file.name}"`);

    // ---------- 1. Peek at the uploaded file to get name + version ----------
    let peeked = null;
    try {
        peeked = await _peekCharacterFile(file, getRequestHeaders);
    } catch (err) {
        console.error('[CharacterIndex] peek failed, falling back to normal import', err);
        return { file, options: {} };   // fall back — don't block import
    }

    if (!peeked || !peeked.name) {
        dbgLog('Peek returned no name — skipping duplicate check');
        return { file, options: {} };
    }

    dbgLog('Peek result', peeked);

    // ---------- 2. Find existing character(s) with the same display name ----------
    const existingChars = characters.filter(c => {
        const cName = (c.data?.name ?? c.name ?? '').trim().toLowerCase();
        return cName === peeked.name.trim().toLowerCase();
    });

    if (existingChars.length === 0) {
        dbgLog(`No duplicate found for "${peeked.name}" — proceeding normally`);
        return { file, options: {} };
    }

    dbgLog(`Found ${existingChars.length} duplicate(s) for "${peeked.name}"`, existingChars);

    // ---------- 3. Apply strategy ----------

    switch (strategy) {

        // ── OVERWRITE ────────────────────────────────────────────────────────
        case 'overwrite': {
            const target = existingChars[0];
            const preserveFileName = target.avatar.replace(/\.png$/i, '');
            dbgLog(`[overwrite] Replacing avatar="${target.avatar}"`, target);
            await _deleteCharacterWorldBook(target, getRequestHeaders);
            toastr.info(`覆盖更新: ${target.name}`, '角色导入策略', { timeOut: 3000 });
            return { file, options: { preserveFileName } };
        }

        // ── APPEND VERSION NUMBER ────────────────────────────────────────────
        case 'append_version': {
            return await _applyAppendVersionLogic(peeked, characters, file, getRequestHeaders);
        }

        // ── DELETE & UPDATE ──────────────────────────────────────────────────
        case 'delete_update': {
            // 找出所有相关角色卡：完全相同名字的 + 带版本号/编号后缀的
            const relatedChars = _findRelatedChars(peeked.name, characters);
            dbgLog(`[delete_update] Found ${relatedChars.length} related char(s)`, relatedChars);

            // 弹出选择框让用户决定删除哪些
            const selectionResult = await _showDeleteSelectionPopup(peeked, relatedChars, getRequestHeaders);

            if (selectionResult === null || !selectionResult.selected || selectionResult.selected.length === 0) {
                // 用户取消 → 调用完整的版本号追加策略（包括同版本自动覆盖逐辑）
                dbgLog('[delete_update] User cancelled — falling back to full append_version logic');
                return await _applyAppendVersionLogic(peeked, characters, file, getRequestHeaders);
            }

            const { selected: selectedAvatars, deleteChats } = selectionResult;

            // 用户确认 → 直接调用后端API删除，跳过ST界面确认弹窗（用户已在我们的弹窗中确认）
            let deletedCount = 0;
            for (const avatar of selectedAvatars) {
                const charEntry = relatedChars.find(c => c.avatar === avatar);
                if (charEntry) {
                    await _deleteCharacterWorldBook(charEntry, getRequestHeaders);
                }
                try {
                    const res = await fetch('/api/characters/delete', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ avatar_url: avatar, delete_chats: deleteChats }),
                        cache: 'no-cache',
                    });
                    if (res.ok) {
                        deletedCount++;
                        dbgLog(`[delete_update] Backend deleted "${avatar}"`);
                    } else {
                        console.warn(`[CharacterIndex] delete_update: backend delete failed for "${avatar}": HTTP ${res.status}`);
                    }
                } catch (err) {
                    console.error(`[CharacterIndex] delete_update: network error deleting "${avatar}"`, err);
                    toastr.error(`删除失败: ${avatar} — ${err?.message ?? err}`, '角色导入策略');
                }
            }

            if (deletedCount > 0) {
                toastr.info(`已删除 ${deletedCount} 张旧角色卡，正在导入新版本…`, '角色导入策略', { timeOut: 3000 });
            }
            return { file, options: {} };
        }

        default:
            dbgLog(`Unknown strategy "${strategy}", proceeding normally`);
            return { file, options: {} };
    }
}

// ---------------------------------------------------------------------------
// Strategy helpers
// ---------------------------------------------------------------------------

/**
 * Calls `/api/characters/index/peek` with the given file.
 * Returns `{ name, character_version }` or throws on error.
 * @param {File} file
 * @param {Function} getRequestHeaders
 */
async function _peekCharacterFile(file, getRequestHeaders) {
    const ext = (file.name.match(/\.(\w+)$/) ?? [])[1]?.toLowerCase() ?? '';
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', ext);

    const res = await fetch('/api/characters/index/peek', {
        method: 'POST',
        body: formData,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? `HTTP ${res.status}`);
    }

    return await res.json();
}

/**
 * Shared helper — full "append version" logic:
 *   1. Compute the target name (Name_version or Name_N if no version).
 *   2. If a character with that exact name already exists, overwrite it.
 *   3. Otherwise import fresh and rename via postImportRename.
 *
 * @param {{ name: string, character_version: string }} peeked
 * @param {object[]} characters   Global characters[]
 * @param {File}     file
 * @param {Function} getRequestHeaders
 */
async function _applyAppendVersionLogic(peeked, characters, file, getRequestHeaders) {
    const version = (peeked.character_version ?? '').trim();
    const newName = version
        ? `${peeked.name}_${version}`
        : _getNextSuffixName(peeked.name, characters);

    dbgLog(`[append_version] version="${version}", newName="${newName}"`);

    // 如果已有完全相同版本的角色卡 → 直接覆盖
    const sameVersionChar = characters.find(c => {
        const cName = (c.data?.name ?? c.name ?? '').trim().toLowerCase();
        return cName === newName.trim().toLowerCase();
    });
    if (sameVersionChar) {
        dbgLog(`[append_version] Same versioned name "${newName}" exists — overwriting`, sameVersionChar);
        const preserveFileName = sameVersionChar.avatar.replace(/\.png$/i, '');
        await _deleteCharacterWorldBook(sameVersionChar, getRequestHeaders);
        toastr.info(`已存在相同版本，覆盖更新: ${sameVersionChar.name}`, '角色导入策略', { timeOut: 3000 });
        return { file, options: { preserveFileName } };
    }

    toastr.info(`版本号重命名: ${newName}`, '角色导入策略', { timeOut: 3000 });
    return { file, options: {}, postImportRename: newName };
}

/**
 * If the character has a `data.extensions.world` entry, deletes the world book file.
 * @param {object} charEntry  Entry from `characters[]`
 * @param {Function} getRequestHeaders
 */
async function _deleteCharacterWorldBook(charEntry, getRequestHeaders) {
    // character_world is stored in data.extensions.world (from the loaded shallow entry)
    // or in the character object itself
    const worldName = charEntry?.data?.extensions?.world ?? charEntry?.world ?? '';
    if (!worldName) {
        dbgLog('No world book associated with this character');
        return;
    }

    dbgLog(`Deleting world book: "${worldName}"`);
    try {
        const res = await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: worldName }),
        });
        if (res.ok) {
            dbgLog(`World book "${worldName}" deleted`);
        } else {
            console.warn(`[CharacterIndex] World book delete failed: HTTP ${res.status}`);
        }
    } catch (err) {
        console.error('[CharacterIndex] World book delete error:', err);
    }
}

/**
 * Returns the next available name for a character by appending an incrementing suffix.
 * E.g. if "Alice_1" exists, returns "Alice_2"; if none exist, returns "Alice_1".
 * @param {string} baseName
 * @param {object[]} characters
 * @returns {string}
 */
function _getNextSuffixName(baseName, characters) {
    const lowerBase = baseName.trim().toLowerCase();
    // Collect all existing suffix numbers
    const existingNumbers = characters
        .map(c => (c.data?.name ?? c.name ?? '').trim())
        .filter(n => {
            const lower = n.toLowerCase();
            return lower.startsWith(lowerBase + '_') || lower === lowerBase;
        })
        .map(n => {
            const suffix = n.slice(baseName.length + 1);  // part after "Name_"
            const num = parseInt(suffix, 10);
            return isNaN(num) ? 0 : num;
        });

    const maxNum = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;
    return `${baseName}_${maxNum + 1}`;
}

/**
 * Returns a new File object with a different base name but same extension.
 * @param {File} file
 * @param {string} newBaseName   Without extension
 * @returns {File}
 */
function _renameFile(file, newBaseName) {
    const ext = (file.name.match(/\.(\w+)$/) ?? ['', 'png'])[0]; // includes the dot
    const newName = `${newBaseName}${ext}`;
    return new File([file], newName, { type: file.type });
}

/**
 * Finds ALL characters that are "related" to a given base name:
 *   - Exact name match
 *   - Name matches `{baseName}_{anything}` pattern (suffix variants: versioned or numeric)
 *
 * @param {string} baseName        The original character name (from peeked data)
 * @param {object[]} characters    Global characters[]
 * @returns {object[]}             Matching character entries
 */
function _findRelatedChars(baseName, characters) {
    const lowerBase = baseName.trim().toLowerCase();
    return characters.filter(c => {
        const cName = (c.data?.name ?? c.name ?? '').trim().toLowerCase();
        return cName === lowerBase || cName.startsWith(lowerBase + '_');
    });
}

/**
 * Global scanner logic to search the entire array for related duplicates,
 * group them, and present a batch delete popup.
 */
async function _scanDuplicatesAndCleanup(template) {
    if (!characters || characters.length === 0) return;

    dbgLog('[BatchScan] Starting full library duplicate scan');

    // 1. Sort by name length ascending to ensure base forms (eName) come before variants (Name_v2)
    const sorted = [...characters]
        .map(c => ({ orig: c, name: (c.data?.name ?? c.name ?? '').trim().toLowerCase() }))
        .sort((a,b) => a.name.length - b.name.length);

    const processedAvatars = new Set();
    const allDuplicatesList = [];

    // Temporary overlay to block clicks during scan (can be fast, but good for UX)
    const scanOverlay = document.createElement('div');
    scanOverlay.style.cssText = 'position:fixed;inset:0;z-index:9999999;background:var(--SmartThemeBlurTintColor, rgba(0,0,0,0.6));backdrop-filter:blur(3px);display:flex;flex-direction:column;gap:15px;align-items:center;justify-content:center;color:white;font-size:1.5em;';
    scanOverlay.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:2em;"></i><span>正在扫描角色库...</span>';
    document.body.appendChild(scanOverlay);

    await new Promise(r => setTimeout(r, 50)); // let UI yield to draw overlay

    for (const item of sorted) {
        if (processedAvatars.has(item.orig.avatar)) continue;

        // Treat this item as a base, find all related
        const baseName = item.orig.data?.name ?? item.orig.name ?? '';
        if (!baseName) continue;

        const related = _findRelatedChars(baseName, characters);
        related.forEach(r => processedAvatars.add(r.avatar));

        if (related.length > 1) {
            allDuplicatesList.push(...related);
        }
    }

    scanOverlay.remove();
    dbgLog(`[BatchScan] Found ${allDuplicatesList.length} total duplicate variants across groups.`);

    if (allDuplicatesList.length === 0) {
        toastr.info('未发现任何关联重复的角色卡。', '角色扫描');
        return;
    }

    // Pass to popup with isBatchCleanup = true
    const selectionResult = await _showDeleteSelectionPopup(null, allDuplicatesList, _deps?.getRequestHeaders ?? (() => ({})), true);

    if (!selectionResult || !selectionResult.selected || selectionResult.selected.length === 0) {
        dbgLog('[BatchScan] User cancelled or selected nothing');
        return;
    }

    const { selected: selectedAvatars, deleteChats } = selectionResult;

    // User confirmed deletion
    let deletedCount = 0;
    for (const avatar of selectedAvatars) {
        const charEntry = characters.find(c => c.avatar === avatar);
        if (charEntry) {
            await _deleteCharacterWorldBook(charEntry, _deps?.getRequestHeaders ?? (() => ({})));
        }
        try {
            const res = await fetch('/api/characters/delete', {
                method: 'POST',
                headers: _deps?.getRequestHeaders ? _deps.getRequestHeaders() : _getHeaders(),
                body: JSON.stringify({ avatar_url: avatar, delete_chats: deleteChats }),
                cache: 'no-cache',
            });
            if (res.ok) {
                deletedCount++;
                dbgLog(`[BatchScan] Backend deleted "${avatar}"`);
                if (typeof globalThis.eventSource !== 'undefined' && globalThis.event_types?.CHARACTER_DELETED) {
                    globalThis.eventSource.emit(globalThis.event_types.CHARACTER_DELETED, { avatar: avatar });
                }
            }
        } catch (err) {
            console.error(`[BatchScan] delete failed for "${avatar}"`, err);
        }
    }

    if (deletedCount > 0) {
        toastr.success(`已清理 ${deletedCount} 张重复卡片。理论上索引已自动同步。`, '角色清理', { timeOut: 4000 });

        // Render updated list natively
        await getCharacters();
        
        // Re-render the stats on the dialog if it's still open
        if (template) {
            _updateStatusLine(template);
        }
    }
}

/**
 * Shows a popup listing all related characters with checkboxes.
 * User can select which ones to delete.
 *
 * @param {{ name: string, character_version: string }} peeked   Peeked import file info (or null if batch cleanup)
 * @param {object[]} relatedChars   Characters to display
 * @param {Function} getRequestHeaders
 * @param {boolean}  isBatchCleanup Whether this is a global scan instead of an import collision
 * @returns {Promise<{selected: string[], deleteChats: boolean}|null>}
 *   - Object containing string[] avatar filenames, and boolean for deleteChats
 *   - null  → user cancelled
 */
async function _showDeleteSelectionPopup(peeked, relatedChars, getRequestHeaders, isBatchCleanup = false) {
    return new Promise(resolve => {
        // Build the card grid HTML
        const cardRows = relatedChars.map(c => {
            const charName = c.data?.name ?? c.name ?? c.avatar;
            const version  = c.data?.character_version ?? c.character_version ?? '';
            const avatar   = c.avatar ?? '';
            // Thumbnail via ST's thumbnail endpoint
            const thumbUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
            const itemId   = `ci_del_${CSS.escape(avatar)}`;

            return `
<label class="ci-delete-card" for="${itemId}">
    <input type="checkbox" id="${itemId}" class="ci-delete-check" data-avatar="${avatar}">
    <div class="ci-delete-thumb-wrap">
        <img class="ci-delete-thumb" src="${thumbUrl}" onerror="this.src='/img/ai4.png'" alt="">
    </div>
    <div class="ci-delete-info">
        <span class="ci-delete-name">${charName}</span>
        ${version ? `<small class="ci-delete-version opacity50p">v${version}</small>` : ''}
        <small class="ci-delete-avatar opacity50p">${avatar}</small>
    </div>
</label>`;
        }).join('');

        let headerText, cancelText, confirmText;
        if (isBatchCleanup) {
            headerText = `以下是扫描出的所有**相关（重复）角色卡**，请勾选需要彻底删除的旧版本：`;
            cancelText = `取消`;
            confirmText = `删除选中`;
        } else {
            const importedVer = (peeked?.character_version ?? '').trim();
            const importedVerLabel = importedVer ? ` (v${importedVer})` : '';
            headerText = `正在导入 <b>${peeked?.name}${importedVerLabel}</b>，以下已存在相关角色卡，请勾选需要删除的：`;
            cancelText = `取消（改为追加命名）`;
            confirmText = `删除选中并导入`;
        }

        const html = `
<div class="ci-delete-popup">
    <style>
        .ci-delete-popup { display:flex; flex-direction:column; gap:10px; min-width:320px; max-width:480px; }
        .ci-delete-header { font-size:0.95em; line-height:1.5; }
        .ci-delete-grid   { display:flex; flex-direction:column; gap:6px; max-height:380px; overflow-y:auto; padding-right:4px; }
        .ci-delete-card   {
            display:flex; align-items:center; gap:10px;
            padding:8px 10px; border-radius:6px; cursor:pointer;
            border:1px solid rgba(128,128,128,0.25);
            transition:background 0.15s;
        }
        .ci-delete-card:hover { background:rgba(255,255,255,0.06); }
        .ci-delete-card:has(.ci-delete-check:checked) { border-color:var(--SmartThemeQuoteColor,#888); background:rgba(255,255,255,0.07); }
        .ci-delete-check  { flex-shrink:0; width:16px; height:16px; cursor:pointer; }
        .ci-delete-thumb-wrap { flex-shrink:0; }
        .ci-delete-thumb  { width:48px; height:48px; object-fit:cover; border-radius:4px; }
        .ci-delete-info   { display:flex; flex-direction:column; gap:2px; flex:1; overflow:hidden; }
        .ci-delete-name   { font-weight:600; font-size:0.9em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .ci-delete-version, .ci-delete-avatar { font-size:0.78em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .ci-delete-actions{ display:flex; gap:10px; justify-content:center; margin-top:8px; flex-wrap:wrap; }
        .ci-delete-actions .menu_button { min-width:140px; text-align:center; padding:6px 14px; }
    </style>

    <div class="ci-delete-header flex-container alignitemscenter flexwrap" style="justify-content:space-between; gap:10px;">
        <div style="flex:1;">${headerText}</div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px;">
            <button id="ci_del_toggle_all" class="menu_button menu_button_icon" style="padding:4px 10px; font-size:0.85em; min-width:auto;">
                <i class="fa-solid fa-check-double"></i> <span>全选</span>
            </button>
            <label style="font-size:0.85em; cursor:pointer;" title="如果勾选，删除角色卡时将同时删除与其关联的所有聊天记录">
                <input type="checkbox" id="ci_del_chats_checkbox"> 删除关联对话
            </label>
        </div>
    </div>

    <div class="ci-delete-grid">
        ${cardRows}
    </div>

    <div class="ci-delete-actions">
        <button id="ci_del_cancel" class="menu_button">${cancelText}</button>
        <button id="ci_del_confirm" class="menu_button" style="background:rgba(180,60,60,0.4);border-color:rgba(180,60,60,0.7);">${confirmText}</button>
    </div>
</div>`;

        // Inject into a floating overlay (outside callGenericPopup to avoid nesting issues)
        const overlay = document.createElement('div');
        overlay.id = 'ci_delete_overlay';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:1000000',
            'display:flex', 'align-items:center', 'justify-content:center',
            'background:rgba(0,0,0,0.65)', 'backdrop-filter:blur(3px)',
        ].join(';');

        const dialog = document.createElement('div');
        dialog.style.cssText = [
            'background:var(--SmartThemeBlurTintColor,#1e1e2e)',
            'border:1px solid rgba(128,128,128,0.35)',
            'border-radius:10px', 'padding:20px', 'max-width:520px', 'width:90vw',
            'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
        ].join(';');
        dialog.innerHTML = html;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        function cleanup() {
            overlay.remove();
        }

        dialog.querySelector('#ci_del_cancel').addEventListener('click', () => {
            cleanup();
            resolve(null);
        });

        let allSelected = false;
        dialog.querySelector('#ci_del_toggle_all').addEventListener('click', () => {
            allSelected = !allSelected;
            const checkboxes = dialog.querySelectorAll('.ci-delete-check');
            checkboxes.forEach(cb => { 
                /** @type {HTMLInputElement} */(cb).checked = allSelected; 
            });
            /** @type {HTMLElement} */(dialog.querySelector('#ci_del_toggle_all span')).innerText = allSelected ? '取消全选' : '全选';
        });

        dialog.querySelector('#ci_del_confirm').addEventListener('click', () => {
            const checks = Array.from(dialog.querySelectorAll('.ci-delete-check:checked'));
            const selected = checks.map(cb => cb.getAttribute('data-avatar')).filter(Boolean);
            const deleteChats = /** @type {HTMLInputElement} */(dialog.querySelector('#ci_del_chats_checkbox')).checked;
            cleanup();
            resolve({ selected, deleteChats });
        });

        // Click outside to cancel
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                cleanup();
                resolve(null);
            }
        });
    });
}
