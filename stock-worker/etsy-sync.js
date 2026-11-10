import {
  ETSY_COLOUR_VALUE_IDS,
  ETSY_CRAFT_TYPE_PROPERTY_ID,
  ETSY_CRAFT_TYPE_VALUE_IDS,
  ETSY_CRAFT_TYPE_VALUES,
  ETSY_PRIMARY_COLOUR_PROPERTY_ID,
  ETSY_SECTION_DEFINITIONS,
  addCatalogueSearchTerms,
  colourCategoryFor,
  etsySectionKeyFor,
  etsyTargetTitle,
} from './etsy-catalogue-rules.js';

const ETSY_API = 'https://api.etsy.com/v3/application';
const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const ETSY_SHOP_ID = 17132311;
const ETSY_TAXONOMY_ID = 6439;
const ETSY_RETURN_POLICY_ID = 1097277084811;
const ETSY_READINESS_STATE_ID = 1406197290896;
const ETSY_SHIPPING_LOOSE = 59451392019;
const ETSY_SHIPPING_SPOOL = 98205807490;
const ETSY_SHIPPING_PUNCHINELLA = 174833781132;
const CUSTOM_FIRST = 514;
const CUSTOM_SECOND = 513;

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let lastEtsyRequestAt = 0;

function canonical(value) {
  return String(value || '').normalize('NFKD').replace(/[’']/g, '').replace(/\+/g, ' and ')
    .replace(/&/g, ' and ').toLocaleLowerCase('en-GB').replace(/centre/g, 'center')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function isMasterOnlyProduct(product) {
  return /^Punchinella\b|^Seconds$/i.test(String(product?.title || ''));
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function optionValue(variant, name) {
  return variant.selectedOptions.find((option) => canonical(option.name) === canonical(name))?.value;
}

function etsyOptionName(name) {
  return canonical(name) === canonical('Material | Shape | Hole Position | Style | Size')
    ? 'Shape | Hole Position | Style | Size'
    : name;
}

function targetTitle(product, mapping) {
  return etsyTargetTitle(product.title, mapping.role, mapping.colour, mapping.listing_title);
}

function targetDescription(product, mapping) {
  let body = htmlToText(product.descriptionHtml);
  if (/^Punchinella\b/i.test(product.title)) {
    body = body.replace(/Colour Shown\s*\n[^\n]+/i, mapping.colour ? `Colour\n${mapping.colour}` : 'Colour\nChoose your colour from the options');
  }
  const intro = [targetTitle(product, mapping), mapping.colour ? `Colour: ${mapping.colour}` : 'Choose your colour and quantity from the options.'];
  return `${intro.join('\n')}\n\n${body}`.slice(0, 13_000);
}

function tagsFor(product, mapping) {
  const values = ['Recycled sequins', 'Sustainable sequins', 'Eco friendly sequins', 'Embroidery supplies', 'Costume sequins', 'Craft sequins', 'PET sequins', 'Paillettes', 'Made in UK'];
  const size = product.title.match(/(?:\d+\*\d+|\d+)mm/i)?.[0];
  if (size) values.push(`${size} sequins`);
  for (const shape of ['Circle', 'Square', 'Triangle', 'Oval', 'Teardrop', 'Punchinella', 'Spool']) {
    if (new RegExp(shape, 'i').test(product.title)) values.push(`${shape} sequins`);
  }
  if (mapping.colour) values.push(mapping.colour);
  if (/100%/.test(product.title)) values.push('100 recycled plastic');
  const unique = [];
  for (const value of addCatalogueSearchTerms(values, mapping.role, mapping.colour)) {
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

function materialsForMapping(product, mapping) {
  const category = mapping.role === 'master' ? 'All colours' : colourCategoryFor(mapping.colour);
  return [...new Set([category, ...materialsFor(product)].filter(Boolean))].slice(0, 13);
}

function shippingProfile(product) {
  if (/^Punchinella\b/i.test(product.title)) return ETSY_SHIPPING_PUNCHINELLA;
  if (/On The Spool/i.test(product.title)) return ETSY_SHIPPING_SPOOL;
  return ETSY_SHIPPING_LOOSE;
}

function mappingPunchOptions(mapping) {
  if (Array.isArray(mapping.punch_option_values)) return mapping.punch_option_values;
  if (typeof mapping.punch_option_values === 'string' && mapping.punch_option_values) {
    try { return JSON.parse(mapping.punch_option_values); } catch { return []; }
  }
  return [];
}

function relevantVariants(product, mapping) {
  const punchOptions = mappingPunchOptions(mapping);
  const allowedPunchOptions = punchOptions.length
    ? new Set(punchOptions.map(canonical))
    : null;
  return product.variants.nodes.filter((variant) => {
    if (allowedPunchOptions && !allowedPunchOptions.has(canonical(optionValue(variant, 'Material | Shape | Hole Position | Style | Size')))) return false;
    return mapping.role === 'master' || canonical(optionValue(variant, 'Colour')) === canonical(mapping.colour);
  });
}

function inventoryFor(product, mapping) {
  const relevant = relevantVariants(product, mapping);
  const isMaster = mapping.role === 'master';
  const available = relevant.filter((variant) => product.status === 'ACTIVE' && Number(variant.inventoryQuantity) > 0);
  const ignored = new Set(['finish']);
  if (!isMaster) ignored.add('colour');
  const optionNames = product.options.map((option) => option.name).filter((name) => !ignored.has(canonical(name)));
  if (optionNames.length > 2) throw new Error(`${product.title}: Etsy needs ${optionNames.length} variations.`);
  // Etsy permits at most 400 combinations and requires the complete matrix of
  // chosen values. Punchinella has 520/1,144 possible Shopify combinations, so
  // publish the complete matrix around values that currently have stock.
  const punchMaster = isMaster && /^Punchinella\b/i.test(product.title) && !mappingPunchOptions(mapping).length;
  const activeValueSets = optionNames.map((name) => new Set(available.map((variant) => canonical(optionValue(variant, name)))));
  const variants = punchMaster
    ? (available.length
      ? relevant.filter((variant) => optionNames.every((name, index) => activeValueSets[index].has(canonical(optionValue(variant, name)))))
      : relevant.slice(0, 1))
    : relevant;
  if (variants.length > 400) throw new Error(`${product.title}: ${variants.length} currently relevant combinations exceed Etsy's 400-combination limit.`);
  const propertyIds = optionNames.map((_, index) => index === 0 ? CUSTOM_FIRST : CUSTOM_SECOND);
  const anyAvailable = available.length > 0;
  const products = variants.map((variant, index) => {
    const enabled = product.status === 'ACTIVE' && Number(variant.inventoryQuantity) > 0;
    const stock = enabled ? Math.max(1, Math.min(999, Number(variant.inventoryQuantity) || 1)) : (!anyAvailable && index === 0 ? 1 : 0);
    return {
      sku: String(variant.sku || '').slice(0, 32),
      offerings: [{
        quantity: stock,
        is_enabled: enabled || (!anyAvailable && index === 0),
        price: Number(variant.price),
        readiness_state_id: ETSY_READINESS_STATE_ID,
      }],
      property_values: optionNames.map((name, optionIndex) => ({
        property_id: propertyIds[optionIndex], property_name: etsyOptionName(name), scale_id: null, values: [optionValue(variant, name)],
      })),
    };
  });
  if (!products.length) throw new Error(`${targetTitle(product, mapping)} has no Shopify variants.`);
  return {
    payload: {
      products,
      price_on_property: propertyIds,
      quantity_on_property: propertyIds,
      sku_on_property: propertyIds,
      readiness_state_on_property: [],
    },
    anyAvailable,
  };
}

function isDiagram(url) { return /size[_-]?diagram/i.test(url); }
function cleanUrl(url) {
  const parsed = new URL(url);
  const version = parsed.searchParams.get('v');
  parsed.search = '';
  if (version) parsed.searchParams.set('v', version);
  return parsed.toString();
}
function downloadableUrl(url) { const parsed = new URL(url); parsed.searchParams.set('width', '2048'); parsed.searchParams.set('format', 'jpg'); return parsed.toString(); }

function productImageUrls(product, mapping, diagramUrl = null) {
  const productImages = product.media.nodes.filter((media) => media.image?.url).map((media) => media.image.url);
  const nonDiagrams = productImages.filter((url) => !isDiagram(url));
  const diagram = /^Seconds$|^Punchinella\b/i.test(product.title)
    ? null
    : (diagramUrl || productImages.find(isDiagram) || null);
  if (mapping.role === 'colour') {
    const variantImage = relevantVariants(product, mapping).flatMap((variant) => variant.media.nodes || []).find((media) => media.image?.url)?.image.url;
    return [...new Set([variantImage || nonDiagrams[0], diagram].filter(Boolean).map(cleanUrl))];
  }
  const variantImages = product.variants.nodes.flatMap((variant) => variant.media.nodes || []).filter((media) => media.image?.url).map((media) => media.image.url);
  return [...new Set([nonDiagrams[0], ...variantImages, ...nonDiagrams.slice(1), diagram].filter(Boolean).map(cleanUrl))].slice(0, 20);
}

async function setting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function setSetting(db, key, value) {
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
}

async function etsyAccessToken(env) {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) return cachedAccessToken;
  const refreshToken = await setting(env.DB, 'etsy_refresh_token') || env.ETSY_REFRESH_TOKEN;
  if (!env.ETSY_KEYSTRING || !env.ETSY_SHARED_SECRET || !refreshToken) throw new Error('Etsy Worker secrets are incomplete.');
  const response = await fetch(ETSY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.ETSY_KEYSTRING, refresh_token: refreshToken }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Etsy token refresh failed (${response.status}): ${body.error_description || body.error || 'unknown error'}`);
  cachedAccessToken = body.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(60, Number(body.expires_in || 3600) - 120) * 1000;
  if (body.refresh_token && body.refresh_token !== refreshToken) await setSetting(env.DB, 'etsy_refresh_token', body.refresh_token);
  return cachedAccessToken;
}

async function etsy(env, pathname, { method = 'GET', form, json, multipart, retry = 0 } = {}) {
  const waitMs = Math.max(0, 175 - (Date.now() - lastEtsyRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastEtsyRequestAt = Date.now();
  const token = await etsyAccessToken(env);
  const headers = { 'x-api-key': `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`, authorization: `Bearer ${token}` };
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = form; }
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (multipart) body = multipart;
  const response = await fetch(`${ETSY_API}${pathname}`, { method, headers, body });
  if (response.status === 401 && retry < 1) {
    cachedAccessToken = null;
    cachedAccessTokenExpiresAt = 0;
    return etsy(env, pathname, { method, form, json, multipart, retry: retry + 1 });
  }
  if (response.status >= 500 && retry < 5) {
    const delay = Math.min(Number(response.headers.get('retry-after') || 2 ** retry) * 1000, 30_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return etsy(env, pathname, { method, form, json, multipart, retry: retry + 1 });
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`${method} ${pathname} failed (${response.status}): ${payload?.error || text}`);
    error.status = response.status;
    error.retryAfter = /daily rate limit/i.test(payload?.error || text)
      ? 10_800
      : Number(response.headers.get('retry-after') || 0);
    throw error;
  }
  return payload;
}

function listingForm(product, mapping, imageIds = [], shopSectionId = null) {
  const variants = relevantVariants(product, mapping);
  const first = variants.find((variant) => variant.availableForSale) || variants[0];
  const form = new URLSearchParams({
    quantity: String(Math.max(1, Math.min(999, Number(first.inventoryQuantity) || 1))),
    title: targetTitle(product, mapping),
    description: targetDescription(product, mapping),
    price: String(first.price),
    who_made: 'i_did',
    when_made: '2020_2026',
    taxonomy_id: String(ETSY_TAXONOMY_ID),
    shipping_profile_id: String(shippingProfile(product)),
    return_policy_id: String(ETSY_RETURN_POLICY_ID),
    readiness_state_id: String(ETSY_READINESS_STATE_ID),
    is_supply: 'true', type: 'physical', should_auto_renew: 'true',
    tags: tagsFor(product, mapping).join(','),
    materials: materialsForMapping(product, mapping).join(','),
  });
  if (imageIds.length) form.set('image_ids', imageIds.join(','));
  if (shopSectionId) form.set('shop_section_id', String(shopSectionId));
  return form;
}

async function ensureImageAsset(env, url, listingId, rank, alt, knownImageId = null, alreadyPresent = false) {
  const key = cleanUrl(url);
  if (knownImageId && alreadyPresent) return Number(knownImageId);
  const form = new FormData();
  if (knownImageId) {
    form.append('listing_image_id', String(knownImageId));
  } else {
    const source = await fetch(downloadableUrl(url));
    if (!source.ok) throw new Error(`Could not download Shopify image (${source.status}): ${url}`);
    form.append('image', new Blob([await source.arrayBuffer()], { type: 'image/jpeg' }), 'shopify-product.jpg');
  }
  form.append('rank', String(rank));
  form.append('alt_text', alt.slice(0, 500));
  const uploaded = await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}/images`, { method: 'POST', multipart: form });
  await env.DB.prepare(`INSERT INTO etsy_image_assets (source_url, image_id, source_listing_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET image_id = excluded.image_id, source_listing_id = excluded.source_listing_id, updated_at = excluded.updated_at`)
    .bind(key, String(uploaded.listing_image_id), String(listingId), new Date().toISOString()).run();
  return Number(uploaded.listing_image_id);
}

async function mapVariationImages(env, product, mapping, listingId, imageUrls, imageIdByUrl) {
  if (mapping.role !== 'master') return;
  const inventory = await etsy(env, `/listings/${listingId}/inventory`);
  const colourValueIds = new Map();
  for (const item of inventory.products || []) {
    const value = item.property_values?.find((entry) => canonical(entry.property_name) === 'colour');
    if (value?.values?.[0] && value?.value_ids?.[0]) colourValueIds.set(canonical(value.values[0]), value.value_ids[0]);
  }
  const links = [];
  for (const colour of product.options.find((option) => canonical(option.name) === 'colour')?.optionValues || []) {
    const variant = product.variants.nodes.find((item) => canonical(optionValue(item, 'Colour')) === canonical(colour.name) && item.media.nodes.some((media) => media.image?.url));
    const url = variant?.media.nodes.find((media) => media.image?.url)?.image.url;
    const imageId = url ? imageIdByUrl.get(cleanUrl(url)) : null;
    const valueId = colourValueIds.get(canonical(colour.name));
    if (imageId && valueId && imageUrls.includes(cleanUrl(url))) links.push({ property_id: CUSTOM_FIRST, value_id: valueId, image_id: Number(imageId) });
    if (links.length === 20) break;
  }
  if (links.length) await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}/variation-images`, { method: 'POST', json: { variation_images: links } });
}

async function runLimited(items, limit, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await task(queue.shift());
  });
  await Promise.all(workers);
}

async function sectionIdForMapping(env, product, mapping) {
  const key = etsySectionKeyFor(product.title, mapping.role);
  return key ? setting(env.DB, `etsy_section_${key}`) : null;
}

async function syncListingProperties(env, listingId, mapping) {
  await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}/properties/${ETSY_CRAFT_TYPE_PROPERTY_ID}`, {
    method: 'PUT',
    form: new URLSearchParams({
      value_ids: ETSY_CRAFT_TYPE_VALUE_IDS.join(','),
      values: ETSY_CRAFT_TYPE_VALUES.join(','),
    }),
  });
  if (mapping.role !== 'colour') return;
  const category = colourCategoryFor(mapping.colour);
  const valueId = ETSY_COLOUR_VALUE_IDS[category];
  if (!valueId) return;
  await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}/properties/${ETSY_PRIMARY_COLOUR_PROPERTY_ID}`, {
    method: 'PUT',
    form: new URLSearchParams({ value_ids: String(valueId), values: category }),
  });
}

export async function createEtsySyncSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS etsy_listing_map (
    target_key TEXT PRIMARY KEY,
    shopify_product_id TEXT NOT NULL,
    etsy_listing_id TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('master','colour')),
    colour TEXT,
    punch_option_values TEXT,
    listing_title TEXT,
    updated_at TEXT NOT NULL
  )`).run();
  try {
    await db.prepare('ALTER TABLE etsy_listing_map ADD COLUMN punch_option_values TEXT').run();
  } catch (error) {
    if (!String(error).toLowerCase().includes('duplicate column')) throw error;
  }
  try {
    await db.prepare('ALTER TABLE etsy_listing_map ADD COLUMN listing_title TEXT').run();
  } catch (error) {
    if (!String(error).toLowerCase().includes('duplicate column')) throw error;
  }
  await db.batch([
    db.prepare('CREATE INDEX IF NOT EXISTS etsy_listing_map_product ON etsy_listing_map(shopify_product_id)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS etsy_image_assets (
      source_url TEXT PRIMARY KEY,
      image_id TEXT NOT NULL,
      source_listing_id TEXT,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS etsy_sync_events (
      event_id TEXT PRIMARY KEY,
      shopify_product_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      details TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS etsy_section_assignments (
      listing_id TEXT PRIMARY KEY,
      category_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
  ]);
}

export async function importEtsyMappings(request, env) {
  const suppliedKey = request.headers.get('x-setup-key');
  if (!suppliedKey || suppliedKey !== env.SETUP_KEY && suppliedKey !== env.MIGRATION_SETUP_KEY) return new Response('Not found', { status: 404 });
  await createEtsySyncSchema(env.DB);
  const body = await request.json();

  const mappings = Array.isArray(body.mappings) ? body.mappings : [];
  const assets = Array.isArray(body.assets) ? body.assets : [];
  if (!mappings.length) return Response.json({ error: 'No mappings supplied.' }, { status: 400 });
  // The setup import is a complete snapshot. Replacing it also removes stale
  // target keys when an existing Etsy listing is repurposed for a split group.
  await env.DB.prepare('DELETE FROM etsy_listing_map').run();
  for (let offset = 0; offset < mappings.length; offset += 50) {
    await env.DB.batch(mappings.slice(offset, offset + 50).map((item) => env.DB.prepare(`INSERT INTO etsy_listing_map
      (target_key, shopify_product_id, etsy_listing_id, role, colour, punch_option_values, listing_title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_key) DO UPDATE SET shopify_product_id = excluded.shopify_product_id, etsy_listing_id = excluded.etsy_listing_id,
      role = excluded.role, colour = excluded.colour, punch_option_values = excluded.punch_option_values,
      listing_title = excluded.listing_title, updated_at = excluded.updated_at`)
      .bind(item.target_key, item.shopify_product_id, String(item.etsy_listing_id), item.role, item.colour || null,
        item.punch_option_values?.length ? JSON.stringify(item.punch_option_values) : null,
        item.listing_title || null, new Date().toISOString())));
  }
  for (let offset = 0; offset < assets.length; offset += 50) {
    await env.DB.batch(assets.slice(offset, offset + 50).map((item) => env.DB.prepare(`INSERT INTO etsy_image_assets
      (source_url, image_id, source_listing_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET image_id = excluded.image_id, source_listing_id = excluded.source_listing_id, updated_at = excluded.updated_at`)
      .bind(cleanUrl(item.source_url), String(item.image_id), String(item.source_listing_id || ''), new Date().toISOString())));
  }
  if (body.enable_sync === true) await setSetting(env.DB, 'etsy_sync_enabled', 'true');
  return Response.json({ imported: mappings.length, image_assets: assets.length, sync_enabled: body.enable_sync === true });
}

async function fetchShopifyProduct(adminGraphql, productId) {
  let after = null;
  let product = null;
  do {
    const data = await adminGraphql(`
      query EtsySyncProduct($id: ID!, $after: String) {
        product(id: $id) {
          id title descriptionHtml status
          options { name optionValues { name } }
          media(first: 100) { nodes { ... on MediaImage { image { url } } } }
          variants(first: 250, after: $after) {
            nodes {
              id sku price availableForSale inventoryQuantity
              selectedOptions { name value }
              media(first: 10) { nodes { ... on MediaImage { image { url } } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `, { id: productId, after });
    if (!data.product) return null;
    if (!product) product = { ...data.product, variants: { nodes: [] } };
    product.variants.nodes.push(...data.product.variants.nodes);
    after = data.product.variants.pageInfo.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
  } while (after);
  return product;
}

async function counterpartDiagram(adminGraphql, product) {
  if (!/100% Recycled Plastic$/i.test(product.title) || /^Seconds$|^Punchinella\b/i.test(product.title)) return null;
  const title = product.title.replace(/100% Recycled Plastic$/i, '20% Recycled Plastic');
  const data = await adminGraphql(`query DiagramProduct($query: String!) {
    products(first: 5, query: $query) { nodes { title media(first: 20) { nodes { ... on MediaImage { image { url } } } } } }
  }`, { query: `title:${JSON.stringify(title)}` });
  const match = data.products.nodes.find((candidate) => canonical(candidate.title) === canonical(title));
  return match?.media.nodes.find((media) => media.image?.url && isDiagram(media.image.url))?.image.url || null;
}

async function syncOneListing(env, product, mapping, diagramUrl, shopSectionId) {
  const listingId = Number(mapping.etsy_listing_id);
  const [current, currentImagesResponse] = await Promise.all([
    etsy(env, `/listings/${listingId}`),
    etsy(env, `/listings/${listingId}/images`),
  ]);
  const currentImages = currentImagesResponse.results || [];
  const urls = productImageUrls(product, mapping, diagramUrl);
  const assetRows = urls.length ? await env.DB.batch(urls.map((url) => env.DB.prepare(
    'SELECT source_url, image_id FROM etsy_image_assets WHERE source_url = ?',
  ).bind(url))) : [];
  const currentImageIds = new Set(currentImages.map((image) => String(image.listing_image_id)));
  const knownImageIdByUrl = new Map(assetRows
    .map((result, index) => [urls[index], result.results?.[0]?.image_id])
    .filter((entry) => entry[1]));
  const imageIdByUrl = new Map([...knownImageIdByUrl]
    .filter((entry) => entry[1] && currentImageIds.has(String(entry[1]))));
  const uploadsNeeded = urls.filter((url) => !imageIdByUrl.has(url)).length;
  const capacityNeeded = Math.max(0, currentImageIds.size + uploadsNeeded - 20);
  if (capacityNeeded) {
    const desiredExistingIds = new Set([...imageIdByUrl.values()].map(String));
    const removable = currentImages.filter((image) => !desiredExistingIds.has(String(image.listing_image_id)));
    if (removable.length < capacityNeeded) throw new Error(`${targetTitle(product, mapping)} cannot free enough Etsy image slots.`);
    for (const image of removable.slice(0, capacityNeeded)) {
      await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}/images/${image.listing_image_id}`, { method: 'DELETE' });
      currentImageIds.delete(String(image.listing_image_id));
    }
  }
  const imageIds = [];
  for (let index = 0; index < urls.length; index += 1) {
    const currentImageId = imageIdByUrl.get(urls[index]);
    const imageId = await ensureImageAsset(
      env, urls[index], listingId, index + 1,
      `${targetTitle(product, mapping)}${isDiagram(urls[index]) ? ' size guide' : index ? ' product detail' : ''}`,
      currentImageId || knownImageIdByUrl.get(urls[index]), Boolean(currentImageId),
    );
    imageIdByUrl.set(urls[index], imageId);
    imageIds.push(imageId);
  }
  await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: listingForm(product, mapping, imageIds, shopSectionId) });
  await syncListingProperties(env, listingId, mapping);
  // Etsy does not reliably remove old listing images when image_ids is
  // patched. Remove stale assets explicitly after the replacement images are
  // safely present, otherwise an old generic image can remain the thumbnail.
  const desiredImageIds = new Set(imageIds.map(String));
  for (const image of currentImages) {
    if (desiredImageIds.has(String(image.listing_image_id))) continue;
    await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}/images/${image.listing_image_id}`, { method: 'DELETE' });
  }
  const inventory = inventoryFor(product, mapping);
  if (!inventory.anyAvailable && current.state === 'active') {
    await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: new URLSearchParams({ state: 'inactive' }) });
  }
  await etsy(env, `/listings/${listingId}/inventory`, { method: 'PUT', json: inventory.payload });
  await mapVariationImages(env, product, mapping, listingId, urls, imageIdByUrl);
  if (inventory.anyAvailable && current.state !== 'active') {
    await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: new URLSearchParams({ state: 'active' }) });
  }
}

