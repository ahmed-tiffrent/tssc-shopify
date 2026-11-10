#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { etsySectionKeyFor } from '../punchinella-stock-worker/etsy-catalogue-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'soply-import', 'etsy-sync-plan.json'), 'utf8'));
const envText = fs.readFileSync(path.join(root, '.env.etsy.local'), 'utf8');
const localEnv = Object.fromEntries(envText.split(/\r?\n/).flatMap((line) => {
  const index = line.indexOf('=');
  if (index < 1 || line.trim().startsWith('#')) return [];
  let value = line.slice(index + 1).trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  return [[line.slice(0, index).trim(), value]];
}));

const setupKey = process.env.TSSC_SETUP_KEY;
if (!setupKey) throw new Error('TSSC_SETUP_KEY is required.');
if (!localEnv.ETSY_REFRESH_TOKEN) throw new Error('ETSY_REFRESH_TOKEN is missing.');

const worker = 'https://tssc-punchinella-stock.mrtiffrent.workers.dev';

async function post(route, payload) {
  const response = await fetch(`${worker}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-setup-key': setupKey },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

const assignments = [];
for (const target of plan.targets) {
  if (target.role === 'colour' && /^Punchinella\b|^Seconds$/i.test(target.shopify_product_title)) continue;
  const key = etsySectionKeyFor(target.shopify_product_title, target.role);
  if (!key) throw new Error(`No category for ${target.shopify_product_title}`);
  assignments.push({ listing_id: target.etsy_listing_id, category_key: key });
}
for (const listing of plan.preserved_etsy_only) {
  const key = etsySectionKeyFor(listing.title, 'colour');
  if (!key) throw new Error(`No category for preserved listing ${listing.listing_id}: ${listing.title}`);
  assignments.push({ listing_id: listing.listing_id, category_key: key });
}
const unique = [...new Map(assignments.map((item) => [String(item.listing_id), item])).values()];
const counts = {};
for (const item of unique) counts[item.category_key] = (counts[item.category_key] || 0) + 1;
if (process.env.SCHEDULE_ETSY_REBUILD === 'true') {
  const delaySeconds = Number(process.env.ETSY_REBUILD_DELAY_SECONDS || 3600);
  const result = await post('/admin/etsy/sections/schedule', { assignments: unique, delay_seconds: delaySeconds });
  console.log(JSON.stringify({ ...result, counts }, null, 2));
  process.exit(0);
}
if (process.env.INSTALL_ETSY_TOKEN === 'true') {
  await post('/admin/etsy/rotate-token', { refresh_token: localEnv.ETSY_REFRESH_TOKEN });
}
let ensured;
if (process.env.REBUILD_ETSY_SECTIONS === 'true') {
  await post('/admin/etsy/sections', { temporary: true });
  for (let offset = 0; offset < unique.length; offset += 20) {
    const chunk = unique.slice(offset, offset + 20).map((item) => ({ listing_id: item.listing_id, category_key: '__temporary__' }));
    await post('/admin/etsy/sections', { assignments: chunk });
    process.stdout.write(`Moved ${Math.min(offset + chunk.length, unique.length)}/${unique.length} to holding section\n`);
  }
  ensured = await post('/admin/etsy/sections', { rebuild: true });
} else {
  ensured = await post('/admin/etsy/sections', { ensure: true });
}
for (let offset = 0; offset < unique.length; offset += 20) {
  const chunk = unique.slice(offset, offset + 20);
  await post('/admin/etsy/sections', { assignments: chunk });
  process.stdout.write(`Assigned ${Math.min(offset + chunk.length, unique.length)}/${unique.length}\n`);
}

const verified = await post('/admin/etsy/sections', { ensure: true });
const cleanup = await post('/admin/etsy/sections', { cleanup: true });
console.log(JSON.stringify({ ensured: ensured.ensured || ensured.rebuilt, assigned: unique.length, counts, sections: verified.sections, cleanup }, null, 2));
