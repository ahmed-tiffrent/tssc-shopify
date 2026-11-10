#!/usr/bin/env node

/**
 * Add the store's existing UK Royal Mail rates to Shopify's General profile so
 * the Google & YouTube channel can create its official GB product source.
 *
 * Dry run:
 *   node scripts/add-uk-general-shipping-for-google.mjs
 *
 * Apply:
 *   node scripts/add-uk-general-shipping-for-google.mjs --apply --confirm=ADD_UK_GENERAL_RATES
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const GENERAL_PROFILE_ID = 'gid://shopify/DeliveryProfile/137868411204';
const GENERAL_LOCATION_GROUP_ID = 'gid://shopify/DeliveryLocationGroup/134784844100';
const GENERAL_UK_ZONE_ID = 'gid://shopify/DeliveryZone/651416142148';
const SOURCE_PROFILE_NAME = 'TSSC — Sequins';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const CONFIRMATION_TEXT = 'ADD_UK_GENERAL_RATES';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(SCRIPT_DIR, '..', 'soply-import', 'backups');

function executeGraphql(query, variables = {}, allowMutations = false) {
  const args = ['store', 'execute', '--store', STORE, '--query', query, '--variables', JSON.stringify(variables), '--json'];
  if (allowMutations) args.push('--allow-mutations');
  const result = spawnSync('shopify', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Shopify CLI exited with ${result.status}`);
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON returned: ${result.stdout}`);
  const payload = JSON.parse(result.stdout.slice(start, end + 1));
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload;
}

const profilesQuery = `
  query ShippingProfiles {
    deliveryProfiles(first: 10) {
      nodes {
        id
        name
        default
        productVariantsCount { count }
        profileLocationGroups {
          locationGroup { id }
          locationGroupZones(first: 20) {
            nodes {
              zone { id name countries { code { countryCode restOfWorld } } }
              methodDefinitions(first: 20) {
                nodes {
                  id
                  name
                  active
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition { id price { amount currencyCode } }
                  }
                  methodConditions { id field operator }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const updateMutation = `
  mutation AddUkGeneralRates($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id name productVariantsCount { count } }
      userErrors { field message }
    }
  }
`;

function ukZone(profile) {
  for (const group of profile.profileLocationGroups) {
    for (const groupZone of group.locationGroupZones.nodes) {
      if (groupZone.zone.countries.some(({ code }) => code.countryCode === 'GB')) {
        return { group, groupZone };
      }
    }
  }
  return null;
}

function flatRates(groupZone) {
  return groupZone.methodDefinitions.nodes.map((definition) => ({
    id: definition.id,
    name: definition.name,
    active: definition.active,
    price: definition.rateProvider?.__typename === 'DeliveryRateDefinition'
      ? definition.rateProvider.price
      : null,
    conditions: definition.methodConditions,
  }));
}

const beforeProfiles = executeGraphql(profilesQuery).deliveryProfiles.nodes;
const general = beforeProfiles.find(({ id }) => id === GENERAL_PROFILE_ID);
const source = beforeProfiles.find(({ name }) => name === SOURCE_PROFILE_NAME);
if (!general?.default) throw new Error('Expected General/default profile was not found.');
if (!source) throw new Error(`Source profile ${SOURCE_PROFILE_NAME} was not found.`);

const generalUk = ukZone(general);
const sourceUk = ukZone(source);
if (!generalUk || generalUk.group.locationGroup.id !== GENERAL_LOCATION_GROUP_ID || generalUk.groupZone.zone.id !== GENERAL_UK_ZONE_ID) {
  throw new Error('The General UK zone no longer matches the audited IDs; refusing to mutate.');
}
if (!sourceUk) throw new Error(`No UK zone found in ${SOURCE_PROFILE_NAME}.`);

const currentRates = flatRates(generalUk.groupZone);
const sourceRates = flatRates(sourceUk.groupZone);
const expected = [
  { name: 'Royal Mail 2nd Class', amount: '2.0', currencyCode: 'GBP' },
  { name: 'Royal Mail 1st Class', amount: '3.75', currencyCode: 'GBP' },
];

for (const rate of expected) {
  const match = sourceRates.find((candidate) => candidate.name === rate.name);
  if (!match?.active || match.price?.amount !== rate.amount || match.price?.currencyCode !== rate.currencyCode || match.conditions.length) {
    throw new Error(`Source rate ${rate.name} no longer matches the audited flat rate.`);
  }
}

console.log('UK General shipping preflight');
console.log('=============================');
console.log(`General profile variants: ${general.productVariantsCount.count}`);
console.log(`General UK current rates: ${currentRates.length}`);
console.log(`Source: ${SOURCE_PROFILE_NAME}`);
for (const rate of expected) console.log(`- ${rate.name}: GBP ${rate.amount}`);

if (currentRates.length) {
  const alreadyCorrect = expected.every((rate) => currentRates.some((candidate) =>
    candidate.name === rate.name && candidate.active && candidate.price?.amount === rate.amount &&
    candidate.price?.currencyCode === rate.currencyCode && !candidate.conditions.length
  ));
  if (alreadyCorrect && currentRates.length === expected.length) {
    console.log('General already contains the two expected UK rates; no change needed.');
    process.exit(0);
  }
  throw new Error('General UK already has unexpected rates; refusing to add duplicates or overwrite them.');
}

if (!APPLY) {
  console.log('\nDry run only: Shopify shipping was not changed.');
  console.log(`Apply with --apply --confirm=${CONFIRMATION_TEXT}`);
  process.exit(0);
}
if (CONFIRMATION !== CONFIRMATION_TEXT) throw new Error(`Apply blocked. Re-run with --confirm=${CONFIRMATION_TEXT}.`);

mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(BACKUP_DIR, `general-uk-rates-before-google-fix-${timestamp}.json`);
writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), general, sourceUk }, null, 2)}\n`);
console.log(`Backup written: ${backupPath}`);

const methods = expected.map(({ name, amount, currencyCode }) => ({
  name,
  active: true,
  rateDefinition: { price: { amount, currencyCode } },
}));
const result = executeGraphql(updateMutation, {
  id: GENERAL_PROFILE_ID,
  profile: {
    locationGroupsToUpdate: [{
      id: GENERAL_LOCATION_GROUP_ID,
      zonesToUpdate: [{ id: GENERAL_UK_ZONE_ID, methodDefinitionsToCreate: methods }],
    }],
  },
}, true).deliveryProfileUpdate;
if (result.userErrors.length) throw new Error(JSON.stringify(result.userErrors, null, 2));

const after = executeGraphql(profilesQuery).deliveryProfiles.nodes.find(({ id }) => id === GENERAL_PROFILE_ID);
const afterUk = ukZone(after);
const afterRates = flatRates(afterUk.groupZone);
for (const rate of expected) {
  if (!afterRates.some((candidate) => candidate.name === rate.name && candidate.active &&
    candidate.price?.amount === rate.amount && candidate.price?.currencyCode === rate.currencyCode)) {
    throw new Error(`Post-update verification failed for ${rate.name}.`);
  }
}
console.log('Verified General UK rates:');
for (const rate of afterRates) console.log(`- ${rate.name}: ${rate.price?.currencyCode} ${rate.price?.amount} (${rate.active ? 'active' : 'inactive'})`);
console.log('Shopify update completed. Google & YouTube can now resync the United Kingdom.');
