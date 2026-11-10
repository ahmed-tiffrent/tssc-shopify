#!/usr/bin/env node

/**
 * Assign local colour photos to the matching Shopify circle variants.
 *
 * Dry run:
 *   node scripts/tssc-assign-variant-images.mjs [--set=2]
 *
 * Apply to the live store:
 *   node scripts/tssc-assign-variant-images.mjs [--set=2] --apply --confirm=ASSIGN_TSSC_VARIANT_IMAGES
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const CONFIRMATION_TEXT = 'ASSIGN_TSSC_VARIANT_IMAGES';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const IMAGE_SET_TWO = process.argv.includes('--set=2');
const IMAGE_DIR = resolve(ROOT_DIR, IMAGE_SET_TWO ? 'Variants images 2' : 'Variants images');
const BACKUP_DIR = resolve(ROOT_DIR, 'soply-import', 'backups');
const TARGET_DEFINITIONS = IMAGE_SET_TWO ? [
  { key: '8mm-circle-side', label: '8mm Circle | Side Hole', filename: /^8mm circles top hole\s*-\s*/i, title: /^8mm Circle \| Side Hole \| Flat \| (20|100)% Recycled Plastic$/i },
  { key: '10mm-circle-side', label: '10mm Circle | Side Hole', filename: /^10mm circles\s*-\s*/i, title: /^10mm Circle \| Side Hole \| Flat \| (20|100)% Recycled Plastic$/i },
  { key: '12mm-circle-side', label: '12mm Circle | Side Hole', filename: /^12mm circles\s*-\s*/i, title: /^12mm Circle \| Side Hole \| Flat \| (20|100)% Recycled Plastic$/i },
  { key: '15mm-circle-side', label: '15mm Circle | Side Hole', filename: /^15mm circles\s*-\s*/i, title: /^15mm Circle \| Side Hole \| Flat \| (20|100)% Recycled Plastic$/i },
  { key: '10x30mm-pointed-oval', label: '10*30mm Pointed Oval', filename: /^pointed ovals\s*-\s*/i, title: /^10\*30mm Pointed Oval \| (20|100)% Recycled Plastic$/i },
  { key: '12x35mm-teardrop', label: '12*35mm Teardrop', filename: /^teardrops\s*-\s*/i, title: /^12\*35mm Teardrop \| (20|100)% Recycled Plastic$/i },
] : [
  { key: '15mm-circle-side', label: '15mm Circle | Side Hole', filename: /^15mm circles\s*-\s*/i, title: /^15mm Circle \| Side Hole \| Flat \| (20|100)% Recycled Plastic$/i },
  { key: '20mm-circle-side', label: '20mm Circle | Side Hole', filename: /^20mm circles\s*-\s*/i, title: /^20mm Circle \| Side Hole \| Flat \| (20|100)% Recycled Plastic$/i },
  { key: '30mm-circle-side', label: '30mm Circle | Side Hole', filename: /^30mm circles\s*-\s*/i, title: /^30mm Circle \| Side Hole \| Flat \| (20|100)% Recycled Plastic$/i },
];
const MEDIA_ALT_PREFIX = 'TSSC variant image | ';
const BATCH_SIZE = 10;

if (APPLY && CONFIRMATION !== CONFIRMATION_TEXT) {
  throw new Error(`Refusing to apply without --confirm=${CONFIRMATION_TEXT}`);
}

function executeGraphql(query, variables = {}, allowMutations = false) {
  const args = [
    'store',
    'execute',
    '--store',
    STORE,
    '--query',
    query,
    '--variables',
    JSON.stringify(variables),
    '--json',
  ];
  if (allowMutations) args.push('--allow-mutations');

  const result = spawnSync('shopify', args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  }
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON returned: ${result.stdout}`);
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

function canonical(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/\+/g, ' and ')
    .replace(/&/g, ' and ')
    .toLocaleLowerCase('en-GB')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function optionValue(variant, optionName) {
  const key = canonical(optionName);
  return variant.selectedOptions.find((option) => canonical(option.name) === key)?.value;
}

function marker(definition, colour) {
  return `${MEDIA_ALT_PREFIX}${definition.label} | ${colour}`;
}

function imagePreference(path) {
  const name = canonical(basename(path, extname(path)));
  if (name.includes('larger pile')) return 40;
  if (name.includes(' full ')) return 30;
  if (name.includes(' pile ')) return 20;
  if (name.includes(' real ')) return 10;
  return 0;
}

const productsSummaryQuery = `
  query TargetProducts {
    products(first: 100) {
      nodes { id title handle }
    }
  }
`;

const productQuery = `
  query ProductVariantMedia($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      media(first: 250) {
        nodes {
          id
          alt
          mediaContentType
          status
          preview { status }
          ... on MediaImage { image { url } }
        }
      }
      variants(first: 250) {
        nodes {
          id
          title
          selectedOptions { name value }
          media(first: 10) {
            nodes { id alt mediaContentType status preview { status } }
          }
        }
      }
    }
  }
