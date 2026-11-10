#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.etsy.local');
const planPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');
const statePath = path.join(root, 'soply-import', 'etsy-sync-state.json');
const backupDir = path.join(root, 'soply-import', 'backups');
const shouldDelete = process.argv.includes('--delete');
const SHOP_ID = 17132311;

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
    const value = pending.get(key); pending.delete(key); return `${key}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

await refreshToken();

async function etsy(pathname, { method = 'GET', retry = 0 } = {}) {
  const response = await fetch(`https://api.etsy.com/v3/application${pathname}`, {
    method,
    headers: { 'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`, authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401 && retry < 1) { await refreshToken(); return etsy(pathname, { method, retry: retry + 1 }); }
  if ((response.status === 429 || response.status >= 500) && retry < 6) {
    await sleep(Math.min(Number(response.headers.get('retry-after') || 2 ** retry) * 1000, 60_000));
    return etsy(pathname, { method, retry: retry + 1 });
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${payload?.error || text}`);
  return payload;
}

async function allListingsByState() {
  const result = {};
  for (const listingState of ['active', 'draft', 'inactive', 'expired']) {
    const listings = [];
    let offset = 0;
    let count = Infinity;
    while (offset < count) {
      const query = new URLSearchParams({ state: listingState, limit: '100', offset: String(offset), includes: 'Images,Inventory' });
      const page = await etsy(`/shops/${SHOP_ID}/listings?${query}`);
      count = page.count;
      listings.push(...page.results);
      offset += page.results.length;
      if (!page.results.length) break;
    }
    result[listingState] = listings;
    process.stdout.write(`${listingState}: ${listings.length}\n`);
  }
  return result;
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const migration = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const originalBackup = JSON.parse(fs.readFileSync(path.join(backupDir, plan.etsy_backup), 'utf8'));
const incomplete = plan.targets.filter((target) => !migration.targets[target.key]?.complete);
if (incomplete.length) throw new Error(`Migration is not complete: ${incomplete.length} of ${plan.targets.length} targets remain.`);

const listingsByState = await allListingsByState();
const listings = Object.values(listingsByState).flat();
const listingById = new Map(listings.map((listing) => [String(listing.listing_id), listing]));
const errors = [];
let activeExpected = 0;
let unavailableExpected = 0;

for (const target of plan.targets) {
  const record = migration.targets[target.key];
  const listing = listingById.get(String(record.listing_id));
  const expectedTitle = target.role === 'master' ? target.shopify_product_title : `${target.shopify_product_title} | ${target.colour}`;
  if (!listing) { errors.push(`${target.key}: listing ${record.listing_id} not found`); continue; }
  if (listing.title !== expectedTitle) errors.push(`${target.key}: title mismatch (${listing.title})`);
  if (!listing.images?.length) errors.push(`${target.key}: no listing images`);
  if (!listing.inventory?.products?.length) errors.push(`${target.key}: no inventory products`);
  if (record.held_as_unavailable_draft) {
    unavailableExpected += 1;
    if (!['draft', 'inactive'].includes(listing.state)) errors.push(`${target.key}: unavailable listing is ${listing.state}`);
  } else {
    activeExpected += 1;
    if (listing.state !== 'active') errors.push(`${target.key}: available listing is ${listing.state}`);
  }
}

const duplicateIds = new Set(plan.delete_duplicates.map((listing) => String(listing.listing_id)));
const originalListings = Object.values(originalBackup.listings_by_state).flat();
const preservedIds = new Set(originalListings.map((listing) => String(listing.listing_id)).filter((id) => !duplicateIds.has(id)));
for (const id of duplicateIds) if (preservedIds.has(id)) errors.push(`Safety conflict: ${id} is both preserved and a duplicate.`);
for (const item of plan.delete_duplicates) {
  if (!migration.targets[item.replacement_target_key]?.complete) errors.push(`Duplicate ${item.listing_id} has no complete replacement.`);
}
for (const id of preservedIds) if (!listingById.has(id)) errors.push(`Protected original Etsy listing ${id} is missing.`);

const report = {
  checked_at: new Date().toISOString(),
  targets: plan.targets.length,
  active_expected: activeExpected,
  unavailable_expected: unavailableExpected,
  duplicates_ready: plan.delete_duplicates.length,
  protected_original_listings: preservedIds.size,
  protected_active_etsy_only: plan.preserved_etsy_only.length,
  errors,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (errors.length) throw new Error(`Validation failed with ${errors.length} error(s); no duplicates were deleted.`);
if (!shouldDelete) {
  process.stdout.write('Validation passed. Re-run with --delete to remove the verified legacy duplicates.\n');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `etsy-listings-immediately-before-duplicate-delete-${stamp}.json`);
fs.writeFileSync(backupPath, `${JSON.stringify({ exported_at: new Date().toISOString(), listings_by_state: listingsByState, delete_duplicates: plan.delete_duplicates }, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(backupPath, 0o600);
process.stdout.write(`Pre-delete backup: ${backupPath}\n`);

const deleted = [];
for (const item of plan.delete_duplicates) {
  await etsy(`/listings/${item.listing_id}`, { method: 'DELETE' });
  deleted.push(item.listing_id);
  if (deleted.length % 20 === 0) process.stdout.write(`Deleted ${deleted.length}/${plan.delete_duplicates.length}\n`);
}
const logPath = path.join(backupDir, `etsy-deleted-legacy-duplicates-${stamp}.json`);
fs.writeFileSync(logPath, `${JSON.stringify({ deleted_at: new Date().toISOString(), listing_ids: deleted }, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(logPath, 0o600);
process.stdout.write(`Deleted ${deleted.length} verified legacy duplicates. Log: ${logPath}\n`);
