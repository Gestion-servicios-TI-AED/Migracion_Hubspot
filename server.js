const express  = require('express');
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const app        = express();
const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET;

const RAW_CONTACTS = path.join(__dirname, 'data', 'contacts_raw.json');
const RAW_UNITS    = path.join(__dirname, 'data', 'units_raw.json');

app.use(express.json());

// ── Autenticación de la API ───────────────────────────────────────────────────
function auth(req, res, next) {
  if (!API_SECRET) return next();
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ── Ejecutar script de migración ──────────────────────────────────────────────
function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scripts', scriptName);
    const child = spawn('node', [scriptPath], { env: process.env });
    let output = '';
    child.stdout.on('data', d => { process.stdout.write(d); output += d.toString(); });
    child.stderr.on('data', d => { process.stderr.write(d); output += d.toString(); });
    child.on('close', code => {
      if (code === 0) resolve(output);
      else reject(new Error(output));
    });
  });
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Endpoints de migración ────────────────────────────────────────────────────
app.post('/migrate/units', auth, async (_req, res) => {
  try {
    const output = await runScript('migrate-units.js');
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/migrate/contacts', auth, async (_req, res) => {
  try {
    const output = await runScript('migrate-contacts.js');
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/migrate/deals', auth, async (_req, res) => {
  try {
    const output = await runScript('migrate-deals.js');
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sincronización completa — orden obligatorio: unidades → contactos → negocios
app.post('/migrate/all', auth, async (_req, res) => {
  if (fs.existsSync(RAW_CONTACTS)) fs.unlinkSync(RAW_CONTACTS);
  if (fs.existsSync(RAW_UNITS))    fs.unlinkSync(RAW_UNITS);

  const results = {};
  try {
    results.units    = await runScript('migrate-units.js');
    results.contacts = await runScript('migrate-contacts.js');
    results.deals    = await runScript('migrate-deals.js');
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, partial: results });
  }
});

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
