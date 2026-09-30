import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './config.js';

export const TOKEN_PATH = path.join(HOME_DIR, 'token');

/*
 * A shared secret for the control API. Loopback keeps the API off the network
 * but not away from every other process running as you, and its endpoints can
 * change what you read and spend your Claude account. The daemon writes the
 * token to a 0600 file; the CLI reads it, and the menu bar helper gets it in
 * its environment (not argv, where `ps` would show it).
 */
export function readToken(file = TOKEN_PATH) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

export function loadToken(file = TOKEN_PATH) {
  const existing = readToken(file);
  if (existing) return existing;

  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Created 0600 rather than chmod'd afterwards, so it is never readable by others.
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // A filesystem without permissions (a mounted volume, Windows).
  }
  return token;
}

// Constant-time comparison.
export function tokenMatches(expected, given) {
  if (!expected) return true;
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

// `Authorization: Bearer <token>`; no other form is accepted.
export function tokenFrom(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}
