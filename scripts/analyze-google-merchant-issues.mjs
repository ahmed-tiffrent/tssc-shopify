#!/usr/bin/env node

/**
 * Read-only comparison of a Google Merchant Center issues export with live
 * Shopify variant shipping data. This script performs GraphQL queries only.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const STORE = '3midq0-8i.myshopify.com';
const csvPath = process.argv[2];

if (!csvPath) {
  throw new Error('Usage: node scripts/analyze-google-merchant-issues.mjs /path/to/product_issues.csv');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  const headers = rows.shift();
  return rows.filter((values) => values.some(Boolean)).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])),
  );
}

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

function numericId(gid) {
  return gid?.split('/').pop() || '';
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
  if (/Pointed Oval/i.test(productTitle)) return 'pointed oval';
  if (/Teardrop/i.test(productTitle)) return 'teardrop';
  if (/Oval/i.test(productTitle)) return 'oval';
  if (/Circle/i.test(productTitle)) return 'circle';
  if (/Triangle/i.test(productTitle)) return 'triangle';
  if (/Square/i.test(productTitle)) return 'square';
  return 'other';
}

function day(value) {
  return value?.slice(0, 10) || '(none)';
}

function groupComparison(allItems, affectedSet, keyFn, minimumTotal = 1) {
  const groups = new Map();
  for (const item of allItems) {
    const key = String(keyFn(item));
    const group = groups.get(key) || { total: 0, affected: 0 };
    group.total += 1;
    if (affectedSet.has(item.id)) group.affected += 1;
    groups.set(key, group);
  }
  return Object.fromEntries(
    [...groups]
      .filter(([, value]) => value.total >= minimumTotal)
      .map(([key, value]) => [key, {
        ...value,
        unaffected: value.total - value.affected,
        affectedPercent: Number(((value.affected / value.total) * 100).toFixed(1)),
      }])
      .sort((a, b) => b[1].affectedPercent - a[1].affectedPercent || b[1].affected - a[1].affected || a[0].localeCompare(b[0])),
  );
}

function variantEvidence(variant) {
  return {
    sku: variant.sku,
    product: variant.product.title,
    variant: variant.title,
    productId: variant.product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem?.id,
    measurementId: variant.inventoryItem?.measurement?.id,
    weight: variant.inventoryItem?.measurement?.weight || null,
    requiresShipping: variant.inventoryItem?.requiresShipping,
    tracked: variant.inventoryItem?.tracked,
    deliveryProfile: variant.deliveryProfile?.name || null,
    hsCode: variant.inventoryItem?.harmonizedSystemCode || null,
    origin: variant.inventoryItem?.countryCodeOfOrigin || null,
    productCreatedAt: variant.product.createdAt,
    productUpdatedAt: variant.product.updatedAt,
    variantCreatedAt: variant.createdAt,
    variantUpdatedAt: variant.updatedAt,
    availableForSale: variant.availableForSale,
    inventoryQuantity: variant.inventoryQuantity,
  };
}

const merchantRows = parseCsv(readFileSync(csvPath, 'utf8'));
const weightRows = merchantRows.filter((row) => row['Issue title'] === 'Missing delivery weight [shipping_weight]');

const variants = [];
let cursor = null;
do {
  const page = executeGraphql(variantsQuery, { after: cursor }).productVariants;
  variants.push(...page.nodes);
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  process.stderr.write(`\rRead ${variants.length} Shopify variants`);
} while (cursor);
process.stderr.write('\n');

const byProductAndSku = new Map();
const byMerchantTitle = new Map();
for (const variant of variants) {
  const productId = numericId(variant.product.id);
  if (variant.sku) byProductAndSku.set(normalize(`${productId}_${variant.sku}`), variant);
  const merchantTitle = normalize(`${variant.product.title} - ${variant.title}`);
  const matches = byMerchantTitle.get(merchantTitle) || [];
  matches.push(variant);
  byMerchantTitle.set(merchantTitle, matches);
}

const mapped = [];
const unmapped = [];
const ambiguous = [];
const matchMethod = { productAndSku: 0, exactTitle: 0 };

for (const row of weightRows) {
  let variant = byProductAndSku.get(normalize(row['Item ID']));
  let method = 'productAndSku';
  if (!variant) {
    const titleMatches = byMerchantTitle.get(normalize(row.Title)) || [];
    if (titleMatches.length === 1) {
      [variant] = titleMatches;
      method = 'exactTitle';
    } else if (titleMatches.length > 1) {
      ambiguous.push({ itemId: row['Item ID'], title: row.Title, candidates: titleMatches.map((item) => item.id) });
      continue;
    }
  }
  if (variant) {
    mapped.push({ row, variant, method });
    matchMethod[method] += 1;
  } else {
    unmapped.push({ itemId: row['Item ID'], title: row.Title });
  }
}

const affectedIds = new Set(mapped.map(({ variant }) => variant.id));
const eligible = variants.filter((variant) =>
  variant.product.status === 'ACTIVE' &&
  variant.inventoryItem?.requiresShipping &&
  Number(variant.inventoryItem?.measurement?.weight?.value) > 0,
);
const affected = eligible.filter((variant) => affectedIds.has(variant.id));
const unaffected = eligible.filter((variant) => !affectedIds.has(variant.id));

const suffixTypes = weightRows.reduce((counts, row) => {
  const suffix = row['Item ID'].split('_').slice(1).join('_');
  const type = /^\d+$/.test(suffix) ? 'numeric generated ID' : 'SKU';
  counts[type] = (counts[type] || 0) + 1;
  return counts;
}, {});

const report = {
  generatedAt: new Date().toISOString(),
  sourceCsv: csvPath,
  merchantExport: {
    rows: merchantRows.length,
    uniqueItemIds: new Set(merchantRows.map((row) => row['Item ID'])).size,
    missingShippingWeight: weightRows.length,
    pendingOnlineShopCheck: merchantRows.filter((row) => row['Issue title'] === 'Pending online shop check').length,
    otherIssues: merchantRows.filter((row) => !['Missing delivery weight [shipping_weight]', 'Pending online shop check'].includes(row['Issue title'])).length,
    missingWeightIdSuffixTypes: suffixTypes,
    countries: [...new Set(weightRows.map((row) => row.Country))],
    feedLabels: [...new Set(weightRows.map((row) => row['Feed label']))],
  },
  mapping: {
    mappedRows: mapped.length,
    uniqueMappedVariants: affectedIds.size,
    matchMethod,
    ambiguous: ambiguous.length,
    unmapped: unmapped.length,
    unmappedExamples: unmapped.slice(0, 20),
    ambiguousExamples: ambiguous.slice(0, 20),
  },
  liveShopifyComparison: {
    eligibleActivePhysicalPositiveWeight: eligible.length,
    affected: affected.length,
    unaffected: unaffected.length,
    affectedWithMissingOrZeroWeight: affected.filter((variant) => !(Number(variant.inventoryItem?.measurement?.weight?.value) > 0)).length,
    affectedRequiresShippingFalse: affected.filter((variant) => !variant.inventoryItem?.requiresShipping).length,
    affectedMissingDeliveryProfile: affected.filter((variant) => !variant.deliveryProfile).length,
    affectedMissingSku: affected.filter((variant) => !variant.sku).length,
  },
  cohorts: {
    merchantIdType: suffixTypes,
    weight: groupComparison(eligible, affectedIds, (variant) => {
      const weight = variant.inventoryItem?.measurement?.weight;
      return `${weight?.value} ${weight?.unit}`;
    }),
    weightOption: groupComparison(eligible, affectedIds, (variant) => option(variant, 'Weight | Quantity')),
    finish: groupComparison(eligible, affectedIds, (variant) => option(variant, 'Finish')),
    colour: groupComparison(eligible, affectedIds, (variant) => option(variant, 'Colour'), 10),
    material: groupComparison(eligible, affectedIds, (variant) => material(variant.product.title)),
    family: groupComparison(eligible, affectedIds, (variant) => family(variant.product.title)),
    deliveryProfile: groupComparison(eligible, affectedIds, (variant) => variant.deliveryProfile?.name || '(missing)'),
    productCreatedDay: groupComparison(eligible, affectedIds, (variant) => day(variant.product.createdAt)),
    variantCreatedDay: groupComparison(eligible, affectedIds, (variant) => day(variant.createdAt)),
    variantUpdatedDay: groupComparison(eligible, affectedIds, (variant) => day(variant.updatedAt)),
    product: groupComparison(eligible, affectedIds, (variant) => variant.product.title),
  },
  affectedEvidence: affected.slice(0, 12).map(variantEvidence),
  unaffectedEvidence: unaffected.slice(0, 12).map(variantEvidence),
};

console.log(JSON.stringify(report, null, 2));