async function reconcileMappings(env, product, mappings) {
  const expected = [{
    target_key: `${product.id}|master`, shopify_product_id: product.id, role: 'master', colour: null,
  }];
  if (!isMasterOnlyProduct(product)) {
    const colours = [...new Map(product.variants.nodes.map((variant) => optionValue(variant, 'Colour')).filter(Boolean).map((colour) => [canonical(colour), colour])).values()];
    for (const colour of colours) {
      expected.push({
        target_key: `${product.id}|colour:${canonical(colour)}`,
        shopify_product_id: product.id,
        role: 'colour',
        colour,
      });
    }
  }
  const existing = new Map(mappings.map((mapping) => [mapping.target_key, mapping]));
  for (const mapping of expected) {
    if (existing.has(mapping.target_key)) continue;
    const shopSectionId = await sectionIdForMapping(env, product, mapping);
    const created = await etsy(env, `/shops/${ETSY_SHOP_ID}/listings?legacy=false`, {
      method: 'POST', form: listingForm(product, mapping, [], shopSectionId),
    });
    mapping.etsy_listing_id = String(created.listing_id);
    await env.DB.prepare(`INSERT INTO etsy_listing_map
      (target_key, shopify_product_id, etsy_listing_id, role, colour, punch_option_values, listing_title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(mapping.target_key, product.id, mapping.etsy_listing_id, mapping.role, mapping.colour,
        mapping.punch_option_values || null, mapping.listing_title || null, new Date().toISOString()).run();
    mappings.push(mapping);
    existing.set(mapping.target_key, mapping);
  }
  const expectedKeys = new Set(expected.map((mapping) => mapping.target_key));
  const obsolete = mappings.filter((item) => !expectedKeys.has(item.target_key));
  for (let offset = 0; offset < obsolete.length; offset += 40) {
    const chunk = obsolete.slice(offset, offset + 40);
    await env.DB.batch(chunk.flatMap((mapping) => [
      env.DB.prepare('DELETE FROM etsy_listing_map WHERE target_key = ?').bind(mapping.target_key),
      env.DB.prepare('DELETE FROM etsy_section_assignments WHERE listing_id = ?').bind(String(mapping.etsy_listing_id)),
    ]));
  }
  for (let offset = 0; offset < obsolete.length; offset += 10) {
    await env.ETSY_SYNC_QUEUE.send({
      kind: 'retire-listings',
      listingIds: obsolete.slice(offset, offset + 10).map((mapping) => String(mapping.etsy_listing_id)),
    });
  }
  return mappings.filter((mapping) => expectedKeys.has(mapping.target_key));
}

async function retireEtsyListings(env, listingIds) {
  await runLimited(listingIds, 2, async (listingId) => {
    const current = await etsy(env, `/listings/${Number(listingId)}`);
    if (current.state === 'active') {
      await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${Number(listingId)}?legacy=false`, {
        method: 'PATCH', form: new URLSearchParams({ state: 'inactive' }),
      });
    }
  });
}

