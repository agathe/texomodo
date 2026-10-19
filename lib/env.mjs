/**
 * Environment for a project: the real process environment wins, then the
 * project's .env file fills in the rest. Never logs values.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(root) {
  const out = { ...process.env };
  const file = join(root, '.env');
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) out[key] = val;
  }
  return out;
}

/** Role claim of a legacy JWT key, or null for new-style sb_publishable_/sb_secret_ keys. */
export function jwtRole(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).role || null;
  } catch {
    return null;
  }
}

export function isSecretKey(key) {
  return !!key && (jwtRole(key) === 'service_role' || /^sb_secret_/.test(key));
}

export const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
