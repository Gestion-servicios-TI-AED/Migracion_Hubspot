const express = require('express');
const https   = require('https');
const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET;

// Si se configura, el servidor rechaza cualquier request si el token
// de HubSpot no corresponde exactamente a este portal.
const EXPECTED_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;

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

// ── Verificar que el token apunta al portal correcto ─────────────────────────
// Evita correr la sincronización contra un portal equivocado por error.
function verifyPortal() {
  return new Promise((resolve, reject) => {
    if (!EXPECTED_PORTAL_ID) return resolve(); // sin restricción configurada

    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) return reject(new Error('HUBSPOT_ACCESS_TOKEN no configurado'));

    const req = https.request({
      hostname: 'api.hubapi.com',
      path:     '/account-info/v3/details',
      method:   'GET',
      headers:  { 'Authorization': `Bearer ${token}` },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          if (String(body.portalId) !== String(EXPECTED_PORTAL_ID)) {
            reject(new Error(
              `Portal incorrecto — esperado: ${EXPECTED_PORTAL_ID}, obtenido: ${body.portalId}. ` +
              `Verifica que HUBSPOT_ACCESS_TOKEN y HUBSPOT_PORTAL_ID correspondan al mismo portal.`
            ));
          } else {
            resolve();
          }
        } catch {
          reject(new Error('No se pudo verificar el portal de HubSpot'));
        }
      });
    });
    req.on('error', () => reject(new Error('Error de conexión al verificar el portal')));
    req.end();
  });
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
    await verifyPortal();
    const output = await runScript('migrate-units.js');
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/migrate/contacts', auth, async (_req, res) => {
  try {
    await verifyPortal();
    const output = await runScript('migrate-contacts.js');
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/migrate/deals', auth, async (_req, res) => {
  try {
    await verifyPortal();
    const output = await runScript('migrate-deals.js');
    res.json({ success: true, output });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sincronización completa — orden obligatorio: unidades → contactos → negocios
// Los negocios se asocian a unidades y contactos, que deben existir primero.
app.post('/migrate/all', auth, async (_req, res) => {
  try {
    await verifyPortal();
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }

  // Borrar caches para traer datos frescos de SmartHome
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
