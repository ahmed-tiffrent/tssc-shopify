#!/usr/bin/env node

/**
 * Generate Soply's BOM import CSV and, when explicitly applied, write the
 * matching SKU to each relevant Shopify variant.
 *
 * Dry run (default):
 *   node scripts/tssc-build-soply-bom.mjs
 *
 * Apply Shopify SKU updates after reviewing the CSV:
 *   node scripts/tssc-build-soply-bom.mjs --apply --confirm=ASSIGN_9024_VARIANT_SKUS
 *
 * Soply's BOM import template identifies each saleable item by variant_sku.
 * The production workbook's SKU convention is retained for loose/spool items;
 * Punchinella uses a stable Shopify-variant suffix to keep each configuration
 * unique. Seconds are intentionally excluded.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const EXPECTED_VARIANT_COUNT = 9024;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(SCRIPT_DIR, '..', 'soply-import');
const RAW_MATERIALS_FILE = resolve(OUTPUT_DIR, 'raw-material-stock-review.csv');

// Prefix and usable sequin yield (grams from one kilogram of film, including
// the workbook's 10% production-loss allowance).
const LOOSE_RECIPES = new Map([
  ['3mm Circle | Center Hole | Flat', ['CC03', 523.6363636]],
  ['4mm Circle | Center Hole | Flat', ['CC04', 566.3636364]],
  ['5mm Circle | Center Hole | Flat', ['CC05', 605.4545455]],
  ['6mm Circle | Center Hole | Flat', ['CC06', 632.7272727]],
  ['7mm Circle | Center Hole | Flat', ['CC07', 648.1818182]],
  ['8mm Circle | Center Hole | Flat', ['CC08', 655.4545455]],
  ['5mm Circle | Center Hole | Cupped', ['CU05', 515.4545455]],
  ['5mm Circle | Side Hole | Flat', ['CS05', 605.4545455]],
  ['8mm Circle | Side Hole | Flat', ['CS08', 655.4545455]],
  ['10mm Circle | Side Hole | Flat', ['CS10', 680]],
  ['12mm Circle | Side Hole | Flat', ['CS12', 623.6363636]],
  ['15mm Circle | Side Hole | Flat', ['CS15', 635.4545455]],
  ['20mm Circle | Side Hole | Flat', ['CS20', 649.0909091]],
  ['30mm Circle | Side Hole | Flat', ['CS30', 640.9090909]],
  ['5mm Square', ['SQ05', 618.1818182]],
  ['10mm Square', ['SQ10', 709.0909091]],
  ['20mm Square', ['SQ20', 681.8181818]],
  ['20mm Triangle', ['TR20', 636.3636364]],
  ['10*30mm Pointed Oval', ['PO1030', 535.4545455]],
  ['12*35mm Teardrop', ['TD1235', 596.3636364]],
  ['10*18mm Oval', ['OV1018', 646.3636364]],
]);

const SPOOL_PREFIXES = new Map([
  ['3mm On The Spool Circle | Center Hole | Flat', 'SPCC03'],
  ['3mm On The Spool Circle | Center Hole | Cupped', 'SPCU03'],
  ['5mm On The Spool Circle | Center Hole | Flat', 'SPCC05'],
  ['5mm On The Spool Circle | Center Hole | Cupped', 'SPCU05'],
  ['5mm On The Spool Circle | Side Hole | Flat', 'SPCS05'],
]);

// The workbook contains separate sections for these films because their film
// weight per metre differs from the standard 27g.
const FILM_GRAMS_PER_METRE = new Map([
  ['bobby dazzler', 34.43],
  ['clear rainbow', 28.48],
  ['disco dancer', 27.55],
]);

function executeGraphql(query, variables = {}, allowMutations = false) {
  const args = [
    'store', 'execute', '--store', STORE, '--query', query,
    '--variables', JSON.stringify(variables), '--json',
  ];
  if (allowMutations) args.push('--allow-mutations');
  const result = spawnSync('shopify', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON returned by Shopify CLI: ${result.stdout}`);
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

function normalise(value) {
  return value.trim().toLocaleLowerCase('en-GB').replace(/\s+/g, ' ');
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(path, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  writeFileSync(path, lines.join('\n') + '\n');
}

function productMaterial(title) {
  const match = title.match(/\|\s*(20|100)% Recycled Plastic\s*$/i);
  return match ? Number(match[1]) : null;
}

function productCoreTitle(title) {
  return title.replace(/\|\s*(20|100)% Recycled Plastic\s*$/i, '').trim();
}

function productVariantSuffix(variant) {
  return variant.id.split('/').pop();
}

function optionValue(variant, optionName) {
  return variant.selectedOptions.find((option) => normalise(option.name) === optionName)?.value;
}

function weightCode(value) {
  const match = value?.match(/^(\d+)g\b/i);
  if (!match) throw new Error(`Unrecognised loose-product weight option: ${value}`);
  return match[1].padStart(4, '0');
}

function lengthCode(value) {
  const match = value?.match(/^(50|100) yards$/i);
  if (!match) throw new Error(`Unrecognised spool length option: ${value}`);
  return `${match[1].padStart(4, '0')}Y`;
}

function filmWeight(colour) {
  return FILM_GRAMS_PER_METRE.get(normalise(colour)) ?? 27;
}

function rawMaterialMap() {
  const lines = readFileSync(RAW_MATERIALS_FILE, 'utf8').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  const output = new Map();
  for (const line of lines) {
    const cells = line.split(',');
    const status = cells[index.status];
    if (status === 'OMIT_UNLINKED') continue;
    const colour = normalise(cells[index.colour]);
    const content = Number(cells[index.recycled_content_percent]);
    output.set(`${colour}\u0000${content}`, {
      sku: cells[index.material_sku],
      name: cells[index.material_name],
      stockG: cells[index.proposed_stock_g],
      colour,
      content,
    });
  }
  return output;
}

const productsQuery = `
  query SoplyProducts {
    products(first: 100, sortKey: TITLE) {
      nodes { id title handle variantsCount { count } }
      pageInfo { hasNextPage }
    }
  }
`;

const variantsQuery = `
  query SoplyVariants($id: ID!, $after: String) {
    product(id: $id) {
      id title handle
      variants(first: 250, after: $after) {
        nodes { id title sku selectedOptions { name value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const skuUpdateMutation = `
  mutation SetVariantSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

const productConnection = executeGraphql(productsQuery).products;
if (productConnection.pageInfo.hasNextPage) throw new Error('Product lookup requires pagination; refusing a partial run.');

const rawMaterials = rawMaterialMap();
const candidates = productConnection.nodes.filter((product) =>
  productMaterial(product.title) !== null && !/^seconds$/i.test(product.title.trim())
);
const bomRows = [];
const skuUpdatesByProduct = new Map();
const rawMaterialRows = [...rawMaterials.values()].sort((a, b) => a.sku.localeCompare(b.sku));

for (const productSummary of candidates) {
  const material = productMaterial(productSummary.title);
  const coreTitle = productCoreTitle(productSummary.title);
  const isPunchinella = /^punchinella\b/i.test(coreTitle);
  const looseRecipe = LOOSE_RECIPES.get(coreTitle);
  const spoolPrefix = SPOOL_PREFIXES.get(coreTitle);
  if (!isPunchinella && !looseRecipe && !spoolPrefix) {
    throw new Error(`No production recipe mapping for ${productSummary.title}.`);
  }

  let after = null;
  const variants = [];
  let product;
  do {
    product = executeGraphql(variantsQuery, { id: productSummary.id, after }).product;
    variants.push(...product.variants.nodes);
    after = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
  } while (after);
  if (variants.length !== productSummary.variantsCount.count) {
    throw new Error(`${product.title}: expected ${productSummary.variantsCount.count} variants, received ${variants.length}.`);
  }

  const productUpdates = [];
  for (const variant of variants) {
    const colour = optionValue(variant, 'colour');
    if (!colour) throw new Error(`${product.title}: ${variant.id} has no Colour option.`);
    const rawMaterial = rawMaterials.get(`${normalise(colour)}\u0000${material}`);
    if (!rawMaterial) throw new Error(`${product.title}: ${colour} has no raw-material record for ${material}%.`);

    let sku;
    let quantityG;
    if (looseRecipe) {
      const [prefix, yieldG] = looseRecipe;
      const packWeight = optionValue(variant, 'weight | quantity');
      const grams = Number(packWeight?.match(/^(\d+)g\b/i)?.[1]);
      if (!grams) throw new Error(`${product.title}: ${variant.id} has no recognised Weight | Quantity.`);
      sku = `TSSC-${prefix}-${rawMaterial.sku.split('-R')[0]}-R${material}-${weightCode(packWeight)}`;
      quantityG = (grams * 1000) / yieldG;
    } else if (spoolPrefix) {
      const length = optionValue(variant, 'length');
      const yards = Number(length?.match(/^(50|100) yards$/i)?.[1]);
      if (!yards) throw new Error(`${product.title}: ${variant.id} has no recognised Length.`);
      sku = `TSSC-${spoolPrefix}-${rawMaterial.sku.split('-R')[0]}-R${material}-${lengthCode(length)}`;
      quantityG = yards * 0.9144 * 1.1 * filmWeight(colour);
    } else {
      // The product is sold by a 3m length. The source workbook defines raw
      // film usage as length × film weight per metre, plus 10% allowance.
      sku = `TSSC-PU-${rawMaterial.sku.split('-R')[0]}-R${material}-${productVariantSuffix(variant)}`;
      quantityG = 3 * 1.1 * filmWeight(colour);
    }

    if (variant.sku && variant.sku !== sku) {
      throw new Error(`${product.title}: ${variant.id} already has a different SKU (${variant.sku}); refusing to overwrite it.`);
    }

    bomRows.push({
      variant_sku: sku,
      product_title: product.title,
      variant_title: variant.title,
      raw_material_sku: rawMaterial.sku,
      raw_material_name: rawMaterial.name,
      quantity: quantityG.toFixed(6),
      unit: 'g',
    });
    if (!variant.sku) productUpdates.push({ id: variant.id, inventoryItem: { sku } });
  }
  if (productUpdates.length) skuUpdatesByProduct.set(product.id, productUpdates);
}

if (bomRows.length !== EXPECTED_VARIANT_COUNT) {
  throw new Error(`Expected ${EXPECTED_VARIANT_COUNT} BOM rows, generated ${bomRows.length}.`);
}
const uniqueSkus = new Set(bomRows.map((row) => row.variant_sku));
if (uniqueSkus.size !== bomRows.length) throw new Error('Generated duplicate Shopify variant SKUs; refusing to continue.');

mkdirSync(OUTPUT_DIR, { recursive: true });
const bomPath = resolve(OUTPUT_DIR, 'soply-bom-import.csv');
writeCsv(bomPath, ['variant_sku', 'product_title', 'variant_title', 'raw_material_sku', 'raw_material_name', 'quantity', 'unit'], bomRows);
const rawMaterialPath = resolve(OUTPUT_DIR, 'soply-raw-materials-to-create.csv');
writeCsv(rawMaterialPath, ['raw_material_sku', 'raw_material_name', 'starting_stock', 'unit'], rawMaterialRows.map((material) => ({
  raw_material_sku: material.sku,
  raw_material_name: material.name,
  starting_stock: material.stockG,
  unit: 'g',
})));

const pendingSkuUpdates = [...skuUpdatesByProduct.values()].reduce((sum, variants) => sum + variants.length, 0);
writeFileSync(
  resolve(OUTPUT_DIR, 'soply-bom-build-status.json'),
  JSON.stringify({
    generated_at: new Date().toISOString(),
    bom_rows: bomRows.length,
    raw_material_rows: rawMaterialRows.length,
    pending_shopify_sku_updates: pendingSkuUpdates,
    excluded_product_group: 'Seconds',
  }, null, 2) + '\n'
);
console.log(`Generated ${bomRows.length} Soply BOM rows: ${bomPath}`);
console.log(`Generated ${rawMaterialRows.length} raw-material setup rows: ${rawMaterialPath}`);
console.log(`${pendingSkuUpdates} Shopify variants need SKUs assigned.`);

if (!APPLY) {
  console.log('Dry run only: Shopify variant SKUs were not changed.');
  console.log(`Apply with --apply --confirm=ASSIGN_${pendingSkuUpdates}_VARIANT_SKUS`);
  process.exit(0);
}

const expectedConfirmation = `ASSIGN_${pendingSkuUpdates}_VARIANT_SKUS`;
if (CONFIRMATION !== expectedConfirmation) {
  throw new Error(`SKU updates blocked. Re-run with --confirm=${expectedConfirmation}.`);
}

let updated = 0;
for (const [productId, variants] of skuUpdatesByProduct) {
  for (let start = 0; start < variants.length; start += 250) {
    const batch = variants.slice(start, start + 250);
    const result = executeGraphql(skuUpdateMutation, { productId, variants: batch }, true).productVariantsBulkUpdate;
    if (result.userErrors.length) throw new Error(`${productId}: ${JSON.stringify(result.userErrors)}`);
    if (result.productVariants.length !== batch.length || result.productVariants.some((variant) => !variant.sku)) {
      throw new Error(`${productId}: SKU update verification failed.`);
    }
    updated += batch.length;
    console.log(`Updated ${updated}/${pendingSkuUpdates} Shopify variant SKUs.`);
  }
}
console.log(`Completed: assigned ${updated} Shopify variant SKUs. The generated CSV is ready for Soply BOM import.`);
