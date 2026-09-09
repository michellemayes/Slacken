import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_PATH = path.join(HERE, '..', 'package.json');
const STAMP_PATH = path.join(HOME_DIR, 'update.json');
const RELEASES_URL = 'https://api.github.com/repos/michellemayes/Slacken/releases/latest';
const DAY_MS = 24 * 3600 * 1000;

export const VERSION = readVersion();

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/*
 * Is there a newer Slacken?
 *
 * Off unless `checkUpdates` is on, and worth being deliberate about: this is
 * the only thing in Slacken that opens a connection to anything but your own
 * machine. It sends nothing but the request itself, asks at most once a day
 * (the answer is stamped in ~/.slacken/update.json so a daemon restarted
 * twenty times does not ask twenty times), and nothing waits on it — a
 * check that fails is a check that did not happen.
 */
export async function checkForUpdate(config, { now = Date.now(), force = false } = {}) {
  if (!force && !config?.checkUpdates) return null;

  const stamp = readStamp();
  if (!force && stamp && now - stamp.at < DAY_MS) return decorate(stamp.latest, stamp.url);

  let latest;
  let url = 'https://github.com/michellemayes/Slacken/releases';
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `slacken/${VERSION}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    latest = String(body.tag_name || '').replace(/^v/, '');
    if (body.html_url) url = body.html_url;
  } catch {
    return null;
  }
  if (!latest) return null;

  writeStamp({ at: now, latest, url });
  return decorate(latest, url);
}

function decorate(latest, url) {
  if (!latest) return null;
  return { current: VERSION, latest, url, newer: compareVersions(latest, VERSION) > 0 };
}

/*
 * Newer, older or the same.
 *
 * Numeric where both sides are numeric, so 0.10.0 is newer than 0.9.0 rather
 * than alphabetically before it. A tag with a suffix — 0.3.0-rc1 — is a
 * release on its way rather than one that has arrived, so it ranks below the
 * plain version it is a candidate for, which is the one rule here that a
 * string comparison would get backwards.
 */
export function compareVersions(a, b) {
  const left = String(a).split(/[.-]/);
  const right = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return isNumeric(r) ? -1 : 1;
    if (r === undefined) return isNumeric(l) ? 1 : -1;
    if (isNumeric(l) && isNumeric(r)) {
      if (Number(l) !== Number(r)) return Number(l) - Number(r);
      continue;
    }
    const cmp = String(l).localeCompare(String(r));
    if (cmp) return cmp;
  }
  return 0;
}

function isNumeric(part) {
  return part !== undefined && part !== '' && !Number.isNaN(Number(part));
}

function readStamp() {
  try {
    const raw = JSON.parse(fs.readFileSync(STAMP_PATH, 'utf8'));
    return Number.isFinite(raw.at) ? raw : null;
  } catch {
    return null;
  }
}

function writeStamp(stamp) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(STAMP_PATH, JSON.stringify(stamp) + '\n');
  } catch {
    // Not being able to remember when we last asked is not worth a word to
    // anyone; the worst case is asking again next time.
  }
}
