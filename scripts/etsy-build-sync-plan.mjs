#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDir = path.join(root, 'soply-import', 'backups');
const outputPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');

function latest(prefix) {
  return fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .at(-1);
}

function canonical(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/[’']/g, '')
    .replace(/\+/g, ' and ')
    .replace(/&/g, ' and ')
    .toLocaleLowerCase('en-GB')
    .replace(/centre/g, 'center')
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function findProduct(products, title) {
  const key = canonical(title);
  return products.find((product) => canonical(product.title) === key) || null;
}

function classifyEtsyListing(listing, products) {
  const title = listing.title.replace(/&#39;/g, "'");
  const lower = title.toLocaleLowerCase('en-GB');
  if (/\bpunchinella\b/i.test(title)) return null;
  if (/\bseconds?\b|\btangled\b|missing holes/i.test(title)) return findProduct(products, 'Seconds');

  const recycled = /100\s*%/i.test(title) ? 100 : 20;
  const suffix = ` | ${recycled}% Recycled Plastic`;

  if (/10\s*[*x×]\s*18|10mm\s*[*x×]\s*18/i.test(title)) return findProduct(products, `10*18mm Oval${suffix}`);
  if (/11\s*[*x×]\s*18/i.test(title)) return null;
  if (/10\s*[*x×]\s*30/i.test(title)) return findProduct(products, `10*30mm Pointed Oval${suffix}`);
  if (/12\s*[*x×]\s*35|\bteardrop/i.test(title)) return findProduct(products, `12*35mm Teardrop${suffix}`);

  const sizeMatch = lower.match(/\b(3|4|5|6|7|8|10|12|15|20|30)\s*mm\b/);
  if (!sizeMatch) return null;
  const size = Number(sizeMatch[1]);

  if (/\bsquares?\b/i.test(title)) return findProduct(products, `${size}mm Square${suffix}`);
  if (/\btriangles?\b/i.test(title)) return findProduct(products, `${size}mm Triangle${suffix}`);

  if (/\bspool\b/i.test(title)) {
    const style = /\bcupped\b/i.test(title) ? 'Cupped' : 'Flat';
    const hole = /top hole|side hole/i.test(title) ? 'Side' : 'Centre';
    return findProduct(products, `${size}mm On The Spool Circle | ${hole} Hole | ${style}${suffix}`);
  }

  if (/no fixing holes/i.test(title)) return null;
  if (/\bcupped\b/i.test(title)) {
    if (size !== 5) return null;
    return findProduct(products, `5mm Circle | Centre Hole | Cupped${suffix}`);
  }

  const sideHole = /top hole|side hole/i.test(title) || [10, 12, 15, 20, 30].includes(size);
  return findProduct(products, `${size}mm Circle | ${sideHole ? 'Side' : 'Centre'} Hole | Flat${suffix}`);
}

function extractShownColour(listing) {
  const description = String(listing.description || '').replace(/\r/g, '');
  const patterns = [
    /colou?r\s+shown(?:\s+in\s+(?:the\s+)?feature\s+image)?_?\s*:?\s*\n?\s*([^\n]+)/i,
    /colou?r\s*:\s*([A-Z]+-\d+\s*\|[^\n]+)/i,
    /this listing is for\s+([^,\.\n]+)/i,
  ];
  let raw = null;
  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) { raw = match[1].trim(); break; }
  }
  if (!raw) return null;
  const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
  if (/^[A-Z]+-\d+$/i.test(parts[0] || '') && parts[1]) return parts[1];
  return parts[0] || null;
}

function colourOption(product) {
  return product.options.find((option) => /^colou?r$/i.test(option.name));
}

function listingScore(listing) {
  return Number(listing.num_favorers || 0) * 1_000_000
    + Number(listing.views || 0) * 1_000
    - Number(listing.original_creation_timestamp || listing.created_timestamp || 0) / 1_000_000_000;
}

const etsyFile = latest('etsy-listings-before-sync-');
const shopifyFile = latest('shopify-products-before-etsy-sync-');
if (!etsyFile || !shopifyFile) throw new Error('Create Etsy and Shopify backups before building the sync plan.');

const etsy = JSON.parse(fs.readFileSync(path.join(backupDir, etsyFile), 'utf8'));
const shopify = JSON.parse(fs.readFileSync(path.join(backupDir, shopifyFile), 'utf8'));
const products = shopify.products.filter((product) => product.status === 'ACTIVE');

const targets = [];
for (const product of products) {
  targets.push({
    key: `${product.id}|master`,
    role: 'master',
    shopify_product_id: product.id,
    shopify_product_title: product.title,
    colour: null,
    etsy_listing_id: null,
    source: 'create',
  });
  const colours = colourOption(product)?.optionValues.map((value) => value.name) || [];
  if (/^Punchinella\b|^Seconds$/i.test(product.title)) continue;
  for (const colour of colours) {
    targets.push({
      key: `${product.id}|colour:${canonical(colour)}`,
      role: 'colour',
      shopify_product_id: product.id,
      shopify_product_title: product.title,
      colour,
      etsy_listing_id: null,
      source: 'create',
    });
  }
}

const targetsByProduct = new Map();
for (const target of targets) {
  if (!targetsByProduct.has(target.shopify_product_id)) targetsByProduct.set(target.shopify_product_id, []);
  targetsByProduct.get(target.shopify_product_id).push(target);
}

const matched = [];
const preserved = [];
for (const listing of etsy.listings_by_state.active) {
  const product = classifyEtsyListing(listing, products);
  if (!product) {
    preserved.push({ listing_id: listing.listing_id, title: listing.title, reason: 'No exact Shopify product match' });
    continue;
  }
  matched.push({ listing, product, shown_colour: extractShownColour(listing) });
}

const unassignedListings = new Set(matched);
for (const product of products) {
  const pool = matched.filter((item) => item.product.id === product.id).sort((a, b) => listingScore(b.listing) - listingScore(a.listing));
  const productTargets = targetsByProduct.get(product.id);
  const master = productTargets.find((target) => target.role === 'master');
  if (pool.length) {
    const chosen = pool.shift();
    Object.assign(master, { etsy_listing_id: chosen.listing.listing_id, source: 'reuse', previous_title: chosen.listing.title });
    unassignedListings.delete(chosen);
  }

  for (const target of productTargets.filter((item) => item.role === 'colour')) {
    const index = pool.findIndex((item) => canonical(item.shown_colour) === canonical(target.colour));
    if (index === -1) continue;
    const [chosen] = pool.splice(index, 1);
    Object.assign(target, { etsy_listing_id: chosen.listing.listing_id, source: 'reuse', previous_title: chosen.listing.title });
    unassignedListings.delete(chosen);
  }

  for (const target of productTargets.filter((item) => !item.etsy_listing_id)) {
    const chosen = pool.shift();
    if (!chosen) break;
    Object.assign(target, { etsy_listing_id: chosen.listing.listing_id, source: 'reuse', previous_title: chosen.listing.title });
    unassignedListings.delete(chosen);
  }
}

// Reuse remaining Shopify-matching duplicates for still-missing targets across
// other families. They will receive the destination product's complete data and
// imagery, avoiding a new Etsy listing fee without touching Etsy-only products.
const remainingListings = [...unassignedListings].sort((a, b) => listingScore(b.listing) - listingScore(a.listing));
const missingTargets = targets.filter((target) => !target.etsy_listing_id);
for (const target of missingTargets) {
  const chosen = remainingListings.shift();
  if (!chosen) break;
  Object.assign(target, {
    etsy_listing_id: chosen.listing.listing_id,
    source: 'reuse-cross-product',
    previous_title: chosen.listing.title,
    previous_shopify_product_title: chosen.product.title,
  });
  unassignedListings.delete(chosen);
}

const deleteDuplicates = [...unassignedListings].map((item) => ({
  listing_id: item.listing.listing_id,
  title: item.listing.title,
  reason: 'Shopify-matching duplicate not needed by the target catalogue',
}));

const plan = {
  generated_at: new Date().toISOString(),
  etsy_backup: etsyFile,
  shopify_backup: shopifyFile,
  shop_id: etsy.shop.shop_id,
  summary: {
    shopify_products: products.length,
    target_listings: targets.length,
    reuse_same_product: targets.filter((target) => target.source === 'reuse').length,
    reuse_cross_product: targets.filter((target) => target.source === 'reuse-cross-product').length,
    create_new: targets.filter((target) => target.source === 'create').length,
    preserve_etsy_only: preserved.length,
    delete_duplicates: deleteDuplicates.length,
  },
  targets,
  preserved_etsy_only: preserved,
  delete_duplicates: deleteDuplicates,
};

fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(plan.summary, null, 2)}\n`);
process.stdout.write(`Plan: ${outputPath}\n`);
