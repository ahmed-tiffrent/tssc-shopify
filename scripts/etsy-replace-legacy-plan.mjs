#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');
const statePath = path.join(root, 'soply-import', 'etsy-sync-state.json');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
const replacements = [];

for (const target of plan.targets) {
  if (target.etsy_listing_id && target.source.startsWith('reuse')) {
    replacements.push({
      listing_id: target.etsy_listing_id,
      title: target.previous_title,
      reason: 'Legacy Shopify-matching listing replaced because Etsy regional pricing blocks API variation synchronisation',
      replacement_target_key: target.key,
    });
    target.legacy_listing_id = target.etsy_listing_id;
    target.etsy_listing_id = null;
    target.source = 'create-replacement';
  }
  if (state && target.source === 'create-replacement' && state.targets[target.key]?.listing_id === target.legacy_listing_id) {
    delete state.targets[target.key];
  }
}

plan.delete_duplicates = [...(plan.delete_duplicates || []), ...replacements];
plan.summary.reuse_same_product = 0;
plan.summary.reuse_cross_product = 0;
plan.summary.create_new = plan.targets.length;
plan.summary.delete_duplicates = plan.delete_duplicates.length;
plan.summary.preserve_etsy_only = plan.preserved_etsy_only.length;
plan.replanned_at = new Date().toISOString();
plan.replan_reason = 'Etsy domestic/global pricing prevents third-party apps from changing legacy listing variation structures.';

fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
if (state) fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ replacements: replacements.length, ...plan.summary }, null, 2)}\n`);
