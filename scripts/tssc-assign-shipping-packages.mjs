#!/usr/bin/env node

/**
 * Assign existing Shopify saved packages to every TSSC product variant.
 *
 * Shopify's Admin API can assign a package ID but cannot create/list saved
 * packages or read the current assignment. Create the three packages in the
 * admin first, then provide their GIDs to this script.
 *
 * Audit:
 *   node scripts/tssc-assign-shipping-packages.mjs
 *
 * Apply:
 *   node scripts/tssc-assign-shipping-packages.mjs --apply \
 *     --sequins-package-id=gid://shopify/ShippingPackageV2/... \
 *     --spools-package-id=gid://shopify/ShippingPackageV2/... \
 *     --punchinella-package-id=gid://shopify/ShippingPackageV2/... \
 *     --confirm=ASSIGN_TSSC_SHIPPING_PACKAGES
 */

import { spawnSync } from 'node:child_process';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = argument('confirm');
const CONFIRMATION_TEXT = 'ASSIGN_TSSC_SHIPPING_PACKAGES';

const PACKAGES = {
  sequins: {
    name: 'TSSC — Sequins box',
    dimensionsCm: [17, 13, 2.5],
    weightG: 25,
    id: argument('sequins-package-id'),
    expectedVariants: 7000,
  },
  spools: {
    name: 'TSSC — Spools box',
    dimensionsCm: [20, 20, 2.5],
    weightG: 60,
    id: argument('spools-package-id'),
    expectedVariants: 640,
  },
  punchinella: {
    name: 'TSSC — Punchinella box',
    dimensionsCm: [15, 8, 8],
    weightG: 50,
    id: argument('punchinella-package-id'),
    expectedVariants: 1664,
  },
};

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function executeGraphql(query, variables = {}, allowMutations = false) {
  const args = ['store', 'execute', '--store', STORE, '--query', query, '--variables', JSON.stringify(variables), '--json'];
  if (allowMutations) args.push('--allow-mutations');
  const result = spawnSync('shopify', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON returned: ${result.stdout}`);
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

const productsQuery = `
  query Products($after: String) {
    products(first: 100, after: $after, sortKey: TITLE) {
      nodes { id title variantsCount { count } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const variantsQuery = `
  query Variants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const updateMutation = `
  mutation AssignPackages($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

function family(title) {
  if (/\bpunchinella\b/i.test(title)) return 'punchinella';
  if (/\bon the spool\b/i.test(title)) return 'spools';
  return 'sequins';
}

const summaries = [];
let productCursor = null;
do {
  const page = executeGraphql(productsQuery, { after: productCursor }).products;
  summaries.push(...page.nodes);
  productCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (productCursor);

const counts = { sequins: 0, spools: 0, punchinella: 0 };
for (const product of summaries) counts[family(product.title)] += product.variantsCount.count;

console.log('TSSC saved-package assignment audit');
console.log('===================================');
for (const [key, definition] of Object.entries(PACKAGES)) {
  const [length, width, height] = definition.dimensionsCm;
  console.log(`${definition.name}: ${length} × ${width} × ${height} cm, ${definition.weightG} g -> ${counts[key]} variants`);
  if (counts[key] !== definition.expectedVariants) {
    throw new Error(`${definition.name}: expected ${definition.expectedVariants} variants, found ${counts[key]}; refusing an unsafe bulk assignment.`);
  }
}

if (!APPLY) {
  console.log('\nAudit only: package assignments were not changed.');
  console.log('Create the three saved packages in Shopify admin, then run with their package IDs and the confirmation flag documented at the top of this file.');
  process.exit(0);
}

if (CONFIRMATION !== CONFIRMATION_TEXT) throw new Error(`Apply blocked. Re-run with --confirm=${CONFIRMATION_TEXT}.`);
for (const definition of Object.values(PACKAGES)) {
  if (!/^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/\d+$/.test(definition.id || '')) {
    throw new Error(`${definition.name}: a valid Shopify package GID is required.`);
  }
}

let updated = 0;
const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
for (const product of summaries) {
  const definition = PACKAGES[family(product.title)];
  let variantCursor = null;
  do {
    const page = executeGraphql(variantsQuery, { id: product.id, after: variantCursor }).product.variants;
    const variants = page.nodes.map(({ id }) => ({
      id,
      inventoryItem: { measurement: { shippingPackageId: definition.id } },
    }));
    const result = executeGraphql(updateMutation, { productId: product.id, variants }, true).productVariantsBulkUpdate;
    if (result.userErrors.length) throw new Error(`${product.title}: ${JSON.stringify(result.userErrors, null, 2)}`);
    if (result.productVariants.length !== variants.length) throw new Error(`${product.title}: incomplete package assignment response.`);
    updated += result.productVariants.length;
    variantCursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (variantCursor);
  console.log(`${product.title}: assigned ${definition.name}`);
}

if (updated !== total) throw new Error(`Expected to assign ${total} variants, assigned ${updated}.`);
console.log(`Assigned saved packages to ${updated} variants.`);
