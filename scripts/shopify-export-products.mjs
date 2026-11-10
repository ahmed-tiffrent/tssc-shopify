#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const store = '3midq0-8i.myshopify.com';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupDir = path.join(root, 'soply-import', 'backups');

function executeGraphql(query, variables = {}) {
  const result = spawnSync(
    'shopify',
    ['store', 'execute', '--store', store, '--query', query, '--variables', JSON.stringify(variables), '--json'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`No JSON returned: ${result.stdout}`);
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload.data || payload;
}

const productsQuery = `
  query ProductsForEtsy($after: String) {
    products(first: 100, after: $after, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        status
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const productQuery = `
  query ProductForEtsy($id: ID!) {
    product(id: $id) {
      id title handle descriptionHtml status vendor productType tags createdAt updatedAt onlineStoreUrl
      seo { title description }
      category { id name fullName }
      options { id name optionValues { id name hasVariants } }
      collections(first: 50) { nodes { id title handle } }
      media(first: 250) {
        nodes {
          id alt mediaContentType
          ... on MediaImage { image { url width height } }
        }
      }
      variants(first: 250) {
        nodes {
          id title sku price compareAtPrice availableForSale inventoryQuantity
          inventoryItem { harmonizedSystemCode countryCodeOfOrigin }
          selectedOptions { name value }
          media(first: 10) {
            nodes {
              id alt mediaContentType
              ... on MediaImage { image { url width height } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const variantsQuery = `
  query MoreVariantsForEtsy($id: ID!, $after: String!) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        nodes {
          id title sku price compareAtPrice availableForSale inventoryQuantity
          inventoryItem { harmonizedSystemCode countryCodeOfOrigin }
          selectedOptions { name value }
          media(first: 10) {
            nodes {
              id alt mediaContentType
              ... on MediaImage { image { url width height } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const products = [];
let after = null;
do {
  const page = executeGraphql(productsQuery, { after }).products;
  products.push(...page.nodes);
  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (after);

for (let index = 0; index < products.length; index += 1) {
  const summary = products[index];
  const product = executeGraphql(productQuery, { id: summary.id }).product;
  products[index] = product;
  let variantAfter = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
  while (variantAfter) {
    const page = executeGraphql(variantsQuery, { id: product.id, after: variantAfter }).product.variants;
    product.variants.nodes.push(...page.nodes);
    variantAfter = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  }
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(backupDir, `shopify-products-before-etsy-sync-${stamp}.json`);
fs.writeFileSync(output, `${JSON.stringify({ exported_at: new Date().toISOString(), store, products }, null, 2)}\n`);
process.stdout.write(`Products: ${products.length}\n`);
process.stdout.write(`Active: ${products.filter((product) => product.status === 'ACTIVE').length}\n`);
process.stdout.write(`Backup: ${output}\n`);
