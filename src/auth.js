import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './config.js';

export const TOKEN_PATH = path.join(HOME_DIR, 'token');

/*
 * A shared secret for the control API.
 *
 * The API listens on loopback, which keeps it away from the network and does
 * nothing about the machine it is running on: every process you run, and
 * everything they run, can reach 127.0.0.1. The endpoints behind it can change
 * what you read, take a channel off the ignore list, stop the daemon, and —
 * through /moderate — spend your Claude account on any text at all. None of
 * that should be available to anything that merely happens to be running as
 * you.
 *
 * So the daemon writes a token to a file only you can read, and everything
 * that talks to it reads the same file: the CLI because it runs as you, the
 * menu bar helper because the daemon hands it the token in its environment
 * rather than on a command line, where `ps` would show it.
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
  // Written 0600 from the start rather than chmod'd afterwards: a token that
  // is world-readable for a millisecond is a token that was world-readable.
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // A filesystem without permissions (a mounted volume, Windows) cannot be
    // made to keep this secret; the token is still a token.
  }
  return token;
}

// Constant-time, so a wrong token cannot be guessed a character at a time.
export function tokenMatches(expected, given) {
  if (!expected) return true;
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

// `Authorization: Bearer <token>`, or the query string for the one client that
// cannot set a header — nothing does today, and it is not offered.
export function tokenFrom(req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}
