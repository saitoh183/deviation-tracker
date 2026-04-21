const express = require('express');
const cors = require('cors');

let server = null;

function startServer(visionConfig, port) {
  if (server) stopServer();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static('dist'));

  // Vision API proxy — solves mixed-content and CORS issues
  app.post('/api/vision', async (req, res) => {
    try {
      const { imageDataUrl } = req.body;
      if (!imageDataUrl) return res.status(400).json({ error: 'Missing imageDataUrl' });

      if (!visionConfig || !visionConfig.endpoint) {
        return res.status(400).json({ error: 'Vision API not configured' });
      }

      const base64 = imageDataUrl.split(',')[1];
      const mime = imageDataUrl.match(/^data:(image\/\w+);/)?.[1] || 'image/png';
      const provider = visionConfig.provider || 'openai';

      let url, headers, body;

      if (provider === 'ollama') {
        const ep = visionConfig.endpoint.replace(/\/+$/, '');
        url = `${ep}/api/chat`;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
          model: visionConfig.model || 'llava',
          stream: false,
          messages: [{
            role: 'user',
            content: getSystemPrompt() + '\n\nAnalyze this screenshot:',
            images: [base64]
          }],
          format: 'json'
        });
      } else {
        const ep = visionConfig.endpoint.replace(/\/+$/, '');
        const needsV1 = !/\/v1\/?$/.test(ep);
        url = `${ep}${needsV1 ? '/v1' : ''}/chat/completions`;
        headers = {
          'Content-Type': 'application/json',
          ...(visionConfig.apiKey ? { 'Authorization': `Bearer ${visionConfig.apiKey}` } : {})
        };
        body = JSON.stringify({
          model: visionConfig.model || 'gpt-4o',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: getSystemPrompt() },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
            ]
          }],
          max_tokens: 1000
        });
      }

      const resp = await fetch(url, { method: 'POST', headers, body });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return res.status(resp.status).json({ error: `API ${resp.status}: ${errText.slice(0, 200)}` });
      }

      const data = await resp.json();
      let content = '';
      if (provider === 'ollama') {
        content = data.message?.content || '';
      } else {
        content = data.choices?.[0]?.message?.content || '';
      }

      // Parse JSON from response
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      let parsed;
      try {
        parsed = JSON.parse(jsonMatch[1].trim());
      } catch (e) {
        return res.status(500).json({ error: 'Could not parse API response', raw: content.slice(0, 300) });
      }

      res.json({
        name: String(parsed.name || '').trim(),
        variant: String(parsed.variant || '').trim(),
        variantEffect: String(parsed.variant_effect || '').trim(),
        description: String(parsed.description || '').trim(),
        skillRating: Math.min(5, Math.max(0, parseInt(parsed.skill_rating) || 0)),
        activityRating: Math.min(5, Math.max(0, parseInt(parsed.activity_rating) || 0)),
        fusion: parsed.fusion ? 1 : 0,
        traits: Array.isArray(parsed.traits) ? parsed.traits.map(t => ({
          name: String(t.name || '').trim(),
          isNegative: !!t.is_negative
        })).filter(t => t.name) : []
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update vision config at runtime
  app.post('/api/vision/config', (req, res) => {
    Object.assign(visionConfig, req.body);
    res.json({ success: true });
  });

  server = app.listen(port, '127.0.0.1', () => {
    console.log(`Vision proxy running on http://127.0.0.1:${port}`);
  });
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
  }
}

function getSystemPrompt() {
  return `You are a data extraction assistant for a game called Once Human. Analyze the screenshot of a Deviation detail screen and extract the following fields as JSON. Be precise with text extraction.

Output ONLY a JSON object with these fields:
{
  "name": "base deviation name (e.g. The Digby Boy, Electric Eel, Butterfly's Emissary)",
  "variant": "variant/skin name after the dash (e.g. Emerald, Prism, Good Fortune) or empty string if none",
  "variant_effect": "the gold-colored variant description that starts with 'Appearance changed.' — extract the full text, or empty string if none",
  "description": "the full description text below the name (NOT the variant effect)",
  "skill_rating": number 0-5 (from Skill Rating),
  "activity_rating": number 0-5 (from Activity Rating),
  "fusion": 0 or 1 (Fusion state: 1 = on/active, 0 = off),
  "traits": [{"name": "trait name", "is_negative": boolean}]
}

CRITICAL VARIANT vs TRAIT RULES:
- The deviation name often has format "Name - Variant". Example: "The Digby Boy - Emerald" → name="The Digby Boy", variant="Emerald"
- The gold text starting with "Appearance changed." is the VARIANT EFFECT, NOT a trait. Do NOT include it in traits.
- Only include traits from the TRAITS section of the UI. These are gameplay traits like "Cheer Up 1", "Growing Pains 2", etc.
- If a trait is negative (starts with ⚠ symbol), set is_negative=true
- If no traits are visible, traits=[]

Other rules:
- If no variant is shown, variant="" and variant_effect=""
- skill_rating and activity_rating are 0 if not visible
- Be precise with apostrophes, dashes, and special characters`;
}

module.exports = { startServer, stopServer };
