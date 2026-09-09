/*
 * What can be changed while Slacken is running, and what a valid value for it
 * looks like.
 *
 * This is the one description of the adjustable surface. The menu bar builds
 * its settings menu from it, the control API validates against it, and
 * `slacken set` uses it too, so a setting cannot exist in one of those and not
 * the others, and cannot mean something different in each.
 *
 * Everything here takes effect on the running daemon. Settings that would need
 * Slack relaunched or the daemon restarted — the debug port, the HTTP port,
 * the target URL pattern — are deliberately absent: they belong in the config
 * file, where changing one is already a restart.
 */

// `short` is what the menu shows without opening the submenu, so a setting's
// current value is readable at a glance and the full wording still explains it
// inside.
const CHOICE = (value, label, short) => ({ value, label, short: short ?? label });

export const SETTINGS = {
  /* ------------------------------------------------------- what to rewrite */

  triageMode: {
    type: 'enum',
    label: 'Look at',
    choices: [
      CHOICE('heuristic', 'Only messages that look heated or padded', 'flagged only'),
      CHOICE('always', 'Every message', 'everything'),
    ],
  },

  triageThreshold: {
    type: 'int',
    min: 1,
    max: 6,
    label: 'Sensitivity',
    choices: [
      CHOICE(1, 'Most sensitive — a hint of heat is enough'),
      CHOICE(2, 'Balanced'),
      CHOICE(3, 'Less sensitive'),
      CHOICE(4, 'Least sensitive — only the worst of it'),
    ].map((c) => ({ ...c, short: c.label.split(' — ')[0].toLowerCase() })),
  },

  minSeverity: {
    type: 'int',
    min: 0,
    max: 3,
    label: 'Soften when it is',
    choices: [
      CHOICE(1, 'Slightly sharp'),
      CHOICE(2, 'Clearly harsh'),
      CHOICE(3, 'Hostile'),
    ].map((c) => ({ ...c, short: c.label.toLowerCase() })),
    invalidatesCache: true,
  },

  condenseEnabled: {
    type: 'boolean',
    label: 'Condense padded messages',
    invalidatesCache: true,
  },

  condenseMinWords: {
    type: 'int',
    min: 10,
    max: 500,
    label: 'Condense messages over',
    choices: [25, 35, 45, 60, 90].map((n) => CHOICE(n, `${n} words`)),
    invalidatesCache: true,
  },

  maxChars: {
    type: 'int',
    min: 200,
    max: 20000,
    label: 'Leave messages longer than',
    choices: [2000, 4000, 8000].map((n) => CHOICE(n, `${n} characters`)),
  },

  /* -------------------------------------------------------- what it costs */

  model: {
    type: 'string',
    label: 'Model',
    choices: [
      CHOICE('claude-haiku-4-5-20251001', 'Haiku 4.5 — cheapest and fastest', 'Haiku 4.5'),
      CHOICE('claude-sonnet-5', 'Sonnet 5 — better judgement, slower', 'Sonnet 5'),
      CHOICE('claude-opus-5', 'Opus 5 — best judgement, priciest', 'Opus 5'),
    ],
  },

  dailyBudgetUsd: {
    type: 'number',
    min: 0,
    max: 1000,
    label: 'Daily budget',
    choices: [
      CHOICE(0, 'No cap'),
      CHOICE(0.25, '$0.25 a day', '$0.25'),
      CHOICE(0.5, '$0.50 a day', '$0.50'),
      CHOICE(1, '$1.00 a day', '$1.00'),
      CHOICE(5, '$5.00 a day', '$5.00'),
    ],
  },

  /* ------------------------------------------------------------- behaviour */

  holdWhilePending: {
    type: 'boolean',
    label: 'Hide a message while it is being checked',
  },

  persistVerdicts: {
    type: 'boolean',
    label: 'Remember rewrites across reloads',
  },

  verbose: {
    type: 'boolean',
    label: 'Log every verdict',
  },

  /* ---------------------------------------------------------- who to skip */

  ignoreChannels: {
    type: 'stringList',
    label: 'Ignored channels',
    empty: 'No channels ignored',
  },

  ignoreSenders: {
    type: 'stringList',
    label: 'Ignored people',
    empty: 'Nobody ignored',
  },

  selfNames: {
    type: 'stringList',
    label: 'Your own names',
    empty: 'Detected from Slack',
  },
};

