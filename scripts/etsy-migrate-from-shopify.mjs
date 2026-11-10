#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.etsy.local');
const backupDir = path.join(root, 'soply-import', 'backups');
const planPath = path.join(root, 'soply-import', 'etsy-sync-plan.json');
const statePath = path.join(root, 'soply-import', 'etsy-sync-state.json');
const limitArg = process.argv.find((value) => value.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const onlySource = process.argv.find((value) => value.startsWith('--source='))?.split('=')[1] || null;
const titleFilter = process.argv.find((value) => value.startsWith('--title='))?.slice('--title='.length) || null;
const pauseMs = Number(process.argv.find((value) => value.startsWith('--pause-ms='))?.split('=')[1] || 140);
const SHOP_ID = 17132311;
const TAXONOMY_ID = 6439;
const RETURN_POLICY_ID = 1097277084811;
const READINESS_STATE_ID = 1406197290896;
const SHIPPING_LOOSE = 59451392019;
const SHIPPING_SPOOL = 98205807490;
const SHIPPING_PUNCHINELLA = 174833781132;
const CUSTOM_FIRST = 514;
const CUSTOM_SECOND = 513;

function latest(prefix) {
  return fs.readdirSync(backupDir).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort().at(-1);
}

function parseEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('=')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));
}

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

