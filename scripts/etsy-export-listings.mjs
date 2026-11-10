#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.etsy.local');
const backupDir = path.join(root, 'soply-import', 'backups');
const states = ['active', 'draft', 'inactive', 'expired', 'sold_out'];

function parseEnv(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => line && !line.trimStart().startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        let value = line.slice(index + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [line.slice(0, index).trim(), value];
      }),
  );
}

function updateEnv(contents, updates) {
  const remaining = new Map(Object.entries(updates));
  const lines = contents.split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    if (index < 0) return line;
    const key = line.slice(0, index).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`;
}

const envText = fs.readFileSync(envPath, 'utf8');
const env = parseEnv(envText);
for (const key of ['ETSY_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_REFRESH_TOKEN']) {
  if (!env[key]) throw new Error(`Missing ${key} in .env.etsy.local`);
}

async function refreshAccessToken() {
  const response = await fetch('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.ETSY_KEYSTRING,
      refresh_token: env.ETSY_REFRESH_TOKEN,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || `Token refresh failed (${response.status})`);
  Object.assign(env, {
    ETSY_ACCESS_TOKEN: payload.access_token,
    ETSY_REFRESH_TOKEN: payload.refresh_token,
    ETSY_TOKEN_SCOPE: payload.scope || env.ETSY_TOKEN_SCOPE,
  });
  fs.writeFileSync(
    envPath,
    updateEnv(envText, {
      ETSY_ACCESS_TOKEN: env.ETSY_ACCESS_TOKEN,
      ETSY_REFRESH_TOKEN: env.ETSY_REFRESH_TOKEN,
      ETSY_TOKEN_SCOPE: env.ETSY_TOKEN_SCOPE,
    }),
    { mode: 0o600 },
  );
}

await refreshAccessToken();

const headers = {
  'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`,
  Authorization: `Bearer ${env.ETSY_ACCESS_TOKEN}`,
};

async function getJson(url) {
  const response = await fetch(url, { headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Etsy request failed (${response.status})`);
  return payload;
}

const me = await getJson('https://api.etsy.com/v3/application/users/me');
const shop = await getJson(`https://api.etsy.com/v3/application/users/${me.user_id}/shops`);
const shopId = shop.shop_id || shop.results?.[0]?.shop_id;
if (!shopId) throw new Error('Could not resolve the authorized Etsy shop.');

const listingsByState = {};
for (const state of states) {
  const listings = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const url = new URL(`https://api.etsy.com/v3/application/shops/${shopId}/listings`);
    url.searchParams.set('state', state);
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('includes', 'Images,Inventory');
    const page = await getJson(url);
    total = page.count;
    listings.push(...page.results);
    offset += page.results.length;
    if (!page.results.length) break;
  }
  listingsByState[state] = listings;
  process.stdout.write(`${state}: ${listings.length}\n`);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(backupDir, `etsy-listings-before-sync-${stamp}.json`);
fs.writeFileSync(
  output,
  `${JSON.stringify({ exported_at: new Date().toISOString(), shop, listings_by_state: listingsByState }, null, 2)}\n`,
  { mode: 0o600 },
);
fs.chmodSync(output, 0o600);
process.stdout.write(`Backup: ${output}\n`);
