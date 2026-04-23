const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Database
  dbQuery: (sql, params) => ipcRenderer.invoke('db:query', sql, params),
  dbExec: (sql) => ipcRenderer.invoke('db:exec', sql),

  // Settings
  settingsGet: (key) => ipcRenderer.invoke('settings:get', key),
  settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  settingsGetAll: () => ipcRenderer.invoke('settings:getAll'),
  visionConfigure: (config) => ipcRenderer.invoke('vision:configure', config),

  // File dialogs
  openImages: () => ipcRenderer.invoke('dialog:openImages'),

  // LLM
  llmDetect: () => ipcRenderer.invoke('llm:detect'),
  llmInstallOllama: () => ipcRenderer.invoke('llm:installOllama'),
  llmPullModel: (model) => ipcRenderer.invoke('llm:pullModel', model),
  llmGetModels: () => ipcRenderer.invoke('llm:getModels'),

  // Setup
  setupComplete: (config) => ipcRenderer.invoke('setup:complete', config),
  setupIsComplete: () => ipcRenderer.invoke('setup:isComplete'),

  // App info
  getPort: () => ipcRenderer.invoke('app:getPort')
});