function canonical(value) {
  return String(value || '').normalize('NFKD').replace(/[’']/g, '').replace(/\+/g, ' and ')
    .replace(/&/g, ' and ').toLocaleLowerCase('en-GB').replace(/centre/g, 'center')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

let envText = fs.readFileSync(envPath, 'utf8');
const env = parseEnv(envText);
for (const key of ['ETSY_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_REFRESH_TOKEN']) {
  if (!env[key]) throw new Error(`Missing ${key} in .env.etsy.local`);
}

let accessToken = null;
async function refreshToken() {
  const response = await fetch('https://api.etsy.com/v3/public/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.ETSY_KEYSTRING, refresh_token: env.ETSY_REFRESH_TOKEN }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || `Token refresh failed (${response.status})`);
  accessToken = payload.access_token;
  env.ETSY_REFRESH_TOKEN = payload.refresh_token;
  envText = updateEnv(envText, {
    ETSY_ACCESS_TOKEN: payload.access_token,
    ETSY_REFRESH_TOKEN: payload.refresh_token,
    ETSY_TOKEN_SCOPE: payload.scope || env.ETSY_TOKEN_SCOPE,
  });
  fs.writeFileSync(envPath, envText, { mode: 0o600 });
}

await refreshToken();

async function etsy(pathname, { method = 'GET', form, json, multipart, retry = 0 } = {}) {
  await sleep(pauseMs);
  const headers = {
    'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`,
    authorization: `Bearer ${accessToken}`,
  };
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = form; }
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (multipart) body = multipart;
  let response;
  try {
    response = await fetch(`https://api.etsy.com/v3/application${pathname}`, { method, headers, body });
  } catch (error) {
    if (retry >= 6) throw error;
    await sleep(Math.min(2 ** retry * 1_000, 30_000));
    return etsy(pathname, { method, form, json, multipart, retry: retry + 1 });
  }
  if (response.status === 401 && retry < 1) { await refreshToken(); return etsy(pathname, { method, form, json, multipart, retry: retry + 1 }); }
  if ((response.status === 429 || response.status >= 500) && retry < 6) {
    const wait = Number(response.headers.get('retry-after') || 2 ** retry) * 1_000;
    await sleep(Math.min(wait, 60_000));
    return etsy(pathname, { method, form, json, multipart, retry: retry + 1 });
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${payload?.error || text}`);
  return payload;
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const shopifyBackup = JSON.parse(fs.readFileSync(path.join(backupDir, plan.shopify_backup), 'utf8'));
const products = new Map(shopifyBackup.products.map((product) => [product.id, product]));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
  created_at: new Date().toISOString(), assets: {}, targets: {},
};

function saveState() {
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function optionValue(variant, name) {
  return variant.selectedOptions.find((option) => canonical(option.name) === canonical(name))?.value;
}

function etsyOptionName(name) {
  return canonical(name) === canonical('Material | Shape | Hole Position | Style | Size')
    ? 'Shape | Hole Position | Style | Size'
    : name;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function titleFor(target) {
  return target.role === 'master' ? target.shopify_product_title : `${target.shopify_product_title} | ${target.colour}`;
}

function descriptionFor(product, target) {
  let body = htmlToText(product.descriptionHtml);
  if (/^Punchinella\b/i.test(product.title)) {
    body = body.replace(/Colour Shown\s*\n[^\n]+/i, target.colour ? `Colour\n${target.colour}` : 'Colour\nChoose your colour from the options');
  }
  const intro = [titleFor(target), target.colour ? `Colour: ${target.colour}` : 'Choose your colour and quantity from the options.'];
  return `${intro.join('\n')}\n\n${body}`.slice(0, 13_000);
}

function tagsFor(product, target) {
  const values = ['Recycled sequins', 'Sustainable sequins', 'Eco friendly sequins', 'Embroidery supplies', 'Costume sequins', 'Craft sequins', 'PET sequins', 'Paillettes', 'Made in UK'];
  const size = product.title.match(/(?:\d+\*\d+|\d+)mm/i)?.[0];
  if (size) values.push(`${size} sequins`);
  for (const shape of ['Circle', 'Square', 'Triangle', 'Oval', 'Teardrop', 'Punchinella', 'Spool']) {
    if (new RegExp(shape, 'i').test(product.title)) values.push(`${shape} sequins`);
  }
  if (target.colour) values.push(target.colour);
  if (/100%/.test(product.title)) values.push('100 recycled plastic');
  const unique = [];
  for (const value of values) {
    const clean = value.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (clean && !unique.some((item) => canonical(item) === canonical(clean))) unique.push(clean);
  }
  return unique.slice(0, 13);
}

function materialsFor(product) {
  if (/^Seconds$/i.test(product.title)) return ['recycled PET'];
  const values = /100%/.test(product.title) ? ['100 percent recycled PET'] : ['20 percent recycled PET', '80 percent polyester'];
  if (/On The Spool/i.test(product.title)) values.push('plastic spool');
  return values;
}

function shippingProfile(product) {
  if (/^Punchinella\b/i.test(product.title)) return SHIPPING_PUNCHINELLA;
  if (/On The Spool/i.test(product.title)) return SHIPPING_SPOOL;
  return SHIPPING_LOOSE;
}

function relevantVariants(product, target) {
  return product.variants.nodes.filter((variant) => target.role === 'master' || canonical(optionValue(variant, 'Colour')) === canonical(target.colour));
}

function inventoryFor(product, target) {
  const relevant = relevantVariants(product, target);
  const isMaster = target.role === 'master';
  const available = relevant.filter((variant) => Number(variant.inventoryQuantity) > 0);
  const ignored = new Set(['finish']);
  if (!isMaster) ignored.add('colour');
  const optionNames = product.options.map((option) => option.name).filter((name) => !ignored.has(canonical(name)));
  if (optionNames.length > 2) throw new Error(`${product.title}: Etsy inventory would need ${optionNames.length} variations.`);
  const punchMaster = isMaster && /^Punchinella\b/i.test(product.title);
  const activeValueSets = optionNames.map((name) => new Set(available.map((variant) => canonical(optionValue(variant, name)))));
  const variants = punchMaster
    ? (available.length
      ? relevant.filter((variant) => optionNames.every((name, index) => activeValueSets[index].has(canonical(optionValue(variant, name)))))
      : relevant.slice(0, 1))
    : relevant;
  if (variants.length > 400) throw new Error(`${product.title}: ${variants.length} currently relevant combinations exceed Etsy's 400-combination limit.`);
  const propertyIds = optionNames.map((_, index) => index === 0 ? CUSTOM_FIRST : CUSTOM_SECOND);
  const anyAvailable = available.length > 0;
  const entries = variants.map((variant, variantIndex) => {
    const enabled = Number(variant.inventoryQuantity) > 0;
    const stock = enabled
      ? Math.max(1, Math.min(999, Number(variant.inventoryQuantity) || 1))
      : (!anyAvailable && variantIndex === 0 ? 1 : 0);
    const propertyValues = optionNames.map((name, index) => ({
      property_id: propertyIds[index], property_name: etsyOptionName(name), scale_id: null, values: [optionValue(variant, name)],
    }));
    return {
      sku: String(variant.sku || '').slice(0, 32),
      offerings: [{
        quantity: stock,
        is_enabled: enabled || (!anyAvailable && variantIndex === 0),
        price: Number(variant.price),
        readiness_state_id: READINESS_STATE_ID,
      }],
      property_values: propertyValues,
    };
  });
  if (!entries.length) throw new Error(`${titleFor(target)}: no matching Shopify variants.`);
  const all = propertyIds;
  return {
    products: entries,
    price_on_property: all,
    quantity_on_property: all,
    sku_on_property: all,
    readiness_state_on_property: [],
    any_available: anyAvailable,
  };
}

function isDiagram(url) { return /size[_-]?diagram/i.test(url); }
function cleanAssetKey(url) { const parsed = new URL(url); parsed.search = ''; return parsed.toString(); }
function uploadUrl(url) { const parsed = new URL(url); parsed.searchParams.set('width', '2048'); parsed.searchParams.set('format', 'jpg'); return parsed.toString(); }

function sizeDiagram(product) {
  if (/^Seconds$|^Punchinella\b/i.test(product.title)) return null;
  let source = product;
  if (/100% Recycled Plastic$/i.test(product.title)) {
    const counterpart = [...products.values()].find((candidate) => canonical(candidate.title.replace(/20% Recycled Plastic$/i, '')) === canonical(product.title.replace(/100% Recycled Plastic$/i, '')) && /20% Recycled Plastic$/i.test(candidate.title));
    if (counterpart) source = counterpart;
  }
  return source.media.nodes.find((media) => media.image?.url && isDiagram(media.image.url))?.image.url || null;
}

function imageUrlsFor(product, target) {
  const productImages = product.media.nodes.filter((media) => media.image?.url).map((media) => media.image.url);
  const nonDiagrams = productImages.filter((url) => !isDiagram(url));
  const diagram = sizeDiagram(product);
  if (target.role === 'colour') {
    const variantUrl = relevantVariants(product, target).flatMap((variant) => variant.media.nodes || []).find((media) => media.image?.url)?.image.url;
    return [...new Set([variantUrl || nonDiagrams[0], diagram].filter(Boolean).map(cleanAssetKey))];
  }
  const variantUrls = product.variants.nodes.flatMap((variant) => variant.media.nodes || []).filter((media) => media.image?.url).map((media) => media.image.url);
  const ordered = [nonDiagrams[0], ...variantUrls, ...nonDiagrams.slice(1), diagram].filter(Boolean).map(cleanAssetKey);
  return [...new Set(ordered)].slice(0, 20);
}

async function ensureAsset(url, listingId, rank, alt) {
  const key = cleanAssetKey(url);
  if (state.assets[key]?.image_id) return state.assets[key].image_id;
  const response = await fetch(uploadUrl(url));
  if (!response.ok) throw new Error(`Could not download Shopify image (${response.status}): ${url}`);
  const bytes = await response.arrayBuffer();
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'shopify-product.jpg');
  form.append('rank', String(rank));
  form.append('alt_text', alt.slice(0, 500));
  const image = await etsy(`/shops/${SHOP_ID}/listings/${listingId}/images`, { method: 'POST', multipart: form });
  state.assets[key] = { image_id: image.listing_image_id, source_listing_id: listingId, uploaded_at: new Date().toISOString() };
  saveState();
  return image.listing_image_id;
}

function listingForm(product, target, imageIds = []) {
  const variants = relevantVariants(product, target);
  const first = variants.find((variant) => variant.availableForSale) || variants[0];
  const form = new URLSearchParams();
  const values = {
    quantity: String(Math.max(1, Math.min(999, Number(first.inventoryQuantity) || 1))),
    title: titleFor(target), description: descriptionFor(product, target), price: String(first.price),
    who_made: 'i_did', when_made: '2020_2026', taxonomy_id: String(TAXONOMY_ID),
    shipping_profile_id: String(shippingProfile(product)), return_policy_id: String(RETURN_POLICY_ID),
    readiness_state_id: String(READINESS_STATE_ID), is_supply: 'true', type: 'physical', should_auto_renew: 'true',
  };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  form.set('tags', tagsFor(product, target).join(','));
  form.set('materials', materialsFor(product).join(','));
  if (imageIds.length) form.set('image_ids', imageIds.join(','));
  return form;
}

async function linkMasterVariationImages(product, target, listingId, imageUrls) {
  if (target.role !== 'master') return;
  const inventory = await etsy(`/listings/${listingId}/inventory`);
  const colourValues = new Map();
  for (const item of inventory.products || []) {
    const value = item.property_values?.find((entry) => canonical(entry.property_name) === 'colour');
    if (value?.values?.[0] && value?.value_ids?.[0]) colourValues.set(canonical(value.values[0]), value.value_ids[0]);
  }
  const links = [];
  for (const colour of product.options.find((option) => canonical(option.name) === 'colour')?.optionValues || []) {
    const targetVariant = product.variants.nodes.find((variant) => canonical(optionValue(variant, 'Colour')) === canonical(colour.name) && variant.media.nodes.some((media) => media.image?.url));
    const url = targetVariant?.media.nodes.find((media) => media.image?.url)?.image.url;
    const imageId = url && state.assets[cleanAssetKey(url)]?.image_id;
    const valueId = colourValues.get(canonical(colour.name));
    if (imageId && valueId && imageUrls.includes(cleanAssetKey(url))) links.push({ property_id: CUSTOM_FIRST, value_id: valueId, image_id: imageId });
    if (links.length === 20) break;
  }
  if (links.length) await etsy(`/shops/${SHOP_ID}/listings/${listingId}/variation-images`, { method: 'POST', json: { variation_images: links } });
}

async function migrateTarget(target) {
  const product = products.get(target.shopify_product_id);
  if (!product) throw new Error(`Missing Shopify product ${target.shopify_product_id}`);
  const record = state.targets[target.key] ||= { source: target.source, listing_id: target.etsy_listing_id || null };
  if (record.complete) return false;

  let listingId = record.listing_id;
  const urls = imageUrlsFor(product, target);
  const knownImageIds = urls.map((url) => state.assets[url]?.image_id).filter(Boolean);

  if (!listingId) {
    const listing = await etsy(`/shops/${SHOP_ID}/listings?legacy=false`, { method: 'POST', form: listingForm(product, target, knownImageIds) });
    listingId = listing.listing_id;
    record.listing_id = listingId;
    record.created_draft = true;
    target.etsy_listing_id = listingId;
    saveState();
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  } else {
    await etsy(`/shops/${SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: listingForm(product, target, knownImageIds) });
    record.metadata_updated = true;
    saveState();
  }

  const imageIds = [];
  for (let index = 0; index < urls.length; index += 1) {
    imageIds.push(await ensureAsset(urls[index], listingId, index + 1, `${titleFor(target)}${index === 0 ? '' : ' product detail'}`));
  }
  await etsy(`/shops/${SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: listingForm(product, target, imageIds) });
  record.images_updated = true;
  saveState();

  const inventory = inventoryFor(product, target);
  const { any_available: anyAvailable, ...inventoryPayload } = inventory;
  await etsy(`/listings/${listingId}/inventory`, { method: 'PUT', json: inventoryPayload });
  record.inventory_updated = true;
  saveState();

  await linkMasterVariationImages(product, target, listingId, urls);
  record.variation_images_updated = true;
  saveState();

  if (record.created_draft && anyAvailable) {
    const form = new URLSearchParams({ state: 'active' });
    await etsy(`/shops/${SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form });
    record.activated = true;
  } else if (record.created_draft) {
    record.held_as_unavailable_draft = true;
  }
  record.complete = true;
  record.completed_at = new Date().toISOString();
  saveState();
  return true;
}

let processed = 0;
let failed = 0;
for (const target of plan.targets) {
  if (processed >= limit) break;
  if (onlySource && target.source !== onlySource) continue;
  if (titleFilter && !titleFor(target).toLocaleLowerCase('en-GB').includes(titleFilter.toLocaleLowerCase('en-GB'))) continue;
  if (state.targets[target.key]?.complete) continue;
  try {
    process.stdout.write(`[${processed + 1}] ${target.source}: ${titleFor(target)}\n`);
    if (await migrateTarget(target)) processed += 1;
  } catch (error) {
    failed += 1;
    const record = state.targets[target.key] ||= {};
    record.error = error.message;
    record.failed_at = new Date().toISOString();
    saveState();
    process.stderr.write(`FAILED ${titleFor(target)}: ${error.message}\n`);
    if (failed >= 5) break;
  }
}

const complete = Object.values(state.targets).filter((record) => record.complete).length;
process.stdout.write(`Processed this run: ${processed}; failed: ${failed}; total complete: ${complete}/${plan.targets.length}\n`);
if (failed) process.exitCode = 1;
