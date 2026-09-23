/**
 * JARVIS Desktop — Electron wrapper (robust)
 */
const { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

let win = null;
let workWin = null;
let tray = null;
const children = [];

// Pfade
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.join(__dirname, '..');
const UNPACKED_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : ROOT;
const isDev = !app.isPackaged;

function logMain(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'main.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
  console.log('[main]', msg);
}

// Globale Fehler sichtbar machen statt silent crash
process.on('uncaughtException', (err) => {
  logMain('uncaughtException: ' + (err && err.stack || err));
  try { dialog.showErrorBox('JARVIS Fehler', String(err.stack || err)); } catch {}
});
process.on('unhandledRejection', (reason) => {
  logMain('unhandledRejection: ' + reason);
});

function writableRoot() {
  try { return app.getPath('userData'); } catch { return os.tmpdir(); }
}
function nodeBin() {
  const cand = 'C:\\nvm4w\\nodejs\\node.exe';
  try { if (fs.existsSync(cand)) return cand; } catch {}
  return process.execPath;
}

// Suche openrouter.env an mehreren Orten (dev vs packaged)
function parseEnvFile() {
  const candidates = [
    path.join(UNPACKED_ROOT, 'openrouter.env'),
    path.join(ROOT, 'openrouter.env'),
    path.join(process.resourcesPath, 'openrouter.env'),
    'C:\\Users\\moser\\Projekte\\jarvis_v7\\openrouter.env',
    path.join(writableRoot(), 'openrouter.env'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const txt = fs.readFileSync(file, 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) process.env[m[1]] = m[2].trim();
      }
      logMain('env loaded from ' + file);
      return;
    } catch (e) { logMain('env load failed ' + file + ': ' + e.message); }
  }
  logMain('no openrouter.env found — using Claude login');
}

