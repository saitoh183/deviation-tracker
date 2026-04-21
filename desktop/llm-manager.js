const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Provider detection ---

async function detectProviders() {
  const providers = [];

  // Check Ollama
  const ollama = await detectOllama();
  if (ollama) providers.push(ollama);

  // Check LM Studio (default port 1234)
  const lmstudio = await checkEndpoint('LM Studio', 'http://127.0.0.1:1234', '/v1/models');
  if (lmstudio) providers.push(lmstudio);

  // Check llama.cpp (common ports 8080, 8000)
  const llamacpp8080 = await checkEndpoint('llama.cpp', 'http://127.0.0.1:8080', '/v1/models');
  if (llamacpp8080) providers.push(llamacpp8080);
  else {
    const llamacpp8000 = await checkEndpoint('llama.cpp', 'http://127.0.0.1:8000', '/v1/models');
    if (llamacpp8000) providers.push(llamacpp8000);
  }

  return providers;
}

async function detectOllama() {
  // Check if Ollama is running
  const running = await httpGet('http://127.0.0.1:11434/api/tags');
  if (running) {
    const models = running.models || [];
    return {
      name: 'Ollama',
      endpoint: 'http://127.0.0.1:11434',
      running: true,
      installed: true,
      models: models.map(m => m.name),
      provider: 'ollama'
    };
  }

  // Check if Ollama is installed but not running
  const isInstalled = checkOllamaInstalled();
  return {
    name: 'Ollama',
    endpoint: 'http://127.0.0.1:11434',
    running: false,
    installed: isInstalled,
    models: [],
    provider: 'ollama'
  };
}

function checkOllamaInstalled() {
  try {
    if (os.platform() === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || '';
      return fs.existsSync(path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'));
    }
    execSync('which ollama', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function checkEndpoint(name, endpoint, testPath) {
  const data = await httpGet(endpoint + testPath);
  if (!data) return null;
  return {
    name,
    endpoint,
    running: true,
    installed: true,
    models: (data.data || data.models || []).map(m => m.id || m.name),
    provider: name.toLowerCase().replace(/[^a-z]/g, '')
  };
}

// --- Ollama installation ---

async function installOllama() {
  return new Promise((resolve, reject) => {
    if (os.platform() === 'win32') {
      // Download Ollama installer for Windows
      const installerUrl = 'https://ollama.com/download/OllamaSetup.exe';
      const tmpDir = os.tmpdir();
      const installerPath = path.join(tmpDir, 'OllamaSetup.exe');

      console.log('Downloading Ollama installer...');
      const file = fs.createWriteStream(installerPath);

      https.get(installerUrl, (resp) => {
        if (resp.statusCode === 302 || resp.statusCode === 301) {
          // Follow redirect
          https.get(resp.headers.location, (resp2) => {
            resp2.pipe(file);
            file.on('finish', () => {
              file.close();
              console.log('Running Ollama installer (silent)...');
              try {
                execSync(`"${installerPath}" /S`, { timeout: 120000 });
                resolve({ success: true, message: 'Ollama installed successfully' });
              } catch (err) {
                // Installer might need elevation — prompt user to run manually
                resolve({ success: false, message: 'Please run the Ollama installer manually: ' + installerPath });
              }
            });
          });
        } else {
          resp.pipe(file);
          file.on('finish', () => {
            file.close();
            try {
              execSync(`"${installerPath}" /S`, { timeout: 120000 });
              resolve({ success: true, message: 'Ollama installed successfully' });
            } catch (err) {
              resolve({ success: false, message: 'Please run the Ollama installer manually: ' + installerPath });
            }
          });
        }
      }).on('error', (err) => {
        reject(new Error('Failed to download Ollama: ' + err.message));
      });
    } else {
      // Linux/Mac — use install script
      try {
        execSync('curl -fsSL https://ollama.com/install.sh | sh', { timeout: 120000 });
        resolve({ success: true, message: 'Ollama installed successfully' });
      } catch (err) {
        reject(new Error('Failed to install Ollama: ' + err.message));
      }
    }
  });
}

// --- Model management ---

async function pullModel(modelName) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/pull',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const lines = data.trim().split('\n').filter(Boolean);
          const last = JSON.parse(lines[lines.length - 1]);
          if (last.status === 'success') {
            resolve({ success: true, message: `Model ${modelName} pulled successfully` });
          } else {
            resolve({ success: true, message: last.status || 'Pull complete' });
          }
        } catch {
          resolve({ success: true, message: 'Model pull initiated' });
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error('Failed to pull model: ' + err.message));
    });

    req.write(JSON.stringify({ name: modelName, stream: false }));
    req.end();
  });
}

async function getLocalModels() {
  const data = await httpGet('http://127.0.0.1:11434/api/tags');
  if (!data || !data.models) return [];
  return data.models.map(m => ({
    name: m.name,
    size: m.size,
    modified: m.modified_at
  }));
}

// --- Utility ---

function httpGet(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? require('https') : http;
    mod.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

module.exports = { detectProviders, installOllama, pullModel, getLocalModels };
