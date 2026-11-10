#!/usr/bin/env node

/*
 * Prepares the data for a Punchinella inventory model that is linked to
 * Shopify inventory, rather than being app-managed by Soply.
 *
 * Shopify inventory is whole-number based, therefore a single internal
 * inventory unit represents one centimetre. Each customer-facing 3 metre
 * Punchinella variant consumes 300 cm from its matching colour/material pool.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve('soply-import/soply-bom-import.csv');
const outputDir = resolve('soply-import/punchinella-linked');
const batchSize = 250;
const internalHandle = 'internal-punchinella-stock';
const [header, ...sourceRows] = readFileSync(sourcePath, 'utf8').trim().split(/\r?\n/);
const headers = header.split(',');
const index = Object.fromEntries(headers.map((value, position) => [value, position]));

function cells(row) {
  return row.split(',');
}

function titleCase(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function csvCell(value) {
  const string = String(value ?? '');
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

const bindings = [];
const pools = new Map();

for (const sourceRow of sourceRows) {
  const values = cells(sourceRow);
  if (!/^Punchinella\b/i.test(values[index.product_title])) continue;

  const filmSku = values[index.raw_material_sku];
  const nameParts = values[index.raw_material_name].match(/^[A-Z0-9-]+\s+(.+?)\s+(20|100)% rPET$/i);
  if (!nameParts) throw new Error(`Cannot parse material name: ${values[index.raw_material_name]}`);
  const [, colour, content] = nameParts;
  const punchSku = `PUNCH-${filmSku}`;
  const punchName = `Punchinella | ${titleCase(colour)} | ${content}% rPET`;

  bindings.push({
    variant_sku: values[index.variant_sku],
    product_title: values[index.product_title],
    variant_title: values[index.variant_title],
    raw_material_sku: punchSku,
    raw_material_name: punchName,
    quantity: '300',
    unit: 'cm',
  });
  pools.set(punchSku, { punchSku, punchName, colour: titleCase(colour), content });
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const bindingHeaders = ['variant_sku', 'product_title', 'variant_title', 'raw_material_sku', 'raw_material_name', 'quantity', 'unit'];
for (let start = 0, batch = 1; start < bindings.length; start += batchSize, batch += 1) {
  const lines = [bindingHeaders.join(','), ...bindings.slice(start, start + batchSize).map((row) => bindingHeaders.map((key) => csvCell(row[key])).join(','))];
  writeFileSync(resolve(outputDir, `punchinella-linked-bom-batch-${String(batch).padStart(2, '0')}.csv`), `${lines.join('\n')}\n`);
}

const sortedPools = [...pools.values()].sort((a, b) => a.punchSku.localeCompare(b.punchSku));
const shopifyHeaders = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Inventory Tracker',
  'Variant Inventory Policy', 'Status',
];
const shopifyRows = sortedPools.map((pool, position) => ({
  Handle: internalHandle,
  Title: position === 0 ? 'Internal Punchinella Stock' : '',
  'Body (HTML)': position === 0 ? 'Internal stock only. Do not publish or sell.' : '',
  Vendor: 'The Sustainable Sequin Company',
  Type: 'Internal inventory',
  Tags: 'internal,punchinella-stock,do-not-publish',
  Published: 'FALSE',
  'Option1 Name': 'Punchinella pool',
  'Option1 Value': `${pool.colour} | ${pool.content}% rPET`,
  'Variant SKU': pool.punchSku,
  'Variant Inventory Tracker': 'shopify',
  'Variant Inventory Policy': 'deny',
  Status: 'draft',
}));
writeFileSync(resolve(outputDir, 'shopify-internal-punchinella-stock.csv'), `${[shopifyHeaders.join(','), ...shopifyRows.map((row) => shopifyHeaders.map((key) => csvCell(row[key])).join(','))].join('\n')}\n`);

const manifestHeaders = ['raw_material_sku', 'raw_material_name', 'shopify_internal_product', 'shopify_variant_sku', 'stock_unit', 'opening_stock'];
const manifestRows = sortedPools.map((pool) => ({
  raw_material_sku: pool.punchSku,
  raw_material_name: pool.punchName,
  shopify_internal_product: 'Internal Punchinella Stock',
  shopify_variant_sku: pool.punchSku,
  stock_unit: 'cm',
  opening_stock: '0',
}));
writeFileSync(resolve(outputDir, 'punchinella-linked-materials-manifest.csv'), `${[manifestHeaders.join(','), ...manifestRows.map((row) => manifestHeaders.map((key) => csvCell(row[key])).join(','))].join('\n')}\n`);

writeFileSync(resolve(outputDir, 'README.md'), `This is the Shopify-linked Punchinella model.\n\n1. Import shopify-internal-punchinella-stock.csv into Shopify Products. It creates one DRAFT internal product with ${sortedPools.length} stock variants. Each inventory unit means 1 cm.\n2. In Soply, create a Linked to Shopify raw material for every row in punchinella-linked-materials-manifest.csv, matching it to the internal variant with the same PUNCH-* SKU. Do not create Track in App materials.\n3. Import the ${Math.ceil(bindings.length / batchSize)} punchinella-linked-bom batches in order. Each customer-facing 3 metre Punchinella variant consumes 300 cm.\n4. Production automation must add centimetres only when a normal sequin order is fulfilled; Punchinella and Seconds must be excluded.\n`);

console.log(`Created ${bindings.length} Punchinella bindings and ${sortedPools.length} Shopify-linked stock pools.`);
