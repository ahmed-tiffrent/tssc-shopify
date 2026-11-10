#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.etsy.local');
const backupDir = path.join(root, 'soply-import', 'backups');
const planPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');
const statePath = path.join(root, 'soply-import', 'etsy-image-reconcile-state.json');
const apply = process.argv.includes('--apply');
const includeFallbacks = process.argv.includes('--include-fallbacks');
const limitArg = process.argv.find((value) => value.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const titleFilter = process.argv.find((value) => value.startsWith('--title='))?.slice('--title='.length).toLocaleLowerCase('en-GB') || null;
const pauseMs = Number(process.argv.find((value) => value.startsWith('--pause-ms='))?.split('=')[1] || 160);
const concurrency = Math.max(1, Number(process.argv.find((value) => value.startsWith('--concurrency='))?.split('=')[1] || 1));
const SHOP_ID = 17132311;
const RECONCILE_VERSION = 4;

function latest(prefix) {
  return fs.readdirSync(backupDir).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort().at(-1);
}

function parseEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));
}

function updateEnv(contents, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = contents.split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    if (index < 0) return line;
    const key = line.slice(0, index).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`;
}

function canonical(value) {
  return String(value || '').normalize('NFKD').replace(/[’']/g, '').replace(/\+/g, ' and ')
    .replace(/&/g, ' and ').toLocaleLowerCase('en-GB').replace(/centre/g, 'center')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function cleanUrl(url) {
  const parsed = new URL(url);
  const version = parsed.searchParams.get('v');
  parsed.search = '';
  if (version) parsed.searchParams.set('v', version);
  return parsed.toString();
}

function downloadableUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('width', '2048');
  parsed.searchParams.set('format', 'jpg');
  return parsed.toString();
}

function optionValue(variant, name) {
  return variant.selectedOptions.find((option) => canonical(option.name) === canonical(name))?.value;
}

function isDiagram(url) { return /size[_-]?diagram/i.test(url); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

let envText = fs.readFileSync(envPath, 'utf8');
const env = parseEnv(envText);
for (const key of ['ETSY_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_REFRESH_TOKEN']) {
  if (!env[key]) throw new Error(`Missing ${key} in .env.etsy.local`);
}

let accessToken = null;
async function refreshToken() {
  const response = await fetch('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.ETSY_KEYSTRING, refresh_token: env.ETSY_REFRESH_TOKEN }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || `Token refresh failed (${response.status})`);
  accessToken = payload.access_token;
  env.ETSY_REFRESH_TOKEN = payload.refresh_token;
  envText = updateEnv(envText, {
    ETSY_ACCESS_TOKEN: payload.access_token,
    ETSY_REFRESH_TOKEN: payload.refresh_token,
    ETSY_TOKEN_SCOPE: payload.scope || env.ETSY_TOKEN_SCOPE,
  });
  fs.writeFileSync(envPath, envText, { mode: 0o600 });
}

await refreshToken();

async function etsy(pathname, { method = 'GET', multipart, json, retry = 0 } = {}) {
  await sleep(pauseMs);
  const headers = {
    'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`,
    authorization: `Bearer ${accessToken}`,
  };
  if (multipart instanceof URLSearchParams) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (json) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`https://api.etsy.com/v3/application${pathname}`, { method, headers, body: json ? JSON.stringify(json) : multipart });
  } catch (error) {
    if (retry >= 6) throw error;
    await sleep(Math.min(2 ** retry * 1_000, 30_000));
    return etsy(pathname, { method, multipart, json, retry: retry + 1 });
  }
  if (response.status === 401 && retry < 1) {
    await refreshToken();
    return etsy(pathname, { method, multipart, json, retry: retry + 1 });
  }
  if ((response.status === 429 || response.status >= 500) && retry < 7) {
    if (response.status === 429) {
      const reason = await response.clone().text();
      if (/daily rate limit/i.test(reason)) throw new Error('Etsy daily rate limit reached; resume from saved progress after quota resets.');
    }
    const wait = Number(response.headers.get('retry-after') || 2 ** retry) * 1_000;
    await sleep(Math.min(wait, 60_000));
    return etsy(pathname, { method, multipart, json, retry: retry + 1 });
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${payload?.error || text}`);
  return payload;
}

const shopifyBackupName = latest('shopify-products-before-etsy-sync-');
if (!shopifyBackupName) throw new Error('No Shopify product export found.');
const shopifyBackup = JSON.parse(fs.readFileSync(path.join(backupDir, shopifyBackupName), 'utf8'));
const products = new Map(shopifyBackup.products.map((product) => [product.id, product]));
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { listings: {} };
const knownAssets = new Map();
for (const record of Object.values(state.listings)) {
  (record.urls || []).forEach((url, index) => {
    if (record.image_ids?.[index]) knownAssets.set(url, record.image_ids[index]);
  });
}
for (const [url, id] of Object.entries(state.assets || {})) knownAssets.set(url, id);

function saveState() {
  state.shopify_backup = shopifyBackupName;
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function sizeDiagram(product) {
  if (/^Seconds$|^Punchinella\b/i.test(product.title)) return null;
  let source = product;
  if (/100% Recycled Plastic$/i.test(product.title)) {
    const counterpartTitle = product.title.replace(/100% Recycled Plastic$/i, '20% Recycled Plastic');
    const counterpart = [...products.values()].find((candidate) => canonical(candidate.title) === canonical(counterpartTitle));
    if (counterpart) source = counterpart;
  }
  return source.media.nodes.find((media) => media.image?.url && isDiagram(media.image.url))?.image.url || null;
}

function desiredImages(product, target) {
  if (target.role === 'master') {
    const images = product.media.nodes.filter(media => media.image?.url && !isDiagram(media.image.url)).map(media => media.image.url);
    const variants = product.variants.nodes.flatMap(variant => variant.media.nodes || []).filter(media => media.image?.url).map(media => media.image.url);
    return { exact: true, urls: [...new Set([images[0], sizeDiagram(product), ...variants, ...images.slice(1)].filter(Boolean).map(cleanUrl))].slice(0, 20) };
  }
  const variants = product.variants.nodes.filter((variant) => canonical(optionValue(variant, 'Colour')) === canonical(target.colour));
  const variantImage = variants.flatMap((variant) => variant.media.nodes || []).find((media) => media.image?.url)?.image.url || null;
  const fallback = product.media.nodes.find((media) => media.image?.url && !isDiagram(media.image.url))?.image.url || null;
  const first = variantImage || (includeFallbacks ? fallback : null);
  return {
    exact: Boolean(variantImage),
    urls: [...new Set([first, sizeDiagram(product)].filter(Boolean).map(cleanUrl))],
  };
}

async function uploadImage(listingId, url, rank, alt) {
  const form = new FormData();
  if (knownAssets.has(url)) {
    form.append('listing_image_id', String(knownAssets.get(url)));
  } else {
    const response = await fetch(downloadableUrl(url));
    if (!response.ok) throw new Error(`Could not download Shopify image (${response.status}): ${url}`);
    form.append('image', new Blob([await response.arrayBuffer()], { type: 'image/jpeg' }), 'shopify-product.jpg');
  }
  form.append('rank', String(rank));
  form.append('alt_text', alt.slice(0, 500));
  const uploaded = await etsy(`/shops/${SHOP_ID}/listings/${listingId}/images`, { method: 'POST', multipart: form });
  knownAssets.set(url, Number(uploaded.listing_image_id));
  state.assets ||= {};
  state.assets[url] = Number(uploaded.listing_image_id);
  saveState();
  return uploaded;
}

const candidates = [];
for (const target of plan.targets) {
  if (!target.etsy_listing_id) continue;
  const title = [target.shopify_product_title, target.colour].filter(Boolean).join(' | ');
  if (titleFilter && !title.toLocaleLowerCase('en-GB').includes(titleFilter)) continue;
  const product = products.get(target.shopify_product_id);
  if (!product) continue;
  const desired = desiredImages(product, target);
  if (!desired.urls.length) continue;
  if (!desired.exact && !includeFallbacks) continue;
  candidates.push({ target, product, title, ...desired });
}

const pending = candidates.filter(({ target, urls }) => {
  const record = state.listings[String(target.etsy_listing_id)];
  return record?.status !== 'complete' || record.reconcile_version !== RECONCILE_VERSION
    || record.shopify_backup !== shopifyBackupName || JSON.stringify(record.urls) !== JSON.stringify(urls);
});

console.log(`Shopify export: ${shopifyBackupName}`);
console.log(`Eligible image listings: ${candidates.length}; pending: ${pending.length}; mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
if (!apply) {
  for (const item of pending.slice(0, 20)) console.log(`${item.target.etsy_listing_id}: ${item.title}`);
  if (pending.length > 20) console.log(`...and ${pending.length - 20} more`);
  process.exit(0);
}

let completed = 0;
let failed = 0;
let started = 0;
const work = pending.slice(0, limit);

async function reconcile(item) {
  const listingId = Number(item.target.etsy_listing_id);
  const record = state.listings[String(listingId)] ||= {};
  try {
    started += 1;
    console.log(`[${started}/${work.length}] ${item.title}`);
    const currentImages = await etsy(`/listings/${listingId}/images`);
    const originals = (currentImages.results || []).sort((a,b) => a.rank-b.rank);
    record.before_images ||= originals;
    saveState();
    const originalIds = originals.map((image) => Number(image.listing_image_id));
    const liveIds = new Set(originalIds);
    const desiredKnown = new Set(item.urls.map(url => knownAssets.get(url)).filter(Boolean));
    const uploadedIds = [];
    for (let index = 0; index < item.urls.length; index += 1) {
      const knownId = knownAssets.get(item.urls[index]);
      if (knownId && originalIds[index] === knownId && uploadedIds.every((id,i) => originalIds[i] === id)) {
        uploadedIds.push(knownId);
        continue;
      }
      if (!liveIds.has(knownId) && liveIds.size >= 20) {
        const removable = [...liveIds].find(id => !desiredKnown.has(id) && !uploadedIds.includes(id));
        if (!removable) throw new Error('No obsolete image slot available');
        await etsy(`/shops/${SHOP_ID}/listings/${listingId}/images/${removable}`, { method: 'DELETE' });
        liveIds.delete(removable);
      }
      const uploaded = await uploadImage(listingId, item.urls[index], index + 1, `${item.title}${isDiagram(item.urls[index]) ? ' size guide' : index ? ' product detail' : ''}`);
      uploadedIds.push(Number(uploaded.listing_image_id));
      liveIds.add(Number(uploaded.listing_image_id));
    }
    for (const imageId of originalIds) {
      if (uploadedIds.includes(imageId) || !liveIds.has(imageId)) continue;
      await etsy(`/shops/${SHOP_ID}/listings/${listingId}/images/${imageId}`, { method: 'DELETE' });
    }
    const ordering = new URLSearchParams();
    ordering.append('image_ids', uploadedIds.join(','));
    await etsy(`/shops/${SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', multipart: ordering });
    const verified = await etsy(`/listings/${listingId}/images`);
    const actualIds = (verified.results || []).sort((a,b) => a.rank-b.rank).map(image => Number(image.listing_image_id));
    if (JSON.stringify(actualIds) !== JSON.stringify(uploadedIds)) throw new Error('Image order verification failed');
    if (item.target.role === 'master') {
      const inventory = await etsy(`/listings/${listingId}/inventory`);
      const links = new Map();
      for (const entry of inventory.products || []) {
        const value = entry.property_values?.find(v => canonical(v.property_name) === 'colour');
        if (!value?.value_ids?.[0]) continue;
        const variant = item.product.variants.nodes.find(v => canonical(optionValue(v, 'Colour')) === canonical(value.values?.[0]) && v.media.nodes.some(m => m.image?.url));
        const url = variant?.media.nodes.find(m => m.image?.url)?.image.url;
        const index = url ? item.urls.indexOf(cleanUrl(url)) : -1;
        if (index >= 0) links.set(value.value_ids[0], { property_id: value.property_id, value_id: value.value_ids[0], image_id: uploadedIds[index] });
      }
      if (links.size) await etsy(`/shops/${SHOP_ID}/listings/${listingId}/variation-images`, { method: 'POST', json: { variation_images: [...links.values()].slice(0,20) } });
    }
    record.status = 'complete';
    record.reconcile_version = RECONCILE_VERSION;
    record.shopify_backup = shopifyBackupName;
    record.urls = item.urls;
    record.image_ids = uploadedIds;
    record.completed_at = new Date().toISOString();
    delete record.error;
    saveState();
    completed += 1;
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    record.failed_at = new Date().toISOString();
    saveState();
    console.error(`FAILED ${item.title}: ${error.message}`);
    failed += 1;
  }
}

const queue = [...work];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length && failed < 5) await reconcile(queue.shift());
}));

console.log(`Completed: ${completed}; failed: ${failed}; remaining: ${Math.max(0, pending.length - completed)}`);
if (failed) process.exitCode = 1;
