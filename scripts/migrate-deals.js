const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const { getAccessToken } = require('./auth');

// ── Config ────────────────────────────────────────────────────────────────────
const SMARTHOME_URL  = 'https://api.smart-home.com.co/api/v1/getSales/588652b8/e8fd1240';
const PIPELINE_ID    = '907963311';
const STAGE_MAP      = { 'Separación': '1378705460' };
const STAGE_DEFAULT  = '1378705460';
const BATCH_SIZE     = 100;
const RAW_FILE       = path.join(__dirname, '..', 'data', 'contacts_raw.json');
const LOG_FILE       = path.join(__dirname, '..', 'logs', 'migration_deals_log.json');

// ── SmartHome fetch (gzip) ────────────────────────────────────────────────────
function fetchSmartHome() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.smart-home.com.co',
      path: '/api/v1/getSales/588652b8/e8fd1240',
      method: 'GET',
    }, res => {
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      let body = '';
      stream.on('data', c => body += c);
      stream.on('end', () => {
        const d = JSON.parse(body);
        if (!d.prospects) reject(new Error('No prospects in response'));
        else resolve(d.prospects);
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Llamada HubSpot ───────────────────────────────────────────────────────────
function hubspotRequest(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hubapi.com',
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
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

// ── Asegurar propiedades personalizadas en deals ──────────────────────────────
async function ensureProperty(token, objectType, def) {
  const res = await hubspotRequest(token, 'GET', `/crm/v3/properties/${objectType}/${def.name}`);
  if (res.status === 200) { console.log(`  ✅ ${def.name} ya existe`); return; }
  const create = await hubspotRequest(token, 'POST', `/crm/v3/properties/${objectType}`, def);
  if (create.status === 201) console.log(`  ✅ ${def.name} creado`);
  else throw new Error(`No se pudo crear ${def.name}: ${JSON.stringify(create.body).substring(0, 200)}`);
}

async function ensureProperties(token) {
  await ensureProperty(token, 'deals', {
    name: 'smarthome_prospect_id', label: 'SmartHome Prospect ID',
    type: 'string', fieldType: 'text', groupName: 'dealinformation',
    description: 'ID del prospecto en SmartHome — clave única por negocio',
    hasUniqueValue: true,
  });
  await ensureProperty(token, 'deals', {
    name: 'smarthome_created_date', label: 'SmartHome Fecha de Creación',
    type: 'date', fieldType: 'date', groupName: 'dealinformation',
    description: 'Fecha en que se creó el prospecto en SmartHome',
  });
}

// ── Transformar prospect → propiedades de negocio ─────────────────────────────
function cleanModuleName(module) {
  if (!module) return module;
  return module.replace(/^TORRE\s+(\d+)\s+/i, 'T$1 ').trim();
}

function transform(prospect) {
  const stage = STAGE_MAP[prospect.stageName] || STAGE_DEFAULT;
  const name  = `Alegra - ${(prospect.firstName || '').trim()} ${(prospect.lastName || '').trim()} - ${cleanModuleName(prospect.module)}`.trim();

  const props = {
    dealname:              name,
    pipeline:              PIPELINE_ID,
    dealstage:             stage,
    amount:                prospect.totalValue    || undefined,
    smarthome_prospect_id: prospect.prospectId,
    cuota_inicial:         prospect.downpayment   || undefined,
    aed_separation_payment_amount: prospect.deposit || undefined,
    ed_quote_amount:       prospect.offerPrice    || undefined,
  };

  if (prospect.closeDate)    props.closedate = new Date(prospect.closeDate).getTime();
  if (prospect.createdDate) {
    const [y, m, d] = prospect.createdDate.substring(0, 10).split('-').map(Number);
    props.smarthome_created_date = Date.UTC(y, m - 1, d);
  }
  if (prospect.agreementNumber) props.aed_trust_form_number = prospect.agreementNumber;

  return Object.fromEntries(
    Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
  );
}

// ── Upsert lote de negocios ───────────────────────────────────────────────────
function batchUpsert(token, inputs) {
  const upsertInputs = inputs.map(({ properties }) => ({
    idProperty: 'smarthome_prospect_id',
    id:         properties.smarthome_prospect_id,
    properties,
  }));
  return hubspotRequest(token, 'POST', '/crm/v3/objects/deals/batch/upsert', { inputs: upsertInputs });
}

// ── Obtener mapa prospectId → HubSpot contact ID ──────────────────────────────
async function buildContactMap(token) {
  const map = {};
  let after = null;
  do {
    const qs  = `?limit=100&properties=smarthome_prospect_id${after ? `&after=${after}` : ''}`;
    const res = await hubspotRequest(token, 'GET', `/crm/v3/objects/contacts${qs}`);
    if (res.status !== 200) throw new Error(`Error leyendo contactos: ${res.status}`);
    (res.body.results || []).forEach(r => {
      const pid = r.properties?.smarthome_prospect_id;
      if (pid) map[pid] = r.id;
    });
    after = res.body.paging?.next?.after || null;
  } while (after);
  return map;
}

// ── Obtener mapa moduleId → HubSpot unit ID ───────────────────────────────────
async function buildUnitMap(token) {
  const map = {};
  let after = null;
  do {
    const qs  = `?limit=100&properties=smarthome_module_id${after ? `&after=${after}` : ''}`;
    const res = await hubspotRequest(token, 'GET', `/crm/v3/objects/2-62473196${qs}`);
    if (res.status !== 200) throw new Error(`Error leyendo unidades: ${res.status}`);
    (res.body.results || []).forEach(r => {
      const mid = r.properties?.smarthome_module_id;
      if (mid) map[mid] = r.id;
    });
    after = res.body.paging?.next?.after || null;
  } while (after);
  return map;
}

// ── Obtener mapa prospectId → HubSpot deal ID ─────────────────────────────────
async function buildDealMap(token) {
  const map = {};
  let after = null;
  do {
    const qs  = `?limit=100&properties=smarthome_prospect_id${after ? `&after=${after}` : ''}`;
    const res = await hubspotRequest(token, 'GET', `/crm/v3/objects/deals${qs}`);
    if (res.status !== 200) throw new Error(`Error leyendo negocios: ${res.status}`);
    (res.body.results || []).forEach(r => {
      const pid = r.properties?.smarthome_prospect_id;
      if (pid) map[pid] = r.id;
    });
    after = res.body.paging?.next?.after || null;
  } while (after);
  return map;
}

// ── Crear asociaciones en lote ────────────────────────────────────────────────
const ASSOC_TYPES = {
  'deals-contacts':    { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3   },
  'deals-2-62473196':  { associationCategory: 'USER_DEFINED',    associationTypeId: 121 },
};

function batchAssociate(token, fromType, toType, pairs) {
  const typeConfig = ASSOC_TYPES[`${fromType}-${toType}`] || { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 };
  const inputs = pairs.map(({ fromId, toId }) => ({
    from:  { id: fromId },
    to:    { id: toId },
    types: [typeConfig],
  }));
  return hubspotRequest(token, 'POST', `/crm/v4/associations/${fromType}/${toType}/batch/create`, { inputs });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function migrate() {
  console.log('🚀 Iniciando migración SmartHome → HubSpot Negocios\n');

  // 1. Token
  let token;
  try {
    token = await getAccessToken();
    console.log('✅ Token listo\n');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }

  // 2. Verificar propiedades
  console.log('🔧 Verificando propiedades en HubSpot...');
  try { await ensureProperties(token); } catch (e) { console.error('❌', e.message); process.exit(1); }

  // 3. Fetch prospects (usa cache si existe)
  let prospects;
  if (fs.existsSync(RAW_FILE)) {
    prospects = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8')).prospects;
    console.log(`\n📦 Cache: ${prospects.length} prospects (${RAW_FILE})`);
  } else {
    console.log('\n📡 Obteniendo prospects de SmartHome...');
    prospects = await fetchSmartHome();
    fs.mkdirSync(path.dirname(RAW_FILE), { recursive: true });
    fs.writeFileSync(RAW_FILE, JSON.stringify({ prospects }, null, 2));
    console.log(`✅ ${prospects.length} prospects guardados`);
  }

  // 4. Transformar
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit  = limitArg ? parseInt(limitArg.split('=')[1]) : null;
  const slice  = limit ? prospects.slice(0, limit) : prospects;
  const inputs = slice.map(p => ({ properties: transform(p) }));
  console.log(`\n🔄 ${inputs.length}${limit ? ` (prueba, de ${prospects.length} totales)` : ''} negocios transformados`);

  // 5. Upsert negocios en lotes
  const log = { total: slice.length, processed: 0, errors: [], associations: { contacts: 0, units: 0 } };
  const totalBatches = Math.ceil(inputs.length / BATCH_SIZE);

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch    = inputs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`  Lote ${batchNum}/${totalBatches} (${i+1}-${Math.min(i+BATCH_SIZE, inputs.length)})... `);
    try {
      const res = await batchUpsert(token, batch);
      if (res.status === 200 || res.status === 201) {
        const count = res.body.results?.length || 0;
        log.processed += count;
        console.log(`✅ ${count} procesados`);
      } else {
        const errMsg = res.body.message || JSON.stringify(res.body).substring(0, 300);
        log.errors.push({ batch: batchNum, status: res.status, error: errMsg });
        console.log(`❌ Error ${res.status}: ${errMsg}`);
      }
    } catch (e) {
      log.errors.push({ batch: batchNum, error: e.message });
      console.log(`❌ ${e.message}`);
    }
    if (batchNum < totalBatches) await new Promise(r => setTimeout(r, 300));
  }

  if (log.errors.length > 0) {
    console.log('\n⚠️  Hubo errores en la creación — omitiendo asociaciones.');
    finalize(log);
    return;
  }

  // 6. Construir mapas de IDs
  console.log('\n🔗 Construyendo mapas de IDs para asociaciones...');
  const [contactMap, unitMap, dealMap] = await Promise.all([
    buildContactMap(token),
    buildUnitMap(token),
    buildDealMap(token),
  ]);
  console.log(`   Contactos: ${Object.keys(contactMap).length} | Unidades: ${Object.keys(unitMap).length} | Negocios: ${Object.keys(dealMap).length}`);

  // 7. Asociar negocios → contactos
  console.log('\n🔗 Asociando negocios con contactos...');
  const dealContactPairs = [];
  slice.forEach(p => {
    const dealId    = dealMap[p.prospectId];
    const contactId = contactMap[p.prospectId];
    if (dealId && contactId) dealContactPairs.push({ fromId: dealId, toId: contactId });
  });

  for (let i = 0; i < dealContactPairs.length; i += BATCH_SIZE) {
    const batch = dealContactPairs.slice(i, i + BATCH_SIZE);
    const res   = await batchAssociate(token, 'deals', 'contacts', batch);
    if (res.status === 200 || res.status === 201) {
      log.associations.contacts += batch.length;
      process.stdout.write(`  ✅ ${Math.min(i+BATCH_SIZE, dealContactPairs.length)}/${dealContactPairs.length}\r`);
    } else {
      console.log(`  ❌ Error asociando contactos: ${res.status} ${JSON.stringify(res.body).substring(0,200)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\n  ✅ ${log.associations.contacts} negocios asociados a contactos`);

  // 8. Asociar negocios → unidades
  console.log('\n🔗 Asociando negocios con unidades...');
  const dealUnitPairs = [];
  slice.forEach(p => {
    const dealId = dealMap[p.prospectId];
    const unitId = unitMap[p.moduleId];
    if (dealId && unitId) dealUnitPairs.push({ fromId: dealId, toId: unitId });
  });

  for (let i = 0; i < dealUnitPairs.length; i += BATCH_SIZE) {
    const batch = dealUnitPairs.slice(i, i + BATCH_SIZE);
    const res   = await batchAssociate(token, 'deals', '2-62473196', batch);
    if (res.status === 200 || res.status === 201) {
      log.associations.units += batch.length;
      process.stdout.write(`  ✅ ${Math.min(i+BATCH_SIZE, dealUnitPairs.length)}/${dealUnitPairs.length}\r`);
    } else {
      console.log(`  ❌ Error asociando unidades: ${res.status} ${JSON.stringify(res.body).substring(0,200)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\n  ✅ ${log.associations.units} negocios asociados a unidades`);

  finalize(log);
}

function finalize(log) {
  console.log('\n─────────────────────────────────────');
  console.log(`✅ Procesados:  ${log.processed}/${log.total}`);
  console.log(`🔗 → Contactos: ${log.associations.contacts}`);
  console.log(`🔗 → Unidades:  ${log.associations.units}`);
  console.log(`❌ Errores:     ${log.errors.length} lotes`);
  console.log(`📄 Log:         logs/migration_deals_log.json`);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

migrate().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
