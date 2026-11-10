#!/usr/bin/env node

/**
 * Activate the international Shopify Markets that correspond to TSSC's
 * configured shipping zones. Product prices remain based on the UK catalogue;
 * the United States receives the approved 25% market uplift.
 *
 * Dry run:
 *   node scripts/tssc-configure-markets-pricing.mjs
 *
 * Apply:
 *   node scripts/tssc-configure-markets-pricing.mjs --apply --confirm=ACTIVATE_TSSC_INTERNATIONAL_MARKETS
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = '3midq0-8i.myshopify.com';
const APPLY = process.argv.includes('--apply');
const CONFIRMATION = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1];
const CONFIRMATION_TEXT = 'ACTIVATE_TSSC_INTERNATIONAL_MARKETS';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(SCRIPT_DIR, '..', 'soply-import', 'backups');

const TARGETS = [
  {
    name: 'Europe — PDDP supported',
    handle: 'europe-pddp',
    countries: ['AT', 'BG', 'CY', 'DK', 'EE', 'FI', 'FR', 'DE', 'IT', 'LU', 'MT', 'NL', 'PT', 'SK', 'ES', 'SE', 'IE'],
    currencySettings: { baseCurrency: 'EUR', localCurrencies: true, roundingEnabled: true },
  },
  {
    name: 'Europe — Tracked',
    handle: 'europe-tracked',
    countries: ['BE', 'HR', 'CZ', 'GR', 'HU', 'LV', 'LT', 'PL', 'RO', 'SI', 'NO', 'CH'],
    currencySettings: { baseCurrency: 'EUR', localCurrencies: true, roundingEnabled: true },
  },
  {
    name: 'United States',
    handle: 'us',
    countries: ['US'],
    currencySettings: { baseCurrency: 'USD', localCurrencies: false, roundingEnabled: true },
    priceAdjustmentPercent: 25,
  },
  {
    name: 'World Zone 1',
    handle: 'world-zone-1',
    countries: ['AE', 'CA', 'HK', 'IL', 'JP', 'KR', 'MY'],
    currencySettings: { baseCurrency: 'GBP', localCurrencies: true, roundingEnabled: true },
  },
  {
    name: 'World Zone 2',
    handle: 'world-zone-2',
    countries: ['AU', 'NZ', 'SG'],
    currencySettings: { baseCurrency: 'GBP', localCurrencies: true, roundingEnabled: true },
  },
];

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

const marketsQuery = `
  query MarketsAndCatalogs {
    markets(first: 100) {
      nodes {
        id name handle status type
        currencySettings {
          baseCurrency { currencyCode enabled manualRate }
          localCurrencies
          roundingEnabled
        }
        conditions {
          regionsCondition {
            applicationLevel
            regions(first: 250) {
              nodes { ... on MarketRegionCountry { code } }
            }
          }
        }
      }
    }
    catalogs(first: 100, type: MARKET) {
      nodes {
        id title status
        priceList { id name currency parent { adjustment { type value } } }
        ... on MarketCatalog { markets(first: 20) { nodes { id name handle } } }
      }
    }
  }
`;

const createMarketMutation = `
  mutation CreateMarket($input: MarketCreateInput!) {
    marketCreate(input: $input) {
      market { id name handle status }
      userErrors { field message code }
    }
  }
`;

const createPriceListMutation = `
  mutation CreatePriceList($input: PriceListCreateInput!) {
    priceListCreate(input: $input) {
      priceList { id name currency parent { adjustment { type value } } }
      userErrors { field message code }
    }
  }
`;

const createCatalogMutation = `
  mutation CreateCatalog($input: CatalogCreateInput!) {
    catalogCreate(input: $input) {
      catalog { id title status }
      userErrors { field message code }
    }
  }
`;

function countryCodes(market) {
  return (market.conditions?.regionsCondition?.regions?.nodes || []).map(({ code }) => code).filter(Boolean).sort();
}

function sameSet(left, right) {
  return [...left].sort().join(',') === [...right].sort().join(',');
}

const before = executeGraphql(marketsQuery);
const existingHandles = new Map(before.markets.nodes.map((market) => [market.handle, market]));

console.log('TSSC Shopify Markets audit');
console.log('==========================');
console.log(`Existing markets: ${before.markets.nodes.map((market) => `${market.name} (${market.status})`).join(', ')}`);
for (const target of TARGETS) {
  const current = existingHandles.get(target.handle);
  console.log(`- ${target.name}: ${target.countries.join(', ')}; ${current ? current.status : 'will create ACTIVE'}`);
  if (target.priceAdjustmentPercent) console.log(`  Product-price adjustment: +${target.priceAdjustmentPercent}%`);
}

if (!APPLY) {
  console.log('\nDry run only: Shopify Markets and pricing were not changed.');
  console.log(`Apply with --apply --confirm=${CONFIRMATION_TEXT}`);
  process.exit(0);
}

if (CONFIRMATION !== CONFIRMATION_TEXT) throw new Error(`Apply blocked. Re-run with --confirm=${CONFIRMATION_TEXT}.`);

mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = resolve(BACKUP_DIR, `markets-before-update-${timestamp}.json`);
writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), before, targets: TARGETS }, null, 2)}\n`);
console.log(`Backup written: ${backupPath}`);

for (const target of TARGETS) {
  const existing = existingHandles.get(target.handle);
  if (existing) {
    if (existing.status !== 'ACTIVE' || !sameSet(countryCodes(existing), target.countries)) {
      throw new Error(`${target.name} already exists but does not exactly match the requested active country group; refusing to overwrite it.`);
    }
    console.log(`${target.name}: already active with the correct countries.`);
    continue;
  }

  const result = executeGraphql(
    createMarketMutation,
    {
      input: {
        name: target.name,
        handle: target.handle,
        status: 'ACTIVE',
        conditions: {
          regionsCondition: {
            regions: target.countries.map((countryCode) => ({ countryCode })),
          },
        },
        currencySettings: target.currencySettings,
      },
    },
    true,
  ).marketCreate;
  if (result.userErrors.length) throw new Error(`${target.name}: ${JSON.stringify(result.userErrors, null, 2)}`);
  existingHandles.set(target.handle, { ...result.market, conditions: { regionsCondition: { regions: { nodes: target.countries.map((code) => ({ code })) } } } });
  console.log(`${target.name}: created and activated.`);
}

const afterMarkets = executeGraphql(marketsQuery);
const usMarket = afterMarkets.markets.nodes.find(({ handle }) => handle === 'us');
if (!usMarket) throw new Error('United States market was not found after creation.');
let usCatalog = afterMarkets.catalogs.nodes.find((catalog) => catalog.markets?.nodes?.some(({ id }) => id === usMarket.id));
if (!usCatalog) {
  const result = executeGraphql(
    createCatalogMutation,
    {
      input: {
        title: 'TSSC — United States pricing',
        status: 'ACTIVE',
        context: { marketIds: [usMarket.id] },
      },
    },
    true,
  ).catalogCreate;
  if (result.userErrors.length) throw new Error(`United States catalog: ${JSON.stringify(result.userErrors, null, 2)}`);
  usCatalog = { ...result.catalog, priceList: null, markets: { nodes: [usMarket] } };
  console.log('United States pricing-only catalog: created and activated.');
}

if (usCatalog.priceList) {
  const adjustment = usCatalog.priceList.parent?.adjustment;
  if (usCatalog.priceList.currency !== 'USD' || adjustment?.type !== 'PERCENTAGE_INCREASE' || Number(adjustment?.value) !== 25) {
    throw new Error('The United States market already has a different price list; refusing to overwrite it.');
  }
  console.log('United States pricing: existing +25% USD market adjustment retained.');
} else {
  const result = executeGraphql(
    createPriceListMutation,
    {
      input: {
        name: 'TSSC — United States +25%',
        currency: 'USD',
        catalogId: usCatalog.id,
        parent: { adjustment: { type: 'PERCENTAGE_INCREASE', value: 25 } },
      },
    },
    true,
  ).priceListCreate;
  if (result.userErrors.length) throw new Error(`United States price list: ${JSON.stringify(result.userErrors, null, 2)}`);
  console.log('United States pricing: +25% adjustment activated in USD.');
}

const verified = executeGraphql(marketsQuery);
for (const target of TARGETS) {
  const market = verified.markets.nodes.find(({ handle }) => handle === target.handle);
  if (!market || market.status !== 'ACTIVE' || !sameSet(countryCodes(market), target.countries)) {
    throw new Error(`${target.name}: final verification failed.`);
  }
}
const verifiedUs = verified.markets.nodes.find(({ handle }) => handle === 'us');
const verifiedUsCatalog = verified.catalogs.nodes.find((catalog) => catalog.markets?.nodes?.some(({ id }) => id === verifiedUs.id));
const verifiedAdjustment = verifiedUsCatalog?.priceList?.parent?.adjustment;
if (verifiedUsCatalog?.priceList?.currency !== 'USD' || verifiedAdjustment?.type !== 'PERCENTAGE_INCREASE' || Number(verifiedAdjustment.value) !== 25) {
  throw new Error('United States price adjustment verification failed.');
}

console.log(`Verified ${TARGETS.length} international markets and ${TARGETS.reduce((sum, target) => sum + target.countries.length, 0)} countries/regions.`);
console.log('Market setup and international pricing activated.');
