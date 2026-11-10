#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDir = path.join(root, 'soply-import', 'backups');
const envPath = path.join(root, '.env.etsy.local');
const planPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');
const statePath = path.join(root, 'soply-import', 'etsy-sync-state.json');
const apply = process.argv.includes('--apply');
const deleteUntracked = process.argv.includes('--delete-untracked');
const SHOP_ID = 17132311;
const READINESS_STATE_ID = 1406197290896;
const CUSTOM_FIRST = 514;
const CUSTOM_SECOND = 513;

function latest(prefix) {
  const name = fs.readdirSync(backupDir).filter((item) => item.startsWith(prefix) && item.endsWith('.json')).sort().at(-1);
  if (!name) throw new Error(`No ${prefix} backup found.`);
  return name;
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

function optionValue(variant, name) {
  return variant.selectedOptions.find((option) => canonical(option.name) === canonical(name))?.value;
}

function etsyOptionName(name) {
  return canonical(name) === canonical('Material | Shape | Hole Position | Style | Size')
    ? 'Shape | Hole Position | Style | Size'
    : name;
}

function titleFor(target) {
  return target.listingTitle || (target.role === 'master' ? target.product.title : `${target.product.title} | ${target.colour}`);
}

function expectedTargets(products, currentPlan) {
  const targets = [];
  for (const product of products.filter((item) => item.status === 'ACTIVE')) {
    if (/^Punchinella\b/i.test(product.title)) {
      const splitTargets = currentPlan.targets.filter((target) => target.shopify_product_id === product.id && target.punch_option_values?.length);
      if (splitTargets.length) {
        for (const target of splitTargets) {
          targets.push({
            key: target.key,
            role: 'master',
            colour: null,
            product,
            punchOptionValues: target.punch_option_values,
            listingTitle: target.listing_title,
          });
        }
        continue;
      }
    }
    targets.push({ key: `${product.id}|master`, role: 'master', colour: null, product });
    if (/^Punchinella\b|^Seconds$/i.test(product.title)) continue;
    const colours = product.options.find((option) => canonical(option.name) === 'colour')?.optionValues || [];
    for (const colour of colours) {
      targets.push({ key: `${product.id}|colour:${canonical(colour.name)}`, role: 'colour', colour: colour.name, product });
    }
  }
  return targets;
}

function relevantVariants(target) {
  const allowedPunchOptions = target.punchOptionValues?.length ? new Set(target.punchOptionValues.map(canonical)) : null;
  return target.product.variants.nodes.filter((variant) => {
    if (allowedPunchOptions && !allowedPunchOptions.has(canonical(optionValue(variant, 'Material | Shape | Hole Position | Style | Size')))) return false;
    return target.role === 'master' || canonical(optionValue(variant, 'Colour')) === canonical(target.colour);
  });
}

function inventoryFor(target) {
  const relevant = relevantVariants(target);
  const available = relevant.filter((variant) => Number(variant.inventoryQuantity) > 0 && variant.availableForSale);
  const ignored = new Set(['finish']);
  if (target.role !== 'master') ignored.add('colour');
  const optionNames = target.product.options.map((option) => option.name).filter((name) => !ignored.has(canonical(name)));
  if (optionNames.length > 2) throw new Error(`${titleFor(target)} needs ${optionNames.length} Etsy variations.`);

  const punchMaster = target.role === 'master' && /^Punchinella\b/i.test(target.product.title) && !target.punchOptionValues?.length;
  const activeValueSets = optionNames.map((name) => new Set(available.map((variant) => canonical(optionValue(variant, name)))));
  const variants = punchMaster
    ? (available.length
      ? relevant.filter((variant) => optionNames.every((name, index) => activeValueSets[index].has(canonical(optionValue(variant, name)))))
      : relevant.slice(0, 1))
    : relevant;
  if (variants.length > 400) throw new Error(`${titleFor(target)} exceeds Etsy's 400-combination limit.`);

  const propertyIds = optionNames.map((_, index) => index === 0 ? CUSTOM_FIRST : CUSTOM_SECOND);
  const anyAvailable = available.length > 0;
  return {
    products: variants.map((variant, index) => {
      const enabled = Number(variant.inventoryQuantity) > 0 && variant.availableForSale;
      return {
        sku: String(variant.sku || '').slice(0, 32),
        offerings: [{
          quantity: enabled ? Math.max(1, Math.min(999, Number(variant.inventoryQuantity) || 1)) : (!anyAvailable && index === 0 ? 1 : 0),
          is_enabled: enabled || (!anyAvailable && index === 0),
          price: Number(variant.price),
          readiness_state_id: READINESS_STATE_ID,
        }],
        property_values: optionNames.map((name, propertyIndex) => ({
          property_id: propertyIds[propertyIndex], property_name: etsyOptionName(name), scale_id: null,
          values: [optionValue(variant, name)],
        })),
      };
    }),
    price_on_property: propertyIds,
    quantity_on_property: propertyIds,
    sku_on_property: propertyIds,
    readiness_state_on_property: [],
    anyAvailable,
  };
}

function inventoryMatches(current, expected) {
  const actualProducts = current?.products || [];
  if (actualProducts.length !== expected.products.length) return false;
  const optionSignature = (product) => (product.property_values || [])
    .map((entry) => `${canonical(entry.property_name)}=${canonical(entry.values?.[0])}`).sort().join('|');
  const actualBySku = new Map(actualProducts.filter((product) => product.sku).map((product) => [product.sku, product]));
  const actualByOptions = new Map(actualProducts.map((product) => [optionSignature(product), product]));
  return expected.products.every((product) => {
    const actual = (product.sku && actualBySku.get(product.sku)) || actualByOptions.get(optionSignature(product));
    if (!actual) return false;
    const offering = product.offerings[0];
    const actualOffering = actual.offerings?.[0];
    if (!actualOffering) return false;
    if (Boolean(actualOffering.is_enabled) !== Boolean(offering.is_enabled)) return false;
    if (Number(actualOffering.quantity) !== Number(offering.quantity)) return false;
    if (Number(actualOffering.price?.amount) !== Math.round(Number(offering.price) * 100)) return false;
    const actualOptions = new Map((actual.property_values || []).map((entry) => [canonical(entry.property_name), canonical(entry.values?.[0])]));
    return product.property_values.every((entry) => actualOptions.get(canonical(entry.property_name)) === canonical(entry.values[0]));
  });
}

const shopifyFile = latest('shopify-products-before-etsy-sync-');
const etsyFile = latest('etsy-listings-before-sync-');
const shopify = JSON.parse(fs.readFileSync(path.join(backupDir, shopifyFile), 'utf8'));
const etsyBackup = JSON.parse(fs.readFileSync(path.join(backupDir, etsyFile), 'utf8'));
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const migrationState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const listings = Object.entries(etsyBackup.listings_by_state).flatMap(([state, values]) => values.map((listing) => ({ ...listing, _state: state })));
const listingById = new Map(listings.map((listing) => [String(listing.listing_id), listing]));
const targets = expectedTargets(shopify.products, plan);
const expectedKeys = new Set(targets.map((target) => target.key));

const problems = [];
const inventoryUpdates = [];
const stateUpdates = [];
const expectedIds = new Set();
for (const target of targets) {
  const record = migrationState.targets[target.key];
  if (!record?.listing_id) { problems.push(`${target.key}: no migration mapping`); continue; }
  const listing = listingById.get(String(record.listing_id));
  if (!listing) { problems.push(`${target.key}: listing ${record.listing_id} is missing`); continue; }
  expectedIds.add(String(record.listing_id));
  if (listing.title !== titleFor(target)) problems.push(`${target.key}: title is ${listing.title}`);
  if (!listing.images?.length) problems.push(`${target.key}: listing has no image`);
  const inventory = inventoryFor(target);
  if (!inventoryMatches(listing.inventory, inventory)) inventoryUpdates.push({ target, listing, inventory });
  const desiredState = inventory.anyAvailable ? 'active' : 'inactive';
  const stateMatches = desiredState === 'active' ? listing._state === 'active' : ['draft', 'inactive'].includes(listing._state);
  if (!stateMatches) stateUpdates.push({ listing, desiredState });
}

const obsolete = [];
for (const oldTarget of plan.targets) {
  if (expectedKeys.has(oldTarget.key)) continue;
  if (oldTarget.role !== 'colour' || !/^Punchinella\b|^Seconds$/i.test(oldTarget.shopify_product_title)) {
    problems.push(`${oldTarget.key}: unexpected non-standard obsolete target`);
    continue;
  }
  const record = migrationState.targets[oldTarget.key];
  const listing = record?.listing_id ? listingById.get(String(record.listing_id)) : null;
  if (!listing) continue;
  const expectedTitle = `${oldTarget.shopify_product_title} | ${oldTarget.colour}`;
  if (listing.title !== expectedTitle) { problems.push(`${oldTarget.key}: refusing title mismatch ${listing.title}`); continue; }
  if (!['draft', 'inactive'].includes(listing._state)) { problems.push(`${oldTarget.key}: refusing to delete ${listing._state} listing`); continue; }
  obsolete.push({ oldTarget, record, listing });
}

const obsoleteIds = new Set(obsolete.map((item) => String(item.listing.listing_id)));
const preserved = listings.filter((listing) => !expectedIds.has(String(listing.listing_id)) && !obsoleteIds.has(String(listing.listing_id)));
const summary = {
  mode: apply ? 'apply' : 'audit', shopify_file: shopifyFile, etsy_file: etsyFile,
  shopify_products: shopify.products.filter((product) => product.status === 'ACTIVE').length,
  required_listings: targets.length, inventory_updates: inventoryUpdates.length,
  state_updates: stateUpdates.length, obsolete_colour_listings: obsolete.length,
  preserved_etsy_only_or_historical: preserved.length, blocking_problems: problems,
  delete_untracked_requested: deleteUntracked,
  inventory_update_titles: inventoryUpdates.map((item) => item.listing.title),
  state_update_titles: stateUpdates.map((item) => `${item.listing.title} -> ${item.desiredState}`),
};
console.log(JSON.stringify(summary, null, 2));
if (problems.length) throw new Error('Safety checks failed; no Etsy changes were made.');
if (!apply) process.exit(0);

let envText = fs.readFileSync(envPath, 'utf8');
const env = parseEnv(envText);
let accessToken;
async function refreshToken() {
  const response = await fetch('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.ETSY_KEYSTRING, refresh_token: env.ETSY_REFRESH_TOKEN }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || `Token refresh failed (${response.status})`);
  accessToken = payload.access_token;
  env.ETSY_REFRESH_TOKEN = payload.refresh_token;
  envText = updateEnv(envText, { ETSY_ACCESS_TOKEN: payload.access_token, ETSY_REFRESH_TOKEN: payload.refresh_token, ETSY_TOKEN_SCOPE: payload.scope || env.ETSY_TOKEN_SCOPE });
  fs.writeFileSync(envPath, envText, { mode: 0o600 });
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function etsy(pathname, { method = 'GET', json, form, retry = 0 } = {}) {
  await sleep(125);
  const headers = { 'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`, authorization: `Bearer ${accessToken}` };
  let body;
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = form; }
  const response = await fetch(`https://api.etsy.com/v3/application${pathname}`, { method, headers, body });
  if (response.status === 401 && retry < 1) { await refreshToken(); return etsy(pathname, { method, json, form, retry: retry + 1 }); }
  if ((response.status === 429 || response.status >= 500) && retry < 6) {
    await sleep(Math.min(Number(response.headers.get('retry-after') || 2 ** retry) * 1_000, 60_000));
    return etsy(pathname, { method, json, form, retry: retry + 1 });
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${payload?.error || text}`);
  return payload;
}

await refreshToken();
let updated = 0;
for (const item of inventoryUpdates) {
  const { anyAvailable: _anyAvailable, ...payload } = item.inventory;
  await etsy(`/listings/${item.listing.listing_id}/inventory`, { method: 'PUT', json: payload });
  updated += 1;
  if (updated % 20 === 0) console.log(`Updated inventory ${updated}/${inventoryUpdates.length}`);
}

for (const item of stateUpdates) {
  await etsy(`/shops/${SHOP_ID}/listings/${item.listing.listing_id}?legacy=false`, {
    method: 'PATCH', form: new URLSearchParams({ state: item.desiredState }),
  });
}

let deleted = 0;
for (const item of obsolete) {
  await etsy(`/listings/${item.listing.listing_id}`, { method: 'DELETE' });
  item.record.obsolete_deleted_at = new Date().toISOString();
  item.record.obsolete_reason = 'Punchinella and Seconds use master listings only';
  deleted += 1;
  if (deleted % 20 === 0) console.log(`Deleted obsolete listings ${deleted}/${obsolete.length}`);
}

let untrackedDeleted = 0;
if (deleteUntracked) {
  for (const listing of preserved) {
    await etsy(`/listings/${listing.listing_id}`, { method: 'DELETE' });
    untrackedDeleted += 1;
    if (untrackedDeleted % 20 === 0) console.log(`Deleted untracked listings ${untrackedDeleted}/${preserved.length}`);
  }
  plan.preserved_etsy_only = [];
}

plan.targets = plan.targets.filter((target) => expectedKeys.has(target.key));
plan.shopify_backup = shopifyFile;
plan.etsy_backup = etsyFile;
plan.reconciled_at = new Date().toISOString();
plan.summary = { ...plan.summary, shopify_products: summary.shopify_products, target_listings: targets.length };
fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
migrationState.updated_at = new Date().toISOString();
fs.writeFileSync(statePath, `${JSON.stringify(migrationState, null, 2)}\n`);

const reportPath = path.join(backupDir, `etsy-structure-reconciliation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify({ ...summary, applied_at: new Date().toISOString(), inventory_updated: updated, states_updated: stateUpdates.length, obsolete_deleted: deleted, untracked_deleted: untrackedDeleted }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ inventory_updated: updated, states_updated: stateUpdates.length, obsolete_deleted: deleted, untracked_deleted: untrackedDeleted, report: reportPath }, null, 2));
