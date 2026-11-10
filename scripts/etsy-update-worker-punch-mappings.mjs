#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'soply-import', 'etsy-sync-plan.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(root, 'soply-import', 'etsy-sync-state.json'), 'utf8'));
const targets = plan.targets.filter((target) => target.punch_option_values?.length);
if (targets.length !== 5) throw new Error(`Expected five split Punchinella mappings, found ${targets.length}.`);

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const statements = [];
for (const target of targets) {
  const record = state.targets[target.key];
  if (!record?.listing_id) throw new Error(`${target.key}: missing listing ID.`);
  const values = JSON.stringify(target.punch_option_values);
  statements.push(`INSERT INTO etsy_listing_map
    (target_key, shopify_product_id, etsy_listing_id, role, colour, punch_option_values, listing_title, updated_at)
    VALUES (${quote(target.key)}, ${quote(target.shopify_product_id)}, ${quote(record.listing_id)}, 'master', NULL,
      ${quote(values)}, ${quote(target.listing_title)}, ${quote(new Date().toISOString())})
    ON CONFLICT(etsy_listing_id) DO UPDATE SET
      target_key=excluded.target_key,
      shopify_product_id=excluded.shopify_product_id,
      role=excluded.role,
      colour=excluded.colour,
      punch_option_values=excluded.punch_option_values,
      listing_title=excluded.listing_title,
      updated_at=excluded.updated_at`);
}
const result = execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'tssc-punchinella-stock-db', '--remote',
  '--command', `${statements.join(';\n')};`,
], {
  cwd: path.join(root, 'punchinella-stock-worker'),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(result);