export async function processEtsyProductSync(env, adminGraphql, productId, eventId, offset = 0) {
  await createEtsySyncSchema(env.DB);
  await env.DB.prepare("UPDATE etsy_sync_events SET status = 'processing', attempts = attempts + 1 WHERE event_id = ?").bind(eventId).run();
  try {
    const product = await fetchShopifyProduct(adminGraphql, productId);
    if (!product) throw new Error(`Shopify product ${productId} was not found.`);
    const result = await env.DB.prepare("SELECT * FROM etsy_listing_map WHERE shopify_product_id = ? ORDER BY CASE role WHEN 'master' THEN 0 ELSE 1 END, colour").bind(productId).all();
    let mappings = result.results || [];
    if (!mappings.length) {
      await env.DB.prepare("UPDATE etsy_sync_events SET status = 'skipped', details = ?, completed_at = ? WHERE event_id = ?")
        .bind('Product is not part of the managed Etsy catalogue.', new Date().toISOString(), eventId).run();
      return;
    }
    if (offset === 0) mappings = await reconcileMappings(env, product, mappings);
    const diagramUrl = await counterpartDiagram(adminGraphql, product);
    const chunkSize = offset === 0 ? 1 : 3;
    const chunk = mappings.slice(offset, offset + chunkSize);
    await runLimited(chunk, 1, async (mapping) => {
      const shopSectionId = await sectionIdForMapping(env, product, mapping);
      return syncOneListing(env, product, mapping, diagramUrl, shopSectionId);
    });
    const nextOffset = offset + chunk.length;
    if (nextOffset < mappings.length) {
      await env.ETSY_SYNC_QUEUE.send({ kind: 'product', productId, eventId, offset: nextOffset });
      await env.DB.prepare("UPDATE etsy_sync_events SET status = 'queued', details = ? WHERE event_id = ?")
        .bind(JSON.stringify({ listings_updated: nextOffset, listings_total: mappings.length }), eventId).run();
      return;
    }
    await env.DB.prepare("UPDATE etsy_sync_events SET status = 'complete', details = ?, completed_at = ? WHERE event_id = ?")
      .bind(JSON.stringify({ listings_updated: mappings.length, title: product.title }), new Date().toISOString(), eventId).run();
    console.log(`Etsy sync complete ${eventId}: ${product.title}, ${mappings.length} listings`);
  } catch (error) {
    await env.DB.prepare("UPDATE etsy_sync_events SET status = 'failed', details = ?, completed_at = ? WHERE event_id = ?")
      .bind(error instanceof Error ? error.message : String(error), new Date().toISOString(), eventId).run();
    console.error(`Etsy sync failed ${eventId}:`, error);
    throw error;
  }
}

