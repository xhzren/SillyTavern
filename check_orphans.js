import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, 'data', 'default-user', 'extension_data');
const extDir = path.join(__dirname, 'public', 'scripts', 'extensions');

const CORE_KEYS = new Set([
    'expressionOverrides', 'memory', 'note', 'caption', 'expressions',
    'connectionManager', 'dice', 'regex', 'regex_presets', 'character_allowed_regex',
    'preset_allowed_regex', 'tts', 'sd', 'chromadb', 'translate', 'objective',
    'quickReply', 'randomizer', 'speech_recognition', 'rvc', 'hypebot', 'vectors',
    'variables', 'attachments', 'character_attachments', 'disabled_attachments',
    'gallery', 'characterIndex', 'cfg', 'customModels', 'engram', 'mobile_context',
    'regexBinding_scriptId', 'st_usage_tracker_local', '__userscripts', 'extension',
    'extension-zerxz-lib', 'SillyTavernExtension-JsRunner'
]);

// Read all JS logic to scan for keys
function getAllJsFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getAllJsFiles(filePath));
        } else if (file.endsWith('.js') || file.endsWith('.json')) {
            results.push(filePath);
        }
    }
    return results;
}

const jsFiles = getAllJsFiles(extDir);
const fileContents = jsFiles.map(f => fs.readFileSync(f, 'utf8'));

const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));

console.log("Analyzing extension_data files...");
const report = { core: [], empty_potential_orphan: [], large_orphan: [], in_use: [] };

for (const file of files) {
    const key = path.parse(file).name;
    const size = fs.statSync(path.join(dataDir, file)).size;
    const content = fs.readFileSync(path.join(dataDir, file), 'utf8').trim();

    if (CORE_KEYS.has(key)) {
        report.core.push(file);
        continue;
    }

    // Check if the key string is referenced anywhere in the extension source code
    let isReferenced = false;
    for (const text of fileContents) {
        if (text.includes("'" + key + "'") || text.includes('"' + key + '"') || text.includes('`' + key + '`')) {
            isReferenced = true;
            break;
        }
        // Also check if the key matches the folder name exactly
        if (text.includes('"name": "' + key + '"') || text.includes('"name": "third-party/' + key + '"')) { 
            isReferenced = true; 
            break; 
        }
    }

    if (isReferenced) {
        report.in_use.push(file);
    } else {
        if (content === '{}' || size <= 2) {
            report.empty_potential_orphan.push(file);
        } else {
            report.large_orphan.push({ file, size });
        }
    }
}

let out = "=== CORE SETTINGS (Kept) ===\n";
out += report.core.join(", ") + "\n\n";

out += "=== POTENTIALLY IN USE (Referenced in code) ===\n";
out += report.in_use.join(", ") + "\n\n";

out += "=== EMPTY ORPHANS (2 bytes, never used) ===\n";
out += report.empty_potential_orphan.join(", ") + "\n\n";

out += "=== LARGE ORPHANS (Has data, but completely unreferenced in code) ===\n";
report.large_orphan.forEach(x => out += `${x.file} (${(x.size / 1024).toFixed(2)} KB)\n`);

fs.writeFileSync('report.txt', out);
console.log("Report saved to report.txt");