function checkPort(port, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout }, (res) => {
      res.resume(); resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function hiddenSpawn(cmd, args, envExtra) {
  const env = { ...process.env, ...envExtra };
  const cwd = writableRoot();
  try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
  const bin = isDev ? cmd : nodeBin();
  logMain(`spawn ${path.basename(bin)} ${args.map(a=>path.basename(a)).join(' ')} cwd=${cwd}`);
  let child;
  try {
    child = spawn(bin, args, { cwd, env, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    logMain('spawn throw: ' + e.message);
    return null;
  }
  const base = path.basename(args[0]).replace('.mjs','').replace('.js','');
  const logFile = path.join(writableRoot(), `${base}.out.log`);
  try {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout && child.stdout.pipe(out);
    child.stderr && child.stderr.pipe(out);
    child.stdout && child.stdout.on('data', d => logMain(`${base}: ${String(d).slice(0,200)}`));
    child.stderr && child.stderr.on('data', d => logMain(`${base} ERR: ${String(d).slice(0,300)}`));
  } catch (e) { logMain('log pipe failed ' + e.message); }
  child.on('error', e => logMain(`spawn failed ${args[0]}: ${e.message}`));
  child.on('exit', (code) => logMain(`${base} exit ${code}`));
  children.push(child);
  return child;
}

async function startBrains() {
  try {
    parseEnvFile();
    if (!process.env.BRAIN_PROXY_PORT) process.env.BRAIN_PROXY_PORT = '8790';

    // Wenn Bridge schon läuft, nichts starten
    if (await checkPort(8787)) { logMain('bridge 8787 already up — reuse'); return; }
    if (await checkPort(Number(process.env.BRAIN_PROXY_PORT))) { logMain('proxy already up — reuse'); }

    const useProxy = (process.env.BRAIN_PRIORITY && process.env.BRAIN_PRIORITY.toLowerCase().includes('ollama'))
      || (process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.toLowerCase().startsWith('paste'));

    if (useProxy) {
      if (!process.env.OPENROUTER_MODEL) process.env.OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
      if (!process.env.BRAIN_PRIORITY) process.env.BRAIN_PRIORITY = 'openrouter,ollama';
      const proxyEnv = {
        BRAIN_PROXY_PORT: process.env.BRAIN_PROXY_PORT,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
        OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
        BRAIN_PRIORITY: process.env.BRAIN_PRIORITY,
        BRAIN_PROXY_SECRET: process.env.BRAIN_PROXY_SECRET || '',
      };
      const p = path.join(UNPACKED_ROOT, 'brain-proxy.mjs');
      if (!fs.existsSync(p)) logMain('brain-proxy.mjs missing at ' + p);
      hiddenSpawn(nodeBin(), [p], proxyEnv);
      await new Promise(r => setTimeout(r, 2200));
      await startBridge(true);
    } else {
      await startBridge(false);
    }
  } catch (e) { logMain('startBrains error: ' + (e.stack||e)); }
}

let bridgeWatchdog = null
function startWatchdog() {
  if (bridgeWatchdog) return
  bridgeWatchdog = setInterval(async () => {
    try {
      const up = await checkPort(8787, 1500)
      if (!up) {
        logMain('watchdog: bridge 8787 down — restarting')
        try { await startBridge(true) } catch {}
        // auch proxy check
        const proxyPort = Number(process.env.BRAIN_PROXY_PORT || 8790)
        const proxyUp = await checkPort(proxyPort, 1000)
        if (!proxyUp && process.env.OPENROUTER_API_KEY) {
          logMain('watchdog: proxy down — restarting')
          const p = path.join(UNPACKED_ROOT, 'brain-proxy.mjs')
          if (fs.existsSync(p)) hiddenSpawn(nodeBin(), [p], { BRAIN_PROXY_PORT: String(proxyPort), OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENROUTER_MODEL: process.env.OPENROUTER_MODEL, BRAIN_PRIORITY: process.env.BRAIN_PRIORITY })
        }
      }
    } catch {}
  }, 8000)
}

async function startBridge(withProxy) {
  try {
    if (await checkPort(8787)) { logMain('bridge already up — skip startBridge'); return; }
    const env = { JARVIS_ALLOW_WRITES: '1', MCP_TOOL_TIMEOUT: '90000', MCP_TIMEOUT: '30000', JARVIS_EFFORT: 'high' };
    if (withProxy) {
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${process.env.BRAIN_PROXY_PORT}`;
      env.ANTHROPIC_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-jarvis-local';
      env.ANTHROPIC_AUTH_TOKEN = '';
      if (process.env.BRAIN_PROXY_SECRET) env.ANTHROPIC_CUSTOM_HEADERS = `x-brain-secret: ${process.env.BRAIN_PROXY_SECRET}`;
      env.JARVIS_MODEL = 'claude-sonnet-4-20250514';
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-sonnet-4-20250514';
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4-20250514';
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-sonnet-4-20250514';
      env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1';
    }
    const b = path.join(UNPACKED_ROOT, 'bridge/server.mjs');
    if (!fs.existsSync(b)) logMain('bridge/server.mjs missing at ' + b);
    const child = hiddenSpawn(nodeBin(), [b], env)
    if (child) {
      child.on('exit', (code, sig) => {
        logMain(`bridge exit code=${code} sig=${sig} — will restart via watchdog`)
      })
    }
  } catch (e) { logMain('startBridge error: ' + (e.stack||e)); }
}

async function startViteIfDev() {
  if (!isDev) return;
  if (await checkPort(5173)) { logMain('vite 5173 already up'); return; }
  hiddenSpawn(nodeBin(), [path.join(ROOT, 'node_modules/vite/bin/vite.js')], {});
}

function createWorkWindow() {
  try {
    if (workWin && !workWin.isDestroyed()) { workWin.show(); workWin.focus(); return workWin; }
    const url = isDev ? 'http://localhost:5173?work=1' : `file://${path.join(ROOT, 'dist/index.html')}?work=1`;
    workWin = new BrowserWindow({
      width: 900, height: 700, backgroundColor: '#01060c', title: 'JARVIS Workspace',
      show: true, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    workWin.loadURL(url).catch(() => workWin.loadFile(path.join(ROOT, 'dist/index.html'), { query: { work: '1' } }));
    workWin.on('closed', () => { workWin = null; });
    logMain('workWindow opened ' + url);
    return workWin;
  } catch (e) { logMain('createWorkWindow failed ' + e.stack); return null; }
}

ipcMain.on('open-work-window', () => { try { createWorkWindow(); } catch {} });
ipcMain.on('close-work-window', () => { try { if (workWin) workWin.close(); } catch {} });

function createWindow() {
  try {
    logMain('createWindow ROOT=' + ROOT + ' isPackaged=' + app.isPackaged);
    let winIcon = undefined;
    try {
      const cand = path.join(ROOT, 'public/logo.png');
      const cand2 = path.join(UNPACKED_ROOT, 'public/logo.png');
      if (fs.existsSync(cand)) winIcon = cand;
      else if (fs.existsSync(cand2)) winIcon = cand2;
    } catch {}
    win = new BrowserWindow({
      width: 1280, height: 900, backgroundColor: '#0a3cff', title: 'J.A.R.V.I.S.',
      icon: winIcon,
      show: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
      autoHideMenuBar: true,
    });
    win.webContents.on('did-fail-load', (e, code, desc, url) => logMain(`did-fail-load ${code} ${desc} ${url}`));
    win.webContents.on('did-finish-load', () => { logMain('did-finish-load ok'); try{ win.webContents.openDevTools({mode:'detach'}); }catch{} });
    win.webContents.on('console-message', (e, level, msg) => logMain(`console[${level}] ${msg}`));

    if (isDev) {
      const url = 'http://localhost:5173';
      logMain('loadURL ' + url);
      setTimeout(() => {
        win.loadURL(url).catch(err => {
          logMain('loadURL failed ' + err.message + ' fallback to file');
          win.loadFile(path.join(ROOT, 'dist/index.html')).catch(e=>logMain('loadFile fallback failed '+e.message));
        });
      }, 3500);
    } else {
      const file = path.join(ROOT, 'dist/index.html');
      logMain('loadFile ' + file + ' exists=' + fs.existsSync(file));
      if (!fs.existsSync(file)) {
        // Fallback: unpacked
        const alt = path.join(UNPACKED_ROOT, 'dist/index.html');
        logMain('alt check ' + alt + ' exists=' + fs.existsSync(alt));
        if (fs.existsSync(alt)) { win.loadFile(alt); return; }
        throw new Error('dist/index.html not found in ' + file);
      }
      win.loadFile(file).catch(e => {
        logMain('loadFile error ' + e.stack);
        dialog.showErrorBox('Load failed', String(e.stack||e));
      });
    }
    win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); }});
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    // Bei Fehler sichtbar machen
    win.once('ready-to-show', () => { try { win.show(); } catch {} });
  } catch (e) {
    logMain('createWindow crash ' + (e.stack||e));
    try { dialog.showErrorBox('Window Fehler', String(e.stack||e)); } catch {}
  }
}

function createTray() {
  try {
    const { nativeImage } = require('electron');
    let trayIcon = null;
    try {
      const cand = path.join(ROOT, 'public/logo.png');
      const cand2 = path.join(UNPACKED_ROOT, 'public/logo.png');
      const p = fs.existsSync(cand) ? cand : (fs.existsSync(cand2) ? cand2 : null);
      if (p) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) trayIcon = img.resize({ width: 16, height: 16 });
      }
    } catch {}
    if (!trayIcon || trayIcon.isEmpty()) {
      try {
        const img = nativeImage.createFromPath(process.execPath);
        if (!img.isEmpty()) trayIcon = img;
      } catch {}
    }
    if (!trayIcon || trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty();
    tray = new Tray(trayIcon);
    const ctx = Menu.buildFromTemplate([
      { label: 'JARVIS zeigen', click: () => { try { win.show(); win.focus(); } catch {} } },
      { label: 'DevTools', click: () => { try { win.webContents.openDevTools(); } catch {} } },
      { type: 'separator' },
      { label: 'Beenden', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setToolTip('J.A.R.V.I.S.');
    tray.setContextMenu(ctx);
    tray.on('click', () => { try { win.show(); } catch {} });
    logMain('tray ok');
  } catch (e) { logMain('tray failed ' + e.message); }
}

// Single instance
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { try { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } } catch {} });

app.whenReady().then(async () => {
  logMain('whenReady isPackaged=' + app.isPackaged + ' ROOT=' + ROOT);
  try { await startBrains(); } catch (e) { logMain('startBrains outer ' + e.stack); }
  try { await startViteIfDev(); } catch {}
  try { createWindow(); } catch (e) { logMain('createWindow outer ' + e.stack); }
  try { createTray(); } catch {}
  try { startWatchdog(); } catch {}
  app.on('activate', () => { try { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else win.show(); } catch {} });
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; for (const c of children) try { c.kill(); } catch {} });
app.on('quit', () => { for (const c of children) try { c.kill('SIGTERM'); } catch {} });
