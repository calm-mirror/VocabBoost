'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const APP_DIR = __dirname;
const IS_SMOKE = process.argv.includes('--smoke-test');
const IS_SELF_TEST = process.argv.includes('--self-test');
const SMOKE_DIR = process.env.VB_SMOKE_DIR || APP_DIR;
const SMOKE_OUT = process.env.VB_SMOKE_OUT || path.join(SMOKE_DIR, 'smoke-result.json');

let DATA_DIR = '';
let DATA_FILE = '';
let LOG_FILE = '';
let mainWindow = null;
let lastData = null;
let lastBackupAt = 0;
let wordsCache = null;
let configCache = null;

app.setName('VocabBoost');
if (process.platform === 'win32') app.setAppUserModelId('com.vocabboost.app');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 便携版：把 Chromium 缓存和用户数据都放在 exe 旁边的 VocabBoost-Data，
// 换电脑时连同文件夹一起拷走即可。
if (app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    try {
        const portableData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'VocabBoost-Data');
        fs.mkdirSync(portableData, { recursive: true });
        app.setPath('userData', portableData);
    } catch (_) { /* 只读位置则回退到默认目录 */ }
}

// ---------------------------------------------------------------- 基础工具

function initPaths() {
    if (!app.isPackaged) {
        DATA_DIR = APP_DIR;
    } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
        DATA_DIR = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'VocabBoost-Data');
    } else {
        DATA_DIR = app.getPath('userData');
    }
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (err) {
        DATA_DIR = app.getPath('userData');
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    DATA_FILE = path.join(DATA_DIR, 'english-trainer-data.json');
    LOG_FILE = path.join(DATA_DIR, 'vocabboost.log');
}

function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.map((x) => {
        if (x instanceof Error) return x.stack || x.message;
        if (typeof x === 'object') {
            try { return JSON.stringify(x); } catch (_) { return String(x); }
        }
        return String(x);
    }).join(' ')}\n`;
    try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) { /* ignore */ }
    try { process.stdout.write(line); } catch (_) { /* ignore */ }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function readJsonSync(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        log('readJsonSync failed:', file, err);
        return fallback;
    }
}

function isValidData(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data)
        && data.users && typeof data.users === 'object' && !Array.isArray(data.users);
}

function saveDataToDisk(data) {
    if (!isValidData(data)) throw new Error('数据格式不正确');
    const text = JSON.stringify(data, null, 2);
    if (text.length > 30 * 1024 * 1024) throw new Error('数据文件过大');
    if (fs.existsSync(DATA_FILE) && Date.now() - lastBackupAt > 10 * 60 * 1000) {
        try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (_) { /* ignore */ }
        lastBackupAt = Date.now();
    }
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    try {
        fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
        fs.writeFileSync(DATA_FILE, text, 'utf8');
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
    lastData = data;
    return true;
}

function readDataFile() {
    if (!fs.existsSync(DATA_FILE)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!isValidData(data)) throw new Error('users 字段缺失');
        lastData = data;
        return data;
    } catch (err) {
        log('数据文件损坏:', err);
        try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch (_) { /* ignore */ }
        return null;
    }
}

function openExternalSafe(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            shell.openExternal(u.toString());
            return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

// ---------------------------------------------------------------- 窗口

function createMainWindow(options = {}) {
    const show = options.show !== false;
    const win = new BrowserWindow({
        width: options.width || 1280,
        height: options.height || 860,
        minWidth: 1024,
        minHeight: 700,
        show: false,
        title: 'VocabBoost · 词力引擎',
        backgroundColor: '#F4F1EA',
        icon: path.join(APP_DIR, 'assets', 'icon.png'),
        skipTaskbar: !!options.skipTaskbar,
        webPreferences: {
            preload: path.join(APP_DIR, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            backgroundThrottling: false
        }
    });

    mainWindow = win;
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(APP_DIR, 'english-trainer.html'));

    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        log(`renderer[${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('did-finish-load', () => log('did-finish-load'));
    win.webContents.on('did-fail-load', (event, code, description, url) => log('did-fail-load', code, description, url));
    win.webContents.on('preload-error', (event, preloadPath, error) => log('preload-error', preloadPath, error));
    win.webContents.on('render-process-gone', (event, details) => log('render-process-gone', details));

    win.once('ready-to-show', () => {
        if (show) win.show();
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternalSafe(url);
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file:')) {
            event.preventDefault();
            openExternalSafe(url);
        }
    });

    win.on('closed', () => {
        if (mainWindow === win) mainWindow = null;
    });

    return win;
}

