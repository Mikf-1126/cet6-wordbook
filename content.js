'use strict';

/* =========================================================================
 *  划词单词本 · 页面脚本
 *  选中单词或句子 → 浮动按钮 / 自动弹卡 → 音标·释义·例句·考纲标签 → 一键存词
 *  UI 全部封装在 Shadow DOM 中，不污染宿主页面样式
 * ========================================================================= */

(function () {
  if (window.__wbWordBookLoaded) return;
  window.__wbWordBookLoaded = true;

  const HOST_ID = '__wb_wordbook_host__';

  const DEFAULT_SETTINGS = {
    trigger: 'button',
    showExamples: true,
    maxExamples: 2,
    autoSave: false
  };

  const settings = Object.assign({}, DEFAULT_SETTINGS);
  let host = null, shadow = null, triggerEl = null, cardEl = null, toastEl = null;
  let current = null;        // { text, result }
  let pendingRange = null;   // 最近一次有效的选区
  let busy = false;
  let closedAt = 0;          // 上次关闭卡片的时间，用来防「刚关又被同一次点击重开」
  let closedText = '';

  /* ------------------------------ 样式 ------------------------------ */

  const CSS = `
:host{
  all: initial;
  display: block;
  position: fixed;
  top: 0; left: 0;
  width: 0; height: 0;
  z-index: 2147483647;
  pointer-events: none;
}
*{ box-sizing: border-box; }
.wb-ui{
  --ink: #191919;
  --ink-2: #3A3733;
  --ink-3: #8A8279;
  --ink-4: #B5ADA1;
  --gold: #A2803C;
  --gold-2: #C9A96A;
  --gold-hi: #B5914C;
  --gold-lo: #94712B;
  --gold-soft: #F5EEE0;
  --hair: rgba(162, 128, 60, .16);
  --hair-2: rgba(162, 128, 60, .1);
  --paper: #FFFFFF;
  --paper-2: #FBF8F3;
  --paper-3: #F6F1E8;
  --line: #EBE5DA;
  --line-2: #F3EEE5;
  --ff-latin: Georgia, "Times New Roman", serif;
  --ff-sans: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  --sh-btn: inset 0 1px 0 rgba(255,255,255,.28), 0 2px 8px rgba(162,128,60,.25);
  font-family: var(--ff-sans);
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink-2);
  -webkit-font-smoothing: antialiased;
}

.wb-trigger{
  position: fixed;
  pointer-events: auto;
  width: 32px; height: 32px;
  border-radius: 10px;
  background: linear-gradient(180deg, var(--gold-hi), var(--gold-lo));
  border: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 2px 8px rgba(162,128,60,.32);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #fff;
  font-family: var(--ff-latin);
  font-size: 15px; font-weight: 700;
  user-select: none;
  padding: 0;
  transition: transform .16s cubic-bezier(.34,1.45,.64,1), box-shadow .16s ease, filter .16s ease;
}
.wb-trigger:hover{
  transform: translateY(-1px) scale(1.08);
  filter: brightness(1.06);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.38), 0 4px 14px rgba(162,128,60,.4);
}
.wb-trigger:active{ transform: scale(.96); }

.wb-card{
  position: fixed;
  pointer-events: auto;
  width: 362px;
  max-width: calc(100vw - 24px);
  background: rgba(255, 254, 251, .9);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--hair);
  border-radius: 14px;
  box-shadow:
    0 1px 2px rgba(25, 25, 25, .06),
    0 4px 12px rgba(162, 128, 60, .07),
    0 20px 48px rgba(25, 25, 25, .14);
  overflow: hidden;
  animation: wbIn .18s cubic-bezier(.2,.8,.3,1);
}
.wb-card::before{
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0; width: 2px;
  background: linear-gradient(180deg,
    var(--gold-2) 0%,
    rgba(201, 169, 106, .45) 42%,
    rgba(201, 169, 106, 0) 100%);
  pointer-events: none;
}
@keyframes wbIn{ from{ opacity: 0; transform: translateY(-7px) scale(.985); } to{ opacity: 1; transform: none; } }

.wb-head{
  display: flex; align-items: flex-start; gap: 8px;
  padding: 15px 12px 7px 16px;
  cursor: move;
}
.wb-word{
  flex: 1;
  font-family: var(--ff-latin);
  font-size: 22px; font-weight: 700; color: var(--ink);
  letter-spacing: -.015em; line-height: 1.28;
  word-break: break-word;
}
.wb-close{
  flex: 0 0 auto;
  width: 24px; height: 24px;
  border: none; background: transparent;
  color: var(--ink-3); cursor: pointer;
  border-radius: 7px; padding: 0;
  font-size: 17px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  font-family: inherit;
  opacity: .45;
  transition: opacity .16s ease, background .12s ease, color .12s ease;
}
.wb-close:hover{ opacity: 1; background: var(--paper-3); color: var(--ink); }

.wb-sub{
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  padding: 0 16px 13px;
  border-bottom: 1px solid var(--hair-2);
}
.wb-ipa{
  font-family: var(--ff-sans);
  font-size: 12.5px; color: var(--ink-3);
  background: rgba(201, 169, 106, .08);
  border-radius: 6px;
  padding: 2px 8px;
  letter-spacing: .005em;
}
.wb-tag{
  font-size: 10px; line-height: 1;
  padding: 4px 8px; border-radius: 20px;
  background: rgba(201, 169, 106, .14);
  color: var(--gold);
  border: 1px solid var(--hair);
  font-weight: 600; letter-spacing: .05em;
}
.wb-tag.plain{
  background: transparent; color: var(--ink-3);
  border: 1px solid var(--line); font-weight: 500;
}
.wb-speak{
  width: 24px; height: 24px; padding: 0;
  border: none; border-radius: 7px;
  background: transparent; color: var(--gold);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  opacity: .45;
  transition: opacity .16s ease, background .12s ease;
}
.wb-speak:hover{ opacity: 1; background: var(--gold-soft); }

.wb-lemma{
  flex: 0 0 100%;
  margin-top: 9px;
  padding: 5px 9px;
  background: rgba(201, 169, 106, .09);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.5;
}
.wb-lemma b{
  font-family: var(--ff-latin);
  font-size: 12.5px;
  color: var(--gold);
  font-weight: 600;
}

.wb-body{
  padding: 13px 16px 16px;
  max-height: 332px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.wb-body::-webkit-scrollbar{ width: 8px; }
.wb-body::-webkit-scrollbar-thumb{
  background: rgba(162, 128, 60, .18);
  border: 2px solid transparent;
  background-clip: padding-box;
  border-radius: 4px;
}
.wb-body::-webkit-scrollbar-thumb:hover{
  background: rgba(162, 128, 60, .34);
  background-clip: padding-box;
}
.wb-body::-webkit-scrollbar-track{ background: transparent; }

.wb-trans{ margin: 0; padding: 0; list-style: none; }
.wb-trans li{
  font-size: 15px; color: var(--ink-2);
  padding: 3px 0; line-height: 1.68;
}
.wb-pos{
  font-style: normal;
  color: var(--gold-2);
  font-size: 12.5px;
  margin-right: 3px;
  letter-spacing: .01em;
}
.wb-forms{
  margin: 9px 0 0; font-size: 11.5px; color: var(--ink-4);
  line-height: 1.7;
}

.wb-ex{
  margin-top: 10px;
  padding: 11px 13px;
  background: rgba(251, 248, 243, .7);
  border-radius: 11px;
}
.wb-ex-en{
  font-family: var(--ff-latin);
  font-size: 13px; color: var(--ink-2); line-height: 1.62;
}
.wb-ex-zh{
  font-size: 12.5px; color: var(--ink-3);
  margin-top: 4px; line-height: 1.62;
}

.wb-ctx{
  margin-top: 13px;
  padding: 2px 0 2px 11px;
  border-left: 2px solid rgba(201, 169, 106, .55);
  font-size: 12px; color: var(--ink-3);
  line-height: 1.72;
}
.wb-ctx b{
  display: block; color: var(--ink-4);
  font-size: 9px; letter-spacing: .16em;
  margin-bottom: 3px; font-weight: 600;
}

.wb-foot{
  display: flex; gap: 8px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--hair-2);
  background: rgba(251, 248, 243, .62);
}
.wb-btn{
  flex: 1; height: 34px;
  border-radius: 9px;
  border: none;
  background: linear-gradient(180deg, var(--gold-hi), var(--gold-lo));
  color: #fff;
  font-size: 13px; font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  letter-spacing: .015em;
  box-shadow: var(--sh-btn);
  transition: filter .15s ease, transform .1s ease, box-shadow .15s ease;
}
.wb-btn:hover{
  filter: brightness(1.06);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.36), 0 4px 14px rgba(162,128,60,.36);
}
.wb-btn:active{ transform: scale(.985); }
.wb-btn.ghost{
  background: rgba(255,255,255,.72);
  color: var(--gold);
  border: 1px solid var(--hair);
  box-shadow: none;
  font-weight: 600;
}
.wb-btn.ghost:hover{
  background: #fff;
  border-color: rgba(162,128,60,.3);
  filter: none;
  box-shadow: 0 2px 8px rgba(162,128,60,.12);
}
.wb-btn:disabled{
  opacity: .55; cursor: default;
  box-shadow: none; transform: none; filter: none;
}
.wb-btn.done{ background: linear-gradient(180deg, #7C6636, #6A5629); }

.wb-state{
  padding: 22px 6px;
  text-align: center;
  color: var(--ink-3); font-size: 13px;
  line-height: 1.7;
}
.wb-state .wb-err{ color: #A32D2D; }
.wb-link{
  display: inline-block; margin-top: 10px;
  color: var(--gold); cursor: pointer; font-size: 12.5px; font-weight: 600;
  border-bottom: 1px solid var(--gold-2);
  padding-bottom: 1px;
}
.wb-link:hover{ color: var(--gold); border-bottom-color: var(--gold); }

.wb-toast{
  position: fixed;
  pointer-events: none;
  padding: 9px 18px;
  border-radius: 22px;
  background: #1F1F1F;
  color: #fff;
  font-size: 12.5px;
  letter-spacing: .01em;
  box-shadow: 0 2px 6px rgba(25,25,25,.2), 0 12px 32px rgba(25,25,25,.3);
  animation: wbIn .18s cubic-bezier(.2,.8,.3,1);
}
`;

  /* ------------------------------ 工具 ------------------------------ */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 把释义开头的词性标记（n. / adj. / vt. …）单独包一层，好做视觉弱化 */
  function posLine(text) {
    const li = el('li');
    const s = String(text == null ? '' : text);
    const m = s.match(/^([a-z]{1,6}\.\s*)([\s\S]+)$/i);
    if (m) {
      li.appendChild(el('span', 'wb-pos', m[1].trim()));
      li.appendChild(document.createTextNode(' ' + m[2]));
    } else {
      li.textContent = s;
    }
    return li;
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false, error: '没有响应' });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return true;
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const root = el('div', 'wb-ui');
    root.setAttribute('part', 'ui');
    shadow.appendChild(root);
    host.__wbRoot = root;

    (document.body || document.documentElement).appendChild(host);
    return true;
  }

  function uiRoot() {
    ensureHost();
    return host.__wbRoot;
  }

  function isOurs(node) {
    if (!host) return false;
    let n = node;
    while (n) {
      if (n === host) return true;
      n = n.parentNode || n.host || null;
    }
    return false;
  }

  /* --------------------------- 选区与上下文 --------------------------- */

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = String(sel.toString() || '').trim();
    if (!text || text.length > 800) return null;

    const range = sel.getRangeAt(0);
    if (isOurs(range.commonAncestorContainer)) return null;

    let rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      const rects = range.getClientRects();
      rect = rects && rects.length ? rects[rects.length - 1] : null;
    }
    if (!rect) return null;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;

    return { text: text, range: range, rect: rect };
  }

  function contextSentence(range, text) {
    try {
      const node = range.startContainer;
      let block = node.nodeType === 1 ? node : node.parentElement;
      if (!block) return '';
      for (let i = 0; i < 4 && block && block.parentElement; i++) {
        const len = (block.textContent || '').trim().length;
        if (len >= text.length + 24) break;
        block = block.parentElement;
      }
      const full = String(block && block.textContent || '').replace(/\s+/g, ' ').trim();
      if (!full) return '';
      const idx = full.indexOf(text);
      if (idx < 0) return full.slice(0, 200);

      const STOP = /[.!?;。！？；]/;
      let s = idx;
      while (s > 0 && !STOP.test(full[s - 1])) s--;
      let e = idx + text.length;
      while (e < full.length && !STOP.test(full[e])) e++;
      let out = full.slice(s, Math.min(e + 1, full.length)).trim();
      if (out.length > 280) out = out.slice(0, 280) + '…';
      return out;
    } catch (e) {
      return '';
    }
  }

  /* ------------------------------ 触发按钮 ------------------------------ */

  function hideTrigger() {
    if (triggerEl) { triggerEl.remove(); triggerEl = null; }
  }

  function showTrigger(sel) {
    hideTrigger();
    const root = uiRoot();
    triggerEl = el('button', 'wb-trigger', '译');
    triggerEl.title = '翻译选中内容';
    const r = sel.rect;
    let x = r.right + 6;
    let y = r.bottom + 6;
    if (x + 30 > window.innerWidth - 8) x = Math.max(8, window.innerWidth - 38);
    if (y + 30 > window.innerHeight - 8) y = Math.max(8, r.top - 36);
    triggerEl.style.left = Math.round(x) + 'px';
    triggerEl.style.top = Math.round(y) + 'px';
    triggerEl.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
    triggerEl.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      hideTrigger();
      openCard(sel.text, sel.range);
    });
    root.appendChild(triggerEl);
  }

  /* ------------------------------- 卡片 ------------------------------- */

  function closeCard() {
    if (cardEl) { cardEl.remove(); cardEl = null; }
    current = null;
    pendingRange = null;
  }

  function placeCard(anchorRect) {
    if (!cardEl) return;
    const w = cardEl.offsetWidth || 344;
    const h = cardEl.offsetHeight || 240;
    let x = anchorRect ? anchorRect.left : (window.innerWidth - w) / 2;
    let y = anchorRect ? anchorRect.bottom + 10 : 80;
    x = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    if (y + h > window.innerHeight - 8) {
      y = anchorRect ? Math.max(8, anchorRect.top - h - 10) : Math.max(8, window.innerHeight - h - 8);
    }
    cardEl.style.left = Math.round(x) + 'px';
    cardEl.style.top = Math.round(y) + 'px';
  }

  function makeDraggable(card, handle) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;
      dragging = true;
      const r = card.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const w = card.offsetWidth, h = card.offsetHeight;
      const x = Math.min(Math.max(-w + 60, e.clientX - dx), window.innerWidth - 60);
      const y = Math.min(Math.max(0, e.clientY - dy), window.innerHeight - 30);
      card.style.left = Math.round(x) + 'px';
      card.style.top = Math.round(y) + 'px';
    }, true);
    window.addEventListener('mouseup', function () { dragging = false; }, true);
  }

  function speakIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p1 = document.createElementNS(ns, 'path');
    p1.setAttribute('d', 'M11 5 6 9H2v6h4l5 4V5z');
    const p2 = document.createElementNS(ns, 'path');
    p2.setAttribute('d', 'M15.5 8.5a5 5 0 0 1 0 7');
    svg.appendChild(p1);
    svg.appendChild(p2);
    return svg;
  }

  function playAudio(word, speakUrl) {
    try {
      const url = speakUrl || ('https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=2');
      const a = new Audio(url);
      a.volume = 1;
      a.play().catch(function () { /* 自动播放被拦截时忽略 */ });
    } catch (e) { /* ignore */ }
  }

  function renderCard(result) {
    const root = uiRoot();
    if (cardEl) cardEl.remove();

    cardEl = el('div', 'wb-card');
    const anchor = pendingRange;

    const head = el('div', 'wb-head');
    const word = el('div', 'wb-word', result.text);
    const close = el('button', 'wb-close', '×');
    close.title = '关闭';
    close.addEventListener('click', closeCard);
    head.appendChild(word);
    head.appendChild(close);

    const sub = el('div', 'wb-sub');
    if (result.phonetic) sub.appendChild(el('span', 'wb-ipa', '/' + result.phonetic + '/'));
    const speak = el('button', 'wb-speak');
    speak.title = '朗读';
    speak.appendChild(speakIcon());
    speak.addEventListener('click', function () { playAudio(result.text, result.speakUrl); });
    sub.appendChild(speak);
    (result.tags || []).forEach(function (t) {
      const isExam = /CET4|CET6|考研|高中|初中|GRE|TOEFL|IELTS/.test(t);
      sub.appendChild(el('span', isExam ? 'wb-tag' : 'wb-tag plain', t));
    });

    /* 选中的是变形词时，标明它是从哪个形式还原过来的 */
    if (result.inflected && result.query && result.query !== result.text) {
      const lemma = el('div', 'wb-lemma');
      lemma.appendChild(document.createTextNode('选中形式 '));
      lemma.appendChild(el('b', null, result.query));
      lemma.appendChild(document.createTextNode('　→　原形 '));
      lemma.appendChild(el('b', null, result.text));
      sub.appendChild(lemma);
    }

    const body = el('div', 'wb-body');
    const ol = el('ol', 'wb-trans');
    (result.trans || []).forEach(function (t) {
      ol.appendChild(posLine(t));
    });
    body.appendChild(ol);

    if (result.forms && result.forms.length) {
      body.appendChild(el('div', 'wb-forms', result.forms.join('　')));
    }

    if (settings.showExamples && result.examples && result.examples.length) {
      result.examples.slice(0, settings.maxExamples).forEach(function (ex) {
        const box = el('div', 'wb-ex');
        box.appendChild(el('div', 'wb-ex-en', ex.en));
        box.appendChild(el('div', 'wb-ex-zh', ex.zh));
        body.appendChild(box);
      });
    }

    const ctx = pendingRange ? contextSentence(pendingRange, result.text) : '';
    if (ctx && ctx.toLowerCase().indexOf(String(result.text).toLowerCase()) >= 0) {
      const cbox = el('div', 'wb-ctx');
      const lab = el('b', null, '原文上下文');
      cbox.appendChild(lab);
      cbox.appendChild(document.createTextNode(ctx));
      body.appendChild(cbox);
    }

    const foot = el('div', 'wb-foot');
    const saveBtn = el('button', 'wb-btn', '加入单词本');
    const copyBtn = el('button', 'wb-btn ghost', '复制');
    copyBtn.addEventListener('click', function () {
      const txt = result.text + '\t' + (result.phonetic ? '/' + result.phonetic + '/ ' : '') + (result.trans || []).join('；');
      navigator.clipboard.writeText(txt).then(function () {
        copyBtn.textContent = '已复制';
        setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
      }).catch(function () { toast('复制失败，请手动选择'); });
    });
    saveBtn.addEventListener('click', function () { doSave(saveBtn, result, ctx); });
    foot.appendChild(saveBtn);
    foot.appendChild(copyBtn);

    cardEl.appendChild(head);
    cardEl.appendChild(sub);
    cardEl.appendChild(body);
    cardEl.appendChild(foot);
    root.appendChild(cardEl);
    makeDraggable(cardEl, head);
    placeCard(anchor);
  }

  function renderLoading(text) {
    const root = uiRoot();
    if (cardEl) cardEl.remove();
    cardEl = el('div', 'wb-card');
    const head = el('div', 'wb-head');
    head.appendChild(el('div', 'wb-word', text.length > 60 ? text.slice(0, 60) + '…' : text));
    const close = el('button', 'wb-close', '×');
    close.addEventListener('click', closeCard);
    head.appendChild(close);
    const body = el('div', 'wb-body');
    body.appendChild(el('div', 'wb-state', '查询中…'));
    cardEl.appendChild(head);
    cardEl.appendChild(body);
    root.appendChild(cardEl);
    makeDraggable(cardEl, head);
    placeCard(pendingRange);
  }

  function renderError(text, message, retryFn) {
    const root = uiRoot();
    if (cardEl) cardEl.remove();
    cardEl = el('div', 'wb-card');
    const head = el('div', 'wb-head');
    head.appendChild(el('div', 'wb-word', text.length > 60 ? text.slice(0, 60) + '…' : text));
    const close = el('button', 'wb-close', '×');
    close.addEventListener('click', closeCard);
    head.appendChild(close);
    const body = el('div', 'wb-body');
    const st = el('div', 'wb-state');
    st.appendChild(el('div', 'wb-err', message));
    const link = el('span', 'wb-link', '重试');
    link.addEventListener('click', retryFn);
    st.appendChild(link);
    body.appendChild(st);
    cardEl.appendChild(head);
    cardEl.appendChild(body);
    root.appendChild(cardEl);
    makeDraggable(cardEl, head);
    placeCard(pendingRange);
  }

  function toast(msg) {
    const root = uiRoot();
    if (toastEl) toastEl.remove();
    toastEl = el('div', 'wb-toast', msg);
    toastEl.style.left = '50%';
    toastEl.style.top = '24px';
    toastEl.style.transform = 'translateX(-50%)';
    root.appendChild(toastEl);
    setTimeout(function () {
      if (toastEl) { toastEl.remove(); toastEl = null; }
    }, 1600);
  }

  /* ------------------------------ 主流程 ------------------------------ */

  async function openCard(text, range) {
    pendingRange = range || null;
    hideTrigger();
    renderLoading(text);

    const res = await send({ type: 'TRANSLATE', text: text });
    if (!res.ok) {
      renderError(text, res.error || '翻译失败', function () { openCard(text, pendingRange); });
      return;
    }
    current = { text: text, result: res.data };
    renderCard(res.data);

    if (settings.autoSave) {
      const btn = cardEl && cardEl.querySelector('.wb-btn');
      if (btn) doSave(btn, res.data, pendingRange ? contextSentence(pendingRange, text) : '');
    }
  }

  async function doSave(btn, result, ctx) {
    if (busy) return;
    busy = true;
    const old = btn.textContent;
    btn.textContent = '保存中…';
    btn.disabled = true;

    const res = await send({
      type: 'SAVE',
      entry: {
        text: result.text,
        origin: result.inflected && result.query ? result.query : '',
        kind: result.kind || 'word',
        phonetic: result.phonetic || '',
        trans: result.trans || [],
        examples: result.examples || [],
        forms: result.forms || [],
        tags: result.tags || [],
        context: ctx || '',
        sourceTitle: document.title || '',
        sourceUrl: location.href || ''
      }
    });

    busy = false;
    btn.disabled = false;

    if (res && res.ok) {
      btn.textContent = res.duplicated ? '已在单词本（+1）' : '已加入单词本';
      btn.classList.add('done');
      toast(res.duplicated ? '该词已在单词本中，查词次数 +1' : '已加入单词本 · 共 ' + res.total + ' 条');
      setTimeout(function () {
        btn.textContent = old;
        btn.classList.remove('done');
      }, 2200);
    } else {
      btn.textContent = old;
      toast((res && res.error) || '保存失败');
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  let mouseTimer = null;

  document.addEventListener('mouseup', function (ev) {
    if (isOurs(ev.target)) return;
    clearTimeout(mouseTimer);
    mouseTimer = setTimeout(function () {
      const sel = readSelection();
      if (!sel) { hideTrigger(); return; }
      /* 刚刚因为点击空白处关掉了同一段文字，就别马上重开 */
      if (Date.now() - closedAt < 400 && sel.text === closedText) return;
      if (settings.trigger === 'auto') {
        openCard(sel.text, sel.range);
      } else if (settings.trigger === 'button') {
        showTrigger(sel);
      }
    }, 10);
  }, true);

  document.addEventListener('mousedown', function (ev) {
    if (isOurs(ev.target)) return;
    hideTrigger();
    /* 点卡片以外的任何地方都关掉卡片；若这一次点击又选中了新词，
       mouseup 会重新开一张，所以不会误伤 */
    if (cardEl) {
      closedAt = Date.now();
      closedText = current ? current.text : '';
      closeCard();
    }
  }, true);

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { hideTrigger(); closeCard(); }
  }, true);

  window.addEventListener('scroll', function () { hideTrigger(); }, true);
  window.addEventListener('resize', function () { hideTrigger(); }, true);

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;

    if (msg.type === 'WB_PING') {
      sendResponse({
        ok: true,
        isTop: window === window.top,
        frameCount: window.frames.length,
        url: location.href,
        trigger: settings.trigger,
        hostMounted: !!(host && document.documentElement.contains(host))
      });
      return true;
    }

    if (msg.type === 'WB_TEST_CARD') {
      openCard('sustainability', null);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'WB_TRANSLATE_SELECTION') {
      openCard(msg.text, null);
      sendResponse({ ok: true });
    } else if (msg.type === 'WB_SAVE_SELECTION') {
      (async function () {
        const res = await send({ type: 'TRANSLATE', text: msg.text });
        if (!res.ok) { toast(res.error || '翻译失败'); return; }
        const d = res.data;
        const saved = await send({
          type: 'SAVE',
          entry: {
            text: d.text, origin: d.inflected && d.query ? d.query : '',
            kind: d.kind || 'word', phonetic: d.phonetic || '',
            trans: d.trans || [], examples: d.examples || [], forms: d.forms || [],
            tags: d.tags || [], context: '',
            sourceTitle: document.title || '', sourceUrl: location.href || ''
          }
        });
        toast(saved && saved.ok
          ? (saved.duplicated ? '该词已在单词本中，查词次数 +1' : '已加入单词本 · 共 ' + saved.total + ' 条')
          : ((saved && saved.error) || '保存失败'));
      })();
      sendResponse({ ok: true });
    }
    return true;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.settings) {
      Object.assign(settings, DEFAULT_SETTINGS, changes.settings.newValue || {});
    }
  });

  chrome.storage.local.get({ settings: null }, function (s) {
    Object.assign(settings, DEFAULT_SETTINGS, (s && s.settings) || {});
  });
})();
