#!/usr/bin/env node

/**
 * Configure the three TSSC product-type shipping profiles from the approved
 * Shopify shipping workbook.
 *
 * Dry run:
 *   node scripts/tssc-configure-shipping-profiles.mjs
 *
 * Apply:
 *   node scripts/tssc-configure-shipping-profiles.mjs --apply --confirm=ACTIVATE_TSSC_PRODUCT_TYPE_SHIPPING
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const LOCATION_ID = 'gid://shopify/Location/111376662852';
const PROFILE_NAMES = ['TSSC — Sequins', 'TSSC — Spools', 'TSSC — Punchinella'];
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const CONFIRMATION_TEXT = 'ACTIVATE_TSSC_PRODUCT_TYPE_SHIPPING';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(SCRIPT_DIR, '..', 'soply-import', 'backups');

const COUNTRIES = {
  uk: ['GB'],
  europePddp: ['AT', 'BG', 'CY', 'DK', 'EE', 'FI', 'FR', 'DE', 'IT', 'LU', 'MT', 'NL', 'PT', 'SK', 'ES', 'SE', 'IE'],
  europeStandard: ['BE', 'HR', 'CZ', 'GR', 'HU', 'LV', 'LT', 'PL', 'RO', 'SI', 'NO', 'CH'],
  usa: ['US'],
  world1: ['AE', 'CA', 'HK', 'IL', 'JP', 'KR', 'MY'],
  world2: ['AU', 'NZ', 'SG'],
};

const PROFILE_PRICES = {
  'TSSC — Sequins': { ukSecond: '2.00', ukFirst: '3.75', europe: '15.50', usa: '13.25', world1: '13.75', world2: '13.25' },
  'TSSC — Spools': { ukSecond: '3.00', ukFirst: '4.00', europe: '15.75', usa: '14.50', world1: '14.50', world2: '15.50' },
  'TSSC — Punchinella': { ukSecond: '5.25', ukFirst: '6.75', europe: '15.50', usa: '14.75', world1: '16.75', world2: '17.25' },
};

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

const catalogueQuery = `
  query Catalogue($after: String) {
    products(first: 100, after: $after, sortKey: TITLE) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const variantsQuery = `
  query Variants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 250, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
    }
  }
`;

const profilesQuery = `
  query CurrentShipping {
    deliveryProfiles(first: 10) {
      nodes {
        id
        name
        default
        coversAllItems
        productVariantsCount { count }
        profileLocationGroups {
          locationGroup { id }
          locationGroupZones(first: 10) {
            nodes {
              zone { id name countries { code { countryCode restOfWorld } } }
              methodDefinitions(first: 20) {
                nodes {
                  id
                  name
                  active
                  description
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition { id price { amount currencyCode } }
                  }
                  methodConditions {
                    id
                    field
                    operator
                    conditionCriteria {
                      __typename
                      ... on MoneyV2 { amount currencyCode }
                      ... on Weight { unit value }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const createProfileMutation = `
  mutation CreateProfile($profile: DeliveryProfileInput!) {
    deliveryProfileCreate(profile: $profile) {
      profile { id name }
      userErrors { field message }
    }
  }
`;

const updateProfileMutation = `
  mutation UpdateProfile($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id name productVariantsCount { count } }
      userErrors { field message }
    }
  }
`;

function method(name, price) {
  return {
    name,
    active: true,
    rateDefinition: { price: { amount: price, currencyCode: 'GBP' } },
  };
}

function zone(name, countries, methods) {
  return {
    name,
    countries: countries.map((code) => ({ code, includeAllProvinces: true })),
    methodDefinitionsToCreate: methods,
  };
}

function locationGroup(prices) {
  return {
    locations: [LOCATION_ID],
    zonesToCreate: [
      zone('United Kingdom', COUNTRIES.uk, [
        method('Royal Mail 2nd Class', prices.ukSecond),
        method('Royal Mail 1st Class', prices.ukFirst),
      ]),
      zone('Europe — PDDP supported', COUNTRIES.europePddp, [
        method('International Tracked — Duties Paid', prices.europe),
      ]),
      zone('Europe — Tracked', COUNTRIES.europeStandard, [
        method('International Tracked', prices.europe),
      ]),
      zone('United States', COUNTRIES.usa, [
        method('International Tracked — Duties Paid', prices.usa),
      ]),
      zone('World Zone 1', COUNTRIES.world1, [
        method('International Tracked', prices.world1),
      ]),
      zone('World Zone 2', COUNTRIES.world2, [
        method('International Tracked', prices.world2),
      ]),
    ],
  };
}

const products = [];
let productCursor = null;
do {
  const connection = executeGraphql(catalogueQuery, { after: productCursor }).products;
  for (const product of connection.nodes) {
    const variantIds = [];
    let variantCursor = null;
    do {
      const variants = executeGraphql(variantsQuery, { id: product.id, after: variantCursor }).product.variants;
      variantIds.push(...variants.nodes.map(({ id }) => id));
      variantCursor = variants.pageInfo.hasNextPage ? variants.pageInfo.endCursor : null;
    } while (variantCursor);
    products.push({ id: product.id, title: product.title, variantIds });
  }
  productCursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
} while (productCursor);

const profileVariants = new Map(PROFILE_NAMES.map((name) => [name, []]));
for (const product of products) {
  const profileName = /\bpunchinella\b/i.test(product.title)
    ? 'TSSC — Punchinella'
    : /\bon the spool\b/i.test(product.title)
      ? 'TSSC — Spools'
      : 'TSSC — Sequins';
  profileVariants.get(profileName).push(...product.variantIds);
}

const currentProfiles = executeGraphql(profilesQuery).deliveryProfiles.nodes;
const duplicate = currentProfiles.find((profile) => PROFILE_NAMES.includes(profile.name));
if (duplicate) throw new Error(`Target profile already exists (${duplicate.name}); refusing a duplicate setup.`);
const defaultProfile = currentProfiles.find((profile) => profile.default);
if (!defaultProfile) throw new Error('No default delivery profile was found.');

console.log('TSSC product-type shipping profile audit');
console.log('========================================');
for (const name of PROFILE_NAMES) {
  console.log(`${name}: ${profileVariants.get(name).length} variants`);
  console.log(JSON.stringify(PROFILE_PRICES[name]));
}
console.log('Countries retained:');
for (const [name, codes] of Object.entries(COUNTRIES)) console.log(`- ${name}: ${codes.join(', ')}`);
console.log(`Existing profiles: ${currentProfiles.map((profile) => profile.name).join(', ')}`);

if (!APPLY) {
  console.log('\nDry run only: Shopify shipping was not changed.');
  console.log(`Apply with --apply --confirm=${CONFIRMATION_TEXT}`);
  process.exit(0);
}

if (CONFIRMATION !== CONFIRMATION_TEXT) throw new Error(`Apply blocked. Re-run with --confirm=${CONFIRMATION_TEXT}.`);

mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(BACKUP_DIR, `shipping-profiles-before-update-${timestamp}.json`);
writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), currentProfiles, target: { PROFILE_PRICES, COUNTRIES } }, null, 2)}\n`);
console.log(`Backup written: ${backupPath}`);

for (const name of PROFILE_NAMES) {
  const allVariantIds = profileVariants.get(name);
  const firstBatch = allVariantIds.slice(0, 250);
  const created = executeGraphql(
    createProfileMutation,
    {
      profile: {
        name,
        variantsToAssociate: firstBatch,
        locationGroupsToCreate: [locationGroup(PROFILE_PRICES[name])],
      },
    },
    true
  ).deliveryProfileCreate;
  if (created.userErrors.length) throw new Error(`${name}: ${JSON.stringify(created.userErrors, null, 2)}`);
  console.log(`${name}: profile created; associated ${firstBatch.length}/${allVariantIds.length}`);

  for (let start = 250; start < allVariantIds.length; start += 250) {
    const batch = allVariantIds.slice(start, start + 250);
    const updated = executeGraphql(
      updateProfileMutation,
      { id: created.profile.id, profile: { variantsToAssociate: batch } },
      true
    ).deliveryProfileUpdate;
    if (updated.userErrors.length) throw new Error(`${name}: ${JSON.stringify(updated.userErrors, null, 2)}`);
    console.log(`${name}: associated ${Math.min(start + batch.length, allVariantIds.length)}/${allVariantIds.length}`);
  }
}

const oldMethodDefinitionIds = new Set();
for (const locationGroup of defaultProfile.profileLocationGroups) {
  for (const locationGroupZone of locationGroup.locationGroupZones.nodes) {
    for (const definition of locationGroupZone.methodDefinitions.nodes) {
      oldMethodDefinitionIds.add(definition.id.split('?')[0]);
    }
  }
}

if (oldMethodDefinitionIds.size) {
  const updated = executeGraphql(
    updateProfileMutation,
    { id: defaultProfile.id, profile: { methodDefinitionsToDelete: [...oldMethodDefinitionIds] } },
    true
  ).deliveryProfileUpdate;
  if (updated.userErrors.length) throw new Error(`Old-rate removal: ${JSON.stringify(updated.userErrors, null, 2)}`);
  console.log(`Removed ${oldMethodDefinitionIds.size} old rate definition(s), including free shipping, from the default profile.`);
}

console.log('Shipping profiles activated.');
