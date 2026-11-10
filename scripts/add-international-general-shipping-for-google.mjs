#!/usr/bin/env node

/**
 * Mirror the existing TSSC — Sequins international country groups/rates into
 * Shopify's otherwise-unused General profile. Google & YouTube requires rates
 * in General before automatically syncing a country to Merchant Center.
 *
 * Dry run:
 *   node scripts/add-international-general-shipping-for-google.mjs
 *
 * Apply:
 *   node scripts/add-international-general-shipping-for-google.mjs --apply --confirm=ADD_INTERNATIONAL_GENERAL_RATES
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const GENERAL_PROFILE_ID = 'gid://shopify/DeliveryProfile/137868411204';
const GENERAL_LOCATION_GROUP_ID = 'gid://shopify/DeliveryLocationGroup/134784844100';
const GENERAL_EU_ZONE_ID = 'gid://shopify/DeliveryZone/651416174916';
const GENERAL_INTERNATIONAL_ZONE_ID = 'gid://shopify/DeliveryZone/651416207684';
const SOURCE_PROFILE_NAME = 'TSSC — Sequins';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const CONFIRMATION_TEXT = 'ADD_INTERNATIONAL_GENERAL_RATES';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(SCRIPT_DIR, '..', 'soply-import', 'backups');

const GROUPS = [
  {
    name: 'Europe — PDDP supported',
    countries: ['AT', 'BG', 'CY', 'DK', 'EE', 'FI', 'FR', 'DE', 'IT', 'LU', 'MT', 'NL', 'PT', 'SK', 'ES', 'SE', 'IE'],
    method: 'International Tracked — Duties Paid',
    amount: '15.5',
  },
  {
    name: 'Europe — Tracked',
    countries: ['BE', 'HR', 'CZ', 'GR', 'HU', 'LV', 'LT', 'PL', 'RO', 'SI', 'NO', 'CH'],
    method: 'International Tracked',
    amount: '15.5',
  },
  {
    name: 'United States',
    countries: ['US'],
    method: 'International Tracked — Duties Paid',
    amount: '13.25',
  },
  {
    name: 'World Zone 1',
    countries: ['AE', 'CA', 'HK', 'IL', 'JP', 'KR', 'MY'],
    method: 'International Tracked',
    amount: '13.75',
  },
  {
    name: 'World Zone 2',
    countries: ['AU', 'NZ', 'SG'],
    method: 'International Tracked',
    amount: '13.25',
  },
];

function executeGraphql(query, variables = {}, allowMutations = false) {
  const args = ['store', 'execute', '--store', STORE, '--query', query, '--variables', JSON.stringify(variables), '--json'];
  if (allowMutations) args.push('--allow-mutations');
  const result = spawnSync('shopify', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
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
        id name default productVariantsCount { count }
        profileLocationGroups {
          locationGroup { id }
          locationGroupZones(first: 20) {
            nodes {
              zone { id name countries { code { countryCode } } }
              methodDefinitions(first: 20) {
                nodes {
                  id name active
                  rateProvider { __typename ... on DeliveryRateDefinition { id price { amount currencyCode } } }
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
  mutation AddInternationalGeneralRates($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id name productVariantsCount { count } }
      userErrors { field message }
    }
  }
`;

function zones(profile) {
  return profile.profileLocationGroups.flatMap((group) =>
    group.locationGroupZones.nodes.map((groupZone) => ({ group, ...groupZone }))
  );
}

function countryCodes(groupZone) {
  return groupZone.zone.countries.map(({ code }) => code.countryCode).sort();
}

function sameCountries(left, right) {
  return [...left].sort().join(',') === [...right].sort().join(',');
}

function rate(groupZone) {
  if (groupZone.methodDefinitions.nodes.length !== 1) return null;
  const definition = groupZone.methodDefinitions.nodes[0];
  return {
    name: definition.name,
    active: definition.active,
    price: definition.rateProvider?.__typename === 'DeliveryRateDefinition' ? definition.rateProvider.price : null,
    conditions: definition.methodConditions,
  };
}

function zoneInput(group, id) {
  return {
    ...(id ? { id } : {}),
    name: group.name,
    countries: group.countries.map((code) => ({ code, includeAllProvinces: true })),
    methodDefinitionsToCreate: [{
      name: group.method,
      active: true,
      rateDefinition: { price: { amount: group.amount, currencyCode: 'GBP' } },
    }],
  };
}

const profilesBefore = executeGraphql(profilesQuery).deliveryProfiles.nodes;
const general = profilesBefore.find(({ id }) => id === GENERAL_PROFILE_ID);
const source = profilesBefore.find(({ name }) => name === SOURCE_PROFILE_NAME);
if (!general?.default) throw new Error('Expected General/default profile was not found.');
if (general.productVariantsCount.count !== 0) throw new Error('General now covers products; refusing to restructure its zones.');
if (!source) throw new Error(`Source profile ${SOURCE_PROFILE_NAME} was not found.`);

const generalZones = zones(general);
const generalGroup = general.profileLocationGroups.find(({ locationGroup }) => locationGroup.id === GENERAL_LOCATION_GROUP_ID);
if (!generalGroup) throw new Error('Audited General location group was not found.');

for (const group of GROUPS) {
  const sourceZone = zones(source).find((candidate) => sameCountries(countryCodes(candidate), group.countries));
  const sourceRate = sourceZone && rate(sourceZone);
  if (!sourceRate || sourceRate.name !== group.method || !sourceRate.active ||
      sourceRate.price?.amount !== group.amount || sourceRate.price?.currencyCode !== 'GBP' ||
      sourceRate.conditions.length) {
    throw new Error(`Live source no longer matches expected ${group.name} rate; refusing to mutate.`);
  }
}

const alreadyComplete = GROUPS.every((group) => {
  const match = generalZones.find((candidate) => sameCountries(countryCodes(candidate), group.countries));
  const currentRate = match && rate(match);
  return match?.zone.name === group.name && currentRate?.name === group.method && currentRate.active &&
    currentRate.price?.amount === group.amount && currentRate.price?.currencyCode === 'GBP' &&
    currentRate.conditions.length === 0;
});

console.log('International General shipping preflight');
console.log('========================================');
console.log(`General profile variants: ${general.productVariantsCount.count}`);
for (const group of GROUPS) console.log(`- ${group.name}: ${group.countries.length} countries, ${group.method}, GBP ${group.amount}`);
if (alreadyComplete) {
  console.log('General already matches all five international source groups; no change needed.');
  process.exit(0);
}

const eu = generalZones.find(({ zone }) => zone.id === GENERAL_EU_ZONE_ID);
const international = generalZones.find(({ zone }) => zone.id === GENERAL_INTERNATIONAL_ZONE_ID);
if (!eu || !international) throw new Error('Audited General EU/International zones were not found.');
if (eu.methodDefinitions.nodes.length || international.methodDefinitions.nodes.length) {
  throw new Error('General EU/International already contains unexpected rates; refusing to overwrite.');
}
const expectedBeforeCountries = [...GROUPS.flatMap(({ countries }) => countries)].sort();
const actualBeforeCountries = [...countryCodes(eu), ...countryCodes(international)].sort();
if (!sameCountries(expectedBeforeCountries, actualBeforeCountries)) {
  throw new Error('General international country coverage changed since audit; refusing to mutate.');
}

if (!APPLY) {
  console.log('\nDry run only: Shopify shipping was not changed.');
  console.log(`Apply with --apply --confirm=${CONFIRMATION_TEXT}`);
  process.exit(0);
}
if (CONFIRMATION !== CONFIRMATION_TEXT) throw new Error(`Apply blocked. Re-run with --confirm=${CONFIRMATION_TEXT}.`);

mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(BACKUP_DIR, `general-international-rates-before-google-fix-${timestamp}.json`);
writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), general, source }, null, 2)}\n`);
console.log(`Backup written: ${backupPath}`);

const result = executeGraphql(updateMutation, {
  id: GENERAL_PROFILE_ID,
  profile: {
    locationGroupsToUpdate: [{
      id: GENERAL_LOCATION_GROUP_ID,
      zonesToUpdate: [zoneInput(GROUPS[0], GENERAL_EU_ZONE_ID), zoneInput(GROUPS[1], GENERAL_INTERNATIONAL_ZONE_ID)],
      zonesToCreate: GROUPS.slice(2).map((group) => zoneInput(group)),
    }],
  },
}, true).deliveryProfileUpdate;
if (result.userErrors.length) throw new Error(JSON.stringify(result.userErrors, null, 2));

const after = executeGraphql(profilesQuery).deliveryProfiles.nodes.find(({ id }) => id === GENERAL_PROFILE_ID);
for (const group of GROUPS) {
  const match = zones(after).find((candidate) => sameCountries(countryCodes(candidate), group.countries));
  const currentRate = match && rate(match);
  if (match?.zone.name !== group.name || currentRate?.name !== group.method || !currentRate.active ||
      currentRate.price?.amount !== group.amount || currentRate.price?.currencyCode !== 'GBP') {
    throw new Error(`Post-update verification failed for ${group.name}.`);
  }
}
console.log('Verified all five General international country groups and rates.');
console.log('Shopify update completed. Google & YouTube can now resync supported countries.');
