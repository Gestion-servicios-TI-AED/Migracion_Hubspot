const https = require('https');
const fs    = require('fs');
const path  = require('path');
const yaml  = require('js-yaml');

const HS_CONFIG_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.hscli', 'config.yml');
const ENV_FILE       = path.join(__dirname, '..', '.env');

// Lee .env manualmente (sin dependencia extra)
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
}

function loadConfig() {
  return yaml.load(fs.readFileSync(HS_CONFIG_PATH, 'utf8'));
}

function saveToken(config, account, accessToken, expiresAtMs) {
  account.auth = {
    tokenInfo: {
      accessToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
  fs.writeFileSync(HS_CONFIG_PATH, yaml.dump(config));
}

function refreshViaPak(pak, portalId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ encodedOAuthRefreshToken: pak });
    const req = https.request({
      hostname: 'api.hubapi.com',
      path: `/localdevauth/v1/auth/refresh?portalId=${portalId}`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Token refresh failed (${res.statusCode}): ${data.substring(0, 200)}`));
        }
        const d = JSON.parse(data);
        if (!d.oauthAccessToken) return reject(new Error('No oauthAccessToken in refresh response'));
        resolve({ accessToken: d.oauthAccessToken, expiresAtMs: d.expiresAtMillis });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  loadEnv();

  // Prioridad 1: token de clave de servicio en .env (permanente, no expira)
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    return process.env.HUBSPOT_ACCESS_TOKEN;
  }

  // Prioridad 2: token del CLI con auto-refresh via PAK
  const config  = loadConfig();
  const account = config.accounts.find(a => a.accountId === config.defaultAccount);
  if (!account) throw new Error('No default account found. Run: hs account auth');

  const token     = account?.auth?.tokenInfo?.accessToken;
  const expiresAt = new Date(account?.auth?.tokenInfo?.expiresAt || 0);
  const pak       = account.personalAccessKey;

  if (!pak) throw new Error('No personalAccessKey in config. Run: hs account auth');

  const twoMinutes = 2 * 60 * 1000;
  if (token && expiresAt > new Date(Date.now() + twoMinutes)) {
    return token;
  }

  process.stdout.write('🔄 Renovando token HubSpot... ');
  try {
    const { accessToken, expiresAtMs } = await refreshViaPak(pak, account.accountId);
    saveToken(config, account, accessToken, expiresAtMs);
    console.log('✅\n');
    return accessToken;
  } catch (e) {
    throw new Error(`No se pudo renovar el token: ${e.message}\nIntenta: hs account auth`);
  }
}

module.exports = { getAccessToken };
