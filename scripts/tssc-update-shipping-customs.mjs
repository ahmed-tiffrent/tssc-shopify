#!/usr/bin/env node

/**
 * Set TSSC variant customs data and packaged shipping weights.
 *
 * Dry run:
 *   node scripts/tssc-update-shipping-customs.mjs
 *
 * Apply after reviewing the audit:
 *   node scripts/tssc-update-shipping-customs.mjs --apply --confirm=UPDATE_TSSC_SHIPPING_CUSTOMS
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const CONFIRMATION_TEXT = 'UPDATE_TSSC_SHIPPING_CUSTOMS';
const HS_CODE = '392690';
const COUNTRY_OF_ORIGIN = 'GB';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(SCRIPT_DIR, '..', 'soply-import', 'backups');

const LOOSE_PACKAGED_WEIGHT_GRAMS = new Map([
  [5, 13],
  [10, 18],
  [25, 30],
  [50, 55],
  [100, 110],
]);

function executeGraphql(query, variables = {}, allowMutations = false) {
  const args = [
    'store',
    'execute',
    '--store',
    STORE,
    '--query',
    query,
    '--variables',
    JSON.stringify(variables),
    '--json',
  ];
  if (allowMutations) args.push('--allow-mutations');

  const result = spawnSync('shopify', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  }
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
      nodes { id title handle variantsCount { count } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const variantsQuery = `
  query Variants($id: ID!, $after: String) {
    product(id: $id) {
      id
      title
      handle
      variants(first: 250, after: $after) {
        nodes {
          id
          title
          selectedOptions { name value }
          inventoryItem {
            id
            harmonizedSystemCode
            countryCodeOfOrigin
            measurement { weight { unit value } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const updateMutation = `
  mutation UpdateShippingCustoms($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        inventoryItem {
          harmonizedSystemCode
          countryCodeOfOrigin
          measurement { weight { unit value } }
        }
      }
      userErrors { field message }
    }
  }
`;

function normalise(value) {
  return value.trim().toLocaleLowerCase('en-GB').replace(/\s+/g, ' ');
}

function optionValue(variant, optionName) {
  return variant.selectedOptions.find((option) => normalise(option.name) === normalise(optionName))?.value;
}

function looseWeight(variant) {
  const value = optionValue(variant, 'Weight | Quantity');
  const match = value?.match(/^\s*(5|10|25|50|100)\s*g\b/i);
  return match ? LOOSE_PACKAGED_WEIGHT_GRAMS.get(Number(match[1])) : null;
}

function spoolWeight(product, variant) {
  const title = normalise(product.title);
  const length = normalise(optionValue(variant, 'Length') || '');
  if (title.startsWith('5mm ') && title.includes(' flat ') && length === '100 yards') return 130;
  if (title.startsWith('5mm ') && title.includes(' cupped ') && length === '50 yards') return 90;
  if (title.startsWith('3mm ') && title.includes(' flat ') && length === '100 yards') return 90;
  if (title.startsWith('3mm ') && title.includes(' cupped ') && length === '50 yards') return 75;
  return null;
}

function targetWeight(product, variant) {
  if (/\bpunchinella\b/i.test(product.title)) return 35;
  if (/\bon the spool\b/i.test(product.title)) return spoolWeight(product, variant);
  return looseWeight(variant);
}

function currentWeightInGrams(variant) {
  const weight = variant.inventoryItem.measurement?.weight;
  if (!weight) return 0;
  if (weight.unit === 'GRAMS') return Number(weight.value);
  if (weight.unit === 'KILOGRAMS') return Number(weight.value) * 1000;
  if (weight.unit === 'OUNCES') return Number(weight.value) * 28.349523125;
  if (weight.unit === 'POUNDS') return Number(weight.value) * 453.59237;
  throw new Error(`${variant.id}: unsupported existing weight unit ${weight.unit}`);
}

const productSummaries = [];
let productCursor = null;
do {
  const connection = executeGraphql(productsQuery, { after: productCursor }).products;
  productSummaries.push(...connection.nodes);
  productCursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
} while (productCursor);

const products = [];
for (const summary of productSummaries) {
  const variants = [];
  let cursor = null;
  do {
    const response = executeGraphql(variantsQuery, { id: summary.id, after: cursor }).product;
    variants.push(...response.variants.nodes);
    cursor = response.variants.pageInfo.hasNextPage ? response.variants.pageInfo.endCursor : null;
  } while (cursor);
  if (variants.length !== summary.variantsCount.count) {
    throw new Error(`${summary.title}: expected ${summary.variantsCount.count} variants, received ${variants.length}`);
  }
  products.push({ ...summary, variants });
}

const audit = {
  products: products.length,
  variants: 0,
  customsChanges: 0,
  weightChanges: 0,
  weightRuleCounts: { looseSequins: 0, spools: 0, punchinella: 0 },
  noWeightRule: [],
};
const prepared = [];

for (const product of products) {
  const updates = [];
  for (const variant of product.variants) {
    audit.variants += 1;
    const grams = targetWeight(product, variant);
    const customsNeedsUpdate =
      variant.inventoryItem.harmonizedSystemCode !== HS_CODE ||
      variant.inventoryItem.countryCodeOfOrigin !== COUNTRY_OF_ORIGIN;
    const weightNeedsUpdate = grams !== null && Math.abs(currentWeightInGrams(variant) - grams) > 0.0001;

    if (customsNeedsUpdate) audit.customsChanges += 1;
    if (weightNeedsUpdate) audit.weightChanges += 1;
    if (grams !== null) {
      if (/\bpunchinella\b/i.test(product.title)) audit.weightRuleCounts.punchinella += 1;
      else if (/\bon the spool\b/i.test(product.title)) audit.weightRuleCounts.spools += 1;
      else audit.weightRuleCounts.looseSequins += 1;
    } else {
      audit.noWeightRule.push({ product: product.title, variant: variant.title });
    }

    if (!customsNeedsUpdate && !weightNeedsUpdate) continue;
    const inventoryItem = {
      harmonizedSystemCode: HS_CODE,
      countryCodeOfOrigin: COUNTRY_OF_ORIGIN,
    };
    if (grams !== null) inventoryItem.measurement = { weight: { unit: 'GRAMS', value: grams } };
    updates.push({ id: variant.id, inventoryItem });
  }
  if (updates.length) prepared.push({ product, updates });
}

const noRuleByProduct = new Map();
for (const item of audit.noWeightRule) {
  noRuleByProduct.set(item.product, (noRuleByProduct.get(item.product) || 0) + 1);
}

console.log('TSSC shipping weight and customs audit');
console.log('======================================');
console.log(`Products: ${audit.products}`);
console.log(`Variants: ${audit.variants}`);
console.log(`Customs changes: ${audit.customsChanges}`);
console.log(`Weight changes: ${audit.weightChanges}`);
console.log(`Loose sequin variants matched: ${audit.weightRuleCounts.looseSequins}`);
console.log(`Spool variants matched exactly: ${audit.weightRuleCounts.spools}`);
console.log(`Punchinella variants matched: ${audit.weightRuleCounts.punchinella}`);
console.log('Variants intentionally left without a new weight rule:');
for (const [title, count] of [...noRuleByProduct].sort()) console.log(`- ${title}: ${count}`);

if (!APPLY) {
  console.log('\nDry run only: no Shopify data was changed.');
  console.log(`Apply with --apply --confirm=${CONFIRMATION_TEXT}`);
  process.exit(0);
}

if (CONFIRMATION !== CONFIRMATION_TEXT) {
  throw new Error(`Apply blocked. Re-run with --confirm=${CONFIRMATION_TEXT}.`);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(BACKUP_DIR, `shipping-customs-before-update-${timestamp}.json`);
writeFileSync(
  backupPath,
  `${JSON.stringify({ createdAt: new Date().toISOString(), hsCode: HS_CODE, countryOfOrigin: COUNTRY_OF_ORIGIN, products }, null, 2)}\n`
);
console.log(`Backup written: ${backupPath}`);

let updated = 0;
for (const { product, updates } of prepared) {
  for (let start = 0; start < updates.length; start += 250) {
    const batch = updates.slice(start, start + 250);
    const response = executeGraphql(
      updateMutation,
      { productId: product.id, variants: batch },
      true
    ).productVariantsBulkUpdate;
    if (response.userErrors.length) {
      throw new Error(`${product.title}: ${JSON.stringify(response.userErrors, null, 2)}`);
    }
    updated += response.productVariants.length;
  }
  console.log(`${product.title}: updated ${updates.length}`);
}

console.log(`Updated ${updated} variants.`);