`;

const stagedUploadsMutation = `
  mutation StageVariantImages($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const createMediaMutation = `
  mutation CreateVariantMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id alt mediaContentType status preview { status } }
      mediaUserErrors { field message }
    }
  }
`;

const mediaStatusQuery = `
  query VariantMediaStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on MediaImage {
        id
        alt
        status
        preview { status }
        image { url }
      }
    }
  }
`;

const updateVariantsMutation = `
  mutation AssignVariantMedia($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        media(first: 1) { nodes { id alt status preview { status } } }
      }
      userErrors { field message }
    }
  }
`;

function loadProducts() {
  const summaries = executeGraphql(productsSummaryQuery).products.nodes
    .map((product) => ({ ...product, definition: TARGET_DEFINITIONS.find((definition) => definition.title.test(product.title)) }))
    .filter((product) => product.definition)
    .sort((a, b) => a.title.localeCompare(b.title, 'en-GB'));

  const expected = TARGET_DEFINITIONS.length * 2;
  if (summaries.length !== expected) {
    throw new Error(`Expected ${expected} target products, found ${summaries.length}: ${summaries.map((p) => p.title).join(', ')}`);
  }

  return summaries.map((summary) => {
    const product = executeGraphql(productQuery, { id: summary.id }).product;
    const match = product.title.match(summary.definition.title);
    return { ...product, definition: summary.definition, material: Number(match[1]) };
  });
}

function loadImageMap(products) {
  const colours = [...new Set(products.flatMap((product) => product.variants.nodes.map((variant) => optionValue(variant, 'Colour'))).filter(Boolean))]
    .sort((a, b) => canonical(b).length - canonical(a).length);
  const imageGroups = new Map();
  const unmatched = [];

  for (const filename of readdirSync(IMAGE_DIR)) {
    const path = resolve(IMAGE_DIR, filename);
    if (!statSync(path).isFile() || !/\.jpe?g$/i.test(filename)) continue;
    const definition = TARGET_DEFINITIONS.find((candidate) => candidate.filename.test(filename));
    const prefix = definition ? filename.match(definition.filename) : null;
    if (!definition || !prefix) {
      unmatched.push(filename);
      continue;
    }

    const remainder = canonical(filename.slice(prefix[0].length).replace(/\.jpe?g$/i, ''));
    const colour = colours.find((candidate) => remainder.startsWith(canonical(candidate)));
    if (!colour) {
      unmatched.push(filename);
      continue;
    }

    const key = `${definition.key}|${canonical(colour)}`;
    if (!imageGroups.has(key)) imageGroups.set(key, []);
    imageGroups.get(key).push({ path, filename, definition, colour });
  }

  const selected = new Map();
  const duplicates = [];
  for (const [key, candidates] of imageGroups) {
    candidates.sort((a, b) => imagePreference(a.path) - imagePreference(b.path) || a.filename.length - b.filename.length || a.filename.localeCompare(b.filename));
    selected.set(key, candidates[0]);
    if (candidates.length > 1) duplicates.push({ key, selected: candidates[0].filename, ignored: candidates.slice(1).map((item) => item.filename) });
  }

  return { selected, duplicates, unmatched };
}

function buildPlan(products, selectedImages) {
  return products.map((product) => {
    const variantsByColour = new Map();
    for (const variant of product.variants.nodes) {
      const colour = optionValue(variant, 'Colour');
      if (!colour) continue;
      const key = canonical(colour);
      if (!variantsByColour.has(key)) variantsByColour.set(key, { colour, variants: [] });
      variantsByColour.get(key).variants.push(variant);
    }

    const assignments = [];
    const missingColours = [];
    for (const group of variantsByColour.values()) {
      const image = selectedImages.get(`${product.definition.key}|${canonical(group.colour)}`);
      if (!image) {
        missingColours.push(group.colour);
        continue;
      }
      assignments.push({ ...group, image, marker: marker(product.definition, group.colour) });
    }
    assignments.sort((a, b) => a.colour.localeCompare(b.colour, 'en-GB'));
    missingColours.sort((a, b) => a.localeCompare(b, 'en-GB'));
    return { product, assignments, missingColours };
  });
}

function uploadStagedFile(target, path) {
  const args = ['-sS', '-X', 'POST', target.url];
  for (const parameter of target.parameters) args.push('-F', `${parameter.name}=${parameter.value}`);
  args.push('-F', `file=@${path};type=image/jpeg`);
  const result = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `Upload failed for ${path}`);
}

