/*
 * Slacken page script. Runs inside the Slack renderer: triages other people's
 * messages locally, asks the daemon for a neutral rewrite over a CDP binding
 * (no network request from the page, so Slack's CSP does not apply), and swaps
 * the rewrite in with a badge that toggles back to the original. The original
 * DOM is hidden, never destroyed.
 *
 * Two rules keep the swap from flickering:
 *   1. The hold is a CSS rule rooted at the list item, not an attribute on the
 *      body. Slack re-renders bodies constantly (hover, reactions, virtual-list
 *      recycling) but the list item survives, so a re-created body is hidden by
 *      the cascade the moment it lands, with no JS in between.
 *   2. Reconciliation is synchronous in the MutationObserver callback, which
 *      runs before paint. Repairing on any timer gives the original a frame.
 * The DOM is reconciled in place, never torn down and rebuilt.
 */
(() => {
  // A newer copy (reinject, daemon restart) tears the older one down. A copy
  // from before teardown existed cannot be replaced, so it is left to run.
  if (window.__SLACKEN__ && typeof window.__slackenTeardown !== 'function') return;
  window.__slackenTeardown?.();
  window.__SLACKEN__ = true;

  // Everything this copy hooks into the page, undone by teardown.
  const cleanups = [];
  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  }
  function every(ms, fn) {
    const timer = setInterval(fn, ms);
    cleanups.push(() => clearInterval(timer));
  }

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

  // Delay before a hold says "checking…"; a cache hit usually lands first.
  const PENDING_LABEL_MS = 140;
  // Off-screen messages wait. A generous margin gives scrolling a head start.
  const VIEWPORT_MARGIN_PX = 800;
  const SWEEP_MS = 2000;
  const STORE_KEY = 'slacken:verdicts:v1';
  const STORE_MAX = 400;
  const STORE_TTL_MS = 24 * 3600 * 1000;
  const MEMORY_MAX = 1500;
  // A failed call is not a verdict: the original is shown and retried after this.
  const RETRY_FAILED_MS = 60_000;

  const SEL = {
    item: '[data-qa="virtual-list-item"]',
    content: '[data-qa="message_content"]',
    blocks: '.c-message_kit__blocks, .c-message__message_blocks',
    rich: '.p-rich_text_section',
    sender: '[data-qa="message_sender_name"]',
    // A broadcast reply quotes its parent in a preamble. That is Slack chrome and
    // someone else's words, so it is neither triaged nor replaced by a rewrite.
    preamble: '[data-qa="message_broadcast_preamble"], .c-message__broadcast_preamble_container,'
      + ' .c-message__broadcast_preamble, .c-message__broadcast_preamble_link',
    channel: '[data-qa="channel_name"]',
    self: '[data-qa="user-button"]',
    composer: '[data-qa="message_input"], .ql-editor',
    // Columns a message list can live in. A thread beside a channel is its own surface.
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
    // Host for the channel-ignore button. Slack moves the header between versions:
    // first matching ancestor wins, else the channel name's parent.
    header: '[data-qa="channel_header"], .p-view_header__text_container, .p-view_header',
  };

  const log = (...args) => { if (CONFIG.verbose) console.log('[slacken]', ...args); };

  /* ------------------------------------------------------- per channel */

  /*
   * Per-channel overrides. Names fold case and a leading # exactly as the daemon
   * does, so both sides agree on which rules a message falls under.
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

  // Cache key suffix: the same text under different settings is a different
  // verdict, so stored verdicts cannot leak between channels.
  function gateFor(channel) {
    const c = settingsFor(channel);
    return `${c.minSeverity}:${c.condenseEnabled ? 1 : 0}:${c.condenseMinWords}:${c.condenseMaxRatio}:${c.maxChars}`;
  }

  // Owned by the daemon. While paused nothing is asked about or held.
  let paused = Boolean(CONFIG.paused);

  /* ---------------------------------------------------------------- styles */

  const STYLE_ID = 'slacken-style';
  const CSS = `
    /* The hold hangs off the list item so that a message body Slack re-renders
       arrives already hidden, rather than flashing until we notice. */
    [${ATTR_HOLD}="1"] .c-message_kit__blocks,
    [${ATTR_HOLD}="1"] .c-message__message_blocks,
    [${ATTR_HOLD}="1"] [${ATTR_BODY}] { display: none !important; }

    /* A column, so the badge is a block box with no inline descender space. */
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
    /* Deliberately unbordered: Slack stacks reaction pills and the thread bar's
       hover box right under a message, and a bordered badge reads as one of them
       or collides with it. The -6px hover inset matches Slack's own. */
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

    /* Above the composer, not inside it, so it is never part of what you send. */
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

    /* Header button. Like the badge but bordered: the header has no pills to
       be confused with, and it has to read as pressable. */
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
    // Nothing to attach to yet at document start; the next flush tries again.
    const parent = document.head || document.documentElement;
    if (parent) parent.appendChild(style);
  }

  /* ------------------------------------------------------------- transport */

  let seq = 0;
  // Ids are per copy, so a reply meant for a replaced copy never resolves ours.
  const INSTANCE = Math.random().toString(36).slice(2, 8);
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
    const id = `${INSTANCE}-${++seq}`;
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

  // Padding tells. Length alone does not earn a condense; length plus these does.
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

  // Channel of the primary column, which the header button refers to.
  function channelName() {
    const primary = document.querySelector(SEL.primary);
    const el = primary?.querySelector(SEL.surfaceChannel) || document.querySelector(SEL.channel);
    const name = el?.textContent?.trim();
    if (name) return name;
    return (document.title || '').split('|')[0].trim() || null;
  }

  /*
   * Channel of the column the message is in, not of the page: a thread open
   * beside a channel belongs to the thread's channel. Memoised per surface for
   * one pass so a burst of messages does not cost a querySelector each.
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

  // Grouped messages only name the sender on the first, so walk back. This is
  // the priciest read here, so it runs only after triage.
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

  // A broadcast thread reply may have no content node; fall back to the list
  // item rather than silently never touching the message.
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
      // Skip the quoted parent of a broadcast reply.
      .filter((el) => !inPreamble(el))
      // Some layouts nest list-item sections; keep the outer one only, or the text
      // is sent twice and its padding scored twice.
      .filter((el, _i, all) => !all.some((other) => other !== el && other.contains(el)));
  }

  function textFor(body) {
    const sections = richSections(body);
    if (sections.length) return sections.map((el) => el.innerText).join('\n').trim();
    if (!body.querySelector(SEL.preamble)) return body.innerText.trim();
    // No rich text and a preamble in the way: read a detached copy without it.
    // innerText degrades to textContent there, which is fine for a rare path.
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

  // Keyed by a hash of the text, so re-renders and recycling cost one call.
  const verdicts = new Map();
  // textContent hash -> verdict key. textContent needs no layout, so a repair
  // pass never touches innerText.
  const sigs = new Map();

  const CLEAN = { flagged: false, rewrite: null };

  const failures = new Map(); // verdict key -> when the call for it failed
  const failedItems = new WeakMap(); // list item -> the key its call failed for

  function failedRecently(key) {
    const at = failures.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < RETRY_FAILED_MS) return true;
    failures.delete(key);
    return false;
  }

  function markFailed(key) {
    failures.set(key, Date.now());
    while (failures.size > MEMORY_MAX) failures.delete(failures.keys().next().value);
  }

  function remember(key, verdict) {
    verdicts.set(key, verdict);
    while (verdicts.size > MEMORY_MAX) verdicts.delete(verdicts.keys().next().value);
  }

  function link(sig, key) {
    sigs.set(sig, key);
    while (sigs.size > MEMORY_MAX) sigs.delete(sigs.keys().next().value);
  }

  // Flagged verdicts persist so a reload repaints rewrites without the daemon.
  // Clean verdicts are cheap to recompute and not stored.
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
    storeTimer = setTimeout(persistNow, 2000);
  }

  function persistNow() {
    clearTimeout(storeTimer);
    storeTimer = null;
    if (!CONFIG.persistVerdicts) return;
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
      // Private mode or a full quota; nothing worth failing a render over.
    }
  }

  /* -------------------------------------------------------------- rendering */

  const panels = new WeakMap(); // list item -> the panel we built for it
  // Revealed messages, keyed by content rather than node: revealing is a large
  // height change that often makes the virtual list re-render the row.
  const revealed = new Set();
  let revealAll = false;

  function setAttr(el, name, value) {
    // Identical writes still fire the observer and start a reconcile loop.
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

    // Re-attach if Slack re-rendered over it. Runs in the observer callback, so
    // it lands before paint.
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
    // Only opening is reported (the reader wanted the original); fire and forget.
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
      // Daemon restarting or page unloading; not worth reporting.
    });
  }

  // Triage suspects this one, so hide it while the model runs. The panel keeps
  // the original's height so nothing moves, and stays blank for
  // PENDING_LABEL_MS so a cached verdict swaps in with no placeholder.
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
    // Kept for the reveal report.
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

  // Pausing must also release pending holds, or they sit on "checking…" forever.
  function releaseHolds() {
    document.querySelectorAll('.slacken-panel[data-pending]').forEach((panel) => {
      const item = panel.closest(SEL.item);
      if (item) clearItem(item, bodyFor(item));
    });
  }

  function setAll(open) {
    revealAll = open;
    if (!open) revealed.clear();
    // Cmd+Shift+U is reported once, not once per message.
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
   * Header button that ignores or un-ignores the current channel. It lives here
   * because only the page knows which channel you mean; the daemon owns the list
   * and the button draws whatever it returns.
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
    // Nothing identifiable on screen (preferences, startup): no button.
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
    // Slack rebuilds the header on channel switch. Re-appended in the observer
    // callback, so it is back before paint.
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
      // Re-plan everything: an ignored channel must restore its originals, and an
      // un-ignored one needs checking again.
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
   * `plan` only reads the DOM and `commit` only writes it, so a batch costs one
   * layout rather than one per message. Interleaving them is slow enough to need
   * a debounce, and a debounce lets the original paint.
   */
  function plan(item, ctx) {
    if (item.closest(SEL.composer)) return null;

    const body = bodyFor(item);
    if (!body) return null;

    const raw = body.textContent || '';
    if (!raw.trim()) return null;

    // Per column, not per page: a thread beside a channel may be another channel.
    const channel = channelFor(item, ctx.memo);
    const settings = settingsFor(channel);
    const sig = hash(raw);
    const gate = gateFor(channel);
    const skey = `${sig}|${gate}`;
    const same = item.getAttribute(ATTR_HASH) === sig;
    const base = { item, body, sig, skey, channel, same };

    // Ignored channel. Checked before the caches so earlier rewrites and stored
    // verdicts give their originals back too.
    if (matchesAny(CONFIG.ignoreChannels, channel)) return { ...base, act: 'idle' };

    // Fast path: this exact text was judged before. No innerText, layout or call.
    const knownKey = sigs.get(skey);
    const cached = knownKey ? verdicts.get(knownKey) : null;
    if (cached) {
      return cached.flagged && cached.rewrite
        ? { ...base, act: 'apply', verdict: cached, key: knownKey, state: 'done' }
        : { ...base, act: 'clear', state: 'clean' };
    }

    // Paused: verdicts on screen stay (revealed by setAll); everything else is
    // released with no state stamped, so resuming examines it afresh.
    if (paused) return { ...base, act: 'idle' };

    // Per-item decisions, which cannot live in the text-keyed cache.
    if (same) {
      const state = item.getAttribute(ATTR_STATE);
      if (state === 'pending') return { ...base, act: 'pending' };
      if (state === 'skipped') return { ...base, act: 'clear', state };
      if (state === 'error' && failedRecently(failedItems.get(item))) {
        return { ...base, act: 'clear', state };
      }
    }

    // Undecided and off screen: leave it alone, hash included, so it is looked at
    // afresh when it scrolls in.
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
    if (failedRecently(key)) return { ...base, act: 'clear', state: 'error', key };
    log('triage', heuristicScore(text), paddingScore(text, settings), text.slice(0, 60));

    // Sender walk only now. Skips are per sender, so never cached by text.
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
      // Measured in the read half so the hold can keep the message's height.
      height: CONFIG.holdWhilePending ? body.offsetHeight : 0,
    };
  }

  function triageLine(text, settings = CONFIG) {
    return `tone ${heuristicScore(text)} of ${settings.triageThreshold} needed,`
      + ` padding ${paddingScore(text, settings)} of 1 needed, ${wordCount(text)} words`;
  }

  /*
   * Read-only account of one row for `slacken inspect`, mainly why nothing
   * happened to it. Writes nothing to the DOM or caches.
   */
  function diagnose(item) {
    const sender = senderFor(item);
    const threadReply = Boolean(item.querySelector(SEL.preamble));
    // Per row, not per page: a thread beside a channel may have other settings.
    const channel = channelFor(item, null);
    const settings = settingsFor(channel);
    const row = { sender, channel, threadReply, state: item.getAttribute(ATTR_STATE) };

    const body = bodyFor(item);
    if (!body) {
      // Day dividers and join notices have no body and are marked chrome. A
      // message-like row with no body is kept: it means an unknown layout.
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
    // CLEAN itself (not a verdict shaped like it) means triage cleared it and the
    // model never saw it, which is something a setting can change.
    if (known === CLEAN) return { ...row, why: `read as written; ${triageLine(text, settings)}` };
    if (known) return { ...row, why: 'the model read it and left it as written' };
    if (matchesAny(CONFIG.ignoreChannels, channel)) return { ...row, why: 'channel is on the ignore list' };
    if (paused) return { ...row, why: 'paused' };
    if (row.state === 'pending') return { ...row, why: 'waiting on the model' };
    if (row.state === 'error') return { ...row, why: 'the model call failed; it is asked again after a minute' };

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
    if (p.state === 'error' && p.key) failedItems.set(item, p.key);
    clearItem(item, body);
  }

  /*
   * Calls in flight, and the content signatures waiting on each. The same text
   * on screen twice (a thread copy, a cross-post) shares one call, so the other
   * copies must be woken explicitly when it lands or they stay pending. Tracked
   * here rather than read from the DOM because copies with the same verdict key
   * can have signatures that differ by whitespace.
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

    // Never leave a message hidden behind a hold that will not lift.
    const fail = () => {
      markFailed(p.key);
      for (const item of waitingItems(p.key, p.sig)) {
        if (item.getAttribute(ATTR_STATE) === 'pending') setAttr(item, ATTR_STATE, 'error');
        failedItems.set(item, p.key);
      }
    };

    ask({ text: p.text, sender: p.sender, channel: p.channel }).then((verdict) => {
      // A verdict landing during a pause says nothing about the message. Caching
      // it would leave the message unexamined after resuming.
      if (paused || verdict.reason === 'paused') {
        for (const item of waitingItems(p.key, p.sig)) {
          dirty.add(item);
          item.removeAttribute(ATTR_STATE);
          item.removeAttribute(ATTR_HASH);
        }
        return;
      }

      // The daemon could not judge it (claude failing, budget reached). Not
      // remembered, so it is retried after RETRY_FAILED_MS.
      if (verdict.error) {
        log('daemon error', verdict.error);
        fail();
        return;
      }

      remember(p.key, verdict);
      link(p.skey, p.key);
      persistSoon();
    }).catch((err) => {
      log('ask failed', err.message);
      fail();
    }).finally(() => {
      const items = waitingItems(p.key, p.sig);
      inFlight.delete(p.key);
      for (const item of items) {
        // `pending` is checked before the text is read, so it must be cleared or
        // this copy never sees the answer.
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
    // Before the early return: the button must follow a switch to an empty channel.
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
        // Our own attributes come back too. Re-planning re-asserts a hold Slack
        // stripped; `plan` is idempotent, so a correct attribute ends the loop.
        if (rec.target.nodeType === 1) collect(rec.target);
        continue;
      }
      collect(rec.target);
      rec.addedNodes.forEach(collect);
    }
    // Synchronous: observer callbacks run before paint, so the original never
    // gets a frame.
    flush();
  });

  // The document rather than <html>: on a new document this runs before
  // <html> exists, and observing null would throw and stop the script here.
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: Array.from(OUR_ATTRS),
  });
  cleanups.push(() => observer.disconnect());

  // Scrolling brings already-rendered items into range. rAF rather than a timer,
  // so it still lands before paint.
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
  listen(window, 'scroll', onScroll, { capture: true, passive: true });
  listen(window, 'resize', onScroll, { passive: true });

  // Backstop: the virtual list sometimes settles without a mutation we see.
  every(SWEEP_MS, () => {
    try {
      ensureStyle();
      sweep();
    } catch (err) {
      log('sweep failed', err.message);
    }
  });

  /*
   * Report list items against bodies found: items without bodies usually mean a
   * renamed class. No items is not reported, as an empty channel looks the same.
   */
  const HEALTH_MS = 60_000;
  function reportHealth() {
    const items = document.querySelectorAll(SEL.item);
    if (!items.length) return;
    let bodies = 0;
    for (const item of items) if (bodyFor(item)) bodies += 1;
    ask({ op: 'health', items: items.length, bodies }).catch(() => {});
  }
  function safeReportHealth() {
    try {
      reportHealth();
    } catch (err) {
      log('health failed', err.message);
    }
  }
  every(HEALTH_MS, safeReportHealth);
  // Once early, so a layout change is noticed in the first minute.
  const firstHealth = setTimeout(safeReportHealth, 4000);
  cleanups.push(() => clearTimeout(firstHealth));

  listen(window, 'keydown', (event) => {
    if (!(event.metaKey && event.shiftKey)) return;
    if (String(event.key || '').toLowerCase() !== 'u') return;
    event.preventDefault();
    setAll(!revealAll);
  });

  /* -------------------------------------------------------- notifications */

  /*
   * Slack raises notifications from the renderer, so the constructor can be
   * wrapped. A suspect notification is held behind a Deferred stand-in until the
   * verdict lands, as correcting it after it has been read is pointless. The wait
   * is capped at DEFER_MAX_MS, then the original is raised: a lost notification
   * is worse than a hostile one. If a Slack build raises notifications from its
   * main process, none of this runs and the menu bar count stays at zero.
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

    // Not a class: it returns a stand-in instead of `this` for held notifications.
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

    // Static members defer to the native constructor.
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
      cleanups.push(() => {
        if (window.Notification === Slackened) window.Notification = Native;
      });
    } catch (err) {
      log('could not wrap Notification', err.message);
    }
  }

  // Stand-in for a held notification. Records listeners and handlers and
  // replays them onto the real one when it is raised.
  class Deferred {
    constructor(Native, title, options) {
      this.Native = Native;
      this.title = title;
      this.options = options;
      this.real = null;
      this.closed = false;
      this.listeners = [];
      this.handlers = {};
      // Always raise it eventually, whatever happens upstream.
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
   * The only feature that reads what you write. Off by default, and it only
   * offers a flatter wording above the composer: nothing is sent or replaced
   * until you click. Tone only, never condensing.
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
    // Off or paused: hide now rather than schedule.
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
    // Tone only: the length of your own message is not flagged.
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
   * insertText rather than setting textContent: Slack's editor keeps its own
   * model and would restore the old text on the next keystroke. It also leaves
   * the change on the undo stack.
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

  listen(document, 'input', (event) => {
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    const composer = target.closest?.(SEL.composer);
    if (composer) scheduleDraftCheck(composer);
  }, true);

  // Read by `slacken inspect`. `missed` counts message bodies outside any list
  // item, which is what an unrecognised Slack layout looks like.
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

  // Called by the daemon on pause changes; the initial state is CONFIG.paused.
  window.__slackenSetPaused = (on) => {
    const next = Boolean(on);
    if (next === paused) return;
    paused = next;

    if (paused) {
      // Release pending holds (no verdict is coming). Decided rewrites keep their
      // badge and show the original.
      releaseHolds();
      setAll(true);
      log('paused: showing every original');
      sweep();
      return;
    }

    // Re-examine anything the pause left unexamined or released. Decided messages
    // keep their verdicts.
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

  // Settings changed, so every verdict is stale. Stored copies go too, or a
  // reload would repaint decisions made under the old rules.
  function forget() {
    document.querySelectorAll(`[${ATTR_STATE}]`).forEach((item) => {
      item.removeAttribute(ATTR_STATE);
      item.removeAttribute(ATTR_HASH);
      clearItem(item, bodyFor(item));
    });
    verdicts.clear();
    sigs.clear();
    revealed.clear();
    failures.clear();
    settingsCache.clear();
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      // Private mode, or storage turned off. Nothing to drop.
    }
  }

  // Called by the daemon on any settings change (menu bar, CLI, another window).
  window.__slackenSetConfig = (json) => {
    let next;
    try {
      next = JSON.parse(json);
    } catch {
      return;
    }
    // Pause has its own path (__slackenSetPaused); it only rides along here.
    delete next.paused;
    Object.assign(CONFIG, next);
    log('settings changed', CONFIG);
    forget();
    sweep();
  };

  // For the daemon, or a test that would rather not wait for the timer.
  window.__slackenReportHealth = safeReportHealth;

  window.__slackenRescan = () => {
    forget();
    sweep();
  };

  // Restore the page as Slack drew it and unhook everything. Verdicts persist in
  // localStorage, so the replacement repaints without asking again.
  window.__slackenTeardown = () => {
    persistNow();
    for (const undo of cleanups.splice(0)) {
      try {
        undo();
      } catch {
        // Keep undoing the rest.
      }
    }
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(draftTimer);
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    pending.clear();
    document.querySelectorAll(`[${ATTR_STATE}], [${ATTR_HOLD}]`).forEach((item) => {
      item.removeAttribute(ATTR_STATE);
      item.removeAttribute(ATTR_HASH);
      clearItem(item, bodyFor(item));
    });
    document.querySelectorAll(`[${ATTR_BODY}]`).forEach((el) => el.removeAttribute(ATTR_BODY));
    document.querySelectorAll('.slacken-panel, .slacken-draft').forEach((el) => el.remove());
    channelButton?.remove();
    document.getElementById(STYLE_ID)?.remove();
    delete window.__slackenTeardown;
    window.__SLACKEN__ = false;
  };

  loadStore();
  ensureStyle();
  sweep();
  log('page script ready', CONFIG);
})();
