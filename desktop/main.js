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

ipcMain.handle('state:save', (_, snapshot) => {
  const db = getDB();
  const saveAll = db.transaction((data) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('characters', JSON.stringify(data.settings?.characters || []));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('variants', JSON.stringify(data.settings?.variants || []));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('hiddenDefaultDeviations', JSON.stringify(data.settings?.hiddenDefaultDeviations || []));
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('hiddenDefaultTraits', JSON.stringify(data.settings?.hiddenDefaultTraits || []));

    db.exec('DELETE FROM deviations');
    const insertDeviation = db.prepare('INSERT INTO deviations (char_name, name, variant, trait1, trait2, trait3, trait4, trait5, skill, activity, eland, fusion, locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const d of data.deviations || []) {
      insertDeviation.run(d.char || '', d.name || '', d.variant || '', d.traits?.[0] || '', d.traits?.[1] || '', d.traits?.[2] || '', d.traits?.[3] || '', d.traits?.[4] || '', d.skill || 0, d.activity || 0, d.eland ? 1 : 0, d.fusion ? 1 : 0, d.locked ? 1 : 0);
    }

    db.exec('DELETE FROM materials');
    const insertMaterial = db.prepare('INSERT INTO materials (name, qty, notes, sort_order) VALUES (?, ?, ?, ?)');
    (data.materials || []).forEach((m, i) => insertMaterial.run(m.name || '', m.qty || 0, m.notes || '', i));

    db.exec('DELETE FROM custom_deviations');
    const insertCustomDeviation = db.prepare('INSERT INTO custom_deviations (name) VALUES (?)');
    for (const name of data.customDeviations || []) insertCustomDeviation.run(name);

    db.exec('DELETE FROM custom_traits');
    const insertCustomTrait = db.prepare('INSERT INTO custom_traits (name, effect, neg, deviants) VALUES (?, ?, ?, ?)');
    for (const t of data.customTraits || []) {
      const deviants = t.deviants === 'ALL' ? 'ALL' : JSON.stringify(t.deviants || []);
      insertCustomTrait.run(t.name || '', t.effect || '', t.neg ? 1 : 0, deviants);
    }

    db.exec('DELETE FROM trait_assignments');
    const insertAssignment = db.prepare('INSERT INTO trait_assignments (deviant_name, trait_name) VALUES (?, ?)');
    for (const [dev, assign] of Object.entries(data.customTraitAssignments || {})) {
      for (const trait of assign?.add || []) insertAssignment.run(dev, trait);
    }
  });

  saveAll(snapshot || {});
  return { success: true };
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
