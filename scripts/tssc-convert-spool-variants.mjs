#!/usr/bin/env node

/**
 * Replace the TSSC On The Spool products' Weight | Quantity option with a
 * Length option containing 50 yards and 100 yards. Both variants cost £10.
 *
 * Dry run (default):
 *   node scripts/tssc-convert-spool-variants.mjs
 *
 * Apply after reviewing the dry run:
 *   node scripts/tssc-convert-spool-variants.mjs --apply --confirm=CONVERT_10_SPOOL_PRODUCTS
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const EXPECTED_PRODUCT_COUNT = 10;
const LENGTHS = ['50 yards', '100 yards'];
const PRICE = '10.00';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(SCRIPT_DIR, '..', 'soply-import', 'backups');

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
  if (start === -1 || end === -1) throw new Error(`No JSON returned by Shopify CLI: ${result.stdout}`);

  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

function normalise(value) {
  return value.trim().toLocaleLowerCase('en-GB').replace(/\s+/g, ' ');
}

const productsQuery = `
  query SpoolProducts {
    products(first: 100, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        options { id name position values }
        variantsCount { count }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const variantsQuery = `
  query SpoolProductVariants($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      options { id name position values }
      variants(first: 250) {
        nodes {
          id
          title
          price
          compareAtPrice
          sku
          barcode
          taxable
          inventoryPolicy
          inventoryQuantity
          image { id }
          inventoryItem {
            id
            tracked
            requiresShipping
            measurement { weight { unit value } }
          }
          selectedOptions { name value }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

const productSetMutation = `
  mutation ConvertSpoolProduct($identifier: ProductSetIdentifiers!, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product {
        id
        title
        options { name position values }
        variantsCount { count }
        variants(first: 250) {
          nodes { id title price selectedOptions { name value } }
          pageInfo { hasNextPage }
        }
      }
      userErrors { code field message }
    }
  }
`;

const productConnection = executeGraphql(productsQuery).products;
if (productConnection.pageInfo.hasNextPage) throw new Error('Product lookup requires pagination; refusing a partial run.');

const spoolProducts = productConnection.nodes.filter((product) => /on the spool/i.test(product.title));
if (spoolProducts.length !== EXPECTED_PRODUCT_COUNT) {
  throw new Error(`Expected ${EXPECTED_PRODUCT_COUNT} On The Spool products, found ${spoolProducts.length}.`);
}

const prepared = [];
const alreadyConverted = [];
for (const productSummary of spoolProducts) {
  const product = executeGraphql(variantsQuery, { id: productSummary.id }).product;
  if (product.variants.pageInfo.hasNextPage) throw new Error(`${product.title}: variant pagination is required.`);
  if (product.variants.nodes.length !== productSummary.variantsCount.count) {
    throw new Error(`${product.title}: expected ${productSummary.variantsCount.count} variants, received ${product.variants.nodes.length}.`);
  }

  const optionNames = product.options.map((option) => normalise(option.name));
  const expectedVariantCountForLength = product.options[1].values.length * LENGTHS.length;
  if (
    optionNames.join('|') === 'finish|colour|length' &&
    product.options[2].values.join('|') === LENGTHS.join('|') &&
    product.variants.nodes.length === expectedVariantCountForLength &&
    product.variants.nodes.every((variant) => variant.price === PRICE)
  ) {
    alreadyConverted.push(product);
    continue;
  }
  if (optionNames.join('|') !== 'finish|colour|weight | quantity') {
    throw new Error(`${product.title}: unexpected options (${product.options.map((option) => option.name).join(', ')}).`);
  }

  const nonDefaultVariantData = product.variants.nodes.filter((variant) =>
    variant.compareAtPrice !== null ||
    variant.sku !== null ||
    variant.barcode !== null ||
    variant.image !== null ||
    variant.taxable !== true ||
    variant.inventoryPolicy !== 'DENY' ||
    variant.inventoryItem.tracked !== false ||
    variant.inventoryItem.requiresShipping !== true ||
    Number(variant.inventoryItem.measurement.weight.value) !== 0
  );
  if (nonDefaultVariantData.length) {
    throw new Error(`${product.title}: ${nonDefaultVariantData.length} variants contain custom data that the conversion would not safely preserve.`);
  }

  const combinations = new Map();
  for (const variant of product.variants.nodes) {
    const finish = variant.selectedOptions.find((option) => normalise(option.name) === 'finish')?.value;
    const colour = variant.selectedOptions.find((option) => normalise(option.name) === 'colour')?.value;
    if (!finish || !colour) throw new Error(`${product.title}: variant ${variant.id} is missing Finish or Colour.`);
    combinations.set(`${finish}\u0000${colour}`, { finish, colour });
  }

  const expectedOldCount = combinations.size * 5;
  if (expectedOldCount !== product.variants.nodes.length) {
    throw new Error(`${product.title}: expected five weight variants for every colour/finish combination.`);
  }

  const variants = [];
  for (const { finish, colour } of combinations.values()) {
    for (const length of LENGTHS) {
      variants.push({
        optionValues: [
          { optionName: 'Finish', name: finish },
          { optionName: 'Colour', name: colour },
          { optionName: 'Length', name: length },
        ],
        price: PRICE,
        taxable: true,
        inventoryPolicy: 'DENY',
        inventoryItem: { tracked: false, requiresShipping: true },
      });
    }
  }

  prepared.push({ product, combinations: [...combinations.values()], variants });
}

console.log('TSSC spool variant conversion');
console.log('=============================');
for (const product of alreadyConverted) {
  console.log(`${product.title}: already converted; skipped.`);
}
for (const { product, combinations, variants } of prepared) {
  console.log(`${product.title}: ${product.variants.nodes.length} weight variants -> ${variants.length} length variants (${combinations.length} colours).`);
}
console.log(`Remaining: ${prepared.reduce((sum, item) => sum + item.product.variants.nodes.length, 0)} old variants -> ${prepared.reduce((sum, item) => sum + item.variants.length, 0)} new variants.`);

if (!APPLY) {
  console.log('\nDry run only: no Shopify data was changed.');
  console.log('Apply with --apply --confirm=CONVERT_10_SPOOL_PRODUCTS');
  process.exit(0);
}

if (!prepared.length) {
  console.log('All spool products are already converted and verified.');
  process.exit(0);
}

if (CONFIRMATION !== 'CONVERT_10_SPOOL_PRODUCTS') {
  throw new Error('Conversion blocked. Re-run with --confirm=CONVERT_10_SPOOL_PRODUCTS after reviewing the dry run.');
}

mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(BACKUP_DIR, `spool-products-before-length-conversion-${timestamp}.json`);
writeFileSync(backupPath, JSON.stringify(prepared.map(({ product }) => product), null, 2) + '\n');
console.log(`Backup written: ${backupPath}`);

for (const { product, variants } of prepared) {
  const input = {
    productOptions: [
      { name: 'Finish', position: 1, values: product.options[0].values.map((name) => ({ name })) },
      { name: 'Colour', position: 2, values: product.options[1].values.map((name) => ({ name })) },
      { name: 'Length', position: 3, values: LENGTHS.map((name) => ({ name })) },
    ],
    variants,
  };

  const response = executeGraphql(
    productSetMutation,
    { identifier: { id: product.id }, input },
    true
  ).productSet;
  if (response.userErrors.length) {
    throw new Error(`${product.title}: ${JSON.stringify(response.userErrors, null, 2)}`);
  }
  if (response.product.variants.pageInfo.hasNextPage || response.product.variants.nodes.length !== variants.length) {
    throw new Error(`${product.title}: post-update variant count verification failed.`);
  }
  const invalid = response.product.variants.nodes.filter((variant) =>
    variant.price !== PRICE ||
    variant.selectedOptions.find((option) => option.name === 'Length')?.value === undefined
  );
  if (invalid.length) throw new Error(`${product.title}: ${invalid.length} converted variants failed verification.`);
  console.log(`Converted and verified: ${product.title}`);
}

console.log(`Completed: converted and verified ${prepared.length} spool products.`);
