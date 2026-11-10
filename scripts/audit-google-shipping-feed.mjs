#!/usr/bin/env node

/**
 * Read-only Shopify audit for Google Merchant Center shipping-weight issues.
 * This script performs GraphQL queries only; it has no mutations.
 */

import { spawnSync } from 'node:child_process';

const STORE = '3midq0-8i.myshopify.com';
const EXAMPLE_SKU = 'TSSC-CS10-S-10-R20-0100';

function executeGraphql(query, variables = {}) {
  const result = spawnSync(
    'shopify',
    ['store', 'execute', '--store', STORE, '--query', query, '--variables', JSON.stringify(variables), '--json'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON returned: ${result.stdout}`);
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

const variantsQuery = `
  query Variants($after: String) {
    productVariants(first: 250, after: $after) {
      nodes {
        id
        title
        sku
        createdAt
        updatedAt
        availableForSale
        inventoryQuantity
        inventoryPolicy
        requiresComponents
        selectedOptions { name value }
        deliveryProfile { id name default }
        inventoryItem {
          id
          tracked
          requiresShipping
          harmonizedSystemCode
          countryCodeOfOrigin
          measurement { id weight { unit value } }
        }
        product {
          id
          title
          handle
          status
          createdAt
          updatedAt
          variantsCount { count }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const variants = [];
let cursor = null;
do {
  const page = executeGraphql(variantsQuery, { after: cursor }).productVariants;
  variants.push(...page.nodes);
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  process.stderr.write(`\rRead ${variants.length} variants`);
} while (cursor);
process.stderr.write('\n');

function day(value) {
  return value?.slice(0, 10) || '(none)';
}

function option(variant, name) {
  return variant.selectedOptions.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value || '(none)';
}

function material(productTitle) {
  if (/100% Recycled/i.test(productTitle)) return '100% recycled';
  if (/20% Recycled/i.test(productTitle)) return '20% recycled';
  return 'other';
}

function family(productTitle) {
  if (/Punchinella/i.test(productTitle)) return 'punchinella';
  if (/On The Spool/i.test(productTitle)) return 'spool';
  if (/Circle/i.test(productTitle)) return 'circle';
  if (/Teardrop/i.test(productTitle)) return 'teardrop';
  if (/Pointed Oval/i.test(productTitle)) return 'pointed oval';
  if (/Oval/i.test(productTitle)) return 'oval';
  if (/Triangle/i.test(productTitle)) return 'triangle';
  if (/Square/i.test(productTitle)) return 'square';
  return 'other';
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = String(keyFn(item));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function weightState(variant) {
  const weight = variant.inventoryItem?.measurement?.weight;
  if (!weight) return 'missing';
  if (!(Number(weight.value) > 0)) return 'zero/non-positive';
  return `positive ${weight.unit}`;
}

function shape(variant) {
  return {
    sku: variant.sku,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem?.id,
    productId: variant.product.id,
    product: variant.product.title,
    variant: variant.title,
    weight: variant.inventoryItem?.measurement?.weight || null,
    measurementId: variant.inventoryItem?.measurement?.id || null,
    requiresShipping: variant.inventoryItem?.requiresShipping,
    tracked: variant.inventoryItem?.tracked,
    deliveryProfile: variant.deliveryProfile?.name || null,
    productCreatedAt: variant.product.createdAt,
    productUpdatedAt: variant.product.updatedAt,
    variantCreatedAt: variant.createdAt,
    variantUpdatedAt: variant.updatedAt,
    productStatus: variant.product.status,
    availableForSale: variant.availableForSale,
    inventoryQuantity: variant.inventoryQuantity,
  };
}

const physical = variants.filter((variant) => variant.inventoryItem?.requiresShipping);
const positiveWeight = variants.filter((variant) => {
  const weight = variant.inventoryItem?.measurement?.weight;
  return weight && Number(weight.value) > 0;
});
const eligible = variants.filter(
  (variant) =>
    variant.product.status === 'ACTIVE' &&
    variant.inventoryItem?.requiresShipping &&
    Number(variant.inventoryItem?.measurement?.weight?.value) > 0,
);

const example = variants.find((variant) => variant.sku === EXAMPLE_SKU);
const sameProductComparators = variants
  .filter((variant) => variant.product.id === example?.product.id && variant.id !== example.id)
  .filter((variant) => option(variant, 'Weight | Quantity') !== option(example, 'Weight | Quantity'))
  .slice(0, 4);
const crossProductComparators = variants
  .filter((variant) => variant.product.id !== example?.product.id)
  .filter((variant) => variant.inventoryItem?.requiresShipping && Number(variant.inventoryItem?.measurement?.weight?.value) > 0)
  .filter((variant) => variant.deliveryProfile?.name === example?.deliveryProfile?.name)
  .slice(0, 6);

const report = {
  generatedAt: new Date().toISOString(),
  totals: {
    variants: variants.length,
    active: variants.filter((variant) => variant.product.status === 'ACTIVE').length,
    physical: physical.length,
    positiveWeight: positiveWeight.length,
    activePhysicalPositiveWeight: eligible.length,
    missingWeight: variants.filter((variant) => weightState(variant) === 'missing').length,
    zeroOrNonPositiveWeight: variants.filter((variant) => weightState(variant) === 'zero/non-positive').length,
    requiresShippingFalse: variants.filter((variant) => !variant.inventoryItem?.requiresShipping).length,
    missingSku: variants.filter((variant) => !variant.sku).length,
    missingDeliveryProfile: variants.filter((variant) => !variant.deliveryProfile).length,
  },
  distributions: {
    weightState: countBy(variants, weightState),
    weightValue: countBy(variants, (variant) => {
      const weight = variant.inventoryItem?.measurement?.weight;
      return weight ? `${weight.value} ${weight.unit}` : '(missing)';
    }),
    deliveryProfile: countBy(variants, (variant) => variant.deliveryProfile?.name || '(missing)'),
    productCreatedDay: countBy(variants, (variant) => day(variant.product.createdAt)),
    variantCreatedDay: countBy(variants, (variant) => day(variant.createdAt)),
    variantUpdatedDay: countBy(variants, (variant) => day(variant.updatedAt)),
    material: countBy(variants, (variant) => material(variant.product.title)),
    family: countBy(variants, (variant) => family(variant.product.title)),
    weightOption: countBy(variants, (variant) => option(variant, 'Weight | Quantity')),
    productVariantCount: countBy(variants, (variant) => variant.product.variantsCount.count),
  },
  activeDistributions: {
    weightState: countBy(eligible, weightState),
    weightValue: countBy(eligible, (variant) => {
      const weight = variant.inventoryItem?.measurement?.weight;
      return weight ? `${weight.value} ${weight.unit}` : '(missing)';
    }),
    deliveryProfile: countBy(eligible, (variant) => variant.deliveryProfile?.name || '(missing)'),
    productCreatedDay: countBy(eligible, (variant) => day(variant.product.createdAt)),
    variantCreatedDay: countBy(eligible, (variant) => day(variant.createdAt)),
    variantUpdatedDay: countBy(eligible, (variant) => day(variant.updatedAt)),
    material: countBy(eligible, (variant) => material(variant.product.title)),
    family: countBy(eligible, (variant) => family(variant.product.title)),
    weightOption: countBy(eligible, (variant) => option(variant, 'Weight | Quantity')),
    productVariantCount: countBy(eligible, (variant) => variant.product.variantsCount.count),
  },
  example: example ? shape(example) : null,
  comparatorCandidates: [...sameProductComparators, ...crossProductComparators].map(shape),
};

console.log(JSON.stringify(report, null, 2));
