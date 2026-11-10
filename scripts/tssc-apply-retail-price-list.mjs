#!/usr/bin/env node

/**
 * Apply the approved GBP retail price matrix from
 * TSSC_Retail_Price_List_UK_US_SHOPIFY AND ETSY (1).xlsx.
 *
 * The United States uplift is configured separately at market level. “Seconds”
 * are intentionally excluded because the workbook contains no price for them.
 *
 * Dry run:
 *   node scripts/tssc-apply-retail-price-list.mjs
 *
 * Apply:
 *   node scripts/tssc-apply-retail-price-list.mjs --apply --confirm=APPLY_TSSC_RETAIL_PRICE_LIST
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const CONFIRMATION_TEXT = 'APPLY_TSSC_RETAIL_PRICE_LIST';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(SCRIPT_DIR, '..', 'soply-import', 'backups');

const PRICES = {
  loose: {
    20: { 5: '3.50', 10: '6.00', 25: '10.00', 50: '15.00', 100: '20.00' },
    100: { 5: '5.00', 10: '7.50', 25: '12.50', 50: '20.00', 100: '28.00' },
  },
  spool: { 20: '10.00', 100: '12.50' },
  punchinella: { 20: '3.00', 100: '3.50' },
};

function executeGraphql(query, variables = {}, allowMutations = false) {
  const args = ['store', 'execute', '--store', STORE, '--query', query, '--variables', JSON.stringify(variables), '--json'];
  if (allowMutations) args.push('--allow-mutations');
  const result = spawnSync('shopify', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON returned: ${result.stdout}`);
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

const productsQuery = `
  query Products($after: String) {
    products(first: 100, after: $after, sortKey: TITLE) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const variantsQuery = `
  query Variants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        nodes { id title sku price selectedOptions { name value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const updateMutation = `
  mutation UpdatePrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

function recycledPercentage(title) {
  return /\b100% recycled plastic\b/i.test(title) ? 100 : /\b20% recycled plastic\b/i.test(title) ? 20 : null;
}

function targetPrice(product, variant) {
  if (/^seconds$/i.test(product.title.trim())) return null;
  const recycled = recycledPercentage(product.title);
  if (!recycled) return null;
  if (/\bpunchinella\b/i.test(product.title)) return PRICES.punchinella[recycled];
  if (/\bon the spool\b/i.test(product.title)) return PRICES.spool[recycled];

  const weightOption = variant.selectedOptions.find(({ name }) => /weight/i.test(name));
  const grams = Number(weightOption?.value.match(/^\s*(5|10|25|50|100)\s*g\b/i)?.[1]);
  return PRICES.loose[recycled]?.[grams] || null;
}

const products = [];
let cursor = null;
do {
  const page = executeGraphql(productsQuery, { after: cursor }).products;
  for (const product of page.nodes) {
    const variants = [];
    let variantCursor = null;
    do {
      const variantPage = executeGraphql(variantsQuery, { id: product.id, after: variantCursor }).product.variants;
      variants.push(...variantPage.nodes);
      variantCursor = variantPage.pageInfo.hasNextPage ? variantPage.pageInfo.endCursor : null;
    } while (variantCursor);
    products.push({ ...product, variants: { nodes: variants } });
  }
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (cursor);

const changes = [];
const skipped = [];
const counts = { loose: 0, spool: 0, punchinella: 0 };
for (const product of products) {
  for (const variant of product.variants.nodes) {
    const target = targetPrice(product, variant);
    if (!target) {
      skipped.push({ productId: product.id, productTitle: product.title, variantId: variant.id, variantTitle: variant.title, price: variant.price });
      continue;
    }
    const type = /\bpunchinella\b/i.test(product.title) ? 'punchinella' : /\bon the spool\b/i.test(product.title) ? 'spool' : 'loose';
    counts[type] += 1;
    if (Number(variant.price) !== Number(target)) {
      changes.push({ productId: product.id, productTitle: product.title, variantId: variant.id, variantTitle: variant.title, sku: variant.sku, before: variant.price, after: target, type });
    }
  }
}

console.log('TSSC retail price-list audit');
console.log('============================');
console.log(`Priced variants: ${Object.values(counts).reduce((sum, count) => sum + count, 0)} (loose ${counts.loose}, spools ${counts.spool}, punchinella ${counts.punchinella})`);
console.log(`Variants requiring an update: ${changes.length}`);
console.log(`Excluded from workbook pricing: ${skipped.length}`);
const changeSummary = changes.reduce((summary, change) => {
  const key = `${change.before} -> ${change.after}`;
  summary[key] = (summary[key] || 0) + 1;
  return summary;
}, {});
for (const [change, count] of Object.entries(changeSummary).sort()) console.log(`- ${change}: ${count}`);

if (!APPLY) {
  console.log('\nDry run only: product prices were not changed.');
  console.log(`Apply with --apply --confirm=${CONFIRMATION_TEXT}`);
  process.exit(0);
}

if (CONFIRMATION !== CONFIRMATION_TEXT) throw new Error(`Apply blocked. Re-run with --confirm=${CONFIRMATION_TEXT}.`);

mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(BACKUP_DIR, `retail-prices-before-update-${timestamp}.json`);
writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), priceMatrix: PRICES, changes, skipped }, null, 2)}\n`);
console.log(`Backup written: ${backupPath}`);

const changesByProduct = new Map();
for (const change of changes) {
  if (!changesByProduct.has(change.productId)) changesByProduct.set(change.productId, []);
  changesByProduct.get(change.productId).push({ id: change.variantId, price: change.after });
}

let updated = 0;
for (const [productId, variants] of changesByProduct) {
  const result = executeGraphql(updateMutation, { productId, variants }, true).productVariantsBulkUpdate;
  if (result.userErrors.length) throw new Error(`${productId}: ${JSON.stringify(result.userErrors, null, 2)}`);
  updated += result.productVariants.length;
  console.log(`Updated ${updated}/${changes.length} variants.`);
}

console.log(`Retail price list applied to ${updated} variants.`);
