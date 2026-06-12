const https = require('https');
const fs = require('fs');
const path = require('path');
const { getAccessToken } = require('./auth');

// ── Config ────────────────────────────────────────────────────────────────────
const OBJECT_TYPE_ID = '2-62473196';
const BATCH_SIZE     = 100;
const LOG_FILE       = path.join(__dirname, '..', 'logs', 'clean_log.json');

// ── Llamadas HubSpot ──────────────────────────────────────────────────────────
function hubspotRequest(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.hubapi.com',
      path: apiPath,
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

// ── Obtener todos los IDs de unidades (con paginación) ────────────────────────
async function getAllUnitIds(token) {
  const ids = [];
  let after = null;

  do {
    const qs = `?limit=100&properties=codigo_unidad${after ? `&after=${after}` : ''}`;
    const res = await hubspotRequest(token, 'GET', `/crm/v3/objects/${OBJECT_TYPE_ID}${qs}`);

    if (res.status !== 200) {
      throw new Error(`Error al obtener unidades: ${res.status} ${JSON.stringify(res.body).substring(0, 200)}`);
    }

    const results = res.body.results || [];
    results.forEach(r => ids.push({ id: r.id, code: r.properties?.codigo_unidad || r.id }));

    after = res.body.paging?.next?.after || null;
  } while (after);

  return ids;
}

// ── Eliminar lote de unidades ─────────────────────────────────────────────────
function batchArchive(token, ids) {
  return hubspotRequest(
    token, 'POST',
    `/crm/v3/objects/${OBJECT_TYPE_ID}/batch/archive`,
    { inputs: ids.map(({ id }) => ({ id })) }
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function clean() {
  console.log('🧹 Limpiando todas las Unidades del sandbox HubSpot\n');

  // Confirmación de seguridad
  const args = process.argv.slice(2);
  if (!args.includes('--confirm')) {
    console.log('⚠️  Esta acción eliminará TODAS las unidades del sandbox.');
    console.log('   Para confirmar, ejecuta:\n');
    console.log('   node scripts/clean-units.js --confirm\n');
    process.exit(0);
  }

  // 1. Token
  let token;
  try {
    token = await getAccessToken();
    console.log('✅ Token listo\n');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }

  // 2. Obtener todos los IDs
  console.log('📋 Obteniendo IDs de todas las unidades...');
  let allIds;
  try {
    allIds = await getAllUnitIds(token);
  } catch (e) {
    console.error('❌', e.message);
    process.exit(1);
  }

  if (allIds.length === 0) {
    console.log('✅ No hay unidades para eliminar.');
    process.exit(0);
  }

  console.log(`🗑  ${allIds.length} unidades encontradas. Eliminando...\n`);

  // 3. Eliminar en lotes
  const log = { total: allIds.length, deleted: 0, errors: [], batches: [] };
  const totalBatches = Math.ceil(allIds.length / BATCH_SIZE);

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch    = allIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const from     = i + 1;
    const to       = Math.min(i + BATCH_SIZE, allIds.length);

    process.stdout.write(`  Lote ${batchNum}/${totalBatches} (${from}-${to})... `);

    try {
      const res = await batchArchive(token, batch);
      if (res.status === 204 || res.status === 200) {
        log.deleted += batch.length;
        log.batches.push({ batch: batchNum, status: 'ok', deleted: batch.length });
        console.log(`✅ ${batch.length} eliminadas`);
      } else {
        const errMsg = res.body?.message || JSON.stringify(res.body).substring(0, 200);
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

  // 4. Resultado
  console.log('\n─────────────────────────────────────');
  console.log(`🗑  Eliminadas: ${log.deleted}/${log.total}`);
  console.log(`❌ Errores:    ${log.errors.length} lotes`);
  console.log(`📄 Log:        logs/clean_log.json`);

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

clean().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
