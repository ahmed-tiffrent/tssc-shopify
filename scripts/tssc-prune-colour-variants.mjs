#!/usr/bin/env node

/**
 * Audit and optionally delete Shopify variants whose Colour is unavailable for
 * the product's recycled-PET percentage according to the TSSC colour chart.
 *
 * Dry run (default):
 *   node scripts/tssc-prune-colour-variants.mjs
 *
 * Apply standard products only:
 *   node scripts/tssc-prune-colour-variants.mjs --apply --confirm=DELETE_N_VARIANTS
 *
 * Include Punchinella only when explicitly requested:
 *   add --include-punchinella to either command.
 */

import { spawnSync } from 'node:child_process';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const INCLUDE_PUNCHINELLA = process.argv.includes('--include-punchinella');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];

// Filled square in the supplied chart: available in 20% recycled PET.
const AVAILABLE_20 = new Set([
  'marmalade',
  'rose tea',
  'sunshine',
  'comet',
  'artichoke',
  'sea serpent',
  'blue lagoon',
  'aegean',
  'admiral',
  'lavender',
  'peony',
  'lipstick',
  'chestnut',
  'dark chocolate',
  'jet black',
  'spacesuit',
  'nostalgia',
  'blush',
  'sandcastle',
  'asparagus',
  'sea foam',
  'fresh air',
  'hello sailor',
  'midnight',
  'iris',
  'seashell',
  'pink petal',
  'carnation',
  'geranium',
  'chilli pepper',
  'claret',
  'russet',
  'black liquorice',
  'rocket man',
  'snow white',
  'clear rainbow',
  'disco dancer',
  'fluoro canary',
  'fluoro tangerine',
  'fluoro flamingo',
  'silver lining',
  'sugar + spice',
  'double denim',
  'sea star',
]);

// Filled circle in the supplied chart: available in GRS-certified 100% rPET.
const AVAILABLE_100 = new Set([
  'sunshine',
  'comet',
  'pale peridot',
  'racing green',
  'silver lilac',
  'lipstick',
  'jet black',
  'gunmetal',
  'dark silver',
  'asparagus',
  'forest',
  'aqua green',
  'pale heather',
  'seashell',
  'carnation',
  'geranium',
  'black liquorice',
  'slate grey',
  'crystal clear',
  'bobby dazzler',
]);

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
    maxBuffer: 64 * 1024 * 1024,
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

function materialForTitle(title) {
  if (/100% Recycled Plastic/i.test(title)) return '100';
  if (/20% Recycled Plastic/i.test(title)) return '20';
  return null;
}

function normalise(value) {
  return value.trim().toLocaleLowerCase('en-GB').replace(/\s+/g, ' ');
}

function chunks(values, size) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

const productsQuery = `
  query ProductsForColourAudit {
    products(first: 100, sortKey: TITLE) {
      nodes { id title handle status variantsCount { count } }
      pageInfo { hasNextPage }
    }
  }
`;

const variantsQuery = `
  query ProductVariantsForColourAudit($id: ID!, $after: String) {
    product(id: $id) {
      id
      title
      variants(first: 250, after: $after) {
        nodes { id title selectedOptions { name value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const deleteMutation = `
  mutation DeleteUnavailableColourVariants($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id title variantsCount { count } }
      userErrors { field message }
    }
  }
