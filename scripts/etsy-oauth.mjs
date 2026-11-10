#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';

const envPath = new URL('../.env.etsy.local', import.meta.url);

function parseEnv(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function upsertEnv(contents, updates) {
  const pending = new Map(Object.entries(updates));
  const lines = contents.split(/\r?\n/).map((line) => {
    const separator = line.indexOf('=');
    if (separator === -1) return line;
    const key = line.slice(0, separator).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`;
}

function base64url(buffer) {
  return buffer.toString('base64url');
}

if (!fs.existsSync(envPath)) {
  throw new Error(`Missing credentials file: ${envPath.pathname}`);
}

const originalEnv = fs.readFileSync(envPath, 'utf8');
const env = parseEnv(originalEnv);
const required = ['ETSY_KEYSTRING', 'ETSY_SHARED_SECRET', 'ETSY_REDIRECT_URI'];
const missing = required.filter((key) => !env[key]);
if (missing.length) throw new Error(`Missing required values: ${missing.join(', ')}`);

const redirect = new URL(env.ETSY_REDIRECT_URI);
if (redirect.hostname !== 'localhost') {
  throw new Error('For this local flow, ETSY_REDIRECT_URI must use localhost.');
}

const verifier = base64url(crypto.randomBytes(48));
const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
const state = base64url(crypto.randomBytes(32));
const scopes = ['listings_r', 'listings_w', 'listings_d', 'shops_r', 'shops_w'];

const authorizeUrl = new URL('https://www.etsy.com/oauth/connect');
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', env.ETSY_KEYSTRING);
authorizeUrl.searchParams.set('redirect_uri', env.ETSY_REDIRECT_URI);
authorizeUrl.searchParams.set('scope', scopes.join(' '));
authorizeUrl.searchParams.set('state', state);
authorizeUrl.searchParams.set('code_challenge', challenge);
authorizeUrl.searchParams.set('code_challenge_method', 'S256');

const server = http.createServer(async (request, response) => {
  const incoming = new URL(request.url ?? '/', env.ETSY_REDIRECT_URI);
  if (incoming.pathname !== redirect.pathname) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    if (incoming.searchParams.get('state') !== state) {
      throw new Error('OAuth state mismatch. Authorization stopped for safety.');
    }
    const error = incoming.searchParams.get('error');
    if (error) {
      throw new Error(incoming.searchParams.get('error_description') || error);
    }
    const code = incoming.searchParams.get('code');
    if (!code) throw new Error('Etsy did not return an authorization code.');

    const tokenResponse = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.ETSY_KEYSTRING,
        redirect_uri: env.ETSY_REDIRECT_URI,
        code,
        code_verifier: verifier,
      }),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(token.error_description || token.error || `Token exchange failed (${tokenResponse.status})`);
    }

    const updatedEnv = upsertEnv(originalEnv, {
      ETSY_ACCESS_TOKEN: token.access_token,
      ETSY_REFRESH_TOKEN: token.refresh_token,
      ETSY_TOKEN_SCOPE: token.scope || scopes.join(' '),
    });
    fs.writeFileSync(envPath, updatedEnv, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<h1>Etsy authorization complete</h1><p>You can close this tab and return to Codex.</p>');
    process.stdout.write('\nAuthorization complete. Tokens saved securely.\n');
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`Authorization failed: ${error.message}`);
    process.stderr.write(`\nAuthorization failed: ${error.message}\n`);
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  process.stdout.write('Open this URL in your browser and approve access:\n\n');
  process.stdout.write(`${authorizeUrl.toString()}\n`);
});
