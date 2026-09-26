'use strict';

const $ = function (id) { return document.getElementById(id); };

let WORDS = [];
let filter = 'all';
let keyword = '';
let sortBy = 'new';
let reviewQueue = [];
let reviewIdx = 0;

/* ------------------------------ 基础 ------------------------------ */

/* 直接双击打开 notebook.html 时没有扩展环境，用内存数据做界面预览 */
const IS_DEMO = (typeof chrome === 'undefined') || !chrome.runtime || !chrome.runtime.sendMessage;

const DEMO_SEED = [
  {
    id: 'demo1', text: 'sustainability', kind: 'word', phonetic: 'səˌsteɪnəˈbɪləti',
    trans: ['n. 持续性，能维持性'],
    examples: [{ en: 'If these messages of ethics and sustainability resonate with them, you get a ripple effect.', zh: '如果这些道德和可持续性的讯息可以让他们产生共鸣，你就可以得到连锁反应。' }],
    forms: [], tags: ['CET4', 'CET6', 'GRE'],
    context: 'The report questions the sustainability of current farming practices in the region.',
    sourceTitle: 'The Conversation · Food and farming', sourceUrl: 'https://theconversation.com/',
    note: '记：sustain（维持）+ ability（能力）→ 能维持下去的性质', starred: true, mastered: false,
    hits: 3, createdAt: Date.now() - 86400000 * 2, updatedAt: Date.now()
  },
  {
    id: 'demo2', text: 'inadequate', kind: 'word', phonetic: 'ɪnˈædɪkwət',
    trans: ['adj. 不充分的，不足的，不够好的；不能胜任的，信心不足的'],
    examples: [{ en: 'Regulators said the new rules were inadequate to prevent safety risks.', zh: '监管机构表示，新规定不足以防范安全风险。' }],
    forms: ['副词：inadequately'], tags: ['CET6', 'IELTS', 'GRE'],
    context: 'inadequate regulation has long been blamed for a series of safety accidents.',
    sourceTitle: 'The Guardian · Environment', sourceUrl: 'https://www.theguardian.com/',
    note: '', starred: false, mastered: false,
    hits: 1, createdAt: Date.now() - 86400000, updatedAt: Date.now()
  },
  {
    id: 'demo3', text: 'Maximize utilization of existing resources.', kind: 'sentence', phonetic: '',
    trans: ['最大限度地利用现有资源。'],
    examples: [], forms: [], tags: [],
    context: '', sourceTitle: '六级翻译练习', sourceUrl: '',
    note: '', starred: false, mastered: true,
    hits: 1, createdAt: Date.now() - 3600000, updatedAt: Date.now()
  }
];

function demoSend(msg) {
  const store = demoSend._store || (demoSend._store = DEMO_SEED.slice());
  switch (msg.type) {
    case 'LIST': return Promise.resolve({ ok: true, words: store, settings: {} });
    case 'UPDATE': {
      const i = store.findIndex(function (w) { return w.id === msg.id; });
      if (i >= 0) Object.assign(store[i], msg.patch || {});
      return Promise.resolve({ ok: true, entry: store[i] });
    }
    case 'DELETE':
      demoSend._store = store.filter(function (w) { return w.id !== msg.id; });
      return Promise.resolve({ ok: true });
    case 'CLEAR':
      demoSend._store = [];
      return Promise.resolve({ ok: true });
    case 'EXPORT': {
      const fmt = msg.format || 'csv';
      const day = new Date().toISOString().slice(0, 10);
      if (fmt === 'docx' || fmt === 'xlsx') {
        return Promise.resolve({
          ok: false,
          error: '预览模式不支持生成二进制文件（' + fmt + '），装好扩展后即可使用'
        });
      }
      if (fmt === 'json') {
        return Promise.resolve({
          ok: true, filename: '六级词汇本-' + day + '.json',
          mime: 'application/json', text: JSON.stringify(store, null, 2)
        });
      }
      const head = ['序号', '单词/句子', '音标', '释义', '例句', '上下文', '来源', '标签', '备注', '查词次数'];
      const rows = [head];
      store.forEach(function (w, i) {
        rows.push([i + 1, w.text, w.phonetic, (w.trans || []).join('；'),
          (w.examples || []).map(function (e) { return e.en + ' | ' + e.zh; }).join(' // '),
          w.context, w.sourceTitle, (w.tags || []).join('/'), w.note, w.hits]);
      });
      const csv = '\ufeff' + rows.map(function (r) {
        return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
      }).join('\r\n');
      return Promise.resolve({
        ok: true, filename: '六级词汇本-' + day + '.csv',
        mime: 'text/csv;charset=utf-8', text: csv
      });
    }
    default: return Promise.resolve({ ok: false, error: '预览模式不支持该操作' });
  }
}