function createMissingMedia(product, assignments) {
  const mediaByAlt = new Map(product.media.nodes.filter((media) => media.alt).map((media) => [media.alt, media]));
  const missing = assignments.filter((assignment) => !mediaByAlt.has(assignment.marker));

  for (const batch of chunks(missing, BATCH_SIZE)) {
    const stagedInput = batch.map((assignment) => ({
      filename: assignment.image.filename,
      mimeType: 'image/jpeg',
      httpMethod: 'POST',
      resource: 'PRODUCT_IMAGE',
      fileSize: String(statSync(assignment.image.path).size),
    }));
    const stagedPayload = executeGraphql(stagedUploadsMutation, { input: stagedInput }, true).stagedUploadsCreate;
    if (stagedPayload.userErrors.length) throw new Error(JSON.stringify(stagedPayload.userErrors, null, 2));
    if (stagedPayload.stagedTargets.length !== batch.length) throw new Error('Shopify returned an unexpected staged upload count');

    stagedPayload.stagedTargets.forEach((target, index) => uploadStagedFile(target, batch[index].image.path));
    const createInput = batch.map((assignment, index) => ({
      alt: assignment.marker,
      mediaContentType: 'IMAGE',
      originalSource: stagedPayload.stagedTargets[index].resourceUrl,
    }));
    const createPayload = executeGraphql(createMediaMutation, { productId: product.id, media: createInput }, true).productCreateMedia;
    if (createPayload.mediaUserErrors.length) throw new Error(JSON.stringify(createPayload.mediaUserErrors, null, 2));
    if (createPayload.media.length !== batch.length) throw new Error('Shopify returned an unexpected created media count');
    createPayload.media.forEach((media) => mediaByAlt.set(media.alt, media));
    console.log(`  uploaded ${batch.length} image${batch.length === 1 ? '' : 's'}`);
  }

  return mediaByAlt;
}

function waitForMedia(media) {
  const ids = media.map((item) => item.id);
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const nodes = executeGraphql(mediaStatusQuery, { ids }).nodes.filter(Boolean);
    const failed = nodes.filter((node) => node.status === 'FAILED' || node.preview?.status === 'FAILED');
    if (failed.length) throw new Error(`Media processing failed: ${failed.map((node) => node.alt || node.id).join(', ')}`);
    if (nodes.length === ids.length && nodes.every((node) => node.status === 'READY' || node.preview?.status === 'READY')) return nodes;
    spawnSync('sleep', ['2']);
  }
  throw new Error(`Timed out waiting for ${ids.length} media item(s) to process`);
}

function applyPlan(plan) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(BACKUP_DIR, `variant-images-before-${timestamp}.json`);
  writeFileSync(backupPath, `${JSON.stringify(plan.map(({ product }) => product), null, 2)}\n`);
  console.log(`Backup: ${backupPath}`);

  for (const { product, assignments } of plan) {
    console.log(`\n${product.title}`);
    const mediaByAlt = createMissingMedia(product, assignments);
    const relevantMedia = assignments.map((assignment) => mediaByAlt.get(assignment.marker));
    waitForMedia(relevantMedia);

    const updates = assignments.flatMap((assignment) => {
      const mediaId = mediaByAlt.get(assignment.marker).id;
      return assignment.variants.map((variant) => ({ id: variant.id, mediaId }));
    });
    const result = executeGraphql(updateVariantsMutation, { productId: product.id, variants: updates }, true).productVariantsBulkUpdate;
    if (result.userErrors.length) throw new Error(JSON.stringify(result.userErrors, null, 2));
    console.log(`  assigned ${assignments.length} colour images to ${updates.length} variants`);

    const verified = executeGraphql(productQuery, { id: product.id }).product;
    const expectedByVariant = new Map(updates.map((update) => [update.id, update.mediaId]));
    const mismatches = verified.variants.nodes.filter((variant) => {
      const expected = expectedByVariant.get(variant.id);
      return expected && variant.media.nodes[0]?.id !== expected;
    });
    if (mismatches.length) throw new Error(`Verification failed for ${mismatches.length} variants on ${product.title}`);
    console.log(`  verified ${updates.length} variants`);
  }
}

const products = loadProducts();
const imageMap = loadImageMap(products);
const plan = buildPlan(products, imageMap.selected);

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`Image folder: ${IMAGE_DIR}`);
console.log(`Selected image mappings: ${imageMap.selected.size}`);
console.log(`Duplicate image groups: ${imageMap.duplicates.length}`);
console.log(`Unmatched files: ${imageMap.unmatched.length}`);

for (const duplicate of imageMap.duplicates) {
  console.log(`Duplicate ${duplicate.key}: using "${duplicate.selected}"; ignoring ${duplicate.ignored.map((name) => `"${name}"`).join(', ')}`);
}
for (const filename of imageMap.unmatched) console.log(`Unmatched file: ${filename}`);

let totalVariants = 0;
for (const { product, assignments, missingColours } of plan) {
  const variantCount = assignments.reduce((sum, assignment) => sum + assignment.variants.length, 0);
  totalVariants += variantCount;
  console.log(`\n${product.title}`);
  console.log(`  mapped colours: ${assignments.length}`);
  console.log(`  mapped variants: ${variantCount}`);
  console.log(`  missing colours (${missingColours.length}): ${missingColours.join(', ') || 'none'}`);
}
console.log(`\nTotal variants planned: ${totalVariants}`);

if (!APPLY) {
  console.log(`\nDry run only. Apply with --apply --confirm=${CONFIRMATION_TEXT}`);
} else {
  applyPlan(plan);
  console.log('\nAll supplied variant images were assigned and verified.');
}
