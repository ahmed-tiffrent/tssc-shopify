#!/usr/bin/env node

/**
 * One-time Google Merchant API developer registration.
 * This links the configured Google Cloud project to the Merchant account and
 * registers the supplied regular Google-account email as technical contact.
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const accountId = process.env.GOOGLE_MERCHANT_ACCOUNT_ID;
const developerEmail = process.env.GOOGLE_MERCHANT_DEVELOPER_EMAIL;

if (!credentialsPath || !accountId || !developerEmail) {
  throw new Error(
    'Set GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_MERCHANT_ACCOUNT_ID, and GOOGLE_MERCHANT_DEVELOPER_EMAIL.',
  );
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

const token = await getAccessToken();
const response = await fetch(
  `https://merchantapi.googleapis.com/accounts/v1/accounts/${encodeURIComponent(accountId)}/developerRegistration:registerGcp`,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ developerEmail }),
  },
);
const body = await response.json();
if (!response.ok) {
  throw new Error(`Merchant API ${response.status}: ${JSON.stringify(body)}`);
}

console.log(JSON.stringify({
  registered: true,
  account: `accounts/${accountId}`,
  developerEmail,
  registration: body,
}, null, 2));
