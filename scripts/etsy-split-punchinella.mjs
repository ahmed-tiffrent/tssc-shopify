#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDir = path.join(root, 'soply-import', 'backups');
const envPath = path.join(root, '.env.etsy.local');
const planPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');
const statePath = path.join(root, 'soply-import', 'etsy-sync-state.json');
const SHOP_ID = 17132311;
const TAXONOMY_ID = 6439;
const RETURN_POLICY_ID = 1097277084811;
const READINESS_STATE_ID = 1406197290896;
const SHIPPING_PUNCHINELLA = 174833781132;
const SECTION_PUNCHINELLA = 60432392;
const COLOUR_PROPERTY = 514;
const SHAPE_PROPERTY = 513;

const latest = (prefix) => fs.readdirSync(backupDir).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort().at(-1);
const parseEnv = (contents) => Object.fromEntries(contents.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
}));
function updateEnv(contents, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = contents.split(/\r?\n/).map((line) => {
    const index = line.indexOf('=');
    if (index < 0) return line;
    const key = line.slice(0, index).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key); pending.delete(key); return `${key}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`;
}
const canonical = (value) => String(value || '').normalize('NFKD').replace(/[’']/g, '').replace(/\+/g, ' and ')
  .replace(/&/g, ' and ').toLocaleLowerCase('en-GB').replace(/centre/g, 'center')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const optionValue = (variant, name) => variant.selectedOptions.find((option) => canonical(option.name) === canonical(name))?.value;
const htmlToText = (html) => String(html || '').replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|ul|ol)>/gi, '\n')
  .replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const shopifyFile = latest('shopify-products-before-etsy-sync-');
if (!shopifyFile) throw new Error('Fresh Shopify export is required.');
const shopify = JSON.parse(fs.readFileSync(path.join(backupDir, shopifyFile), 'utf8'));
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const products = shopify.products.filter((product) => /^Punchinella\b/i.test(product.title)).sort((a, b) => b.title.localeCompare(a.title));
if (products.length !== 2) throw new Error(`Expected two Punchinella Shopify products, found ${products.length}.`);

function splitGroups(product) {
  const option = product.options.find((item) => canonical(item.name).startsWith('material shape hole position style size'));
  const values = option?.optionValues.map((item) => item.name) || [];
  if (values.length !== 26) throw new Error(`${product.title}: expected 26 product options, found ${values.length}.`);
  const spools = values.filter((value) => /On The Spool/i.test(value));
  const centres = values.filter((value) => /Circle/i.test(value) && /Cent(?:er|re) Hole/i.test(value) && !/On The Spool/i.test(value));
  const sides = values.filter((value) => /Circle/i.test(value) && /Side Hole/i.test(value) && !/On The Spool/i.test(value));
  const shapes = values.filter((value) => !centres.includes(value) && !sides.includes(value) && !spools.includes(value));
  if (/100%/.test(product.title)) {
    return [
      { slug: 'loose-circles', label: 'Loose Circles', values: [...centres, ...sides] },
      { slug: 'shapes-spools', label: 'Shapes + Spools', values: [...shapes, ...spools] },
    ];
  }
  return [
    { slug: 'centre-circles-spools', label: 'Centre-Hole Circles + Spools', values: [...centres, ...spools.slice(0, 2)] },
    { slug: 'side-circles-spools', label: 'Side-Hole Circles + Spools', values: [...sides, ...spools.slice(2, 4)] },
    { slug: 'shapes-spools', label: 'Shapes + Spools', values: [...shapes, ...spools.slice(4)] },
  ];
}

function targetFor(product, group) {
  const key = `${product.id}|punch-group:${group.slug}`;
  return {
    key, role: 'master', shopify_product_id: product.id, shopify_product_title: product.title,
    colour: null, source: 'punchinella-split', punch_option_values: group.values,
    listing_title: `${product.title} | ${group.label}`,
  };
}

function inventoryFor(product, target) {
  const allowed = new Set(target.punch_option_values.map(canonical));
  const variants = product.variants.nodes.filter((variant) => allowed.has(canonical(optionValue(variant, 'Material | Shape | Hole Position | Style | Size'))));
  if (!variants.length || variants.length > 400) throw new Error(`${target.listing_title}: invalid group size ${variants.length}.`);
  const anyAvailable = variants.some((variant) => variant.availableForSale && Number(variant.inventoryQuantity) > 0);
  return {
    anyAvailable,
    payload: {
      products: variants.map((variant, index) => {
        const enabled = variant.availableForSale && Number(variant.inventoryQuantity) > 0;
        return {
          sku: String(variant.sku || '').slice(0, 32),
          offerings: [{
            quantity: enabled ? Math.max(1, Math.min(999, Number(variant.inventoryQuantity))) : (!anyAvailable && index === 0 ? 1 : 0),
            is_enabled: enabled || (!anyAvailable && index === 0), price: Number(variant.price), readiness_state_id: READINESS_STATE_ID,
          }],
          property_values: [
            { property_id: COLOUR_PROPERTY, property_name: 'Colour', scale_id: null, values: [optionValue(variant, 'Colour')] },
            { property_id: SHAPE_PROPERTY, property_name: 'Shape | Hole Position | Style | Size', scale_id: null, values: [optionValue(variant, 'Material | Shape | Hole Position | Style | Size')] },
          ],
        };
      }),
      price_on_property: [COLOUR_PROPERTY, SHAPE_PROPERTY], quantity_on_property: [COLOUR_PROPERTY, SHAPE_PROPERTY],
      sku_on_property: [COLOUR_PROPERTY, SHAPE_PROPERTY], readiness_state_on_property: [],
    },
  };
}

let envText = fs.readFileSync(envPath, 'utf8');
const env = parseEnv(envText);
let accessToken;
async function refreshToken() {
  const response = await fetch('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.ETSY_KEYSTRING, refresh_token: env.ETSY_REFRESH_TOKEN }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description || body.error || `Token refresh failed (${response.status})`);
  accessToken = body.access_token; env.ETSY_REFRESH_TOKEN = body.refresh_token;
  envText = updateEnv(envText, { ETSY_ACCESS_TOKEN: body.access_token, ETSY_REFRESH_TOKEN: body.refresh_token, ETSY_TOKEN_SCOPE: body.scope || env.ETSY_TOKEN_SCOPE });
  fs.writeFileSync(envPath, envText, { mode: 0o600 });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function etsy(pathname, { method = 'GET', form, json, multipart, retry = 0 } = {}) {
  await sleep(150);
  const headers = { 'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`, authorization: `Bearer ${accessToken}` };
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = form; }
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (multipart) body = multipart;
  const response = await fetch(`https://api.etsy.com/v3/application${pathname}`, { method, headers, body });
  if (response.status === 401 && retry < 1) { await refreshToken(); return etsy(pathname, { method, form, json, multipart, retry: retry + 1 }); }
  if ((response.status === 429 || response.status >= 500) && retry < 6) {
    await sleep(Math.min(Number(response.headers.get('retry-after') || 2 ** retry) * 1_000, 60_000));
    return etsy(pathname, { method, form, json, multipart, retry: retry + 1 });
  }
  const text = await response.text(); const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${payload?.error || text}`);
  return payload;
}

function listingForm(product, target) {
  const first = product.variants.nodes[0];
  return new URLSearchParams({
    quantity: '1', title: target.listing_title,
    description: `${target.listing_title}\n\nChoose your colour and product type from the options.\n\n${htmlToText(product.descriptionHtml)}`.slice(0, 13_000),
    price: String(first.price), who_made: 'i_did', when_made: '2020_2026', taxonomy_id: String(TAXONOMY_ID),
    shipping_profile_id: String(SHIPPING_PUNCHINELLA), return_policy_id: String(RETURN_POLICY_ID),
    readiness_state_id: String(READINESS_STATE_ID), shop_section_id: String(SECTION_PUNCHINELLA),
    is_supply: 'true', type: 'physical', should_auto_renew: 'true',
    tags: 'Recycled sequins,Sustainable sequins,Eco friendly sequins,Embroidery supplies,Costume sequins,Craft sequins,PET sequins,Paillettes,Made in UK,Punchinella',
    materials: /100%/.test(product.title) ? '100 percent recycled PET' : '20 percent recycled PET,80 percent polyester',
  });
}

async function uploadPrimaryImage(product, target, listingId) {
  const url = product.media.nodes.find((media) => media.image?.url)?.image?.url;
  if (!url) throw new Error(`${product.title}: no primary image.`);
  const imageUrl = new URL(url); imageUrl.searchParams.set('width', '2048'); imageUrl.searchParams.set('format', 'jpg');
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
  const form = new FormData();
  form.append('image', new Blob([await response.arrayBuffer()], { type: 'image/jpeg' }), 'punchinella.jpg');
  form.append('rank', '1'); form.append('alt_text', target.listing_title.slice(0, 500));
  await etsy(`/shops/${SHOP_ID}/listings/${listingId}/images`, { method: 'POST', multipart: form });
}

await refreshToken();
const newTargets = [];
const created = [];
for (const product of products) {
  const groups = splitGroups(product);
  const oldKey = `${product.id}|master`;
  const oldRecord = state.targets[oldKey];
  if (!oldRecord?.listing_id) throw new Error(`${product.title}: missing existing master listing.`);
  for (let index = 0; index < groups.length; index += 1) {
    const target = targetFor(product, groups[index]);
    const inventory = inventoryFor(product, target);
    let record = state.targets[target.key];
    if (!record && index === 0) {
      record = state.targets[target.key] = { ...oldRecord, source: 'punchinella-split-reuse', split_from: oldKey };
    }
    let listingId = record?.listing_id;
    if (!listingId) {
      const listing = await etsy(`/shops/${SHOP_ID}/listings?legacy=false`, { method: 'POST', form: listingForm(product, target) });
      listingId = listing.listing_id;
      record = state.targets[target.key] = { source: 'punchinella-split-create', listing_id: listingId, created_draft: true };
      await uploadPrimaryImage(product, target, listingId);
      created.push(listingId);
    } else {
      await etsy(`/shops/${SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: listingForm(product, target) });
    }
    await etsy(`/listings/${listingId}/inventory`, { method: 'PUT', json: inventory.payload });
    if (inventory.anyAvailable) {
      await etsy(`/shops/${SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: new URLSearchParams({ state: 'active' }) });
    }
    Object.assign(record, { complete: true, listing_id: listingId, inventory_updated: true, completed_at: new Date().toISOString() });
    target.etsy_listing_id = listingId;
    newTargets.push(target);
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
  oldRecord.split_into = newTargets.filter((target) => target.shopify_product_id === product.id).map((target) => target.key);
}

const punchIds = new Set(products.map((product) => product.id));
plan.targets = [...plan.targets.filter((target) => !punchIds.has(target.shopify_product_id)), ...newTargets];
plan.summary.target_listings = plan.targets.length;
plan.punchinella_split_at = new Date().toISOString();
fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
state.updated_at = new Date().toISOString();
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

const report = { applied_at: new Date().toISOString(), created_listing_ids: created, targets: newTargets.map((target) => ({ key: target.key, title: target.listing_title, listing_id: target.etsy_listing_id, options: target.punch_option_values.length })) };
const reportPath = path.join(backupDir, `etsy-punchinella-split-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