// ---------------------------------------------------------------- IPC：数据

async function loadWords() {
    if (wordsCache) return wordsCache;
    const file = path.join(APP_DIR, 'words.json');
    const raw = await fsp.readFile(file, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('words.json 词库为空');
    wordsCache = arr;
    return arr;
}

function loadConfig() {
    if (configCache) return configCache;
    const base = readJsonSync(path.join(APP_DIR, 'config.json'), {});
    // 允许用户直接编辑 VocabBoost-Data\使用说明.txt，不需要重新打包。
    try {
        const helpPath = path.join(DATA_DIR, '使用说明.txt');
        if (!fs.existsSync(helpPath) && base.helpText) {
            fs.writeFileSync(helpPath, base.helpText, 'utf8');
        }
        if (fs.existsSync(helpPath)) {
            const custom = fs.readFileSync(helpPath, 'utf8').trim();
            if (custom) base.helpText = custom;
        }
    } catch (err) {
        log('读取自定义使用说明失败:', err);
    }
    configCache = base;
    return configCache;
}

function appInfo() {
    return {
        version: app.getVersion(),
        dataDir: DATA_DIR,
        dataFile: DATA_FILE,
        isPackaged: app.isPackaged,
        platform: process.platform,
        electron: process.versions.electron,
        chrome: process.versions.chrome
    };
}

function registerIpc() {
    ipcMain.handle('app:info', () => appInfo());
    ipcMain.handle('data:load', () => readDataFile());
    ipcMain.handle('data:save', (event, data) => {
        try { saveDataToDisk(data); return true; } catch (err) { log('保存失败:', err); return false; }
    });
    ipcMain.on('data:save-sync', (event, data) => {
        try { saveDataToDisk(data); event.returnValue = true; } catch (err) { log('同步保存失败:', err); event.returnValue = false; }
    });
    ipcMain.handle('words:load', () => loadWords());
    ipcMain.handle('config:load', () => loadConfig());

    ipcMain.handle('shell:open-data', async () => {
        const err = await shell.openPath(DATA_DIR);
        return { ok: !err, error: err || '' };
    });

    ipcMain.handle('shell:show-item', (event, filePath) => {
        try {
            if (typeof filePath === 'string' && filePath && fs.existsSync(filePath)) {
                shell.showItemInFolder(filePath);
                return true;
            }
        } catch (_) { /* ignore */ }
        return false;
    });

    ipcMain.handle('shell:open-external', (event, url) => openExternalSafe(url));

    ipcMain.handle('data:export-backup', async () => {
        try {
            const data = lastData || readDataFile();
            if (!data) return { ok: false, error: '暂时没有可备份的数据' };
            const res = await dialog.showSaveDialog(mainWindow, {
                title: '导出学习数据备份',
                defaultPath: path.join(app.getPath('documents'), `VocabBoost-备份-${dateStamp()}.json`),
                filters: [{ name: 'JSON 备份', extensions: ['json'] }]
            });
            if (res.canceled || !res.filePath) return { ok: false, canceled: true };
            await fsp.writeFile(res.filePath, JSON.stringify(data, null, 2), 'utf8');
            return { ok: true, path: res.filePath };
        } catch (err) {
            log('备份失败:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('data:import-backup', async () => {
        try {
            const res = await dialog.showOpenDialog(mainWindow, {
                title: '选择 VocabBoost 备份文件',
                properties: ['openFile'],
                filters: [{ name: 'JSON 备份', extensions: ['json'] }]
            });
            if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
            const file = res.filePaths[0];
            const data = JSON.parse(await fsp.readFile(file, 'utf8'));
            if (!isValidData(data)) return { ok: false, error: '这不是有效的 VocabBoost 备份文件' };
            return { ok: true, data, path: file };
        } catch (err) {
            log('导入备份失败:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('export:document', (event, payload) => handleExportDocument(payload));
}

// ---------------------------------------------------------------- 导出：公共

function normalizeExportWords(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        const w = String(item.w || '').trim();
        if (!w) continue;
        out.push({
            w: w.slice(0, 80),
            p: String(item.p || '').trim().slice(0, 80),
            z: String(item.z || '').trim().slice(0, 2000),
            l: Math.max(1, Math.min(6, parseInt(item.l, 10) || 1))
        });
        if (out.length >= 5000) break;
    }
    return out;
}

const FORMAT_META = {
    docx: { ext: 'docx', label: 'Word 文档', filter: [{ name: 'Word 文档', extensions: ['docx'] }] },
    xlsx: { ext: 'xlsx', label: 'Excel 工作簿', filter: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] },
    pdf: { ext: 'pdf', label: 'PDF 文件', filter: [{ name: 'PDF 文件', extensions: ['pdf'] }] }
};

async function handleExportDocument(payload) {
    try {
        const format = String(payload && payload.format || '').toLowerCase();
        const meta = FORMAT_META[format];
        if (!meta) return { ok: false, error: '不支持的导出格式' };
        const mode = ['both', 'en', 'zh'].includes(payload.mode) ? payload.mode : 'both';
        const words = normalizeExportWords(payload.words);
        if (!words.length) return { ok: false, error: '没有选中任何单词' };
        if (words.length > 2000) return { ok: false, error: '一次最多导出 2000 个单词' };
        const title = String(payload.title || 'VocabBoost 词汇表').trim().slice(0, 80) || 'VocabBoost 词汇表';

        // Windows 对“桌面/盘符根目录直接建文件”可能有限制，但通常允许建子文件夹。
        // 因此让用户选一个文件夹，软件自动在里面建 VocabBoost-导出 子文件夹再写文件。
        const dirRes = await dialog.showOpenDialog(mainWindow, {
            title: `选择导出文件夹（会自动建 VocabBoost-导出 子文件夹）`,
            defaultPath: app.getPath('desktop'),
            properties: ['openDirectory', 'createDirectory']
        });
        if (dirRes.canceled || !dirRes.filePaths || !dirRes.filePaths.length) return { ok: false, canceled: true };

        const chosenDir = dirRes.filePaths[0];
        const outDir = path.basename(chosenDir) === 'VocabBoost-导出'
            ? chosenDir
            : path.join(chosenDir, 'VocabBoost-导出');
        await fsp.mkdir(outDir, { recursive: true });
        let filePath = path.join(outDir, `VocabBoost-词汇表-${dateStamp()}.${meta.ext}`);

        const buffer = await buildExportBuffer(format, mode, words, title);
        let finalPath = filePath;
        try {
            await fsp.writeFile(finalPath, buffer);
        } catch (err) {
            if (['EACCES', 'EPERM', 'EBUSY'].includes(err.code)) {
                // 同名文件被 Word/Excel 打开：换一个不冲突的名字再试一次。
                const ext = path.extname(filePath) || `.${meta.ext}`;
                const base = path.basename(filePath, ext);
                for (let i = 2; i <= 9; i += 1) {
                    const alt = path.join(outDir, `${base}-${i}${ext}`);
                    try {
                        await fsp.writeFile(alt, buffer);
                        finalPath = alt;
                        break;
                    } catch (_) { /* 继续尝试 */ }
                }
                if (finalPath === filePath) {
                    return {
                        ok: false,
                        error: `没有权限写入：${filePath}\n请确认这个文件夹可写，或换一个文件夹（例如桌面上的子文件夹）。`
                    };
                }
            } else {
                throw err;
            }
        }
        log('导出成功:', finalPath, words.length, format);
        return { ok: true, path: finalPath, count: words.length, format };
    } catch (err) {
        log('导出失败:', err);
        return { ok: false, error: (err && err.message) || String(err) };
    }
}

async function buildExportBuffer(format, mode, words, title) {
    if (format === 'docx') return buildDocx(mode, words, title);
    if (format === 'xlsx') return buildXlsx(mode, words, title);
    return buildPdf(mode, words, title);
}

// ---------------------------------------------------------------- ZIP 写入器

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d = new Date()) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
}

function zipFiles(files) {
    const localParts = [];
    const centralParts = [];
    const { time, date } = dosDateTime();
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(file.name, 'utf8');
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        const useCompressed = compressed.length < data.length;
        const body = useCompressed ? compressed : data;
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(useCompressed ? 8 : 0, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, name, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(useCompressed ? 8 : 0, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);

        offset += local.length + name.length + body.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const part of centralParts) centralSize += part.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, end]);
}

// ---------------------------------------------------------------- Word (.docx)

function xmlClean(value) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
        .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
}

