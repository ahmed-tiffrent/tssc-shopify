#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.etsy.local');
const workerDir = path.join(root, 'punchinella-stock-worker');

const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));

if (!env.ETSY_REFRESH_TOKEN) throw new Error('Missing ETSY_REFRESH_TOKEN in .env.etsy.local');
const escapedToken = env.ETSY_REFRESH_TOKEN.replaceAll("'", "''");
const updatedAt = new Date().toISOString();
const sql = `INSERT INTO settings (key, value) VALUES ('etsy_refresh_token', '${escapedToken}')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  INSERT INTO settings (key, value) VALUES ('etsy_refresh_token_updated_at', '${updatedAt}')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;`;

const result = spawnSync('npx', [
  'wrangler', 'd1', 'execute', 'tssc-punchinella-stock-db', '--remote', '--command', sql,
], { cwd: workerDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Wrangler exited with ${result.status}`);
process.stdout.write('The current Etsy refresh token is stored in the live synchronisation worker.\n');