`;

const productConnection = executeGraphql(productsQuery).products;
if (productConnection.pageInfo.hasNextPage) throw new Error('Product audit requires pagination; refusing a partial run.');

const candidates = productConnection.nodes.filter((product) => materialForTitle(product.title));
const audit = [];
const unknownColours = new Set();

for (const [productIndex, product] of candidates.entries()) {
  let after = null;
  const variants = [];

  do {
    const response = executeGraphql(variantsQuery, { id: product.id, after });
    const connection = response.product.variants;
    variants.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  if (variants.length !== product.variantsCount.count) {
    throw new Error(`${product.title}: expected ${product.variantsCount.count} variants, received ${variants.length}.`);
  }

  const material = materialForTitle(product.title);
  const allowed = material === '20' ? AVAILABLE_20 : AVAILABLE_100;
  const remove = [];
  const removedColours = new Set();

  for (const variant of variants) {
    const colourOption = variant.selectedOptions.find((option) => /^(colour|color)$/i.test(option.name));
    if (!colourOption) {
      throw new Error(`${product.title}: variant ${variant.id} has no Colour option.`);
    }

    const colour = normalise(colourOption.value);
    const known = AVAILABLE_20.has(colour) || AVAILABLE_100.has(colour) || colour === 'pink lemonade';
    if (!known) {
      unknownColours.add(colourOption.value);
      continue;
    }

    if (!allowed.has(colour)) {
      remove.push(variant.id);
      removedColours.add(colourOption.value);
    }
  }

  audit.push({
    ...product,
    material,
    punchinella: /punchinella/i.test(product.title),
    remove,
    removedColours: [...removedColours].sort((a, b) => a.localeCompare(b)),
  });

  process.stderr.write(`\rAudited ${productIndex + 1}/${candidates.length} products`);
}

process.stderr.write('\n');
if (unknownColours.size) {
  throw new Error(`Unrecognised colours found; refusing to continue: ${[...unknownColours].join(', ')}`);
}

const standard = audit.filter((product) => !product.punchinella);
const punchinella = audit.filter((product) => product.punchinella);
const selected = INCLUDE_PUNCHINELLA ? audit : standard;
const selectedCount = selected.reduce((total, product) => total + product.remove.length, 0);
const punchinellaCount = punchinella.reduce((total, product) => total + product.remove.length, 0);

console.log('\nTSSC unavailable-colour variant audit');
console.log('=====================================');
console.log(`Standard products: ${standard.length}`);
console.log(`Standard variants to remove: ${standard.reduce((total, product) => total + product.remove.length, 0)}`);
console.log(`Punchinella products: ${punchinella.length}`);
console.log(`Punchinella variants to remove (separate): ${punchinellaCount}`);
console.log(`Selected for this run: ${selectedCount}`);
console.log(`20% colours kept: ${AVAILABLE_20.size}; 100% colours kept: ${AVAILABLE_100.size}`);

for (const product of audit) {
  console.log(
    `${product.punchinella ? '[PUNCHINELLA] ' : ''}${product.title}: ` +
      `${product.remove.length}/${product.variantsCount.count} variants; ` +
      `remove ${product.removedColours.length} colours (${product.removedColours.join(', ')})`
  );
}

if (!APPLY) {
  console.log('\nDry run only: no Shopify data was changed.');
  console.log(`To apply this exact scope, use --apply --confirm=DELETE_${selectedCount}_VARIANTS`);
  if (!INCLUDE_PUNCHINELLA) console.log('Punchinella remains excluded unless --include-punchinella is supplied.');
  process.exit(0);
}

const expectedConfirmation = `DELETE_${selectedCount}_VARIANTS`;
if (CONFIRMATION !== expectedConfirmation) {
  throw new Error(`Deletion blocked. Re-run with --confirm=${expectedConfirmation} after reviewing the dry run.`);
}

let deleted = 0;
for (const product of selected) {
  for (const variantIds of chunks(product.remove, 250)) {
    const response = executeGraphql(
      deleteMutation,
      { productId: product.id, variantsIds: variantIds },
      true
    );
    const result = response.productVariantsBulkDelete;
    if (result.userErrors.length) {
      throw new Error(`${product.title}: ${JSON.stringify(result.userErrors)}`);
    }
    deleted += variantIds.length;
    console.log(`Deleted ${variantIds.length} variants from ${product.title} (${deleted}/${selectedCount}).`);
  }
}

console.log(`Completed: deleted ${deleted} unavailable-colour variants.`);