function send(msg) {
  if (IS_DEMO) return demoSend(msg);
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (res) {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (res || { ok: false }));
    });
  });
}

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

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.hidden = true; }, 1900);
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** 统一导出入口：docx / xlsx 走 base64，其余走文本 */
async function exportAs(fmt, btn) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; }
  toast('正在生成…');

  const res = await send({ type: 'EXPORT', format: fmt });
  if (btn) { btn.disabled = false; btn.innerHTML = old; }

  if (!res.ok) { toast('导出失败：' + (res.error || '未知错误')); return; }

  const blob = res.base64
    ? new Blob([b64ToBytes(res.base64)], { type: res.mime })
    : new Blob([res.text], { type: res.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  toast('已导出 ' + res.filename);
}

function stamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function isExamTag(t) { return /CET4|CET6|考研|GRE|TOEFL|IELTS|高中|初中/.test(t); }

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

/* ------------------------------ 过滤 ------------------------------ */

function visibleWords() {
  const kw = keyword.trim().toLowerCase();
  let list = WORDS.slice();

  if (filter === 'cet6') list = list.filter(function (w) { return (w.tags || []).indexOf('CET6') >= 0; });
  else if (filter === 'exam') list = list.filter(function (w) { return (w.tags || []).some(isExamTag); });
  else if (filter === 'star') list = list.filter(function (w) { return w.starred; });
  else if (filter === 'todo') list = list.filter(function (w) { return !w.mastered; });
  else if (filter === 'done') list = list.filter(function (w) { return w.mastered; });
  else if (filter === 'sentence') list = list.filter(function (w) { return w.kind === 'sentence'; });

  if (kw) {
    list = list.filter(function (w) {
      const hay = [w.text, w.origin, (w.trans || []).join(' '), w.context, w.note, w.sourceTitle].join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }

  if (sortBy === 'new') list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  else if (sortBy === 'old') list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  else if (sortBy === 'hits') list.sort(function (a, b) { return (b.hits || 1) - (a.hits || 1); });
  else if (sortBy === 'az') list.sort(function (a, b) { return String(a.text).localeCompare(String(b.text)); });

  return list;
}

/* ------------------------------ 渲染 ------------------------------ */

function speakIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
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

function speak(w) {
  try {
    const a = new Audio('https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(w.text) + '&type=2');
    a.play().catch(function () {});
  } catch (e) { /* ignore */ }
}

function buildCard(w) {
  const card = el('div', 'card' + (w.mastered ? ' mastered' : ''));

  /* 头部 */
  const top = el('div', 'card-top');
  const left = el('div');
  left.style.flex = '1';
  left.style.minWidth = '0';
  left.appendChild(el('div', 'head-word', w.text));

  if (w.tags && w.tags.length) {
    const tags = el('div', 'tags');
    w.tags.forEach(function (t) {
      tags.appendChild(el('span', isExamTag(t) ? 'tag' : 'tag plain', t));
    });
    left.appendChild(tags);
  }
  top.appendChild(left);

  const acts = el('div', 'acts');

  const starBtn = el('button', 'iconbtn' + (w.starred ? ' on' : ''), '★');
  starBtn.title = '收藏';
  starBtn.addEventListener('click', async function () {
    const r = await send({ type: 'UPDATE', id: w.id, patch: { starred: !w.starred } });
    if (r.ok) { w.starred = !w.starred; render(); }
  });

  const okBtn = el('button', 'iconbtn' + (w.mastered ? ' on' : ''), '✓');
  okBtn.title = w.mastered ? '标记为未掌握' : '标记为已掌握';
  okBtn.addEventListener('click', async function () {
    const r = await send({ type: 'UPDATE', id: w.id, patch: { mastered: !w.mastered } });
    if (r.ok) { w.mastered = !w.mastered; render(); }
  });

  const delBtn = el('button', 'iconbtn', '×');
  delBtn.title = '删除';
  delBtn.addEventListener('click', async function () {
    if (delBtn.dataset.armed !== '1') {
      delBtn.dataset.armed = '1';
      delBtn.textContent = '!';
      delBtn.title = '再点一次删除';
      setTimeout(function () {
        delBtn.dataset.armed = '0';
        delBtn.textContent = '×';
        delBtn.title = '删除';
      }, 3000);
      return;
    }
    const r = await send({ type: 'DELETE', id: w.id });
    if (r.ok) { WORDS = WORDS.filter(function (x) { return x.id !== w.id; }); render(); }
  });

  acts.appendChild(starBtn);
  acts.appendChild(okBtn);
  acts.appendChild(delBtn);
  top.appendChild(acts);
  card.appendChild(top);

  /* 音标 */
  if (w.phonetic) {
    const ipa = el('div', 'ipa');
    ipa.appendChild(document.createTextNode(w.lang === 'zh' ? w.phonetic : '/' + w.phonetic + '/'));
    const sp = el('button');
    sp.title = '朗读';
    sp.appendChild(speakIcon());
    sp.addEventListener('click', function () { speak(w); });
    ipa.appendChild(sp);
    card.appendChild(ipa);
  } else {
    const ipa = el('div', 'ipa');
    const sp = el('button');
    sp.title = '朗读';
    sp.appendChild(speakIcon());
    sp.addEventListener('click', function () { speak(w); });
    ipa.appendChild(sp);
    card.appendChild(ipa);
  }

  /* 变形来源 */
  if (w.origin && w.origin !== w.text) {
    const og = el('div', 'origin');
    og.appendChild(document.createTextNode('选中形式 '));
    og.appendChild(el('b', null, w.origin));
    card.appendChild(og);
  }

  /* 释义 */
  const trans = el('ol', 'trans');
  (w.trans || []).forEach(function (t) { trans.appendChild(posLine(t)); });
  if (!(w.trans || []).length) trans.appendChild(el('li', null, '（暂无释义）'));
  card.appendChild(trans);

  if (w.forms && w.forms.length) card.appendChild(el('div', 'forms', w.forms.join('　')));

  /* 例句 */
  (w.examples || []).slice(0, 2).forEach(function (ex) {
    const box = el('div', 'ex');
    box.appendChild(el('div', 'ex-en', ex.en));
    box.appendChild(el('div', 'ex-zh', ex.zh));
    card.appendChild(box);
  });

  /* 上下文 */
  if (w.context) {
    const ctx = el('div', 'ctx');
    ctx.appendChild(el('b', null, '原文上下文'));
    ctx.appendChild(document.createTextNode(w.context));
    card.appendChild(ctx);
  }

  /* 备注 */
  const note = el('textarea', 'note');
  note.placeholder = '写点笔记，比如记忆法、易混词、常考搭配…';
  note.value = w.note || '';
  note.rows = 1;
  note.addEventListener('blur', async function () {
    if (note.value === (w.note || '')) return;
    const r = await send({ type: 'UPDATE', id: w.id, patch: { note: note.value } });
    if (r.ok) { w.note = note.value; toast('备注已保存'); }
  });
  note.addEventListener('input', function () {
    note.style.height = 'auto';
    note.style.height = Math.max(36, note.scrollHeight) + 'px';
  });
  card.appendChild(note);

  /* 元信息 */
  const meta = el('div', 'meta');
  const bits = [];
  bits.push(fmtDate(w.createdAt));
  if ((w.hits || 1) > 1) bits.push('查过 ' + w.hits + ' 次');
  const src = el('span', 'src');
  if (w.sourceUrl) {
    const a = el('a', null, (w.sourceTitle ? w.sourceTitle.slice(0, 42) : hostOf(w.sourceUrl)) || hostOf(w.sourceUrl));
    a.href = w.sourceUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    src.appendChild(document.createTextNode('来源：'));
    src.appendChild(a);
  }
  meta.appendChild(el('span', null, bits.join(' · ')));
  meta.appendChild(src);
  card.appendChild(meta);

  return card;
}

function render() {
  const list = $('list');
  const empty = $('empty');
  list.innerHTML = '';

  const words = visibleWords();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayN = WORDS.filter(function (w) { return (w.createdAt || 0) >= today.getTime(); }).length;
  const cet6N = WORDS.filter(function (w) { return (w.tags || []).indexOf('CET6') >= 0; }).length;
  $('stat').textContent = '共 ' + WORDS.length + ' 条 · 六级词 ' + cet6N + ' 条 · 今日新增 ' + todayN + ' 条';

  if (!words.length) {
    empty.hidden = false;
    empty.querySelector('.empty-title').textContent = WORDS.length ? '没有匹配的词条' : '这里还是空的';
    empty.querySelector('.empty-sub').textContent = WORDS.length
      ? '换个关键词或筛选条件试试。'
      : '去任意英文网页选中单词或句子，点「加入单词本」就会出现在这里。';
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  words.forEach(function (w) { frag.appendChild(buildCard(w)); });
  list.appendChild(frag);
}

/* ------------------------------ 复习 ------------------------------ */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function startReview() {
  const pool = visibleWords().filter(function (w) { return !w.mastered; });
  const use = pool.length ? pool : visibleWords();
  if (!use.length) { toast('没有可复习的词条'); return; }
  reviewQueue = shuffle(use);
  reviewIdx = 0;
  $('overlay').hidden = false;
  showReview();
}

function showReview() {
  const body = $('rvBody');
  body.innerHTML = '';

  if (reviewIdx >= reviewQueue.length) {
    body.appendChild(el('div', 'rv-word', '复习完成'));
    body.appendChild(el('div', 'rv-hint', '这一轮 ' + reviewQueue.length + ' 条已过完'));
    $('rvProgress').textContent = reviewQueue.length + ' / ' + reviewQueue.length;
    $('rvAgain').textContent = '重新开始';
    $('rvKnown').textContent = '关闭';
    return;
  }

  const w = reviewQueue[reviewIdx];
  $('rvProgress').textContent = (reviewIdx + 1) + ' / ' + reviewQueue.length;
  $('rvAgain').textContent = '再看看';
  $('rvKnown').textContent = '记住了';

  body.appendChild(el('div', 'rv-word', w.text));
  const hint = el('div', 'rv-hint', '先回想意思，再点「再看看」核对');
  body.appendChild(hint);

  $('rvAgain').onclick = function () {
    if (reviewIdx >= reviewQueue.length) { closeReview(); startReview(); return; }
    if (body.querySelector('.rv-answer')) { reviewIdx++; showReview(); return; }

    const ans = el('div', 'rv-answer');
    if (w.phonetic) ans.appendChild(el('div', 'rv-ipa', w.lang === 'zh' ? w.phonetic : '/' + w.phonetic + '/'));
    ans.appendChild(el('div', 'rv-trans', (w.trans || []).join('；') || '（暂无释义）'));
    if (w.examples && w.examples.length) {
      ans.appendChild(el('div', 'rv-ex', w.examples[0].en));
      ans.appendChild(el('div', 'rv-ex', w.examples[0].zh));
    }
    if (w.context) {
      const c = el('div', 'ctx');
      c.appendChild(el('b', null, '原文上下文'));
      c.appendChild(document.createTextNode(w.context));
      ans.appendChild(c);
    }
    body.appendChild(ans);
    hint.textContent = '记住就打勾，没记住就下一张';
    $('rvAgain').textContent = '下一张';
    $('rvKnown').textContent = '记住了';
  };

  $('rvKnown').onclick = async function () {
    if (reviewIdx >= reviewQueue.length) { closeReview(); return; }
    const target = reviewQueue[reviewIdx];
    const r = await send({ type: 'UPDATE', id: target.id, patch: { mastered: true } });
    if (r.ok) {
      const local = WORDS.find(function (x) { return x.id === target.id; });
      if (local) local.mastered = true;
    }
    reviewIdx++;
    showReview();
    render();
  };
}

function closeReview() {
  $('overlay').hidden = true;
  render();
}

/* ------------------------------ 事件 ------------------------------ */

function bind() {
  $('search').addEventListener('input', function () { keyword = this.value; render(); });

  $('chips').addEventListener('click', function (e) {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    filter = btn.dataset.f;
    Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (c) {
      c.classList.toggle('on', c === btn);
    });
    render();
  });

  $('sort').addEventListener('change', function () { sortBy = this.value; render(); });

  $('btnReview').addEventListener('click', startReview);
  $('rvClose').addEventListener('click', closeReview);
  $('overlay').addEventListener('click', function (e) { if (e.target === this) closeReview(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('overlay').hidden) closeReview();
  });

  /* ---------- 导出下拉菜单 ---------- */
  const menu = $('exportMenu');
  $('btnExport').addEventListener('click', function (e) {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', function (e) {
    e.stopPropagation();
    const b = e.target.closest('button[data-fmt]');
    if (!b) return;
    menu.hidden = true;
    exportAs(b.dataset.fmt, b);
  });
  document.addEventListener('click', function () { menu.hidden = true; });

  $('btnImport').addEventListener('click', function () { $('fileInput').click(); });

  $('fileInput').addEventListener('change', function () {
    const file = this.files && this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function () {
      let data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { toast('文件格式不对，需要之前导出的 JSON'); return; }
      const list = Array.isArray(data) ? data : (Array.isArray(data.words) ? data.words : null);
      if (!list) { toast('文件里没有找到词条'); return; }
      const res = await send({ type: 'IMPORT', words: list });
      if (res.ok) { toast('已导入 ' + res.added + ' 条'); await load(); }
      else toast('导入失败');
    };
    reader.readAsText(file, 'utf-8');
    this.value = '';
  });

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });
}

/* ------------------------------ 启动 ------------------------------ */

if (IS_DEMO) {
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  bar.textContent = '预览模式 · 下面显示的是示例数据，改动不会保存。装好扩展后从扩展图标进入本页，即为你的真实单词本。';
  const toolbar = document.querySelector('.toolbar');
  toolbar.parentNode.insertBefore(bar, toolbar);
}

async function load() {
  const res = await send({ type: 'LIST' });
  if (!res.ok) { $('stat').textContent = '读取失败：' + (res.error || ''); return; }
  WORDS = res.words || [];
  render();
}

bind();
load();
