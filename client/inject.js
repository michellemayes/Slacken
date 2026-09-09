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
    channel: '[data-qa="channel_name"]',
    self: '[data-qa="user-button"]',
    composer: '[data-qa="message_input"], .ql-editor',
  };

  const log = (...args) => { if (CONFIG.verbose) console.log('[slacken]', ...args); };

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

    .slacken-panel { margin: 2px 0 0; }
    .slacken-rewrite {
      line-height: 1.46668;
      font-size: 15px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .slacken-panel[data-open="1"] .slacken-rewrite { display: none; }
    .slacken-badge {
      display: inline-flex; align-items: center; gap: 5px;
      margin-top: 3px; padding: 1px 8px;
      font-size: 11px; line-height: 17px; font-weight: 500;
      color: inherit; opacity: .62;
      background: transparent;
      border: 1px solid rgba(127,127,127,.45); border-radius: 10px;
      cursor: pointer; user-select: none;
    }
    .slacken-badge:hover { opacity: 1; border-color: rgba(127,127,127,.8); }
    .slacken-badge[hidden] { display: none; }
    .slacken-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #d9a441; flex: 0 0 auto;
    }
    .slacken-badge[data-severity="3"] .slacken-dot { background: #e01e5a; }
    .slacken-badge[data-kind="condensed"] .slacken-dot { background: #5b8def; }
    .slacken-action { opacity: .75; }
    .slacken-pending { opacity: .45; font-style: italic; }
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

  function paddingScore(text) {
    if (!CONFIG.condenseEnabled) return 0;
    if (hasCode(text)) return 0;
    // Mostly a bare link is not padding, it is a link.
    if (/^\s*<?https?:\/\/\S+>?\s*$/.test(text)) return 0;

    const words = wordCount(text);
    if (words < CONFIG.condenseMinWords) return 0;

    let tells = 0;
    for (const re of AI_TELLS) if (re.test(text)) tells += 1;
    if ((text.match(/^\s*([-*•]|\d+\.)\s+/gm) || []).length >= 3) tells += 1;
    if ((text.match(/\n\s*\n/g) || []).length >= 2) tells += 1;
    if (words >= 120) tells += 1;
    return tells;
  }

  function shouldAsk(text) {
    if (CONFIG.triageMode === 'always') return true;
    return heuristicScore(text) >= CONFIG.triageThreshold || paddingScore(text) >= 1;
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

  function channelName() {
    const el = document.querySelector(SEL.channel);
    const name = el?.textContent?.trim();
    if (name) return name;
    return (document.title || '').split('|')[0].trim() || null;
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

  function bodyFor(item) {
    const content = item.querySelector(SEL.content);
    if (!content) return null;
    const blocks = content.querySelector(SEL.blocks);
    if (blocks) return blocks;
    // Older layouts put rich text straight under the content node.
    const rich = content.querySelector(SEL.rich);
    return rich ? rich.parentElement : null;
  }

  function textFor(body) {
    const sections = body.querySelectorAll(SEL.rich);
    const source = sections.length ? Array.from(sections) : [body];
    return source.map((el) => el.innerText).join('\n').trim();
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
    setHold(item, body, item.getAttribute(ATTR_HOLD) === '0');
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

  function applyVerdict(item, body, verdict, keepOpen) {
    const refs = ensurePanel(item, body);

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

    setHold(item, body, !(keepOpen || revealAll));
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
    document.querySelectorAll(`[${ATTR_STATE}="done"]`).forEach((item) => {
      if (!item.hasAttribute(ATTR_HOLD)) return;
      const body = bodyFor(item);
      if (body) setHold(item, body, !open);
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

    const sig = hash(raw);
    const same = item.getAttribute(ATTR_HASH) === sig;
    const base = { item, body, sig, same };

    // Fast path: we have judged this exact text before, here or anywhere else.
    // No innerText, no layout, no call.
    const knownKey = sigs.get(sig);
    const cached = knownKey ? verdicts.get(knownKey) : null;
    if (cached) {
      return cached.flagged && cached.rewrite
        ? { ...base, act: 'apply', verdict: cached, state: 'done' }
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
    if (!text || text.length > CONFIG.maxChars) return { ...base, act: 'clear', state: 'clean' };

    const key = hash(text);
    const known = verdicts.get(key);
    if (known) {
      link(sig, key);
      return known.flagged && known.rewrite
        ? { ...base, act: 'apply', verdict: known, state: 'done' }
        : { ...base, act: 'clear', state: 'clean' };
    }

    if (!shouldAsk(text)) {
      remember(key, CLEAN);
      link(sig, key);
      return { ...base, act: 'clear', state: 'clean' };
    }
    log('triage', heuristicScore(text), paddingScore(text), text.slice(0, 60));

    // Only now is the sender walk worth its cost, and a skip is per-sender so
    // it never goes in the text-keyed cache.
    const sender = senderFor(item);
    const me = selfName();
    if ((me && sender === me)
      || matchesAny(CONFIG.selfNames, sender)
      || matchesAny(CONFIG.ignoreSenders, sender)
      || matchesAny(CONFIG.ignoreChannels, ctx.channel)) {
      return { ...base, act: 'clear', state: 'skipped' };
    }

    return {
      ...base,
      act: 'ask',
      key,
      text,
      sender,
      channel: ctx.channel,
      // Read the height now, in the read half, so the hold can keep the
      // message's place without shifting the page.
      height: CONFIG.holdWhilePending ? body.offsetHeight : 0,
    };
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
      applyVerdict(item, body, p.verdict, p.same && item.getAttribute(ATTR_HOLD) === '0');
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

  const inFlight = new Set();

  // Every copy of this text on screen, not just the one that asked for it.
  function itemsFor(sig) {
    return Array.from(document.querySelectorAll(`[${ATTR_HASH}="${sig}"]`));
  }

  function startAsk(p) {
    if (inFlight.has(p.key)) return;
    inFlight.add(p.key);

    ask({ text: p.text, sender: p.sender, channel: p.channel }).then((verdict) => {
      if (verdict.error) log('daemon error', verdict.error);

      // A verdict that lands after a pause began says nothing about the
      // message, only about the pause. Remembering it would leave this message
      // unexamined for as long as the page lived, long after resuming.
      if (paused || verdict.reason === 'paused') {
        for (const item of itemsFor(p.sig)) {
          dirty.add(item);
          item.removeAttribute(ATTR_STATE);
          item.removeAttribute(ATTR_HASH);
        }
        return;
      }

      remember(p.key, verdict);
      link(p.sig, p.key);
      persistSoon();
    }).catch((err) => {
      log('ask failed', err.message);
      // Never leave a message hidden behind a hold that will not lift.
      for (const item of itemsFor(p.sig)) {
        if (item.getAttribute(ATTR_STATE) === 'pending') setAttr(item, ATTR_STATE, 'error');
      }
    }).finally(() => {
      inFlight.delete(p.key);
      for (const item of itemsFor(p.sig)) dirty.add(item);
      flush();
    });
  }

  /* ------------------------------------------------------------ scheduling */

  const dirty = new Set();

  function flush() {
    if (!dirty.size) return;
    ensureStyle();
    const items = Array.from(dirty);
    dirty.clear();

    const ctx = { channel: channelName() };
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

  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey && event.shiftKey)) return;
    if (event.key.toLowerCase() !== 'u') return;
    event.preventDefault();
    setAll(!revealAll);
  });

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

  window.__slackenRescan = () => {
    document.querySelectorAll(`[${ATTR_STATE}]`).forEach((item) => {
      item.removeAttribute(ATTR_STATE);
      item.removeAttribute(ATTR_HASH);
      clearItem(item, bodyFor(item));
    });
    verdicts.clear();
    sigs.clear();
    sweep();
  };

  loadStore();
  ensureStyle();
  sweep();
  log('page script ready', CONFIG);
})();
