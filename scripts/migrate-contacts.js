const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const { getAccessToken } = require('./auth');
const SMARTHOME_URL   = 'https://api.smart-home.com.co/api/v1/getSales/588652b8/e8fd1240';
const BATCH_SIZE      = 100;
const RAW_FILE        = path.join(__dirname, '..', 'data', 'contacts_raw.json');
const LOG_FILE        = path.join(__dirname, '..', 'logs', 'migration_contacts_log.json');

// ── SmartHome fetch (maneja gzip) ─────────────────────────────────────────────
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
        if (!d.prospects) reject(new Error('No prospects in response: ' + body.substring(0, 200)));
        else resolve(d.prospects);
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Transformar prospect SmartHome → propiedades HubSpot ─────────────────────
function transform(prospect) {
  const props = {
    firstname:              prospect.firstName   || undefined,
    lastname:               prospect.lastName    || undefined,
    phone:                  prospect.phoneNumber || prospect.secondPhoneNumber || undefined,
    mobilephone:            prospect.mobileNumber || undefined,
    address:                prospect.address     || undefined,
    city:                   prospect.city        || undefined,
    identification_number:  prospect.identificationNumber || undefined,
    smarthome_prospect_id:  prospect.prospectId,
    smarthome_customer_id:  prospect.customerId || undefined,
  };

  if (prospect.email) props.email = prospect.email.trim().toLowerCase();

  return Object.fromEntries(
    Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

// ── Llamada genérica HubSpot ──────────────────────────────────────────────────
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

// ── Crear propiedades personalizadas si no existen ────────────────────────────
async function ensureProperty(token, def) {
  const res = await hubspotRequest(token, 'GET', `/crm/v3/properties/contacts/${def.name}`);
  if (res.status === 200) { console.log(`  ✅ ${def.name} ya existe`); return; }
  const create = await hubspotRequest(token, 'POST', '/crm/v3/properties/contacts', def);
  if (create.status === 201) console.log(`  ✅ ${def.name} creado`);
  else throw new Error(`No se pudo crear ${def.name}: ${JSON.stringify(create.body).substring(0, 200)}`);
}

async function ensureProspectIdProperty(token) {
  await ensureProperty(token, {
    name: 'smarthome_prospect_id', label: 'SmartHome Prospect ID',
    type: 'string', fieldType: 'text', groupName: 'contactinformation',
    description: 'ID del prospecto en SmartHome (prospectId)',
    hasUniqueValue: true,
  });
  await ensureProperty(token, {
    name: 'smarthome_customer_id', label: 'SmartHome Customer ID',
    type: 'string', fieldType: 'text', groupName: 'contactinformation',
    description: 'ID del cliente en SmartHome (customerId) — identifica a la persona independiente de la venta',
  });
}

// ── Batch upsert contactos ────────────────────────────────────────────────────
// Siempre usa smarthome_prospect_id como clave para que cada prospecto sea
// un contacto independiente en HubSpot, sin importar si comparten email.
function batchUpsert(token, inputs) {
  const upsertInputs = inputs.map(({ properties }) => ({
    idProperty: 'smarthome_prospect_id',
    id:         properties.smarthome_prospect_id,
    properties,
  }));
  return hubspotRequest(token, 'POST', '/crm/v3/objects/contacts/batch/upsert', { inputs: upsertInputs });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function migrate() {
  console.log('🚀 Iniciando migración SmartHome → HubSpot Contactos\n');

  // 1. Token
  let token;
  try {
    token = await getAccessToken();
    console.log('✅ Token listo\n');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }

  // 2. Asegurar que exista la propiedad smarthome_prospect_id
  console.log('🔧 Verificando propiedades en HubSpot...');
  try {
    await ensureProspectIdProperty(token);
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }

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
    console.log(`✅ ${prospects.length} prospects guardados en data/contacts_raw.json`);
  }

  // 4. Transformar — si dos prospects comparten email, el segundo va sin email
  //    para que ambos existan en HubSpot como contactos separados.
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit  = limitArg ? parseInt(limitArg.split('=')[1]) : null;
  const slice  = limit ? prospects.slice(0, limit) : prospects;

  // Pre-calcular qué emails aparecen más de una vez
  const emailCount = {};
  slice.forEach(p => {
    const e = p.email ? p.email.trim().toLowerCase() : null;
    if (e) emailCount[e] = (emailCount[e] || 0) + 1;
  });
  const emailsDuplicados = new Set(Object.keys(emailCount).filter(e => emailCount[e] > 1));

  if (emailsDuplicados.size > 0) {
    console.log(`\n⚠️  Emails compartidos (se crean sin email para que existan como contactos separados):`);
    emailsDuplicados.forEach(e => {
      const personas = slice.filter(p => p.email && p.email.trim().toLowerCase() === e);
      personas.forEach(p => console.log(`     - ${p.firstName} ${p.lastName} (${p.identificationNumber}) → ${e}`));
    });
    console.log();
  }

  const inputs = slice.map(p => {
    const props = transform(p);
    if (props.email && emailsDuplicados.has(props.email)) {
      delete props.email;
    }
    return { properties: props };
  });

  console.log(`\n🔄 ${inputs.length}${limit ? ` (prueba, de ${prospects.length} totales)` : ''} contactos transformados`);

  // 5. Subir en lotes
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
        console.log(`✅ ${count} procesados`);
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

  // 6. Resultado
  console.log('\n─────────────────────────────────────');
  console.log(`✅ Procesados: ${log.created}/${log.total}`);
  console.log(`❌ Errores:  ${log.errors.length} lotes`);
  console.log(`📄 Log:      logs/migration_contacts_log.json`);

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

migrate().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
