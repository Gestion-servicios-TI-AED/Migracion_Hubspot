const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { getAccessToken } = require('./auth');

const BATCH_SIZE = 100;
const LOG_FILE   = path.join(__dirname, '..', 'logs', 'clean_deals_log.json');

function hubspotRequest(token, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hubapi.com', path: apiPath, method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
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

async function getAllDealIds(token) {
  const ids = [];
  let after = null;
  do {
    const qs  = `?limit=100&properties=smarthome_prospect_id${after ? `&after=${after}` : ''}`;
    const res = await hubspotRequest(token, 'GET', `/crm/v3/objects/deals${qs}`);
    if (res.status !== 200) throw new Error(`Error al obtener negocios: ${res.status}`);
    (res.body.results || [])
      .filter(r => r.properties?.smarthome_prospect_id)
      .forEach(r => ids.push({ id: r.id }));
    after = res.body.paging?.next?.after || null;
  } while (after);
  return ids;
}

async function clean() {
  console.log('🧹 Limpiando negocios SmartHome del sandbox HubSpot\n');

  if (!process.argv.includes('--confirm')) {
    console.log('⚠️  Esta acción eliminará todos los negocios importados desde SmartHome.');
    console.log('   Para confirmar:\n');
    console.log('   node scripts/clean-deals.js --confirm\n');
    process.exit(0);
  }

  let token;
  try { token = await getAccessToken(); console.log('✅ Token listo\n'); }
  catch (e) { console.error('❌', e.message); process.exit(1); }

  console.log('📋 Obteniendo negocios SmartHome...');
  let allIds;
  try { allIds = await getAllDealIds(token); }
  catch (e) { console.error('❌', e.message); process.exit(1); }

  if (allIds.length === 0) { console.log('✅ No hay negocios para eliminar.'); process.exit(0); }
  console.log(`🗑  ${allIds.length} negocios encontrados. Eliminando...\n`);

  const log = { total: allIds.length, deleted: 0, errors: [] };
  const totalBatches = Math.ceil(allIds.length / BATCH_SIZE);

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch    = allIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`  Lote ${batchNum}/${totalBatches}... `);
    const res = await hubspotRequest(token, 'POST', '/crm/v3/objects/deals/batch/archive', { inputs: batch });
    if (res.status === 204 || res.status === 200) {
      log.deleted += batch.length;
      console.log(`✅ ${batch.length} eliminados`);
    } else {
      const err = res.body?.message || JSON.stringify(res.body).substring(0,200);
      log.errors.push({ batch: batchNum, error: err });
      console.log(`❌ ${err}`);
    }
    if (batchNum < totalBatches) await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n─────────────────────────────────────');
  console.log(`🗑  Eliminados: ${log.deleted}/${log.total}`);
  console.log(`❌ Errores:    ${log.errors.length} lotes`);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

clean().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
