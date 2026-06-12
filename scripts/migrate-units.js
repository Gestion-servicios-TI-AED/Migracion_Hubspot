const https = require('https');
const fs = require('fs');
const path = require('path');
const { getAccessToken } = require('./auth');

// ── Config ────────────────────────────────────────────────────────────────────
const OBJECT_TYPE_ID = '2-62473196';
const SMARTHOME_URL  = 'https://api.smart-home.com.co/api/v1/getUnits/588652b8/e8fd1240';
const BATCH_SIZE     = 100;
const RAW_FILE       = path.join(__dirname, '..', 'data', 'units_raw.json');
const LOG_FILE       = path.join(__dirname, '..', 'logs', 'migration_log.json');

// ── SmartHome fetch ───────────────────────────────────────────────────────────
function fetchSmartHome() {
  return new Promise((resolve, reject) => {
    https.get(SMARTHOME_URL, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const d = JSON.parse(body);
        if (!d.units) reject(new Error('No units in response: ' + body.substring(0, 200)));
        else resolve(d.units);
      });
    }).on('error', reject);
  });
}

// ── Mapeo de valores ──────────────────────────────────────────────────────────
const STATUS_MAP = { 1: 'Disponible', 2: 'Separado', 3: 'Vendido', 4: 'Reservado' };

function mapBedrooms(n) {
  if (n === 0) return 'Studio (0)';
  if (n >= 5)  return '5+';
  return String(n);
}

function mapBathrooms(n) {
  if (n >= 4) return '4+';
  return String(n);
}

function mapType(type) {
  if (!type) return null;
  return `Tipo ${type}`; // "A" → "Tipo A", "B" → "Tipo B"
}

function cleanCode(code) {
  if (!code) return code;
  // "TORRE 1 Apto 0801" → "T1 Apto 0801"
  return code.replace(/^TORRE\s+(\d+)\s+/i, 'T$1 ').trim();
}

// ── Transformar unidad SmartHome → propiedades HubSpot ───────────────────────
function transform(unit) {
  const props = {
    codigo_unidad:          cleanCode(unit.code),
    piso:                   unit.floor,
    torre:                  unit.building,
    private_area_m2:        unit.privateArea   || undefined,
    terrace_area_m2:        unit.balconyArea    || undefined,
    // built_area_m2 es calculado en HubSpot — no se puede escribir
    unit_price:             unit.price          || undefined,
    valor_unidad_comercial: unit.totalPrice     || undefined,
    number_bedrooms:        mapBedrooms(unit.bedroom),
    number_bathrooms:       mapBathrooms(unit.bathrooms),
    tipo_de_apartamento:    mapType(unit.type),
    smarthome_module_id:    unit.moduleId,
    no_garajes:             unit.garageNumber   || undefined,
    no_depositos:           unit.storageNumber  || undefined,
    property_type:          'Apartamento',
  };

  if (STATUS_MAP[unit.status])  props.unit_status  = STATUS_MAP[unit.status];
  if (unit.propertyView)        props.view_type     = unit.propertyView;
  if (unit.scheduledForDelivery) props.fecha_entrega = unit.scheduledForDelivery;

  return Object.fromEntries(
    Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

// ── Llamada batch HubSpot (upsert: crea si no existe, actualiza si ya existe) ──
function hubspotRequest(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.hubapi.com',
      path:     apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function batchUpsert(token, inputs) {
  const upsertInputs = inputs.map(({ properties }) => ({
    idProperty: 'codigo_unidad',
    id:         properties.codigo_unidad,
    properties,
  }));
  return hubspotRequest(token, 'POST', `/crm/v3/objects/${OBJECT_TYPE_ID}/batch/upsert`, { inputs: upsertInputs });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function migrate() {
  console.log('🚀 Iniciando migración SmartHome → HubSpot Unidades\n');

  // 1. Token
  let token;
  try {
    token = await getAccessToken();
    console.log('✅ Token listo\n');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }

  // 2. Fetch unidades (usa cache si existe)
  let units;
  if (fs.existsSync(RAW_FILE)) {
    units = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8')).units;
    console.log(`📦 Cache: ${units.length} unidades (${RAW_FILE})`);
  } else {
    console.log('📡 Obteniendo unidades de SmartHome...');
    units = await fetchSmartHome();
    fs.mkdirSync(path.dirname(RAW_FILE), { recursive: true });
    fs.writeFileSync(RAW_FILE, JSON.stringify({ units }, null, 2));
    console.log(`✅ ${units.length} unidades guardadas en data/units_raw.json`);
  }

  // 3. Transformar (uso: node scripts/migrate-units.js --limit=2)
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
  const slice = limit ? units.slice(0, limit) : units;
  const inputs = slice.map(u => ({ properties: transform(u) }));

  console.log(`\n🔄 ${inputs.length}${limit ? ` (prueba, de ${units.length} totales)` : ''} unidades transformadas`);

  // 4. Subir en lotes
  const log = { total: slice.length, created: 0, errors: [], batches: [] };
  const totalBatches = Math.ceil(inputs.length / BATCH_SIZE);

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch    = inputs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const from     = i + 1;
    const to       = Math.min(i + BATCH_SIZE, inputs.length);

    process.stdout.write(`  Lote ${batchNum}/${totalBatches} (${from}-${to})... `);

    try {
      const res = await batchUpsert(token, batch);
      if (res.status === 200 || res.status === 201) {
        const count = res.body.results?.length || 0;
        log.created += count;
        log.batches.push({ batch: batchNum, status: 'ok', count });
        console.log(`✅ ${count} procesadas`);
      } else {
        const errMsg = res.body.message || JSON.stringify(res.body).substring(0, 300);
        log.errors.push({ batch: batchNum, status: res.status, error: errMsg });
        log.batches.push({ batch: batchNum, status: 'error', message: errMsg });
        console.log(`❌ Error ${res.status}: ${errMsg}`);
      }
    } catch (e) {
      log.errors.push({ batch: batchNum, error: e.message });
      console.log(`❌ ${e.message}`);
    }

    if (batchNum < totalBatches) await new Promise(r => setTimeout(r, 300));
  }

  // 5. Resultado
  console.log('\n─────────────────────────────────────');
  console.log(`✅ Procesadas: ${log.created}/${log.total}`);
  console.log(`❌ Errores:  ${log.errors.length} lotes`);
  console.log(`📄 Log:      logs/migration_log.json`);

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

migrate().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