// A rewrite is cached under the text that produced it, already judged against
// the thresholds in force at the time. Changing one of those thresholds makes
// every cached verdict an answer to a question nobody is asking any more.
export function invalidatesCache(keys) {
  return keys.some((key) => SETTINGS[key]?.invalidatesCache);
}

const TRUE = new Set(['true', 'on', 'yes', '1']);
const FALSE = new Set(['false', 'off', 'no', '0']);
const MAX_LIST = 200;
const MAX_ENTRY = 200;

/*
 * Values arrive from a menu click, an HTTP client or a shell argument, so they
 * arrive as anything at all. A rejected value leaves the config untouched and
 * says why; nothing here ever coerces a value it does not understand into one
 * it does, because a setting that quietly became something else is worse than
 * one that refused to change.
 */
export function coerce(key, raw) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`${key} cannot be changed while Slacken runs; edit the config file`);

  switch (spec.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).trim().toLowerCase();
      if (TRUE.has(text)) return true;
      if (FALSE.has(text)) return false;
      throw new Error(`${key} is on or off, not ${JSON.stringify(raw)}`);
    }

    case 'enum': {
      const text = String(raw).trim();
      const match = spec.choices.find((c) => c.value === text);
      if (!match) {
        throw new Error(`${key} is one of ${spec.choices.map((c) => c.value).join(', ')}`);
      }
      return match.value;
    }

    case 'int':
    case 'number': {
      const n = spec.type === 'int' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
      if (!Number.isFinite(n)) throw new Error(`${key} is a number, not ${JSON.stringify(raw)}`);
      if (n < spec.min || n > spec.max) {
        throw new Error(`${key} is between ${spec.min} and ${spec.max}`);
      }
      return n;
    }

    case 'string': {
      const text = String(raw).trim();
      if (!text) throw new Error(`${key} cannot be empty`);
      if (text.length > MAX_ENTRY) throw new Error(`${key} is too long`);
      return text;
    }

    case 'stringList': {
      // A comma-separated string is what a shell hands over; an array is what
      // the menu and the API send.
      const parts = Array.isArray(raw) ? raw : String(raw).split(',');
      const out = [];
      const seen = new Set();
      for (const part of parts) {
        const text = String(part).trim();
        if (!text) continue;
        if (text.length > MAX_ENTRY) throw new Error(`${key} has an entry that is too long`);
        const fold = text.toLowerCase();
        if (seen.has(fold)) continue;
        seen.add(fold);
        out.push(text);
      }
      if (out.length > MAX_LIST) throw new Error(`${key} holds at most ${MAX_LIST} entries`);
      return out;
    }

    default:
      throw new Error(`${key} has no known type`);
  }
}

// Validates a whole patch before any of it is applied, so a request with one
// bad value in it does not leave half a change behind.
export function coerceAll(patch) {
  const values = {};
  const errors = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    try {
      values[key] = coerce(key, raw);
    } catch (err) {
      errors.push({ key, message: err.message });
    }
  }
  return { values, errors };
}

// Case-insensitive, because "#Eng-Oncall" and "#eng-oncall" are one channel.
export function inList(list, value) {
  if (!value) return false;
  const needle = String(value).trim().toLowerCase();
  return (list || []).some((entry) => String(entry).trim().toLowerCase() === needle);
}

export function withEntry(list, value, present) {
  const text = String(value ?? '').trim();
  if (!text) return [...(list || [])];
  const kept = (list || []).filter((entry) => String(entry).trim().toLowerCase() !== text.toLowerCase());
  return present ? [...kept, text] : kept;
}
