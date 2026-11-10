#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((value) => value.startsWith('--confirm='))?.split('=')[1];
const EXPECTED = 280;

function graphql(query, variables = {}, mutate = false) {
  const args = ['store', 'execute', '--store', STORE, '--query', query, '--variables', JSON.stringify(variables), '--json'];
  if (mutate) args.push('--allow-mutations');
  const result = spawnSync('shopify', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

const lookup = graphql(`query SecondsProduct {
  products(first: 10, query: "title:Seconds") {
    nodes { id title variantsCount { count } }
  }
}`);
const product = lookup.products.nodes.find((item) => item.title.trim().toLowerCase() === 'seconds');
if (!product) throw new Error('Seconds product not found.');
if (product.variantsCount.count !== EXPECTED) throw new Error(`Expected ${EXPECTED} Seconds variants, found ${product.variantsCount.count}.`);

const variants = [];
let after = null;
do {
  const page = graphql(`query SecondsVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        nodes { id sku }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`, { id: product.id, after }).product.variants;
  variants.push(...page.nodes);
  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (after);

const updates = variants.filter((variant) => !variant.sku).map((variant) => ({
  id: variant.id,
  inventoryItem: { sku: `TSSC-SE-${variant.id.split('/').pop()}` },
}));
if (!APPLY) {
  console.log(JSON.stringify({ product: product.title, variants: variants.length, missing_skus: updates.length, preview: updates.slice(0, 5) }, null, 2));
  process.exit(0);
}
if (CONFIRMATION !== `ASSIGN_${EXPECTED}_SECONDS_SKUS`) throw new Error(`Use --confirm=ASSIGN_${EXPECTED}_SECONDS_SKUS.`);
if (updates.length !== EXPECTED) throw new Error(`Expected ${EXPECTED} blank SKUs before applying, found ${updates.length}.`);

const mutation = `mutation UpdateSecondsSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id inventoryItem { sku } }
    userErrors { field message }
  }
}`;
let updated = 0;
for (let offset = 0; offset < updates.length; offset += 100) {
  const result = graphql(mutation, { productId: product.id, variants: updates.slice(offset, offset + 100) }, true).productVariantsBulkUpdate;
  if (result.userErrors.length) throw new Error(JSON.stringify(result.userErrors, null, 2));
  updated += result.productVariants.length;
}
console.log(JSON.stringify({ product: product.title, updated }, null, 2));
