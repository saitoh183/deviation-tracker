const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { initDB, getDB } = require('./db');
const { startServer, stopServer } = require('./server');
const { detectProviders, installOllama, pullModel, getLocalModels } = require('./llm-manager');

let mainWindow;
const PORT = 18923;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

// --- IPC Handlers ---

// Database operations
ipcMain.handle('db:query', (_, sql, params) => {
  try {
    const db = getDB();
    const stmt = db.prepare(sql);
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      return { success: true, data: stmt.all(...(params || [])) };
    }
    const result = stmt.run(...(params || []));
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('db:exec', (_, sql) => {
  try {
    getDB().exec(sql);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Settings
ipcMain.handle('settings:get', (_, key) => {
  const db = getDB();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
});

ipcMain.handle('settings:set', (_, key, value) => {
  const db = getDB();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  return { success: true };
});

ipcMain.handle('settings:getAll', () => {
  const db = getDB();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = JSON.parse(r.value); });
  return settings;
});

ipcMain.handle('vision:configure', (_, visionConfig) => {
  const db = getDB();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vision_config', JSON.stringify(visionConfig));
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('setup_complete', JSON.stringify(true));

  if (!visionConfig || visionConfig.provider === 'none' || !visionConfig.endpoint) {
    stopServer();
    return { success: true, port: PORT, running: false };
  }

  startServer(visionConfig, PORT);
  return { success: true, port: PORT, running: true };
});

// File dialogs
ipcMain.handle('dialog:openImages', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });
  if (result.canceled) return [];
  // Read files as base64 data URLs
  const fs = require('fs');
  return result.filePaths.map(fp => {
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fp).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  });
});

// LLM Manager
ipcMain.handle('llm:detect', async () => detectProviders());
ipcMain.handle('llm:installOllama', async () => installOllama());
ipcMain.handle('llm:pullModel', async (_, model) => pullModel(model));
ipcMain.handle('llm:getModels', async () => getLocalModels());

// Setup wizard
ipcMain.handle('setup:complete', async (_, config) => {
  const db = getDB();
  // Save LLM config
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('vision_config', JSON.stringify(config.vision));
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('setup_complete', JSON.stringify(true));
  // Start proxy server with the config
  startServer(config.vision, PORT);
  return { success: true };
});

ipcMain.handle('setup:isComplete', () => {
  const db = getDB();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('setup_complete');
  return row ? JSON.parse(row.value) : false;
});

// App info
ipcMain.handle('app:getPort', () => PORT);

// --- App lifecycle ---
app.whenReady().then(() => {
  initDB(app.getPath('userData'));
  createWindow();

  // If setup is complete, start the proxy server
  const db = getDB();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('setup_complete');
  if (row && JSON.parse(row.value)) {
    const visRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('vision_config');
    if (visRow) {
      const visionConfig = JSON.parse(visRow.value);
      startServer(visionConfig, PORT);
    }
  }
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});