async function syncOneInventory(env, product, mapping) {
  const listingId = Number(mapping.etsy_listing_id);
  const [current, inventory] = await Promise.all([
    etsy(env, `/listings/${listingId}`),
    Promise.resolve(inventoryFor(product, mapping)),
  ]);
  if (!inventory.anyAvailable && current.state === 'active') {
    await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: new URLSearchParams({ state: 'inactive' }) });
  }
  await etsy(env, `/listings/${listingId}/inventory`, { method: 'PUT', json: inventory.payload });
  if (inventory.anyAvailable && current.state !== 'active') {
    await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${listingId}?legacy=false`, { method: 'PATCH', form: new URLSearchParams({ state: 'active' }) });
  }
}

async function processEtsyInventorySync(env, adminGraphql, productId, eventId, offset = 0) {
  await env.DB.prepare("UPDATE etsy_sync_events SET status = 'processing', attempts = attempts + 1 WHERE event_id = ?").bind(eventId).run();
  try {
    // Inventory imports can emit many webhooks together. Briefly debounce them
    // so one Etsy write observes the completed Shopify batch.
    if (offset === 0) await new Promise((resolve) => setTimeout(resolve, 3000));
    const product = await fetchShopifyProduct(adminGraphql, productId);
    if (!product) throw new Error(`Shopify product ${productId} was not found.`);
    const result = await env.DB.prepare("SELECT * FROM etsy_listing_map WHERE shopify_product_id = ? ORDER BY CASE role WHEN 'master' THEN 0 ELSE 1 END, colour").bind(productId).all();
    const mappings = result.results || [];
    if (!mappings.length) {
      await env.DB.prepare("UPDATE etsy_sync_events SET status = 'skipped', details = ?, completed_at = ? WHERE event_id = ?")
        .bind('Product is not part of the managed Etsy catalogue.', new Date().toISOString(), eventId).run();
      return;
    }
    const chunk = mappings.slice(offset, offset + 12);
    await runLimited(chunk, 4, (mapping) => syncOneInventory(env, product, mapping));
    const nextOffset = offset + chunk.length;
    if (nextOffset < mappings.length) {
      await env.ETSY_SYNC_QUEUE.send({ kind: 'inventory', productId, eventId, offset: nextOffset });
      await env.DB.prepare("UPDATE etsy_sync_events SET status = 'queued', details = ? WHERE event_id = ?")
        .bind(JSON.stringify({ listings_updated: nextOffset, listings_total: mappings.length, inventory_only: true }), eventId).run();
      return;
    }
    await env.DB.prepare("UPDATE etsy_sync_events SET status = 'complete', details = ?, completed_at = ? WHERE event_id = ?")
      .bind(JSON.stringify({ listings_updated: mappings.length, inventory_only: true }), new Date().toISOString(), eventId).run();
  } catch (error) {
    await env.DB.prepare("UPDATE etsy_sync_events SET status = 'failed', details = ?, completed_at = ? WHERE event_id = ?")
      .bind(error instanceof Error ? error.message : String(error), new Date().toISOString(), eventId).run();
    throw error;
  }
}

export async function queueEtsyProductSync(request, env, ctx, verifyWebhook, adminGraphql) {
  const rawBody = await request.text();
  if (!await verifyWebhook(request, rawBody, env.SHOPIFY_CLIENT_SECRET)) return new Response('Invalid webhook signature', { status: 401 });
  await createEtsySyncSchema(env.DB);
  if (await setting(env.DB, 'etsy_sync_enabled') !== 'true') return Response.json({ accepted: false, paused: true });
  const payload = JSON.parse(rawBody);
  const numericId = String(payload.id || '');
  if (!/^\d+$/.test(numericId)) return new Response('Product ID missing', { status: 400 });
  const productId = `gid://shopify/Product/${numericId}`;
  const webhookId = request.headers.get('x-shopify-webhook-id') || crypto.randomUUID();
  const eventId = `products-update:${webhookId}`;
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO etsy_sync_events
    (event_id, shopify_product_id, status, created_at) VALUES (?, ?, 'queued', ?)`)
    .bind(eventId, productId, new Date().toISOString()).run();
  if (inserted.meta.changes === 0) return Response.json({ duplicate: true, event_id: eventId });
  await env.ETSY_SYNC_QUEUE.send({ kind: 'product', productId, eventId });
  return Response.json({ accepted: true, event_id: eventId }, { status: 202 });
}

export async function queueEtsyInventorySync(request, env, ctx, verifyWebhook, adminGraphql) {
  const rawBody = await request.text();
  if (!await verifyWebhook(request, rawBody, env.SHOPIFY_CLIENT_SECRET)) return new Response('Invalid webhook signature', { status: 401 });
  await createEtsySyncSchema(env.DB);
  if (await setting(env.DB, 'etsy_sync_enabled') !== 'true') return Response.json({ accepted: false, paused: true });
  const payload = JSON.parse(rawBody);
  const inventoryItemId = String(payload.inventory_item_id || '');
  if (!/^\d+$/.test(inventoryItemId)) return new Response('Inventory item ID missing', { status: 400 });
  const data = await adminGraphql(`query EtsyInventoryProduct($id: ID!) {
    inventoryItem(id: $id) { variant { product { id } } }
  }`, { id: `gid://shopify/InventoryItem/${inventoryItemId}` });
  const productId = data.inventoryItem?.variant?.product?.id;
  if (!productId) return Response.json({ skipped: true, reason: 'No product for inventory item.' });
  const bucket = Math.floor(Date.now() / 15_000);
  const eventId = `inventory-update:${productId}:${bucket}`;
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO etsy_sync_events
    (event_id, shopify_product_id, status, created_at) VALUES (?, ?, 'queued', ?)`)
    .bind(eventId, productId, new Date().toISOString()).run();
  if (inserted.meta.changes === 0) return Response.json({ duplicate: true, event_id: eventId });
  await env.ETSY_SYNC_QUEUE.send({ kind: 'inventory', productId, eventId });
  return Response.json({ accepted: true, event_id: eventId }, { status: 202 });
}

export async function retryEtsySync(request, env, ctx, adminGraphql) {
  const suppliedKey = request.headers.get('x-setup-key');
  if (!suppliedKey || suppliedKey !== env.SETUP_KEY && suppliedKey !== env.MIGRATION_SETUP_KEY) return new Response('Not found', { status: 404 });
  await createEtsySyncSchema(env.DB);
  const body = await request.json();
  const productId = String(body.shopify_product_id || '');
  if (!productId.startsWith('gid://shopify/Product/')) return Response.json({ error: 'Valid shopify_product_id required.' }, { status: 400 });
  const eventId = `manual:${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO etsy_sync_events (event_id, shopify_product_id, status, created_at) VALUES (?, ?, 'queued', ?)`)
    .bind(eventId, productId, new Date().toISOString()).run();
  await env.ETSY_SYNC_QUEUE.send({ kind: 'product', productId, eventId });
  return Response.json({ accepted: true, event_id: eventId }, { status: 202 });
}

export async function queueEtsyAvailabilityReconciliation(request, env) {
  const suppliedKey = request.headers.get('x-setup-key');
  if (!suppliedKey || suppliedKey !== env.SETUP_KEY && suppliedKey !== env.MIGRATION_SETUP_KEY) return new Response('Not found', { status: 404 });
  await createEtsySyncSchema(env.DB);
  const body = (request.headers.get('content-type') || '').includes('application/json') ? await request.json() : {};
  const requested = Array.isArray(body.shopify_product_ids)
    ? new Set(body.shopify_product_ids.map(String).filter((id) => id.startsWith('gid://shopify/Product/')))
    : null;
  const result = await env.DB.prepare('SELECT DISTINCT shopify_product_id FROM etsy_listing_map ORDER BY shopify_product_id').all();
  const products = (result.results || []).filter((row) => !requested || requested.has(String(row.shopify_product_id)));
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  for (const row of products) {
    const eventId = `availability:${jobId}:${String(row.shopify_product_id).split('/').pop()}`;
    await env.DB.prepare(`INSERT INTO etsy_sync_events (event_id, shopify_product_id, status, created_at)
      VALUES (?, ?, 'queued', ?)`).bind(eventId, row.shopify_product_id, now).run();
    await env.ETSY_SYNC_QUEUE.send({ kind: 'availability', productId: row.shopify_product_id, eventId, offset: 0 });
  }
  return Response.json({ accepted: true, job_id: jobId, products: products.length }, { status: 202 });
}

async function processEtsyAvailabilityReconciliation(env, adminGraphql, productId, eventId, offset = 0) {
  await env.DB.prepare("UPDATE etsy_sync_events SET status = 'processing', attempts = attempts + 1 WHERE event_id = ?").bind(eventId).run();
  try {
    const product = await fetchShopifyProduct(adminGraphql, productId);
    if (!product) throw new Error(`Shopify product ${productId} was not found.`);
    const result = await env.DB.prepare("SELECT * FROM etsy_listing_map WHERE shopify_product_id = ? ORDER BY CASE role WHEN 'master' THEN 0 ELSE 1 END, colour").bind(productId).all();
    const mappings = result.results || [];
    const chunk = mappings.slice(offset, offset + 20);
    if (!chunk.length) {
      await env.DB.prepare("UPDATE etsy_sync_events SET status = 'complete', details = ?, completed_at = ? WHERE event_id = ?")
        .bind(JSON.stringify({ listings_checked: offset, availability_only: true }), new Date().toISOString(), eventId).run();
      return;
    }
    const ids = chunk.map((mapping) => Number(mapping.etsy_listing_id));
    const current = await etsy(env, `/listings/batch?listing_ids=${ids.join(',')}`);
    const stateById = new Map((current.results || []).map((listing) => [String(listing.listing_id), listing.state]));
    let changed = 0;
    await runLimited(chunk, 1, async (mapping) => {
      const hasStock = product.status === 'ACTIVE' && relevantVariants(product, mapping).some((variant) => Number(variant.inventoryQuantity) > 0);
      const state = stateById.get(String(mapping.etsy_listing_id));
      if (hasStock && state !== 'active') {
        await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${Number(mapping.etsy_listing_id)}?legacy=false`, {
          method: 'PATCH', form: new URLSearchParams({ state: 'active' }),
        });
        changed += 1;
      } else if (!hasStock && state === 'active') {
        await etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${Number(mapping.etsy_listing_id)}?legacy=false`, {
          method: 'PATCH', form: new URLSearchParams({ state: 'inactive' }),
        });
        changed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 175));
    });
    const nextOffset = offset + chunk.length;
    if (nextOffset < mappings.length) {
      await env.ETSY_SYNC_QUEUE.send({ kind: 'availability', productId, eventId, offset: nextOffset });
      await env.DB.prepare("UPDATE etsy_sync_events SET status = 'queued', details = ? WHERE event_id = ?")
        .bind(JSON.stringify({ listings_checked: nextOffset, listings_total: mappings.length, changed, availability_only: true }), eventId).run();
      return;
    }
    await env.DB.prepare("UPDATE etsy_sync_events SET status = 'complete', details = ?, completed_at = ? WHERE event_id = ?")
      .bind(JSON.stringify({ listings_checked: mappings.length, changed, availability_only: true }), new Date().toISOString(), eventId).run();
  } catch (error) {
    await env.DB.prepare("UPDATE etsy_sync_events SET status = 'failed', details = ?, completed_at = ? WHERE event_id = ?")
      .bind(error instanceof Error ? error.message : String(error), new Date().toISOString(), eventId).run();
    throw error;
  }
}

export async function manageEtsySections(request, env) {
  const suppliedKey = request.headers.get('x-setup-key');
  if (!suppliedKey || suppliedKey !== env.SETUP_KEY && suppliedKey !== env.MIGRATION_SETUP_KEY) return new Response('Not found', { status: 404 });
  await createEtsySyncSchema(env.DB);
  const body = await request.json();

  if (body.reorder_tail === true) {
    return Response.json({ error: 'Tail-only reordering was retired; use the complete section assignment flow.' }, { status: 410 });
  }

  if (body.temporary === true) {
    const current = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`);
    let section = (current.results || []).find((item) => canonical(item.title) === canonical('TSSC Reorganising'));
    if (!section) {
      section = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`, {
        method: 'POST', form: new URLSearchParams({ title: 'TSSC Reorganising' }),
      });
    }
    await setSetting(env.DB, 'etsy_section_temporary', String(section.shop_section_id));
    return Response.json({ shop_section_id: Number(section.shop_section_id), title: section.title });
  }

  if (body.rebuild === true) {
    const current = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`);
    const temporaryId = await setting(env.DB, 'etsy_section_temporary');
    if (!temporaryId) return Response.json({ error: 'Temporary section has not been created.' }, { status: 409 });
    for (const section of (current.results || []).filter((item) => String(item.shop_section_id) !== String(temporaryId))) {
      await etsy(env, `/shops/${ETSY_SHOP_ID}/sections/${section.shop_section_id}`, { method: 'DELETE' });
    }
    const rebuilt = [];
    for (const definition of ETSY_SECTION_DEFINITIONS) {
      const section = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`, {
        method: 'POST', form: new URLSearchParams({ title: definition.title }),
      });
      await setSetting(env.DB, `etsy_section_${definition.key}`, String(section.shop_section_id));
      rebuilt.push({ key: definition.key, title: definition.title, shop_section_id: Number(section.shop_section_id) });
    }
    return Response.json({ rebuilt: rebuilt.length, sections: rebuilt });
  }

  if (body.ensure === true) {
    const current = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`);
    const sections = current.results || [];
    const used = new Set();
    const resolved = [];
    for (const definition of ETSY_SECTION_DEFINITIONS) {
      let section = sections.find((item) => !used.has(String(item.shop_section_id)) && canonical(item.title) === canonical(definition.title));
      if (!section) {
        section = sections.find((item) => !used.has(String(item.shop_section_id))
          && (definition.reuse || []).some((title) => canonical(item.title) === canonical(title)));
      }
      if (section && canonical(section.title) !== canonical(definition.title)) {
        section = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections/${section.shop_section_id}`, {
          method: 'PUT', form: new URLSearchParams({ title: definition.title }),
        });
      }
      if (!section) {
        section = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`, {
          method: 'POST', form: new URLSearchParams({ title: definition.title }),
        });
        sections.push(section);
      }
      used.add(String(section.shop_section_id));
      await setSetting(env.DB, `etsy_section_${definition.key}`, String(section.shop_section_id));
      resolved.push({ key: definition.key, title: definition.title, shop_section_id: Number(section.shop_section_id) });
    }
    return Response.json({ ensured: resolved.length, sections: resolved });
  }

  if (body.cleanup === true) {
    const keep = new Set();
    for (const definition of ETSY_SECTION_DEFINITIONS) {
      const id = await setting(env.DB, `etsy_section_${definition.key}`);
      if (id) keep.add(String(id));
    }
    const current = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`);
    const obsolete = (current.results || []).filter((section) => !keep.has(String(section.shop_section_id)));
    const removed = [];
    for (const section of obsolete) {
      if (Number(section.active_listing_count) > 0) continue;
      await etsy(env, `/shops/${ETSY_SHOP_ID}/sections/${section.shop_section_id}`, { method: 'DELETE' });
      removed.push({ shop_section_id: Number(section.shop_section_id), title: section.title });
    }
    return Response.json({ removed, retained_nonempty: obsolete.filter((section) => Number(section.active_listing_count) > 0) });
  }

  const assignments = Array.isArray(body.assignments) ? body.assignments : [];
  if (!assignments.length || assignments.length > 20) {
    return Response.json({ error: 'Supply between 1 and 20 listing assignments.' }, { status: 400 });
  }
  const validKeys = new Set([...ETSY_SECTION_DEFINITIONS.map((item) => item.key), '__temporary__']);
  const sectionIds = new Map();
  for (const assignment of assignments) {
    const key = assignment.category_key || etsySectionKeyFor(assignment.title, assignment.role);
    if (!validKeys.has(key)) return Response.json({ error: `Unknown section for listing ${assignment.listing_id}.` }, { status: 400 });
    if (!sectionIds.has(key)) sectionIds.set(key, await setting(env.DB, key === '__temporary__' ? 'etsy_section_temporary' : `etsy_section_${key}`));
    if (!sectionIds.get(key)) return Response.json({ error: `Section ${key} has not been created.` }, { status: 409 });
    assignment.resolved_key = key;
  }
  await runLimited(assignments, 2, (assignment) => etsy(
    env,
    `/shops/${ETSY_SHOP_ID}/listings/${Number(assignment.listing_id)}?legacy=false`,
    { method: 'PATCH', form: new URLSearchParams({ shop_section_id: String(sectionIds.get(assignment.resolved_key)) }) },
  ));
  return Response.json({ assigned: assignments.length });
}

async function sectionRows(db, offset, categoryKey = null) {
  const statement = categoryKey
    ? db.prepare('SELECT listing_id, category_key FROM etsy_section_assignments WHERE category_key = ? ORDER BY listing_id LIMIT 20 OFFSET ?').bind(categoryKey, offset)
    : db.prepare('SELECT listing_id, category_key FROM etsy_section_assignments ORDER BY listing_id LIMIT 20 OFFSET ?').bind(offset);
  const result = await statement.all();
  return result.results || [];
}

async function assignSectionRows(env, rows, temporary = false) {
  const ids = new Map();
  for (const row of rows) {
    const key = temporary ? '__temporary__' : row.category_key;
    if (!ids.has(key)) {
      const id = await setting(env.DB, key === '__temporary__' ? 'etsy_section_temporary' : `etsy_section_${key}`);
      ids.set(key, id);
    }
    if (!ids.get(key)) throw new Error(`Missing Etsy section for ${key}.`);
    row.resolved_key = key;
  }
  await runLimited(rows, 2, (row) => etsy(env, `/shops/${ETSY_SHOP_ID}/listings/${Number(row.listing_id)}?legacy=false`, {
    method: 'PATCH', form: new URLSearchParams({ shop_section_id: String(ids.get(row.resolved_key)) }),
  }));
}

async function continueSectionJob(env, message, delaySeconds = 2) {
  await env.ETSY_SYNC_QUEUE.send(message, { delaySeconds });
}

export async function processEtsySectionRebuild(env, message) {
  const phase = message.phase || 'start';
  const offset = Number(message.offset || 0);
  const jobId = await setting(env.DB, 'etsy_section_job_id');
  if (jobId && message.jobId !== jobId) return;
  try {
    if (phase === 'start') {
      const current = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`);
      let temporary = (current.results || []).find((item) => canonical(item.title) === canonical('TSSC Reorganising'));
      if (!temporary) {
        temporary = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`, {
          method: 'POST', form: new URLSearchParams({ title: 'TSSC Reorganising' }),
        });
      }
      await setSetting(env.DB, 'etsy_section_temporary', String(temporary.shop_section_id));
      await setSetting(env.DB, 'etsy_section_job_status', JSON.stringify({ phase: 'to_temporary', offset: 0 }));
      return continueSectionJob(env, { kind: 'sections', jobId, phase: 'to_temporary', offset: 0 });
    }

    if (phase === 'to_temporary') {
      const rows = await sectionRows(env.DB, offset);
      if (!rows.length) return continueSectionJob(env, { kind: 'sections', jobId, phase: 'rebuild' });
      await assignSectionRows(env, rows, true);
      const next = offset + rows.length;
      await setSetting(env.DB, 'etsy_section_job_status', JSON.stringify({ phase, offset: next }));
      return continueSectionJob(env, { kind: 'sections', jobId, phase, offset: next });
    }

    if (phase === 'rebuild') {
      const current = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`);
      const temporaryId = await setting(env.DB, 'etsy_section_temporary');
      for (const section of (current.results || []).filter((item) => String(item.shop_section_id) !== String(temporaryId))) {
        await etsy(env, `/shops/${ETSY_SHOP_ID}/sections/${section.shop_section_id}`, { method: 'DELETE' });
      }
      await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'etsy_section_%' AND key NOT IN ('etsy_section_temporary', 'etsy_section_job_id', 'etsy_section_job_status')").run();
      for (const definition of ETSY_SECTION_DEFINITIONS) {
        const section = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`, {
          method: 'POST', form: new URLSearchParams({ title: definition.title }),
        });
        await setSetting(env.DB, `etsy_section_${definition.key}`, String(section.shop_section_id));
      }
      await setSetting(env.DB, 'etsy_section_job_status', JSON.stringify({ phase: 'assign', offset: 0 }));
      return continueSectionJob(env, { kind: 'sections', jobId, phase: 'assign', offset: 0 });
    }

    if (phase === 'assign') {
      const rows = await sectionRows(env.DB, offset);
      if (!rows.length) return continueSectionJob(env, { kind: 'sections', jobId, phase: 'cleanup' });
      await assignSectionRows(env, rows, false);
      const next = offset + rows.length;
      await setSetting(env.DB, 'etsy_section_job_status', JSON.stringify({ phase, offset: next }));
      return continueSectionJob(env, { kind: 'sections', jobId, phase, offset: next });
    }

    if (phase === 'cleanup') {
      const keep = new Set();
      for (const definition of ETSY_SECTION_DEFINITIONS) keep.add(String(await setting(env.DB, `etsy_section_${definition.key}`)));
      const current = await etsy(env, `/shops/${ETSY_SHOP_ID}/sections`);
      for (const section of (current.results || []).filter((item) => !keep.has(String(item.shop_section_id)))) {
        await etsy(env, `/shops/${ETSY_SHOP_ID}/sections/${section.shop_section_id}`, { method: 'DELETE' });
      }
      await setSetting(env.DB, 'etsy_section_job_status', JSON.stringify({ phase: 'complete', completed_at: new Date().toISOString() }));
      return;
    }
    throw new Error(`Unknown Etsy section job phase: ${phase}`);
  } catch (error) {
    if (error?.status === 429) {
      const delaySeconds = Math.min(86_400, Math.max(10, Number(error.retryAfter || 10) + 2));
      await setSetting(env.DB, 'etsy_section_job_status', JSON.stringify({ phase, offset, rate_limited: true, retry_in_seconds: delaySeconds }));
      return continueSectionJob(env, { kind: 'sections', jobId, phase, offset }, delaySeconds);
    }
    throw error;
  }
}

export async function scheduleEtsySectionRebuild(request, env) {
  const suppliedKey = request.headers.get('x-setup-key');
  if (!suppliedKey || suppliedKey !== env.SETUP_KEY && suppliedKey !== env.MIGRATION_SETUP_KEY) return new Response('Not found', { status: 404 });
  await createEtsySyncSchema(env.DB);
  const body = await request.json();
  const assignments = Array.isArray(body.assignments) ? body.assignments : [];
  const validKeys = new Set(ETSY_SECTION_DEFINITIONS.map((item) => item.key));
  if (!assignments.length || assignments.some((item) => !/^\d+$/.test(String(item.listing_id)) || !validKeys.has(item.category_key))) {
    return Response.json({ error: 'Valid listing assignments are required.' }, { status: 400 });
  }
  await env.DB.prepare('DELETE FROM etsy_section_assignments').run();
  for (let offset = 0; offset < assignments.length; offset += 50) {
    await env.DB.batch(assignments.slice(offset, offset + 50).map((item) => env.DB.prepare(`INSERT INTO etsy_section_assignments
      (listing_id, category_key, updated_at) VALUES (?, ?, ?)`)
      .bind(String(item.listing_id), item.category_key, new Date().toISOString())));
  }
  const delaySeconds = Math.min(86_400, Math.max(30, Number(body.delay_seconds || 3600)));
  const jobId = crypto.randomUUID();
  await setSetting(env.DB, 'etsy_section_job_id', jobId);
  await setSetting(env.DB, 'etsy_section_job_status', JSON.stringify({ phase: 'scheduled', job_id: jobId, listings: assignments.length, delay_seconds: delaySeconds }));
  await env.ETSY_SYNC_QUEUE.send({ kind: 'sections', jobId, phase: 'start' }, { delaySeconds });
  return Response.json({ scheduled: true, job_id: jobId, listings: assignments.length, delay_seconds: delaySeconds });
}

export async function rotateEtsyToken(request, env) {
  const suppliedKey = request.headers.get('x-setup-key');
  if (!suppliedKey || suppliedKey !== env.SETUP_KEY && suppliedKey !== env.MIGRATION_SETUP_KEY) return new Response('Not found', { status: 404 });
  if ((request.headers.get('content-type') || '').includes('application/json')) {
    const body = await request.json();
    if (body.refresh_token) await setSetting(env.DB, 'etsy_refresh_token', String(body.refresh_token));
  }
  cachedAccessToken = null;
  cachedAccessTokenExpiresAt = 0;
  await etsyAccessToken(env);
  return Response.json({ rotated: true });
}

export async function processEtsyQueueMessage(env, adminGraphql, message) {
  if (message.kind === 'sections') return processEtsySectionRebuild(env, message);
  if (message.kind === 'retire-listings') return retireEtsyListings(env, Array.isArray(message.listingIds) ? message.listingIds : []);
  if (message.kind === 'availability') return processEtsyAvailabilityReconciliation(env, adminGraphql, message.productId, message.eventId, Number(message.offset || 0));
  if (message.kind === 'inventory') return processEtsyInventorySync(env, adminGraphql, message.productId, message.eventId, Number(message.offset || 0));
  if (message.kind === 'product') return processEtsyProductSync(env, adminGraphql, message.productId, message.eventId, Number(message.offset || 0));
  throw new Error(`Unknown Etsy sync queue message kind: ${message.kind}`);
}
