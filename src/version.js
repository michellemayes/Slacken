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

// Numeric where both sides are numeric, so 0.10.0 is newer than 0.9.0.
export function compareVersions(a, b) {
  const left = String(a).split(/[.-]/);
  const right = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = Number(left[i] ?? 0);
    const y = Number(right[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const cmp = String(left[i] ?? '').localeCompare(String(right[i] ?? ''));
      if (cmp) return cmp;
      continue;
    }
    if (x !== y) return x - y;
  }
  return 0;
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
