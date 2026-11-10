#!/usr/bin/env node

/*
 * Builds Soply imports for Punchinella as its own stock, measured in metres.
 * Source rows use already-assigned Shopify variant SKUs, but replace the
 * previous film material with a dedicated PUNCH-* material and a 3m usage.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve('soply-import/soply-bom-import.csv');
const outputDir = resolve('soply-import/punchinella');
const batchSize = 250;
const [header, ...sourceRows] = readFileSync(sourcePath, 'utf8').trim().split(/\r?\n/);
const headers = header.split(',');
const index = Object.fromEntries(headers.map((value, position) => [value, position]));

function cells(row) {
  return row.split(',');
}

function titleCase(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const rows = [];
const rawMaterials = new Map();
for (const sourceRow of sourceRows) {
  const values = cells(sourceRow);
  if (!/^Punchinella\b/i.test(values[index.product_title])) continue;

  const filmSku = values[index.raw_material_sku];
  const nameParts = values[index.raw_material_name].match(/^[A-Z0-9-]+\s+(.+?)\s+(20|100)% rPET$/i);
  if (!nameParts) throw new Error(`Cannot parse material name: ${values[index.raw_material_name]}`);
  const [, colour, content] = nameParts;
  const punchSku = `PUNCH-${filmSku}`;
  const punchName = `Punchinella | ${titleCase(colour)} | ${content}% rPET`;

  rows.push({
    variant_sku: values[index.variant_sku],
    product_title: values[index.product_title],
    variant_title: values[index.variant_title],
    raw_material_sku: punchSku,
    raw_material_name: punchName,
    quantity: '3',
    unit: 'm',
  });
  rawMaterials.set(punchSku, {
    raw_material_sku: punchSku,
    raw_material_name: punchName,
    starting_stock: '0',
    unit: 'm',
  });
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const csvHeaders = ['variant_sku', 'product_title', 'variant_title', 'raw_material_sku', 'raw_material_name', 'quantity', 'unit'];
for (let start = 0, batch = 1; start < rows.length; start += batchSize, batch += 1) {
  const lines = [csvHeaders.join(','), ...rows.slice(start, start + batchSize).map((row) => csvHeaders.map((key) => row[key]).join(','))];
  writeFileSync(resolve(outputDir, `punchinella-bom-batch-${String(batch).padStart(2, '0')}.csv`), `${lines.join('\n')}\n`);
}

const stockHeaders = ['raw_material_sku', 'raw_material_name', 'starting_stock', 'unit'];
const stockRows = [...rawMaterials.values()].sort((a, b) => a.raw_material_sku.localeCompare(b.raw_material_sku));
writeFileSync(resolve(outputDir, 'punchinella-raw-materials.csv'), `${[stockHeaders.join(','), ...stockRows.map((row) => stockHeaders.map((key) => row[key]).join(','))].join('\n')}\n`);
writeFileSync(resolve(outputDir, 'README.md'), `Import the ${Math.ceil(rows.length / batchSize)} BOM batches in order. Soply creates the dedicated PUNCH-* raw materials at 0m; set physical starting metres when known. Each Punchinella sale deducts 3m from the matching colour/material pool.\n`);

console.log(`Created ${rows.length} Punchinella bindings across ${rawMaterials.size} stock pools.`);