function xmlEscape(value) {
    return xmlClean(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function docxRun(text, options = {}) {
    const props = ['<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/>'];
    if (options.bold) props.push('<w:b/>');
    if (options.color) props.push(`<w:color w:val="${options.color}"/>`);
    if (options.size) props.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);
    return `<w:r><w:rPr>${props.join('')}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function docxParagraph(text, options = {}) {
    const pPr = [];
    if (options.align) pPr.push(`<w:jc w:val="${options.align}"/>`);
    if (options.spaceAfter != null) pPr.push(`<w:spacing w:after="${options.spaceAfter}" w:line="300" w:lineRule="auto"/>`);
    if (options.spaceBefore != null) pPr.push(`<w:spacing w:before="${options.spaceBefore}"/>`);
    return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${docxRun(text, options)}</w:p>`;
}

function docxCell(text, options = {}) {
    const tcPr = [`<w:tcW w:w="${options.width || 2000}" w:type="dxa"/>`];
    if (options.shade) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>`);
    tcPr.push('<w:vAlign w:val="center"/>');
    tcPr.push('<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>');
    const jc = options.align ? `<w:jc w:val="${options.align}"/>` : '';
    const run = docxRun(text, options);
    return `<w:tc><w:tcPr>${tcPr.join('')}</w:tcPr><w:p><w:pPr>${jc}<w:spacing w:before="0" w:after="0"/></w:pPr>${run}</w:p></w:tc>`;
}

function buildDocx(mode, words, title) {
    const useP = mode !== 'zh';
    const useZ = mode !== 'en';
    const columns = [];
    if (useP) {
        columns.push({ key: 'w', label: '单词', width: 2600 });
        columns.push({ key: 'p', label: '音标', width: 2100 });
    }
    if (useZ) columns.push({ key: 'z', label: '释义', width: useP ? 4300 : 9000 });

    const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
    const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D8D2C4"/>`;
    const headerCells = columns.map((c) => docxCell(c.label, {
        width: c.width, shade: '2F5D50', color: 'FFFFFF', bold: true, size: 21, align: 'center'
    })).join('');

    const rows = words.map((item, index) => {
        const shade = index % 2 === 0 ? 'FFFFFF' : 'F7F4EE';
        const cells = columns.map((c) => {
            let value = item[c.key];
            if (c.key === 'p' && !value) value = '—';
            return docxCell(value, {
                width: c.width,
                shade,
                bold: c.key === 'w',
                size: c.key === 'w' ? 22 : 20,
                align: c.key === 'z' ? 'left' : 'center'
            });
        }).join('');
        return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr>`;
    }).join('');

    const body = `
        ${docxParagraph(title, { bold: true, size: 36, align: 'center', spaceAfter: 80 })}
        ${docxParagraph(`共 ${words.length} 个单词 · 生成于 ${new Date().toLocaleString('zh-CN')} · VocabBoost`, {
            size: 18, color: '7C7568', align: 'center', spaceAfter: 240
        })}
        <w:tbl>
            <w:tblPr>
                <w:tblW w:w="${totalWidth}" w:type="dxa"/>
                <w:jc w:val="center"/>
                <w:tblLayout w:type="fixed"/>
                <w:tblBorders>${border('top')}${border('left')}${border('bottom')}${border('right')}${border('insideH')}${border('insideV')}</w:tblBorders>
                <w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>
            </w:tblPr>
            <w:tblGrid>${columns.map((c) => `<w:gridCol w:w="${c.width}"/>`).join('')}</w:tblGrid>
            <w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${headerCells}</w:tr>
            ${rows}
        </w:tbl>
        ${docxParagraph(' ', { size: 20 })}
        ${docxParagraph('由 VocabBoost · 词力引擎 生成，可自由打印背诵。', { size: 16, color: 'A39B8D', align: 'center' })}
    `;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body}
<w:sectPr>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="1134" w:right="1247" w:bottom="1134" w:left="1247" w:header="720" w:footer="720" w:gutter="0"/>
    <w:cols w:space="720"/>
    <w:docGrid w:linePitch="312"/>
</w:sectPr>
</w:body></w:document>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEscape(title)}</dc:title>
<dc:creator>VocabBoost</dc:creator>
<cp:lastModifiedBy>VocabBoost</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

    const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>VocabBoost</Application>
</Properties>`;

    return zipFiles([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rootRels },
        { name: 'word/document.xml', data: documentXml },
        { name: 'word/_rels/document.xml.rels', data: docRels },
        { name: 'word/styles.xml', data: styles },
        { name: 'docProps/core.xml', data: core },
        { name: 'docProps/app.xml', data: app }
    ]);
}

// ---------------------------------------------------------------- Excel (.xlsx)

function xlsxCell(ref, value, style) {
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function buildXlsx(mode, words, title) {
    const columns = [];
    if (mode !== 'zh') {
        columns.push({ key: 'w', label: '单词', width: 24 });
        columns.push({ key: 'p', label: '音标', width: 24 });
    }
    if (mode !== 'en') columns.push({ key: 'z', label: '释义', width: 80 });

    const colNames = ['A', 'B', 'C', 'D', 'E'];
    const header = columns.map((c, i) => xlsxCell(`${colNames[i]}1`, c.label, 1)).join('');
    const rows = words.map((item, rowIndex) => {
        const r = rowIndex + 2;
        const cells = columns.map((c, i) => {
            let value = item[c.key];
            if (c.key === 'p' && !value) value = '—';
            return xlsxCell(`${colNames[i]}${r}`, value, c.key === 'z' ? 2 : 3);
        }).join('');
        return `<row r="${r}" ht="22" customHeight="1">${cells}</row>`;
    }).join('');

    const lastCol = colNames[Math.max(0, columns.length - 1)];
    const lastRow = words.length + 1;
    const colsXml = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');

    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="20"/>
<cols>${colsXml}</cols>
<sheetData>
<row r="1" ht="28" customHeight="1">${header}</row>
${rows}
</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
<pageSetup orientation="portrait" paperSize="9" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;

    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="词汇表" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><color rgb="FF24211C"/><name val="Microsoft YaHei"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>
<font><sz val="11"/><color rgb="FF2F5D50"/><name val="Microsoft YaHei"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F5D50"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD8D2C4"/></left><right style="thin"><color rgb="FFD8D2C4"/></right><top style="thin"><color rgb="FFD8D2C4"/></top><bottom style="thin"><color rgb="FFD8D2C4"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    return zipFiles([
        { name: '[Content_Types].xml', data: contentTypes },
        { name: '_rels/.rels', data: rootRels },
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/worksheets/sheet1.xml', data: sheet },
        { name: 'xl/styles.xml', data: styles }
    ]);
}

// ---------------------------------------------------------------- PDF

function buildPrintHtml(mode, words, title) {
    const useP = mode !== 'zh';
    const useZ = mode !== 'en';
    const head = [];
    if (useP) { head.push('<th class="c-word">单词</th>', '<th class="c-phonetic">音标</th>'); }
    if (useZ) head.push(`<th class="${useP ? 'c-meaning' : 'c-meaning-only'}">释义</th>`);

    const rows = words.map((item, index) => {
        const cells = [];
        if (useP) {
            cells.push(`<td class="c-word"><span class="word">${xmlEscape(item.w)}</span></td>`);
            cells.push(`<td class="c-phonetic">${xmlEscape(item.p || '—')}</td>`);
        }
        if (useZ) cells.push(`<td class="${useP ? 'c-meaning' : 'c-meaning-only'}">${xmlEscape(item.z)}</td>`);
        return `<tr class="${index % 2 === 0 ? 'even' : 'odd'}">${cells.join('')}</tr>`;
    }).join('');

    const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${xmlEscape(title)}</title>
<style>
@page { size: A4; margin: 14mm 12mm 14mm 12mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #24211C; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 10.5pt; }
.doc-head { border-bottom: 2px solid #2F5D50; padding-bottom: 10px; margin-bottom: 14px; }
h1 { margin: 0 0 6px; font-size: 22pt; letter-spacing: 1px; color: #1E3F36; }
.meta { color: #7C7568; font-size: 9pt; display: flex; justify-content: space-between; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th { background: #2F5D50; color: #fff; font-weight: 600; font-size: 9.5pt; padding: 7px 8px; text-align: left; border: 1px solid #2F5D50; }
td { border: 1px solid #DDD5C7; padding: 7px 8px; vertical-align: middle; word-break: break-word; }
tr.even td { background: #FFFFFF; }
tr.odd td { background: #F8F4EA; }
.c-word { width: ${useP && useZ ? '22%' : useP ? '32%' : '0'}; }
.c-phonetic { width: ${useP && useZ ? '20%' : useP ? '68%' : '0'}; }
.c-meaning { width: 58%; }
.c-meaning-only { width: 100%; }
.word { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 12pt; color: #1E3F36; }
.c-phonetic { color: #fff; font-size: 9.5pt; }
td.c-phonetic { color: #6E675B; }
.footer { margin-top: 10px; padding-top: 6px; border-top: 1px solid #E5DED0; color: #A39B8D; font-size: 8pt; text-align: right; }
</style></head>
<body>
<div class="doc-head">
  <h1>${xmlEscape(title)}</h1>
  <div class="meta"><span>共 ${words.length} 个单词 · ${mode === 'both' ? '中英对照' : mode === 'en' ? '纯英文' : '纯中文'}</span><span>VocabBoost · ${date}</span></div>
</div>
<table><thead><tr>${head.join('')}</tr></thead><tbody>${rows}</tbody></table>
<div class="footer">由 VocabBoost · 词力引擎生成 · 建议双面打印</div>
</body></html>`;
}

async function buildPdf(mode, words, title) {
    const html = buildPrintHtml(mode, words, title);
    let tempDir;
    try {
        tempDir = path.join(DATA_DIR || os.tmpdir(), '.print-temp');
        fs.mkdirSync(tempDir, { recursive: true });
    } catch (_) {
        tempDir = os.tmpdir();
    }
    const tmp = path.join(tempDir, `vocabboost-print-${process.pid}-${Date.now()}.html`);
    await fsp.writeFile(tmp, html, 'utf8');
    const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    try {
        await win.loadFile(tmp);
        try {
            await win.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
        } catch (_) { /* ignore */ }
        await sleep(120);
        const pdf = await win.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            pageSize: 'A4'
        });
        return Buffer.from(pdf);
    } finally {
        try { win.destroy(); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
}

// ---------------------------------------------------------------- 冒烟测试

async function waitFor(win, expression, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const value = await win.webContents.executeJavaScript(expression);
            if (value) return true;
        } catch (_) { /* not ready */ }
        await sleep(150);
    }
    return false;
}

async function capture(win, fileName) {
    try {
        win.showInactive();
        await sleep(250);
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SMOKE_DIR, fileName), image.toPNG());
        win.hide();
        return true;
    } catch (err) {
        log('截图失败:', err);
        return false;
    }
}

async function runSmoke() {
    const result = { ok: false, startedAt: new Date().toISOString() };
    let win = null;
    try {
        win = createMainWindow({ show: false, width: 1280, height: 900 });
        const loadPromise = new Promise((resolve, reject) => {
            if (!win.webContents.isLoading()) return resolve();
            win.webContents.once('did-finish-load', resolve);
            win.webContents.once('did-fail-load', (event, code, description) => reject(new Error(`${code}: ${description}`)));
        });
        await Promise.race([
            loadPromise,
            sleep(20000).then(() => { throw new Error('页面加载超时（did-finish-load 未触发）'); })
        ]);
        log('SMOKE 页面已加载，等待前端就绪');
        const ready = await waitFor(win, 'window.__APP_READY__ === true', 25000);
        if (!ready) {
            const errors = await win.webContents.executeJavaScript('window.__errors || []').catch(() => []);
            throw new Error('前端启动超时（__APP_READY__ 未就绪）: ' + JSON.stringify(errors));
        }
        log('SMOKE 前端已就绪');

        await sleep(900);
        await win.webContents.executeJavaScript('if (window.VB && VB.views) VB.views.closeAllModals(); true').catch(() => {});
        await sleep(250);
        result.front = await win.webContents.executeJavaScript('window.__smoke()');
        result.screenshots = {};
        result.screenshots.home = await capture(win, 'smoke-home.png');

        result.study = await win.webContents.executeJavaScript('window.__smokeStudy()');
        await sleep(700);
        result.screenshots.study = await capture(win, 'smoke-study.png');

        result.library = await win.webContents.executeJavaScript('window.__smokeLibrary()');
        await sleep(500);
        result.screenshots.library = await capture(win, 'smoke-library.png');

        const sample = (result.front && result.front.sampleWords) || [];
        const exportDir = path.join(SMOKE_DIR, 'smoke-exports');
        fs.mkdirSync(exportDir, { recursive: true });
        result.exports = {};
        for (const format of ['docx', 'xlsx', 'pdf']) {
            const buffer = await buildExportBuffer(format, 'both', sample, 'VocabBoost 冒烟测试词汇表');
            const file = path.join(exportDir, `smoke.${format}`);
            fs.writeFileSync(file, buffer);
            const magic = buffer.slice(0, 4).toString('hex');
            result.exports[format] = { file, bytes: buffer.length, magic };
        }

        result.appInfo = appInfo();
        result.ok = true;
    } catch (err) {
        result.error = err && err.stack ? err.stack : String(err);
        log('SMOKE 失败:', err);
    } finally {
        fs.writeFileSync(SMOKE_OUT, JSON.stringify(result, null, 2), 'utf8');
        try { if (win) win.destroy(); } catch (_) { /* ignore */ }
        app.exit(result.ok ? 0 : 1);
    }
}

// ---------------------------------------------------------------- 打包自检

async function runSelfTest() {
    const result = { ok: false, startedAt: new Date().toISOString() };
    const outDir = process.env.VB_SELF_TEST_DIR || path.join(process.cwd(), 'self-test-output');
    const outFile = process.env.VB_SELF_TEST_OUT || path.join(process.cwd(), 'self-test-result.json');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        const words = await loadWords();
        const config = loadConfig();
        const sample = words.slice(0, 16).map((word) => ({ w: word.w, p: word.p, z: word.z, l: word.l }));
        const files = {};
        const docx = buildDocx('both', sample, 'VocabBoost 打包自检');
        fs.writeFileSync(path.join(outDir, 'self-test.docx'), docx);
        files.docx = docx.length;
        const xlsx = buildXlsx('both', sample, 'VocabBoost 打包自检');
        fs.writeFileSync(path.join(outDir, 'self-test.xlsx'), xlsx);
        files.xlsx = xlsx.length;
        const html = buildPrintHtml('both', sample, 'VocabBoost 打包自检');
        fs.writeFileSync(path.join(outDir, 'self-test.html'), html, 'utf8');
        files.html = Buffer.byteLength(html, 'utf8');
        result.words = words.length;
        result.configAppName = config.appName;
        result.appInfo = appInfo();
        result.files = files;
        result.ok = words.length > 0 && !!config.appName;
    } catch (err) {
        result.error = err && err.stack ? err.stack : String(err);
        log('SELF-TEST 失败:', err);
    }
    try {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
        log('SELF-TEST 结果写入失败:', err);
    }
    app.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------- 生命周期

const gotLock = (IS_SMOKE || IS_SELF_TEST) ? true : app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        initPaths();
        Menu.setApplicationMenu(null);
        registerIpc();
        log('VocabBoost 启动', app.getVersion(), 'packaged=' + app.isPackaged, 'data=' + DATA_FILE);
        if (IS_SMOKE) {
            runSmoke();
        } else if (IS_SELF_TEST) {
            runSelfTest();
        } else {
            createMainWindow();
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
}

process.on('uncaughtException', (err) => log('uncaughtException:', err));
process.on('unhandledRejection', (err) => log('unhandledRejection:', err));

// 供 Node 侧导出格式自测使用；Electron 主进程本身忽略此导出。
module.exports = {
    buildDocx,
    buildXlsx,
    buildPrintHtml,
    buildExportBuffer,
    normalizeExportWords,
    zipFiles
};
