/*
 * Slacken page script.
 *
 * Runs inside the Slack renderer. It finds rendered messages from other
 * people, triages them locally, asks the daemon (over a CDP binding, so no
 * network request is made from the page and Slack's CSP is irrelevant) for a
 * neutral rewrite, and swaps the rewrite in with a badge that flips back to
 * the original text.
 *
 * The original DOM is never destroyed. It is hidden and revealed again on
 * click.
 *
 * Two rules keep the swap from flickering, and both matter more than they
 * look:
 *
 *   1. The hold is a CSS rule rooted at the list item, not an attribute on
 *      the message body. Slack re-renders the body constantly — hover,
 *      reactions, read receipts, virtual-list recycling — and anything we
 *      write onto the body dies with it. The list item survives, so a body
 *      React has just re-created is already hidden by the cascade the moment
 *      it lands. No JavaScript runs, so there is no window to see through.
 *
 *   2. Reconciliation is synchronous inside the MutationObserver callback,
 *      which the browser runs before it paints. Repairing on a timer, however
 *      short, guarantees the original gets at least one frame on screen.
 *
 * Everything else here follows from those two: the DOM is reconciled, never
 * rebuilt, so a repair mutates text in place instead of tearing a panel down
 * and putting a new one up.
 */
(() => {
  if (window.__SLACKEN__) return;
  window.__SLACKEN__ = true;

  const CONFIG = Object.assign({
    triageMode: 'heuristic',
    triageThreshold: 2,
    condenseEnabled: true,
    condenseMinWords: 45,
    maxChars: 4000,
    minSeverity: 2,
    condenseMaxRatio: 0.7,
    channelOverrides: {},
    rewriteNotifications: true,
    draftCheck: false,
    holdWhilePending: true,
    persistVerdicts: true,
    paused: false,
    selfNames: [],
    ignoreSenders: [],
    ignoreChannels: [],
    requestTimeoutMs: 25000,
    verbose: false,
  }, window.__SLACKEN_CONFIG || {});

  const ASK = '__slackenAsk';
  // On the list item: what we decided, and the content we decided it about.
  const ATTR_STATE = 'data-slacken';
  const ATTR_HASH = 'data-slacken-hash';
  // On the list item: '1' original hidden, '0' original revealed by the reader.
  const ATTR_HOLD = 'data-slacken-hold';
  // On the body, for older layouts the class-based hold rules do not reach.
  const ATTR_BODY = 'data-slacken-body';
  const OUR_ATTRS = new Set([ATTR_STATE, ATTR_HASH, ATTR_HOLD, ATTR_BODY]);

  // How long a hold stays silent before it admits to waiting. Under this, a
  // cache hit lands first and the reader never sees a placeholder at all.
  const PENDING_LABEL_MS = 140;
  // Off-screen messages cost a model call for nothing, so they wait. Generous,
  // because the margin is what buys a scroll its head start.
  const VIEWPORT_MARGIN_PX = 800;
  const SWEEP_MS = 2000;
  const STORE_KEY = 'slacken:verdicts:v1';
  const STORE_MAX = 400;
  const STORE_TTL_MS = 24 * 3600 * 1000;
  const MEMORY_MAX = 1500;

  const SEL = {
    item: '[data-qa="virtual-list-item"]',
    content: '[data-qa="message_content"]',
    blocks: '.c-message_kit__blocks, .c-message__message_blocks',
    rich: '.p-rich_text_section',
    sender: '[data-qa="message_sender_name"]',
    // A reply broadcast back into the channel carries a "replied to a thread:"
    // line quoting the message it answers. That preview is Slack's chrome and
    // a copy of someone else's words, so it is neither what we read for triage
    // nor what a rewrite may stand in for.
    preamble: '[data-qa="message_broadcast_preamble"], .c-message__broadcast_preamble_container,'
      + ' .c-message__broadcast_preamble, .c-message__broadcast_preamble_link',
    channel: '[data-qa="channel_name"]',
    self: '[data-qa="user-button"]',
    composer: '[data-qa="message_input"], .ql-editor',
    // The columns a message list can live in. A thread open beside a channel
    // is two conversations on one screen, and they are not the same channel.
    surface: [
      '[data-qa="threads_flexpane"]',
      '[data-qa="thread_view"]',
      '[data-qa="slack_kit_scrollbar"][data-qa-thread]',
      '.p-flexpane',
      '.p-threads_flexpane',
      '[data-qa="channel_view"]',
      '.p-workspace__primary_view',
      '.p-view_contents',
    ].join(', '),
    // What a surface calls itself, in the order the client has used over time.
    surfaceChannel: '[data-qa="channel_name"], [data-qa="thread_channel_name"], .p-view_header__channel_title',
    primary: '.p-workspace__primary_view, [data-qa="channel_view"]',
    // Where the channel-ignore button goes. Slack has moved this header
    // around between versions, so the first ancestor that matches wins and
    // the channel name's own parent is the fallback.
    header: '[data-qa="channel_header"], .p-view_header__text_container, .p-view_header',
  };

  const log = (...args) => { if (CONFIG.verbose) console.log('[slacken]', ...args); };

  /* ------------------------------------------------------- per channel */

  /*
   * A channel can be told to behave differently, and the page has to agree
   * with the daemon about which channel that is — otherwise a message would
   * be triaged under one set of rules and judged under another.
   *
   * The lookup folds case and a leading #, the way the daemon's does, so
   * "#Eng-Oncall" and "eng-oncall" are one channel here too.
   */
  const CHANNEL_KEYS = [
    'triageMode', 'triageThreshold', 'minSeverity',
    'condenseEnabled', 'condenseMinWords', 'maxChars',
  ];

  function channelFold(name) {
    return String(name ?? '').trim().replace(/^#/, '').toLowerCase();
  }

  const settingsCache = new Map();
  function settingsFor(channel) {
    const fold = channelFold(channel);
    if (!fold) return CONFIG;
    if (settingsCache.has(fold)) return settingsCache.get(fold);

    let resolved = CONFIG;
    const overrides = CONFIG.channelOverrides || {};
    for (const [name, patch] of Object.entries(overrides)) {
      if (channelFold(name) !== fold || !patch || typeof patch !== 'object') continue;
      resolved = { ...CONFIG };
      for (const key of CHANNEL_KEYS) if (patch[key] !== undefined) resolved[key] = patch[key];
      break;
    }
    settingsCache.set(fold, resolved);
    return resolved;
  }

  // What a remembered verdict is an answer to. The same words under a
  // different threshold are a different answer, so they are a different key —
  // which is also why a stored verdict cannot leak from a channel with its own
  // settings into one without.
  function gateFor(channel) {
    const c = settingsFor(channel);
    return `${c.minSeverity}:${c.condenseEnabled ? 1 : 0}:${c.condenseMinWords}:${c.condenseMaxRatio}:${c.maxChars}`;
  }

  // Set from the daemon, which owns the pause state. While paused nothing is
  // asked about and nothing stays hidden: you read exactly what was written.
  let paused = Boolean(CONFIG.paused);

  /* ---------------------------------------------------------------- styles */

  const STYLE_ID = 'slacken-style';
  const CSS = `
    /* The hold hangs off the list item so that a message body Slack re-renders
       arrives already hidden, rather than flashing until we notice. */
    [${ATTR_HOLD}="1"] .c-message_kit__blocks,
    [${ATTR_HOLD}="1"] .c-message__message_blocks,
    [${ATTR_HOLD}="1"] [${ATTR_BODY}] { display: none !important; }

    /* A column, so the badge is a block-level box with predictable margins
       rather than an inline one whose baseline drags phantom descender space
       under it. */
    .slacken-panel {
      display: flex; flex-direction: column; align-items: flex-start;
      margin: 2px 0 0;
    }
    .slacken-rewrite {
      line-height: 1.46668;
      font-size: 15px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .slacken-panel[data-open="1"] .slacken-rewrite { display: none; }
    /* Deliberately not a chip. Slack stacks its own bordered boxes directly
       under a message — reaction pills 4px below, and a thread bar whose
       hover box is pulled up over whatever precedes it — so a bordered badge
       either reads as one more reaction or gets crossed by the thread bar's
       outline. A dot and two words collide with neither, and the hover fill
       hangs 6px left the way Slack's own hover boxes do, which keeps the
       label itself flush with the message text above it. */
    .slacken-badge {
      display: inline-flex; align-items: center; gap: 5px;
      box-sizing: border-box; max-width: 100%;
      margin: 4px 0 6px -6px; padding: 1px 6px;
      font-size: 11px; line-height: 16px; font-weight: 500;
      color: inherit; opacity: .62;
      background: transparent; border: 0; border-radius: 7px;
      cursor: pointer; user-select: none;
    }
    .slacken-badge:hover { opacity: 1; background: rgba(127,127,127,.13); }
    .slacken-badge[hidden] { display: none; }
    .slacken-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #d9a441; flex: 0 0 auto;
    }
    .slacken-badge[data-severity="3"] .slacken-dot { background: #e01e5a; }

    /* The draft bar. Above the composer rather than inside it, so nothing here
       is ever part of what you are about to send. */
    .slacken-draft {
      margin: 0 0 6px; padding: 8px 10px;
      border: 1px solid rgba(127,127,127,.28); border-radius: 8px;
      background: rgba(127,127,127,.06);
      font-size: 13px; line-height: 1.4;
    }
    .slacken-draft-head { opacity: .7; font-size: 11px; margin-bottom: 4px; }
    .slacken-draft-text { white-space: pre-wrap; word-break: break-word; }
    .slacken-draft-actions { display: flex; gap: 8px; margin-top: 8px; }
    .slacken-draft-button {
      font: inherit; font-size: 12px; padding: 3px 10px;
      border: 1px solid rgba(127,127,127,.35); border-radius: 6px;
      background: transparent; color: inherit; cursor: pointer;
    }
    .slacken-draft-button:hover { background: rgba(127,127,127,.14); }
    .slacken-draft-quiet { border-color: transparent; opacity: .7; }
    .slacken-badge[data-kind="condensed"] .slacken-dot { background: #5b8def; }
    .slacken-action { opacity: .75; }
    .slacken-pending { opacity: .45; font-style: italic; }

    /* The header button. Same dot, size and weight as the badge, so the two
       read as parts of one thing — but bordered, which the badge deliberately
       is not. The badge sits where Slack stacks reaction pills and thread
       bars, and a border there reads as one of them; the header has no such
       boxes, and without one this would read as a second line of header text
       rather than as something you can press. */
    .slacken-channel {
      display: inline-flex; align-items: center; gap: 5px;
      margin: 0 0 0 8px; padding: 1px 8px; vertical-align: middle;
      font-size: 11px; line-height: 16px; font-weight: 500;
      color: inherit; opacity: .62;
      background: transparent;
      border: 1px solid rgba(127,127,127,.35); border-radius: 7px;
      cursor: pointer; user-select: none;
    }
    .slacken-channel:hover {
      opacity: 1;
      background: rgba(127,127,127,.13);
      border-color: rgba(127,127,127,.6);
    }
    .slacken-channel[data-ignored="1"] .slacken-dot { background: #8d8d8d; }
    .slacken-channel[data-busy="1"] { opacity: .35; pointer-events: none; }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------- transport */

  let seq = 0;
  const pending = new Map();

  window.__slackenResult = (json) => {
    let msg;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  };

  function ask(payload) {
    if (typeof window[ASK] !== 'function') {
      return Promise.reject(new Error('binding missing'));
    }
    const id = `r${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('timeout'));
      }, CONFIG.requestTimeoutMs + 2000);
      pending.set(id, { resolve, reject, timer });
      try {
        window[ASK](JSON.stringify({ id, ...payload }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  /* -------------------------------------------------------------- triage */

  const ACRONYMS = new Set([
    'OK', 'PR', 'PRS', 'CI', 'CD', 'QA', 'API', 'EOD', 'ETA', 'FYI', 'PTO', 'WFH',
    'LGTM', 'TLDR', 'SLA', 'UTC', 'EST', 'PST', 'AM', 'PM', 'US', 'UK', 'EU', 'ID',
    'URL', 'HTTP', 'HTTPS', 'JSON', 'YAML', 'SQL', 'AWS', 'GCP', 'UI', 'UX', 'MVP',
    'KPI', 'OOO', 'RFC', 'PTAL', 'IMO', 'IIRC', 'TIL', 'CTA', 'CSV', 'PDF', 'DM',
    'DNS', 'SSH', 'SDK', 'CLI', 'IDE', 'OS', 'RAM', 'CPU', 'GPU', 'DB',
  ]);

  const URGENT_RE = /\b(asap|urgent(ly)?|immediately|right now|drop everything|top priority|highest priority|blocker|emergency|need this now|by eod|end of day|last chance|final (warning|reminder)|can'?t wait|no later than)\b/i;
  const BLAME_RE = /\b(why (haven'?t|hasn'?t|didn'?t|did no ?one|is no ?one|are (you|we) still)|unacceptable|ridiculous|how many times|i (already )?(told|asked|said)|you (need|have) to|do i (have|need) to|this is (a mess|broken|nonsense|not (ok|okay))|as i (already )?said|for the (third|last) time|seriously\?)\b/i;
  const PROFANE_RE = /\b(wtf|bullshit|bs|damn(it)?|shit|crap|f+u+c+k+\w*|hell)\b/i;

  function heuristicScore(text) {
    let score = 0;

    const shouted = (text.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || [])
      .filter((w) => !ACRONYMS.has(w));
    score += Math.min(shouted.length, 2);

    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length > 15 && letters === letters.toUpperCase()) score += 2;

    const bangs = (text.match(/!/g) || []).length;
    if (bangs >= 4) score += 2;
    else if (bangs >= 2) score += 1;

    if (/[?!]{2,}/.test(text)) score += 1;
    if (URGENT_RE.test(text)) score += 2;
    if (BLAME_RE.test(text)) score += 2;
    if (PROFANE_RE.test(text)) score += 2;

    return score;
  }

  // Padding tells. Length alone is not one: a long message dense with facts is
  // worth reading in full. What earns a condense is length plus the shape of
  // writing that is mostly throat-clearing.
  const AI_TELLS = [
    /\bi hope (this|you|we)\b/i,
    /\b(just )?wanted to (reach out|take a moment|circle back|flag|check in|follow up|share)\b/i,
    /\bcircl(e|ed|ing) back\b/i,
    /\bas you (may|might) (recall|know|remember)\b/i,
    /\bit'?s (worth|important) (noting|to note|mentioning)\b/i,
    /\bplease (don'?t hesitate|feel free) to\b/i,
    /\blet me know if you have any (questions|thoughts|concerns)\b/i,
    /\b(happy|glad) to (discuss|elaborate|help|clarify)\b/i,
    /\bthat (being )?said\b/i,
    /\b(furthermore|moreover|additionally|in summary|to summarize|overall|in conclusion)\b/i,
    /\b(delve|leverage|robust|seamless|holistic|synerg\w*|streamlin\w*|actionable insights?)\b/i,
    /\bbest (path|way) forward\b/i,
    /\balign(ing)? on\b/i,
    /\b(several|a number of|various) (areas|aspects|factors|considerations|opportunities)\b/i,
    /\bafter (giving it )?(considerable|careful|some) (thought|consideration)\b/i,
    /\bi (believe|think|feel) it would be (beneficial|helpful|valuable|worth)\b/i,
    /\b(great|excellent) (question|point)\b/i,
    /\bcertainly[!,]/i,
    /\bhere'?s a (breakdown|summary|quick rundown|high[- ]level)\b/i,
    /\blet me (break|walk) (this|you|it) (down|through)\b/i,
    /\bfor visibility\b/i,
  ];

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function hasCode(text) {
    return /```/.test(text) || /^\s{4,}\S/m.test(text);
  }

  function paddingScore(text, settings = CONFIG) {
    if (!settings.condenseEnabled) return 0;
    if (hasCode(text)) return 0;
    // Mostly a bare link is not padding, it is a link.
    if (/^\s*<?https?:\/\/\S+>?\s*$/.test(text)) return 0;

    const words = wordCount(text);
    if (words < settings.condenseMinWords) return 0;

    let tells = 0;
    for (const re of AI_TELLS) if (re.test(text)) tells += 1;
    if ((text.match(/^\s*([-*•]|\d+\.)\s+/gm) || []).length >= 3) tells += 1;
    if ((text.match(/\n\s*\n/g) || []).length >= 2) tells += 1;
    if (words >= 120) tells += 1;
    return tells;
  }

  function shouldAsk(text, settings = CONFIG) {
    if (settings.triageMode === 'always') return true;
    return heuristicScore(text) >= settings.triageThreshold || paddingScore(text, settings) >= 1;
  }

  /* ------------------------------------------------------------ extraction */

  let cachedSelf = null;
  function selfName() {
    if (cachedSelf) return cachedSelf;
    const el = document.querySelector(SEL.self);
    const label = el?.getAttribute('aria-label') || el?.getAttribute('data-tooltip') || '';
    const m = label.match(/:\s*(.+?)\s*$/);
    if (m) cachedSelf = m[1].trim();
    return cachedSelf;
  }

  // The channel of the column you are actually reading, which is what the
  // button in the header is about.
  function channelName() {
    const primary = document.querySelector(SEL.primary);
    const el = primary?.querySelector(SEL.surfaceChannel) || document.querySelector(SEL.channel);
    const name = el?.textContent?.trim();
    if (name) return name;
    return (document.title || '').split('|')[0].trim() || null;
  }

  /*
   * Which channel is this particular message in?
   *
   * Asking the page once and using the answer for everything on it is wrong
   * the moment a thread is open beside a channel, or two columns are: the
   * messages in the flexpane belong to whatever channel the thread is in, and
   * telling Slacken to leave #deploys alone has to mean the thread too.
   *
   * So the channel is read from the surface the message is in, memoised per
   * surface for the length of one pass — the lookup is a querySelector inside
   * a column, and a burst of forty messages must not cost forty of them.
   */
  function channelFor(item, memo) {
    const surface = item.closest?.(SEL.surface);
    if (!surface) return channelName();
    if (memo?.has(surface)) return memo.get(surface);
    const el = surface.querySelector(SEL.surfaceChannel);
    const name = el?.textContent?.trim() || channelName();
    memo?.set(surface, name);
    return name;
  }

  // Grouped consecutive messages only carry the sender name on the first one,
  // so walk back through earlier list items until we find it. Only worth doing
  // for a message that has already cleared triage; it is the priciest read here.
  function senderFor(item) {
    let node = item;
    for (let i = 0; i < 40 && node; i += 1) {
      const el = node.querySelector?.(SEL.sender);
      if (el) return el.textContent.trim();
      node = node.previousElementSibling;
    }
    return null;
  }

  function inPreamble(el) {
    return Boolean(el.closest(SEL.preamble));
  }

  // The content node is where a message body normally lives, but a thread
  // reply shown in the channel does not always have one, so the list item
  // itself is the fallback scope rather than a reason to give up: a message we
  // cannot find a body for is a message we silently never touch.
  function bodyFor(item) {
    const scope = item.querySelector(SEL.content) || item;
    const blocks = Array.from(scope.querySelectorAll(SEL.blocks)).find((el) => !inPreamble(el));
    if (blocks) return blocks;
    // Older layouts put rich text straight under the content node.
    const rich = Array.from(scope.querySelectorAll(SEL.rich)).find((el) => !inPreamble(el));
    return rich ? rich.parentElement : null;
  }

  function richSections(body) {
    return Array.from(body.querySelectorAll(SEL.rich))
      // The quoted parent of a broadcast reply is rich text too, and it sits
      // inside the same blocks the reply does.
      .filter((el) => !inPreamble(el))
      // A list item's section nests inside another in some layouts. Keeping
      // both would hand the model the same sentence twice and score its
      // padding on the duplicate.
      .filter((el, _i, all) => !all.some((other) => other !== el && other.contains(el)));
  }

  function textFor(body) {
    const sections = richSections(body);
    if (sections.length) return sections.map((el) => el.innerText).join('\n').trim();
    if (!body.querySelector(SEL.preamble)) return body.innerText.trim();
    // No rich text to pick from and a preamble in the way: read a copy with
    // the preamble cut out. Detached, so innerText falls back to textContent,
    // which is close enough for a path this rare.
    const copy = body.cloneNode(true);
    copy.querySelectorAll(SEL.preamble).forEach((el) => el.remove());
    return copy.innerText?.trim() || copy.textContent.trim();
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function matchesAny(list, value) {
    if (!value) return false;
    const needle = value.toLowerCase();
    return list.some((entry) => needle === String(entry).toLowerCase());
  }

  /* --------------------------------------------------------------- memory */

  // Keyed by a hash of the message text, so the same message costs one call no
  // matter how often it is re-rendered, recycled or scrolled past.
  const verdicts = new Map();
  // Cheap textContent hash -> verdict key. textContent needs no layout, so a
  // repair pass can decide what to do without touching innerText at all.
  const sigs = new Map();

  const CLEAN = { flagged: false, rewrite: null };

  function remember(key, verdict) {
    verdicts.set(key, verdict);
    while (verdicts.size > MEMORY_MAX) verdicts.delete(verdicts.keys().next().value);
  }

  function link(sig, key) {
    sigs.set(sig, key);
    while (sigs.size > MEMORY_MAX) sigs.delete(sigs.keys().next().value);
  }

  // Flagged verdicts survive a reload, so re-opening Slack repaints the
  // rewrites immediately instead of walking every held message back through
  // the daemon. Triage is cheap enough that clean verdicts are not worth a
  // storage slot.
  function loadStore() {
    if (!CONFIG.persistVerdicts) return;
    try {
      const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw)) {
        if (entry && now - entry.at < STORE_TTL_MS) remember(key, entry.v);
      }
    } catch {
      // Private mode, a quota error, or a corrupt blob. Start empty.
    }
  }

  let storeTimer = null;
  function persistSoon() {
    if (!CONFIG.persistVerdicts || storeTimer) return;
    storeTimer = setTimeout(() => {
      storeTimer = null;
      try {
        const out = {};
        const at = Date.now();
        const keys = Array.from(verdicts.keys()).slice(-STORE_MAX);
        for (const key of keys) {
          const v = verdicts.get(key);
          if (v && v.flagged && v.rewrite) out[key] = { at, v };
        }
        window.localStorage.setItem(STORE_KEY, JSON.stringify(out));
      } catch {
        // Nothing here is worth failing a render over.
      }
    }, 2000);
  }

  /* -------------------------------------------------------------- rendering */

  const panels = new WeakMap(); // list item -> the panel we built for it
  // Messages the reader has opened, keyed by content rather than by node. A
  // reveal kept on the node dies the moment Slack re-renders the row — and
  // revealing a condensed message swaps one line of rewrite for the whole
  // original, which is the biggest height change on the page and the surest
  // way to make the virtual list re-render it. Keyed by content, the reveal
  // survives being re-rendered straight through it.
  const revealed = new Set();
  let revealAll = false;

  function setAttr(el, name, value) {
    // Writing an identical value still fires the observer, which is how a
    // reconcile loop starts. Every write here is conditional for that reason.
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function dropAttr(el, name) {
    if (el?.hasAttribute(name)) el.removeAttribute(name);
  }

  function actionLabel(verdict) {
    if (verdict.hostile && verdict.verbose) return 'softened · condensed';
    if (verdict.verbose) return 'condensed';
    return 'softened';
  }

  function ensurePanel(item, body) {
    let refs = panels.get(item);
    if (!refs) {
      const panel = document.createElement('div');
      panel.className = 'slacken-panel';
      panel.dataset.open = '0';

      const rewrite = document.createElement('div');
      rewrite.className = 'slacken-rewrite';

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'slacken-badge';
      const dot = document.createElement('span');
      dot.className = 'slacken-dot';
      const label = document.createElement('span');
      label.className = 'slacken-label';
      const action = document.createElement('span');
      action.className = 'slacken-action';
      action.textContent = 'show original';
      badge.append(dot, label, action);

      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle(item);
      });

      panel.append(rewrite, badge);
      refs = { panel, rewrite, badge, label, action, labelTimer: null };
      panels.set(item, refs);
    }

    // Put it back if Slack re-rendered over it. This runs inside the observer
    // callback, so the repair lands before the frame is painted and the gap is
    // never visible.
    const parent = body.parentElement;
    if (parent && (refs.panel.parentElement !== parent || refs.panel.previousElementSibling !== body)) {
      parent.insertBefore(refs.panel, body.nextSibling);
    }
    return refs;
  }

  function setHold(item, body, on) {
    setAttr(item, ATTR_HOLD, on ? '1' : '0');
    if (body) setAttr(body, ATTR_BODY, on ? 'hidden' : 'shown');
    const refs = panels.get(item);
    if (!refs) return;
    if (refs.panel.dataset.open !== (on ? '0' : '1')) refs.panel.dataset.open = on ? '0' : '1';
    const action = on ? 'show original' : 'hide original';
    if (refs.action.textContent !== action) refs.action.textContent = action;
  }

  function toggle(item) {
    const body = bodyFor(item);
    if (!body) return;
    const refs = panels.get(item);
    const key = refs?.key;
    const open = item.getAttribute(ATTR_HOLD) === '0';
    if (key) {
      if (open) revealed.delete(key);
      else revealed.add(key);
      while (revealed.size > MEMORY_MAX) revealed.delete(revealed.values().next().value);
    }
    setHold(item, body, open);
    // Opening one is the clearest thing a reader ever says about a rewrite —
    // that they wanted the words. Closing it again says nothing, so only the
    // opening is reported, and nothing waits on the answer.
    if (!open) reportReveal(refs);
  }

  function reportReveal(refs) {
    if (!refs) return;
    ask({
      op: 'reveal',
      sender: refs.sender || null,
      channel: refs.channel || null,
      kind: refs.kind || null,
    }).catch(() => {
      // The daemon is restarting, or the page is going away. A count is not
      // worth a word to anyone.
    });
  }

  // Local triage already suspects this one, so hide it now rather than letting
  // the hostile version sit on screen for the second or so the model takes.
  // The panel holds the original's height while it waits, so nothing on the
  // page moves, and it stays wordless for a beat: a cached verdict beats
  // PENDING_LABEL_MS and swaps straight in with no placeholder in between.
  function applyPending(item, body, height) {
    const refs = ensurePanel(item, body);
    const fresh = refs.panel.dataset.pending !== '1';
    refs.panel.dataset.pending = '1';
    if (!refs.badge.hidden) refs.badge.hidden = true;
    refs.rewrite.classList.add('slacken-pending');
    if (height && refs.panel.style.minHeight !== `${height}px`) {
      refs.panel.style.minHeight = `${height}px`;
    }
    if (fresh) {
      refs.rewrite.textContent = '';
      clearTimeout(refs.labelTimer);
      refs.labelTimer = setTimeout(() => {
        if (refs.panel.dataset.pending === '1') refs.rewrite.textContent = 'checking…';
      }, PENDING_LABEL_MS);
    }
    setHold(item, body, true);
  }

  function applyVerdict(item, body, verdict, key, channel) {
    const refs = ensurePanel(item, body);
    refs.key = key;
    // Kept so that clicking the badge can say what was revealed and where,
    // rather than only that something was.
    refs.channel = channel || refs.channel || null;
    refs.sender = senderFor(item) || refs.sender || null;
    refs.kind = verdict.hostile && verdict.verbose ? 'softened+condensed'
      : verdict.verbose ? 'condensed' : 'softened';

    if (refs.panel.dataset.pending === '1') {
      delete refs.panel.dataset.pending;
      clearTimeout(refs.labelTimer);
      refs.panel.style.minHeight = '';
      refs.rewrite.classList.remove('slacken-pending');
    }

    if (refs.badge.hidden) refs.badge.hidden = false;
    if (refs.rewrite.textContent !== verdict.rewrite) refs.rewrite.textContent = verdict.rewrite;

    const severity = String(verdict.severity ?? 2);
    const kind = verdict.hostile ? 'softened' : 'condensed';
    if (refs.badge.dataset.severity !== severity) refs.badge.dataset.severity = severity;
    if (refs.badge.dataset.kind !== kind) refs.badge.dataset.kind = kind;

    const tones = (verdict.tone || []).join(', ');
    const title = [verdict.note, tones && `(${tones})`].filter(Boolean).join(' ')
      || 'Slacken rewrote this message';
    if (refs.badge.title !== title) refs.badge.title = title;

    const label = actionLabel(verdict);
    if (refs.label.textContent !== label) refs.label.textContent = label;

    setHold(item, body, !(revealAll || revealed.has(key)));
  }

  function clearItem(item, body) {
    const refs = panels.get(item);
    if (refs) {
      clearTimeout(refs.labelTimer);
      delete refs.panel.dataset.pending;
      refs.panel.style.minHeight = '';
      refs.panel.remove();
    }
    dropAttr(item, ATTR_HOLD);
    dropAttr(body, ATTR_BODY);
  }

  // Pausing has to clear held messages as well as revealed ones, or a message
  // caught mid-verdict would stay behind "checking…" with nothing coming to
  // replace it.
  function releaseHolds() {
    document.querySelectorAll('.slacken-panel[data-pending]').forEach((panel) => {
      const item = panel.closest(SEL.item);
      if (item) clearItem(item, bodyFor(item));
    });
  }

  function setAll(open) {
    revealAll = open;
    if (!open) revealed.clear();
    // Reported once rather than once per message: Cmd+Shift+U is one decision
    // about the screen, and forty of them would drown the count it feeds.
    if (open) {
      ask({ op: 'reveal', kind: 'all' }).catch(() => {});
    }
    document.querySelectorAll(`[${ATTR_STATE}="done"]`).forEach((item) => {
      if (!item.hasAttribute(ATTR_HOLD)) return;
      const body = bodyFor(item);
      if (body) setHold(item, body, !open);
    });
  }

  /* -------------------------------------------------------- channel button */

  /*
   * A button in Slack's channel header that takes the channel you are reading
   * out of Slacken's way, and puts it back.
   *
   * It lives here rather than in the menu bar because this is the only place
   * that knows which channel you mean. The daemon owns the list; the button
   * asks it to change and then draws whatever came back, so the two can never
   * disagree about whether a channel is ignored.
   */
  const BUTTON_CLASS = 'slacken-channel';

  function buildChannelButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;

    const dot = document.createElement('span');
    dot.className = 'slacken-dot';
    const label = document.createElement('span');
    label.className = 'slacken-channel-label';
    button.append(dot, label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      requestIgnore(button, button.dataset.channel, button.dataset.ignored !== '1');
    });
    return button;
  }

  let channelButton = null;

  function ensureChannelButton(channel, ignored) {
    // Nothing identifiable on screen — a preferences pane, or Slack still
    // starting up. A button that cannot say which channel it means should not
    // be offering to ignore one.
    if (!channel) {
      channelButton?.remove();
      return;
    }
    const anchor = document.querySelector(SEL.channel);
    if (!anchor) {
      channelButton?.remove();
      return;
    }
    const host = anchor.closest(SEL.header) || anchor.parentElement;
    if (!host) return;

    if (!channelButton) channelButton = buildChannelButton();
    // Slack rebuilds its header on every channel switch, which takes the
    // button with it. Putting it back is one append, and it happens inside the
    // observer callback, so it is back before the frame is painted.
    if (channelButton.parentElement !== host) host.appendChild(channelButton);

    if (channelButton.dataset.channel !== channel) channelButton.dataset.channel = channel;
    // A click in flight owns the button's wording until the daemon answers.
    if (channelButton.dataset.busy === '1') return;

    const flag = ignored ? '1' : '0';
    if (channelButton.dataset.ignored !== flag) channelButton.dataset.ignored = flag;

    const label = channelButton.querySelector('.slacken-channel-label');
    const text = ignored ? 'Ignored by Slacken' : 'Ignore in Slacken';
    if (label.textContent !== text) label.textContent = text;

    const title = ignored
      ? `Slacken is leaving ${channel} exactly as written — click to rewrite here again`
      : `Stop Slacken rewriting anything in ${channel}`;
    if (channelButton.title !== title) channelButton.title = title;
  }

  function requestIgnore(button, channel, ignored) {
    if (!channel) return;
    button.dataset.busy = '1';
    ask({ op: 'ignore-channel', channel, ignored }).then((res) => {
      if (Array.isArray(res.ignoreChannels)) CONFIG.ignoreChannels = res.ignoreChannels;
      if (res.error) log('ignore failed', res.error);
    }).catch((err) => {
      log('ignore failed', err.message);
    }).finally(() => {
      delete button.dataset.busy;
      // Whatever the answer was, the whole view is re-planned against it: an
      // ignored channel has to give its originals back, and an un-ignored one
      // has to be looked at again.
      sweep();
    });
  }

  /* ------------------------------------------------------------ processing */

  function nearViewport(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return false;
    return rect.bottom > -VIEWPORT_MARGIN_PX
      && rect.top < window.innerHeight + VIEWPORT_MARGIN_PX;
  }

  /*
   * Reconciliation runs in two halves on purpose. `plan` only reads the DOM
   * and `commit` only writes it, so a batch of messages costs one layout
   * instead of one per message. Interleaving the two is what makes a naive
   * version of this slow enough to need a debounce — and a debounce is what
   * puts the original on screen.
   */
  function plan(item, ctx) {
    if (item.closest(SEL.composer)) return null;

    const body = bodyFor(item);
    if (!body) return null;

    const raw = body.textContent || '';
    if (!raw.trim()) return null;

    // Read from the column this message is in rather than from the page: a
    // thread open beside a channel is two conversations on one screen.
    const channel = channelFor(item, ctx.memo);
    const settings = settingsFor(channel);
    const sig = hash(raw);
    const gate = gateFor(channel);
    const skey = `${sig}|${gate}`;
    const same = item.getAttribute(ATTR_HASH) === sig;
    const base = { item, body, sig, skey, channel, same };

    // This channel is on the ignore list. Checked before the caches, not after
    // the triage: a message we rewrote before the channel was ignored — or one
    // a stored verdict would repaint after a reload — has to give its original
    // back too, or ignoring a channel would only apply to what had not been
    // read yet.
    if (matchesAny(CONFIG.ignoreChannels, channel)) return { ...base, act: 'idle' };

    // Fast path: we have judged this exact text before, here or anywhere else.
    // No innerText, no layout, no call.
    const knownKey = sigs.get(skey);
    const cached = knownKey ? verdicts.get(knownKey) : null;
    if (cached) {
      return cached.flagged && cached.rewrite
        ? { ...base, act: 'apply', verdict: cached, key: knownKey, state: 'done' }
        : { ...base, act: 'clear', state: 'clean' };
    }

    // Paused. Verdicts already on screen stay, revealed by setAll, so the badge
    // still flips back; everything else is released and left unexamined, with
    // no state stamped, so resuming gives it a fresh look.
    if (paused) return { ...base, act: 'idle' };

    // Second fast path: decisions that belong to this item rather than to the
    // text, so they cannot live in the shared cache.
    if (same) {
      const state = item.getAttribute(ATTR_STATE);
      if (state === 'pending') return { ...base, act: 'pending' };
      if (state === 'skipped' || state === 'error') return { ...base, act: 'clear', state };
    }

    // Undecided, and off screen. Leave it completely alone — including its
    // hash, so it gets a fresh look when it scrolls in.
    if (!nearViewport(item)) return { ...base, act: 'idle' };

    const text = textFor(body);
    if (!text || text.length > settings.maxChars) return { ...base, act: 'clear', state: 'clean' };

    const key = `${hash(text)}|${gate}`;
    const known = verdicts.get(key);
    if (known) {
      link(skey, key);
      return known.flagged && known.rewrite
        ? { ...base, act: 'apply', verdict: known, key, state: 'done' }
        : { ...base, act: 'clear', state: 'clean' };
    }

    if (!shouldAsk(text, settings)) {
      remember(key, CLEAN);
      link(skey, key);
      return { ...base, act: 'clear', state: 'clean' };
    }
    log('triage', heuristicScore(text), paddingScore(text, settings), text.slice(0, 60));

    // Only now is the sender walk worth its cost, and a skip is per-sender so
    // it never goes in the text-keyed cache.
    const sender = senderFor(item);
    const me = selfName();
    if ((me && sender === me)
      || matchesAny(CONFIG.selfNames, sender)
      || matchesAny(CONFIG.ignoreSenders, sender)) {
      return { ...base, act: 'clear', state: 'skipped' };
    }

    return {
      ...base,
      act: 'ask',
      key,
      text,
      sender,
      // Read the height now, in the read half, so the hold can keep the
      // message's place without shifting the page.
      height: CONFIG.holdWhilePending ? body.offsetHeight : 0,
    };
  }

  function triageLine(text, settings = CONFIG) {
    return `tone ${heuristicScore(text)} of ${settings.triageThreshold} needed,`
      + ` padding ${paddingScore(text, settings)} of 1 needed, ${wordCount(text)} words`;
  }

  /*
   * Read-only account of what Slacken makes of one row on screen, for
   * `slacken inspect`. It answers the question the badge cannot: not what
   * happened to a message, but why nothing did. Nothing here writes to the DOM
   * or to the caches, so looking never changes the answer.
   */
  function diagnose(item) {
    const sender = senderFor(item);
    const threadReply = Boolean(item.querySelector(SEL.preamble));
    // Read where the row is, not where the page is: a thread open beside a
    // channel is a different conversation with possibly different settings,
    // and a report that answered for the wrong one would be worse than none.
    const channel = channelFor(item, null);
    const settings = settingsFor(channel);
    const row = { sender, channel, threadReply, state: item.getAttribute(ATTR_STATE) };

    const body = bodyFor(item);
    if (!body) {
      // A day divider or a join notice is a row with nothing in it to read,
      // not a message we failed on. Marked as chrome so the report can drop it
      // — a row that looks like a message and still has no body is the one
      // worth showing, because it is a layout this does not know.
      const looksLikeMessage = Boolean(item.querySelector(`${SEL.content}, ${SEL.blocks}`) || threadReply);
      return { ...row, chrome: !looksLikeMessage, why: 'no message body found under this row' };
    }

    const text = textFor(body);
    row.chars = text.length;
    row.words = wordCount(text);
    row.head = text.slice(0, 80).replace(/\s+/g, ' ');
    if (!text.trim()) return { ...row, why: 'no text to read' };

    const known = verdicts.get(`${hash(text)}|${gateFor(channel)}`);
    if (known && known.flagged && known.rewrite) return { ...row, why: 'rewritten' };
    // The CLEAN object itself, rather than a verdict shaped like it, is the
    // one triage cleared without asking. Saying which of the two happened is
    // the difference between "the model saw no problem" and "the model never
    // saw it", and only the second one is a setting you can change.
    if (known === CLEAN) return { ...row, why: `read as written; ${triageLine(text, settings)}` };
    if (known) return { ...row, why: 'the model read it and left it as written' };
    if (matchesAny(CONFIG.ignoreChannels, channel)) return { ...row, why: 'channel is on the ignore list' };
    if (paused) return { ...row, why: 'paused' };
    if (row.state === 'pending') return { ...row, why: 'waiting on the model' };
    if (row.state === 'error') return { ...row, why: 'the model call failed' };

    const me = selfName();
    if ((me && sender === me) || matchesAny(CONFIG.selfNames, sender)) return { ...row, why: 'written by you' };
    if (matchesAny(CONFIG.ignoreSenders, sender)) return { ...row, why: 'sender is on the ignore list' };
    if (!nearViewport(item)) return { ...row, why: 'off screen; it gets looked at when you scroll to it' };
    if (text.length > settings.maxChars) {
      return { ...row, why: `too long: ${text.length} chars, over the ${settings.maxChars} limit` };
    }
    if (!shouldAsk(text, settings)) return { ...row, why: `left alone; ${triageLine(text, settings)}` };
    return { ...row, why: 'about to be sent to the model' };
  }

  function commit(p) {
    const { item, body } = p;

    if (p.act === 'idle') {
      clearItem(item, body);
      return;
    }

    setAttr(item, ATTR_HASH, p.sig);

    if (p.act === 'apply') {
      setAttr(item, ATTR_STATE, 'done');
      applyVerdict(item, body, p.verdict, p.key, p.channel);
      return;
    }

    if (p.act === 'pending') {
      applyPending(item, body, 0);
      return;
    }

    if (p.act === 'ask') {
      setAttr(item, ATTR_STATE, 'pending');
      if (CONFIG.holdWhilePending) applyPending(item, body, p.height);
      else clearItem(item, body);
      startAsk(p);
      return;
    }

    setAttr(item, ATTR_STATE, p.state || 'clean');
    clearItem(item, body);
  }

  /*
   * The calls in the air, and every copy of a message waiting on one.
   *
   * The same words can be on screen more than once — a message and its copy in
   * a thread, the same announcement in two channels — and they are one
   * question, so the second copy joins the first one's call rather than paying
   * for its own. That makes the second copy something that has to be woken up
   * when the answer lands: it never asked, so nothing else would tell it, and
   * a message left in `pending` is a message you are being kept from reading.
   * Which copies are waiting is therefore tracked rather than inferred from
   * the DOM, because the thing they have in common is their words, and the
   * signatures the DOM knows them by can differ by a line of whitespace.
   */
  const inFlight = new Map(); // verdict key -> the content signatures waiting on it

  // Every copy of this text on screen, not just the one that asked for it.
  function itemsFor(sig) {
    return Array.from(document.querySelectorAll(`[${ATTR_HASH}="${sig}"]`));
  }

  function waitingItems(key, sig) {
    const sigs = inFlight.get(key) || new Set([sig]);
    const items = [];
    for (const one of sigs) items.push(...itemsFor(one));
    return items;
  }

  function startAsk(p) {
    const waiting = inFlight.get(p.key);
    if (waiting) {
      waiting.add(p.sig);
      return;
    }
    inFlight.set(p.key, new Set([p.sig]));

    ask({ text: p.text, sender: p.sender, channel: p.channel }).then((verdict) => {
      if (verdict.error) log('daemon error', verdict.error);

      // A verdict that lands after a pause began says nothing about the
      // message, only about the pause. Remembering it would leave this message
      // unexamined for as long as the page lived, long after resuming.
      if (paused || verdict.reason === 'paused') {
        for (const item of waitingItems(p.key, p.sig)) {
          dirty.add(item);
          item.removeAttribute(ATTR_STATE);
          item.removeAttribute(ATTR_HASH);
        }
        return;
      }

      remember(p.key, verdict);
      link(p.skey, p.key);
      persistSoon();
    }).catch((err) => {
      log('ask failed', err.message);
      // Never leave a message hidden behind a hold that will not lift.
      for (const item of waitingItems(p.key, p.sig)) {
        if (item.getAttribute(ATTR_STATE) === 'pending') setAttr(item, ATTR_STATE, 'error');
      }
    }).finally(() => {
      const items = waitingItems(p.key, p.sig);
      inFlight.delete(p.key);
      for (const item of items) {
        // `pending` is a state an item can only be talked out of: it is
        // checked before the text is read, so a copy still wearing it would
        // never look at the answer that has just arrived.
        if (item.getAttribute(ATTR_STATE) === 'pending') item.removeAttribute(ATTR_STATE);
        dirty.add(item);
      }
      flush();
    });
  }

  /* ------------------------------------------------------------ scheduling */

  const dirty = new Set();

  function flush() {
    ensureStyle();
    // Worked out before the early return: switching to an empty channel makes
    // nothing dirty, and the button still has to follow you there.
    const channel = channelName();
    // One lookup per column per pass, rather than one per message.
    const ctx = { channel, memo: new Map() };
    ensureChannelButton(channel, matchesAny(CONFIG.ignoreChannels, channel));

    if (!dirty.size) return;
    const items = Array.from(dirty);
    dirty.clear();

    const plans = [];
    // Read half.
    for (const item of items) {
      if (!item.isConnected) continue;
      try {
        const p = plan(item, ctx);
        if (p) plans.push(p);
      } catch (err) {
        log('plan failed', err.message);
      }
    }
    // Write half.
    for (const p of plans) {
      try {
        commit(p);
      } catch (err) {
        log('commit failed', err.message);
      }
    }
  }

  function refresh(selector) {
    document.querySelectorAll(selector).forEach((item) => dirty.add(item));
    flush();
  }

  function sweep() {
    document.querySelectorAll(SEL.item).forEach((item) => dirty.add(item));
    flush();
  }

  function collect(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.closest?.('.slacken-panel')) return;
    const item = node.closest?.(SEL.item);
    if (item) {
      dirty.add(item);
      return;
    }
    // A whole slice of the virtual list can land in one mutation.
    node.querySelectorAll?.(SEL.item).forEach((el) => dirty.add(el));
  }

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes') {
        // Our own attributes come back as records too. Re-planning the item is
        // how a hold Slack stripped gets re-asserted; `plan` is idempotent, so
        // an attribute that is already right ends the loop rather than
        // extending it.
        if (rec.target.nodeType === 1) collect(rec.target);
        continue;
      }
      collect(rec.target);
      rec.addedNodes.forEach(collect);
    }
    // Synchronous: MutationObserver callbacks run before the browser paints,
    // which is the whole reason the original never gets a frame on screen.
    flush();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: Array.from(OUR_ATTRS),
  });

  // Scrolling reveals items that were already in the DOM but too far away to
  // be worth a call. A frame callback, not a timer: it still lands before the
  // paint that would show the original.
  let frame = null;
  function onScroll() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      try {
        sweep();
      } catch (err) {
        log('sweep failed', err.message);
      }
    });
  }
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  // Backstop: the virtual list sometimes settles without a mutation we see.
  setInterval(() => {
    try {
      ensureStyle();
      sweep();
    } catch (err) {
      log('sweep failed', err.message);
    }
  }, SWEEP_MS);

  /*
   * Say what is being found, so a Slack that has moved under us is noticeable.
   *
   * The failure this exists for is silent by construction: Slack renames a
   * class, the page stops finding message bodies, and the daemon goes on
   * reporting that it is watching three windows. List items with no bodies
   * inside them is the signature — the list is still the list and the words
   * are not where they were. Finding no list items at all is not evidence of
   * anything, and is deliberately not reported as a problem.
   */
  const HEALTH_MS = 60_000;
  function reportHealth() {
    const items = document.querySelectorAll(SEL.item);
    if (!items.length) return;
    let bodies = 0;
    for (const item of items) if (bodyFor(item)) bodies += 1;
    ask({ op: 'health', items: items.length, bodies }).catch(() => {});
  }
  const healthTimer = setInterval(() => {
    try {
      reportHealth();
    } catch (err) {
      log('health failed', err.message);
    }
  }, HEALTH_MS);
  healthTimer.unref?.();
  // Once early, so a layout change is noticed in the first minute rather than
  // after it.
  setTimeout(() => {
    try {
      reportHealth();
    } catch {
      // Nothing here is worth failing a render over.
    }
  }, 4000);

  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey && event.shiftKey)) return;
    if (event.key.toLowerCase() !== 'u') return;
    event.preventDefault();
    setAll(!revealAll);
  });

  /* -------------------------------------------------------- notifications */

  /*
   * The message you actually get hit with first.
   *
   * Everything else here happens once you are looking at the channel. A
   * notification arrives before that, in the corner of the screen, in full —
   * which is the one place a calmer reading layer is least able to help and
   * most needed. Slack raises its notifications from the renderer, so the
   * constructor can be wrapped like anything else on the page.
   *
   * A suspected body is held rather than shown and corrected: raising the
   * original and replacing it a second later would be strictly worse than not
   * trying, because you would have read it by then. So the real notification
   * is not created until the verdict lands, a stand-in stands in for it
   * meanwhile, and a verdict that does not arrive within DEFER_MAX_MS gives
   * up and raises the original — a notification that never arrives is a
   * message you never knew about, which is the one outcome worse than a
   * hostile banner.
   *
   * If a Slack build raises notifications from its main process instead, none
   * of this runs and nothing breaks; the count in the menu bar stays at zero,
   * which is how you can tell.
   */
  const DEFER_MAX_MS = 2500;

  function channelFromTitle(title) {
    const text = String(title || '');
    const named = text.match(/#[^\s(),]+/);
    if (named) return named[0];
    const parens = text.match(/\(([^)]+)\)\s*$/);
    return parens ? parens[1].trim() : channelName();
  }

  function installNotificationHook() {
    const Native = window.Notification;
    if (typeof Native !== 'function' || Native.__slacken) return;

    // Deliberately not a class: a stand-in is returned instead of `this` for a
    // held notification, which a class constructor cannot do.
    function Slackened(title, options) {
      const opts = options || {};
      const body = typeof opts.body === 'string' ? opts.body.trim() : '';
      if (paused || !CONFIG.rewriteNotifications || !body) return new Native(title, opts);

      const channel = channelFromTitle(title);
      if (matchesAny(CONFIG.ignoreChannels, channel) || matchesAny(CONFIG.ignoreSenders, title)) {
        return new Native(title, opts);
      }

      const settings = settingsFor(channel);
      const key = `${hash(body)}|${gateFor(channel)}`;
      const known = verdicts.get(key);
      if (known) {
        return new Native(title, known.flagged && known.rewrite ? { ...opts, body: known.rewrite } : opts);
      }
      if (body.length > settings.maxChars || !shouldAsk(body, settings)) return new Native(title, opts);

      const pending = new Deferred(Native, title, opts);
      ask({ text: body, sender: String(title || ''), channel, kind: 'notification' })
        .then((verdict) => {
          if (verdict && !verdict.error && !verdict.reason) {
            remember(key, verdict);
            persistSoon();
          }
          pending.settle(verdict?.flagged && verdict.rewrite ? verdict.rewrite : null);
        })
        .catch(() => pending.settle(null));
      return pending;
    }

    // Everything a page can legitimately ask the constructor about is the
    // native one's business, not ours.
    for (const name of ['permission', 'maxActions']) {
      try {
        Object.defineProperty(Slackened, name, { get: () => Native[name], configurable: true });
      } catch {
        // A locked-down build. The wrapper still works; this is only polish.
      }
    }
    Slackened.requestPermission = (...args) => Native.requestPermission(...args);
    Slackened.prototype = Native.prototype;
    Slackened.__slacken = true;

    try {
      window.Notification = Slackened;
    } catch (err) {
      log('could not wrap Notification', err.message);
    }
  }

  // Stands in for a notification that has not been raised yet: it remembers
  // what was done to it and does the same to the real one when it appears.
  class Deferred {
    constructor(Native, title, options) {
      this.Native = Native;
      this.title = title;
      this.options = options;
      this.real = null;
      this.closed = false;
      this.listeners = [];
      this.handlers = {};
      // A notification that is never raised is a message you never heard
      // about, so the wait has an end whatever happens upstream.
      this.timer = setTimeout(() => this.settle(null), DEFER_MAX_MS);
    }

    settle(rewrite) {
      if (this.real || this.closed) return;
      clearTimeout(this.timer);
      try {
        this.real = new this.Native(
          this.title,
          rewrite ? { ...this.options, body: rewrite } : this.options,
        );
      } catch (err) {
        log('notification refused', err.message);
        return;
      }
      for (const [type, fn, opts] of this.listeners) this.real.addEventListener(type, fn, opts);
      for (const [type, fn] of Object.entries(this.handlers)) this.real[type] = fn;
    }

    close() {
      this.closed = true;
      clearTimeout(this.timer);
      if (this.real) this.real.close();
    }

    addEventListener(type, fn, opts) {
      if (this.real) this.real.addEventListener(type, fn, opts);
      else this.listeners.push([type, fn, opts]);
    }

    removeEventListener(type, fn, opts) {
      if (this.real) this.real.removeEventListener(type, fn, opts);
      else this.listeners = this.listeners.filter(([t, f]) => t !== type || f !== fn);
    }

    dispatchEvent(event) {
      return this.real ? this.real.dispatchEvent(event) : false;
    }
  }

  for (const type of ['onclick', 'onclose', 'onerror', 'onshow']) {
    Object.defineProperty(Deferred.prototype, type, {
      get() {
        return this.real ? this.real[type] : this.handlers[type] || null;
      },
      set(fn) {
        if (this.real) this.real[type] = fn;
        else this.handlers[type] = fn;
      },
    });
  }

  installNotificationHook();

  /* --------------------------------------------------------------- drafts */

  /*
   * The one thing here that looks at what you wrote.
   *
   * Off unless you turn it on, and even then it changes nothing: it offers a
   * flatter wording above the composer and waits. Slacken's whole promise is
   * that it does not touch what you write, and an editor that rewrote your
   * message as you typed would break that promise whatever the wording came
   * out like. Nothing is sent, nothing is replaced until you click, and the
   * offer disappears the moment you dismiss it.
   *
   * Only tone is offered, never condensing: how long your own message is, is
   * your business.
   */
  const DRAFT_DEBOUNCE_MS = 1200;
  const DRAFT_MIN_WORDS = 6;
  const drafts = new WeakMap(); // composer -> the bar we built for it
  const dismissed = new Set();
  let draftTimer = null;
  let draftAsked = null;

  function composerText(composer) {
    return (composer.innerText || composer.textContent || '').trim();
  }

  function scheduleDraftCheck(composer) {
    clearTimeout(draftTimer);
    // On a pause, when it is off, or in a channel Slacken leaves alone, this
    // is not a delay — it is nothing at all.
    if (!CONFIG.draftCheck || paused) {
      hideDraft(composer);
      return;
    }
    draftTimer = setTimeout(() => {
      try {
        checkDraft(composer);
      } catch (err) {
        log('draft check failed', err.message);
      }
    }, DRAFT_DEBOUNCE_MS);
  }

  function checkDraft(composer) {
    if (!composer.isConnected) return;
    const text = composerText(composer);
    if (wordCount(text) < DRAFT_MIN_WORDS || dismissed.has(hash(text))) {
      hideDraft(composer);
      return;
    }

    const channel = channelFor(composer, null);
    if (matchesAny(CONFIG.ignoreChannels, channel)) return;
    const settings = settingsFor(channel);
    if (text.length > settings.maxChars) return;
    // Only the tone half of triage: a long message of your own is not
    // something to be talked out of.
    if (heuristicScore(text) < settings.triageThreshold) {
      hideDraft(composer);
      return;
    }
    if (draftAsked === text) return;
    draftAsked = text;

    ask({ text, sender: 'you', channel, kind: 'draft' }).then((verdict) => {
      if (composerText(composer) !== text) return;
      if (verdict?.flagged && verdict.hostile && verdict.rewrite) showDraft(composer, text, verdict.rewrite);
      else hideDraft(composer);
    }).catch(() => {});
  }

  function showDraft(composer, original, rewrite) {
    const anchor = composer.closest('[data-qa="message_input"]') || composer.parentElement;
    if (!anchor) return;

    let bar = drafts.get(composer);
    if (!bar || !bar.root.isConnected) {
      const root = document.createElement('div');
      root.className = 'slacken-draft';

      const head = document.createElement('div');
      head.className = 'slacken-draft-head';
      head.textContent = 'This reads sharp. A flatter way to say it:';

      const suggestion = document.createElement('div');
      suggestion.className = 'slacken-draft-text';

      const actions = document.createElement('div');
      actions.className = 'slacken-draft-actions';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'slacken-draft-button';
      use.textContent = 'Use this';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'slacken-draft-button slacken-draft-quiet';
      dismiss.textContent = 'Leave it';
      actions.append(use, dismiss);

      root.append(head, suggestion, actions);
      bar = { root, suggestion, use, dismiss, original, rewrite };
      drafts.set(composer, bar);

      use.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        replaceDraft(composer, bar.rewrite);
        hideDraft(composer);
      });
      dismiss.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dismissed.add(hash(bar.original));
        while (dismissed.size > 200) dismissed.delete(dismissed.values().next().value);
        hideDraft(composer);
      });
    }

    bar.original = original;
    bar.rewrite = rewrite;
    if (bar.suggestion.textContent !== rewrite) bar.suggestion.textContent = rewrite;
    if (bar.root.parentElement !== anchor.parentElement || bar.root.nextElementSibling !== anchor) {
      anchor.parentElement?.insertBefore(bar.root, anchor);
    }
  }

  function hideDraft(composer) {
    const bar = drafts.get(composer);
    if (bar?.root.isConnected) bar.root.remove();
  }

  /*
   * Typed rather than assigned.
   *
   * Slack's composer is a rich text editor with its own model of what is in
   * it, so writing textContent leaves the editor believing the old text is
   * still there and the next keystroke puts it back. An insertText command is
   * an edit the editor performs itself — which also means it lands in its
   * undo stack, so Cmd-Z gives you your own words back.
   */
  function replaceDraft(composer, rewrite) {
    composer.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(composer);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, rewrite);
    } catch (err) {
      log('could not replace the draft', err.message);
    }
  }

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    const composer = target.closest?.(SEL.composer);
    if (composer) scheduleDraftCheck(composer);
  }, true);

  // What `slacken inspect` reads. `missed` is the important number: message
  // bodies on the page that no list item of ours contains, which is what a
  // Slack layout we do not recognise looks like from here.
  window.__slackenInspect = () => {
    const items = Array.from(document.querySelectorAll(SEL.item));
    const missed = Array.from(document.querySelectorAll(`${SEL.content}, ${SEL.blocks}`))
      .filter((el) => !items.some((item) => item.contains(el)))
      // A content node and the blocks inside it are one missed message, not two.
      .filter((el, _i, all) => !all.some((other) => other !== el && other.contains(el)))
      .map((el) => (el.innerText || '').slice(0, 60).replace(/\s+/g, ' '));
    return {
      channel: channelName(),
      self: selfName(),
      paused,
      counted: items.length,
      missed: missed.slice(0, 5),
      missedCount: missed.length,
      rows: items.map((item) => {
        try {
          return diagnose(item);
        } catch (err) {
          return { why: `could not be read: ${err.message}` };
        }
      }).filter((row) => !row.chrome),
    };
  };

  // Called by the daemon whenever the pause state changes, and once at
  // injection time via CONFIG.paused.
  window.__slackenSetPaused = (on) => {
    const next = Boolean(on);
    if (next === paused) return;
    paused = next;

    if (paused) {
      // A hold with no verdict coming is just a message you cannot read, so
      // release those outright; rewrites already decided keep their badge and
      // simply show the original.
      releaseHolds();
      setAll(true);
      log('paused: showing every original');
      sweep();
      return;
    }

    // Anything the pause left unexamined — or released only because we were
    // paused — deserves a second look. Messages already rewritten keep their
    // verdict, so resuming costs nothing for what was decided before.
    document.querySelectorAll(`[${ATTR_STATE}]`).forEach((el) => {
      const state = el.getAttribute(ATTR_STATE);
      if (state === 'done' || state === 'skipped') return;
      el.removeAttribute(ATTR_STATE);
      el.removeAttribute(ATTR_HASH);
    });
    setAll(false);
    log('resumed');
    sweep();
  };

  // Every verdict we are holding was reached under settings that have just
  // changed, so none of them answers the question being asked now. The stored
  // copies go too, or a reload would repaint decisions made under the old
  // rules.
  function forget() {
    document.querySelectorAll(`[${ATTR_STATE}]`).forEach((item) => {
      item.removeAttribute(ATTR_STATE);
      item.removeAttribute(ATTR_HASH);
      clearItem(item, bodyFor(item));
    });
    verdicts.clear();
    sigs.clear();
    revealed.clear();
    // The per-channel answers were worked out from the settings that have
    // just moved.
    settingsCache.clear();
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      // Private mode, or storage turned off. Nothing to drop.
    }
  }

  // Called by the daemon whenever a setting changes, wherever it was changed:
  // the menu bar, the terminal, or the button in another Slack window.
  window.__slackenSetConfig = (json) => {
    let next;
    try {
      next = JSON.parse(json);
    } catch {
      return;
    }
    // Pausing has its own path, and its own careful handling of messages
    // caught mid-verdict. It arrives here only because it rides along in the
    // same payload.
    delete next.paused;
    Object.assign(CONFIG, next);
    log('settings changed', CONFIG);
    forget();
    sweep();
  };

  // Asked for by the daemon, or by a test that would rather not wait a minute
  // for the timer.
  window.__slackenReportHealth = () => {
    try {
      reportHealth();
    } catch (err) {
      log('health failed', err.message);
    }
  };

  window.__slackenRescan = () => {
    forget();
    sweep();
  };

  loadStore();
  ensureStyle();
  sweep();
  log('page script ready', CONFIG);
})();
