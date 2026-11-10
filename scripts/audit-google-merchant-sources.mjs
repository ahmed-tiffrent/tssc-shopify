#!/usr/bin/env node

/**
 * Read-only Google Merchant API audit.
 *
 * Required environment variables:
 *   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
 *   GOOGLE_MERCHANT_ACCOUNT_ID=123456789
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const accountId = process.env.GOOGLE_MERCHANT_ACCOUNT_ID;

if (!credentialsPath || !accountId) {
  throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_MERCHANT_ACCOUNT_ID.');
}

const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));

function encode(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    .toString('base64url');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/content',
    aud: credentials.token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.private_key, 'base64url')}`;

  const response = await fetch(credentials.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`OAuth ${response.status}: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function merchantGet(token, path) {
  const response = await fetch(`https://merchantapi.googleapis.com/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Merchant API ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const token = await getAccessToken();
const dataSources = await merchantGet(
  token,
  `datasources/v1/accounts/${encodeURIComponent(accountId)}/dataSources?pageSize=1000`,
);
if (process.env.GOOGLE_MERCHANT_SOURCES_ONLY === '1') {
  console.log(JSON.stringify({
    account: `accounts/${accountId}`,
    authenticatedAs: credentials.client_email,
    dataSources: dataSources.dataSources || [],
  }, null, 2));
  process.exit(0);
}
const products = [];
let pageToken = '';
do {
  const query = new URLSearchParams({ pageSize: '1000' });
  if (pageToken) query.set('pageToken', pageToken);
  const page = await merchantGet(
    token,
    `products/v1/accounts/${encodeURIComponent(accountId)}/products?${query}`,
  );
  products.push(...(page.products || []));
  pageToken = page.nextPageToken || '';
  process.stderr.write(`\rRead ${products.length} Merchant products`);
} while (pageToken);
process.stderr.write('\n');

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = String(keyFn(item));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function destinationState(product) {
  const countries = product.productStatus?.destinationStatuses || [];
  if (countries.some((item) => item.approvedCountries?.length)) return 'approved';
  if (countries.some((item) => item.disapprovedCountries?.length)) return 'disapproved';
  if (countries.some((item) => item.pendingCountries?.length)) return 'pending';
  return 'unknown';
}

const sanitized = (dataSources.dataSources || []).map((source) => ({
  name: source.name,
  dataSourceId: source.dataSourceId,
  displayName: source.displayName,
  input: source.input,
  primaryProductDataSource: source.primaryProductDataSource,
  supplementalProductDataSource: source.supplementalProductDataSource,
  localInventoryDataSource: source.localInventoryDataSource,
  regionalInventoryDataSource: source.regionalInventoryDataSource,
}));

console.log(JSON.stringify({
  account: `accounts/${accountId}`,
  authenticatedAs: credentials.client_email,
  dataSourceCount: sanitized.length,
  dataSources: sanitized,
  catalogSummary: {
    total: products.length,
    byDataSource: countBy(products, (product) => product.dataSource || '(missing)'),
    byFeedLabel: countBy(products, (product) => product.feedLabel || '(missing)'),
    byDestinationState: countBy(products, destinationState),
    missingShippingWeight: products.filter((product) => !product.productAttributes?.shippingWeight).length,
    missingShippingWeightByFeedLabel: countBy(
      products.filter((product) => !product.productAttributes?.shippingWeight),
      (product) => product.feedLabel || '(missing)',
    ),
    issueCodes: countBy(
      products.flatMap((product) => product.productStatus?.itemLevelIssues || []),
      (issue) => issue.code || '(missing)',
    ),
  },
  productSample: products.slice(0, 10).map((product) => ({
    name: product.name,
    channel: product.channel,
    offerId: product.offerId,
    contentLanguage: product.contentLanguage,
    feedLabel: product.feedLabel,
    dataSource: product.dataSource,
    title: product.productAttributes?.title,
    shippingWeight: product.productAttributes?.shippingWeight,
    targetCountries: product.productAttributes?.shipping?.map((item) => item.country),
    destinations: product.productStatus?.destinationStatuses,
    itemLevelIssues: product.productStatus?.itemLevelIssues?.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      resolution: issue.resolution,
      reportingContext: issue.reportingContext,
      countries: issue.applicableCountries,
    })),
  })),
}, null, 2));
