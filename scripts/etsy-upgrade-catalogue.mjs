#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ETSY_COLOUR_VALUE_IDS,
  ETSY_CRAFT_TYPE_PROPERTY_ID,
  ETSY_CRAFT_TYPE_VALUE_IDS,
  ETSY_CRAFT_TYPE_VALUES,
  ETSY_PRIMARY_COLOUR_PROPERTY_ID,
  ETSY_SECTION_DEFINITIONS,
  addCatalogueSearchTerms,
  canonicalCatalogueValue,
  colourCategoryFor,
  etsySectionKeyFor,
  etsyTargetTitle,
} from '../punchinella-stock-worker/etsy-catalogue-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDir = path.join(root, 'soply-import', 'backups');
const outputDir = path.join(root, 'soply-import');
const envPath = path.join(root, '.env.etsy.local');
const planPath = path.join(outputDir, 'etsy-sync-plan.json');
const statePath = path.join(outputDir, 'etsy-catalogue-upgrade-state.json');
const reportPath = path.join(outputDir, 'etsy-manual-listing-settings.csv');
const SHOP_ID = 17132311;
const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((value) => value.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const concurrency = Math.max(1, Number(process.argv.find((value) => value.startsWith('--concurrency='))?.split('=')[1] || 4));

function latest(prefix) {
  const name = fs.readdirSync(backupDir).filter((item) => item.startsWith(prefix) && item.endsWith('.json')).sort().at(-1);
  if (!name) throw new Error(`No ${prefix} backup found.`);
  return name;
}

function parseEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith('#') && line.includes('=')).map((line) => {
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

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function uniqueTerms(values, max, maxLength = Infinity) {
  const result = [];
  for (const value of values) {
    const clean = String(value || '').replace(/[^\p{L}\p{N} +'™©®-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
    if (!clean || result.some((item) => canonicalCatalogueValue(item) === canonicalCatalogueValue(clean))) continue;
    result.push(clean);
    if (result.length === max) break;
  }
  return result;
}

let envText = fs.readFileSync(envPath, 'utf8');
const env = parseEnv(envText);
for (const key of ['ETSY_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_REFRESH_TOKEN']) {
  if (!env[key]) throw new Error(`Missing ${key} in .env.etsy.local`);
}

let accessToken = env.ETSY_ACCESS_TOKEN || null;
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

let nextRequestAt = 0;
async function throttle() {
  const wait = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Math.max(nextRequestAt, Date.now()) + 140;
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function etsy(pathname, { method = 'GET', form, retry = 0 } = {}) {
  await throttle();
  const headers = {
    'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`,
    authorization: `Bearer ${accessToken}`,
  };
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = form;
  }
  const response = await fetch(`https://api.etsy.com/v3/application${pathname}`, { method, headers, body });
  if (response.status === 401 && retry < 1) {
    await refreshToken();
    return etsy(pathname, { method, form, retry: retry + 1 });
  }
  if ((response.status === 429 || response.status >= 500) && retry < 8) {
    const delay = Math.min(60_000, Math.max(1_000, Number(response.headers.get('retry-after') || 2 ** retry) * 1_000));
    await new Promise((resolve) => setTimeout(resolve, delay));
    return etsy(pathname, { method, form, retry: retry + 1 });
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${payload?.error || text}`);
  return payload;
}

const shopifyFile = latest('shopify-products-before-etsy-sync-');
const etsyFile = latest('etsy-listings-before-sync-');
const shopify = JSON.parse(fs.readFileSync(path.join(backupDir, shopifyFile), 'utf8'));
const etsyBackup = JSON.parse(fs.readFileSync(path.join(backupDir, etsyFile), 'utf8'));
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const products = new Map(shopify.products.map((product) => [product.id, product]));
const listings = Object.values(etsyBackup.listings_by_state).flat();
const listingsById = new Map(listings.map((listing) => [String(listing.listing_id), listing]));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { completed: {}, errors: {}, sections: {} };

function saveState() {
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

const jobs = plan.targets.map((target) => {
  const product = products.get(target.shopify_product_id);
  const listing = listingsById.get(String(target.etsy_listing_id));
  if (!product) throw new Error(`Missing Shopify product ${target.shopify_product_id}`);
  if (!listing) throw new Error(`Missing Etsy listing ${target.etsy_listing_id}`);
  const category = target.role === 'master' ? 'All colours' : colourCategoryFor(target.colour);
  const sectionKey = etsySectionKeyFor(product.title, target.role);
  if (!sectionKey) throw new Error(`No section rule for ${product.title} (${target.role})`);
  const title = etsyTargetTitle(product.title, target.role, target.colour, target.listing_title);
  const tags = uniqueTerms(addCatalogueSearchTerms(listing.tags || [], target.role, target.colour), 13, 20);
  const materials = uniqueTerms([category, ...(listing.materials || [])], 13, 45);
  const hsCodes = [...new Set(product.variants.nodes.map((variant) => variant.inventoryItem?.harmonizedSystemCode).filter(Boolean))];
  if (hsCodes.length !== 1) throw new Error(`${product.title} does not have one Shopify HS code.`);
  return { target, product, listing, category, sectionKey, title, tags, materials, tariffNumber: hsCodes[0] };
});

const titleCounts = new Map();
for (const job of jobs) titleCounts.set(job.title, (titleCounts.get(job.title) || 0) + 1);
const duplicateTitles = [...titleCounts].filter(([, count]) => count > 1);
if (duplicateTitles.length) throw new Error(`Generated duplicate titles: ${JSON.stringify(duplicateTitles.slice(0, 5))}`);
if (jobs.some((job) => job.title.length > 140)) throw new Error('At least one generated title exceeds 140 characters.');

const reportLines = [['Etsy listing ID', 'New Etsy title', 'Shopify product', 'Shopify HS code', 'Domestic and global pricing', 'Tariff number']];
for (const job of jobs) {
  reportLines.push([job.listing.listing_id, job.title, job.product.title, job.tariffNumber, 'Enable manually on Etsy.com', `Enter ${job.tariffNumber} manually on Etsy.com`]);
}
fs.writeFileSync(reportPath, `${reportLines.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);

const summary = {
  mode: apply ? 'apply' : 'audit',
  shopify_file: shopifyFile,
  etsy_file: etsyFile,
  listings: jobs.length,
  masters: jobs.filter((job) => job.target.role === 'master').length,
  colour_listings: jobs.filter((job) => job.target.role === 'colour').length,
  section_counts: Object.fromEntries(ETSY_SECTION_DEFINITIONS.map((definition) => [definition.title, jobs.filter((job) => job.sectionKey === definition.key).length])),
  colour_category_counts: Object.fromEntries([...new Set(jobs.map((job) => job.category))].sort().map((category) => [category, jobs.filter((job) => job.category === category).length])),
  sample_titles: jobs.slice(0, 6).map((job) => job.title),
  manual_settings_report: reportPath,
};
console.log(JSON.stringify(summary, null, 2));
if (!apply) process.exit(0);

async function ensureSections() {
  const response = await etsy(`/shops/${SHOP_ID}/sections`);
  const sections = response.results || [];
  if (sections.length < ETSY_SECTION_DEFINITIONS.length) throw new Error(`Only ${sections.length} Etsy sections exist; ${ETSY_SECTION_DEFINITIONS.length} are needed.`);
  const claimed = new Set();
  const resolved = {};
  for (const definition of ETSY_SECTION_DEFINITIONS) {
    const exact = sections.find((section) => !claimed.has(String(section.shop_section_id))
      && canonicalCatalogueValue(section.title) === canonicalCatalogueValue(definition.title));
    if (exact) {
      claimed.add(String(exact.shop_section_id));
      resolved[definition.key] = exact;
    }
  }
  for (const definition of ETSY_SECTION_DEFINITIONS) {
    if (resolved[definition.key]) continue;
    const reusable = sections.find((section) => !claimed.has(String(section.shop_section_id)));
    if (!reusable) throw new Error(`No Etsy section slot available for ${definition.title}`);
    const renamed = await etsy(`/shops/${SHOP_ID}/sections/${reusable.shop_section_id}`, {
      method: 'PUT', form: new URLSearchParams({ title: definition.title }),
    });
    claimed.add(String(reusable.shop_section_id));
    resolved[definition.key] = renamed;
  }
  state.sections = Object.fromEntries(Object.entries(resolved).map(([key, section]) => [key, Number(section.shop_section_id)]));
  saveState();
  return { resolved, obsolete: sections.filter((section) => !claimed.has(String(section.shop_section_id))) };
}

const { obsolete } = await ensureSections();
const pending = jobs.filter((job) => !state.completed[String(job.listing.listing_id)]).slice(0, limit);
let finished = 0;
let failed = 0;

async function updateJob(job) {
  const listingId = Number(job.listing.listing_id);
  try {
    const sectionId = state.sections[job.sectionKey];
    if (!sectionId) throw new Error(`Missing section ${job.sectionKey}`);
    await etsy(`/shops/${SHOP_ID}/listings/${listingId}?legacy=false`, {
      method: 'PATCH',
      form: new URLSearchParams({
        title: job.title,
        tags: job.tags.join(','),
        materials: job.materials.join(','),
        shop_section_id: String(sectionId),
      }),
    });
    await etsy(`/shops/${SHOP_ID}/listings/${listingId}/properties/${ETSY_CRAFT_TYPE_PROPERTY_ID}`, {
      method: 'PUT', form: new URLSearchParams({
        value_ids: ETSY_CRAFT_TYPE_VALUE_IDS.join(','),
        values: ETSY_CRAFT_TYPE_VALUES.join(','),
      }),
    });
    if (job.target.role === 'colour') {
      const valueId = ETSY_COLOUR_VALUE_IDS[job.category];
      if (!valueId) throw new Error(`No Etsy primary-colour value for ${job.category}`);
      await etsy(`/shops/${SHOP_ID}/listings/${listingId}/properties/${ETSY_PRIMARY_COLOUR_PROPERTY_ID}`, {
        method: 'PUT', form: new URLSearchParams({ value_ids: String(valueId), values: job.category }),
      });
    }
    state.completed[String(listingId)] = { completed_at: new Date().toISOString(), title: job.title, section_key: job.sectionKey };
    delete state.errors[String(listingId)];
    finished += 1;
    if (finished % 25 === 0) {
      saveState();
      process.stdout.write(`Updated ${finished}/${pending.length}\n`);
    }
  } catch (error) {
    failed += 1;
    state.errors[String(listingId)] = { failed_at: new Date().toISOString(), error: error.message };
    process.stderr.write(`FAILED ${listingId} ${job.title}: ${error.message}\n`);
  }
}

const queue = [...pending];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) await updateJob(queue.shift());
}));
saveState();

if (!Number.isFinite(limit) && failed === 0 && jobs.every((job) => state.completed[String(job.listing.listing_id)])) {
  for (const section of obsolete) {
    try {
      await etsy(`/shops/${SHOP_ID}/sections/${section.shop_section_id}`, { method: 'DELETE' });
    } catch (error) {
      process.stderr.write(`Could not remove obsolete section ${section.title}: ${error.message}\n`);
    }
  }
}

const verificationJob = pending.find((job) => state.completed[String(job.listing.listing_id)]);
let verification = null;
if (verificationJob) {
  const [listing, properties] = await Promise.all([
    etsy(`/listings/${verificationJob.listing.listing_id}`),
    etsy(`/shops/${SHOP_ID}/listings/${verificationJob.listing.listing_id}/properties`),
  ]);
  verification = {
    listing_id: listing.listing_id,
    title: listing.title,
    tags: listing.tags,
    materials: listing.materials,
    shop_section_id: listing.shop_section_id,
    properties: (properties.results || []).map((property) => ({ property_id: property.property_id, values: property.values })),
  };
}
console.log(JSON.stringify({ updated_this_run: finished, failed_this_run: failed, total_completed: Object.keys(state.completed).length, verification }, null, 2));
if (failed) process.exitCode = 1;
