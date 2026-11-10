#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');
const statePath = path.join(root, 'soply-import', 'etsy-sync-state.json');
const outputPath = path.join(root, 'soply-import', 'etsy-worker-import.json');

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const shopify = JSON.parse(fs.readFileSync(path.join(root, 'soply-import', 'backups', plan.shopify_backup), 'utf8'));
const mappings = [];

for (const target of plan.targets) {
  if (target.role === 'colour' && /^Punchinella\b|^Seconds$/i.test(target.shopify_product_title)) continue;
  const record = state.targets[target.key];
  const listingId = record?.listing_id || target.etsy_listing_id;
  if (!listingId || !record?.complete && !target.etsy_listing_id) continue;
  mappings.push({
    target_key: target.key,
    shopify_product_id: target.shopify_product_id,
    etsy_listing_id: listingId,
    role: target.role,
    colour: target.colour || null,
    punch_option_values: target.punch_option_values || null,
    listing_title: target.listing_title || null,
  });
}

const assets = Object.entries(state.assets || {}).flatMap(([sourceUrl, value]) => value?.image_id ? [{
  source_url: sourceUrl,
  image_id: value.image_id,
  source_listing_id: value.source_listing_id || null,
}] : []);
const assetByPath = new Map(assets.map((asset) => {
  const parsed = new URL(asset.source_url); parsed.search = ''; return [parsed.toString(), asset];
}));
const liveUrls = shopify.products.flatMap((product) => [
  ...(product.media?.nodes || []).map((media) => media.image?.url),
  ...(product.variants?.nodes || []).flatMap((variant) => (variant.media?.nodes || []).map((media) => media.image?.url)),
]).filter(Boolean);
for (const sourceUrl of liveUrls) {
  const parsed = new URL(sourceUrl); const version = parsed.searchParams.get('v'); parsed.search = '';
  const known = assetByPath.get(parsed.toString());
  if (!known || !version) continue;
  parsed.searchParams.set('v', version);
  if (!assets.some((asset) => asset.source_url === parsed.toString())) assets.push({ ...known, source_url: parsed.toString() });
}

const enableSync = process.argv.includes('--enable-sync');
fs.writeFileSync(outputPath, `${JSON.stringify({ mappings, assets, enable_sync: enableSync }, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, mappings: mappings.length, assets: assets.length, sync_enabled: enableSync }, null, 2));
