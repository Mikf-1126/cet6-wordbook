'use strict';

/* 导出格式生成器（exporters.js）按需加载：
   查词完全用不到它，没必要让每次 service worker 冷启动都求值一遍。 */
function ensureExporters() {
  if (typeof WBExport === 'undefined') importScripts('exporters.js');
  return WBExport;
}

/* =========================================================================
 *  划词单词本 · 后台服务（MV3 Service Worker）
 *  职责：翻译请求（三级降级） + 单词本读写 + 右键菜单
 * ========================================================================= */

const YD_DICT = 'https://dict.youdao.com/jsonapi';
const YD_TRANS = 'https://aidemo.youdao.com/trans';
const MM_API = 'https://api.mymemory.translated.net/get';

/* 有道返回的 prototype 偶尔会指向不常用的同形词（went → wend、better → well），
   这里用一张小表纠正常见的不规则变形，只在该词确实被判为变形时生效 */
const LEMMA_FIX = {
  went: 'go', gone: 'go', was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be',
  had: 'have', has: 'have', did: 'do', does: 'do', said: 'say', made: 'make',
  took: 'take', taken: 'take', came: 'come', saw: 'see', seen: 'see',
  got: 'get', gotten: 'get', gave: 'give', given: 'give', found: 'find',
  thought: 'think', told: 'tell', became: 'become', left: 'leave', felt: 'feel',
  brought: 'bring', began: 'begin', begun: 'begin', kept: 'keep', held: 'hold',
  wrote: 'write', written: 'write', stood: 'stand', heard: 'hear',
  meant: 'mean', met: 'meet', ran: 'run', paid: 'pay', sat: 'sit',
  spoke: 'speak', spoken: 'speak', led: 'lead', grew: 'grow', grown: 'grow',
  lost: 'lose', fell: 'fall', fallen: 'fall', sent: 'send', built: 'build',
  understood: 'understand', drew: 'draw', drawn: 'draw', broke: 'break', broken: 'break',
  spent: 'spend', rose: 'rise', risen: 'rise', drove: 'drive', driven: 'drive',
  bought: 'buy', wore: 'wear', worn: 'wear', chose: 'choose', chosen: 'choose',
  children: 'child', men: 'man', women: 'woman', teeth: 'tooth', feet: 'foot',
  mice: 'mouse', geese: 'goose', people: 'person',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad'
};

/** 取字符串型字段（有道有时给字符串，有时给 {l:{i:...}}） */
function pickString(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const i = v.l ? v.l.i : null;
    if (typeof i === 'string') return i;
    if (Array.isArray(i) && typeof i[0] === 'string') return i[0];
  }
  return '';
}

const DEFAULT_SETTINGS = {
  trigger: 'button',     // button | auto | off
  showExamples: true,
  maxExamples: 2,
  autoSave: false
};

/* ------------------------------ 存储 ------------------------------ */

async function getState() {
  const s = await chrome.storage.local.get({ words: [], settings: null });
  return {
    words: Array.isArray(s.words) ? s.words : [],
    settings: Object.assign({}, DEFAULT_SETTINGS, s.settings || {})
  };
}

async function getWords() {
  const s = await chrome.storage.local.get({ words: [] });
  return Array.isArray(s.words) ? s.words : [];
}

async function setWords(words) {
  await chrome.storage.local.set({ words: words });
  paintBadge(words.length);
}

function paintBadge(n) {
  try {
    chrome.action.setBadgeText({ text: n ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#C9A96A' });
    chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  } catch (e) { /* 旧版本可能不支持 setBadgeTextColor */ }
}

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* --------------------------- 网络与解析 --------------------------- */

const FETCH_TIMEOUT = 6000;   // 单次请求上限，超了就降级，绝不干等

async function fetchJSON(url, timeoutMs) {
  const ms = timeoutMs || FETCH_TIMEOUT;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
  try {
    /* cache 用默认值让浏览器 HTTP 缓存生效。
       之前写死 no-store，同一个词查几次就要走几次完整网络往返。 */
    const res = await fetch(url, {
      credentials: 'omit',
      cache: 'default',
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error('返回内容不是合法 JSON');
    }
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
      throw new Error('请求超时');
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------------------------- 查询缓存 ----------------------------
   同一个词查过就不再走网络。
   内存做一级；storage.local 做二级（MV3 的 service worker 会被回收，只靠内存存不住）。
   落盘是延迟批量做的，不占查询本身的耗时 —— 否则每次查词写几百 KB 反而更慢。 */
const CACHE_KEY = 'lookupCache';
const CACHE_MAX = 300;
const CACHE_TTL = 3 * 24 * 3600 * 1000;

let memCache = null;
let cacheDirty = false;
let cacheTimer = null;

async function loadCache() {
  if (memCache) return memCache;
  try {
    const o = await chrome.storage.local.get(CACHE_KEY);
    memCache = o[CACHE_KEY] || {};
  } catch (e) {
    memCache = {};
  }
  return memCache;
}

function cacheGet(key) {
  if (!memCache) return null;
  const hit = memCache[key];
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) { delete memCache[key]; return null; }
  return hit.data;
}

function scheduleCacheSave() {
  cacheDirty = true;
  if (cacheTimer) return;
  cacheTimer = setTimeout(function () {
    cacheTimer = null;
    if (!cacheDirty || !memCache) return;
    cacheDirty = false;
    const o = {}; o[CACHE_KEY] = memCache;
    try { chrome.storage.local.set(o).catch(function () {}); } catch (e) {}
  }, 2500);
}

function cacheSet(key, data) {
  if (!memCache) return;
  memCache[key] = { at: Date.now(), data: data };
  const keys = Object.keys(memCache);
  if (keys.length > CACHE_MAX) {
    keys.sort(function (a, b) { return memCache[a].at - memCache[b].at; });
    keys.slice(0, keys.length - CACHE_MAX).forEach(function (k) { delete memCache[k]; });
  }
  scheduleCacheSave();
}

/* 词典接口失败后先跳过它一段时间，省掉每个词白等一个来回 */
let dictDownUntil = 0;

/* ---------------------------- 语言判定 ---------------------------- */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 含中日韩统一表意文字就当中文处理 */
function detectLang(text) {
  return CJK_RE.test(String(text || '')) ? 'zh' : 'en';
}

/** 中文「词/短语」而非整句：短、且不含句读 */
function isChineseWordLike(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 12) return false;
  if (!CJK_RE.test(t)) return false;
  return !/[。！？；，、,.!?;:：]/.test(t);
}

function isWordLike(text) {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  if (!/^[A-Za-z][A-Za-z'’\-.\s]*$/.test(t)) return false;
  const n = t.split(/\s+/).filter(Boolean).length;
  return n <= 3;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ''));
}

/** 有道汉英（ce / ce_new）—— 中文查英文对应词 */
function parseYoudaoCE(data, query) {
  const out = {
    text: query,
    query: query,
    lang: 'zh',
    inflected: false,
    kind: 'word',
    phonetic: '',          // 这里放拼音
    trans: [],
    ens: [],               // [{ word, pos, zh }]
    phrases: [],           // [{ en, zh }]
    examples: [],
    forms: [],
    tags: [],
    source: '有道汉英'
  };

  /* ce：英文对应词 + 词性 + 该英文词的中文解释 */
  const cw = (data.ce && data.ce.word && data.ce.word[0]) || null;
  if (cw) {
    out.phonetic = pickString(cw.phone).trim();
    (cw.trs || []).forEach(function (t) {
      (t.tr || []).forEach(function (x) {
        const l = (x && x.l) || {};
        const pos = l.pos || '';
        const zh = stripTags(l['#tran'] || '');
        /* l.i 是「词级链接碎片」，一个 tr 对应一个译法：
           ["", {#text:'take'}, {#text:'charge'}, {#text:'of'}] 要拼回 "take charge of"，
           不能逐条当成独立单词，否则 take charge of 会被拆成三个词。 */
        const items = l.i;
        const pieces = [];
        if (typeof items === 'string') {
          if (items.trim()) pieces.push(items.trim());
        } else if (Array.isArray(items)) {
          items.forEach(function (one) {
            if (typeof one === 'string') { if (one.trim()) pieces.push(one.trim()); }
            else if (one && typeof one === 'object' && one['#text']) {
              pieces.push(String(one['#text']).trim());
            }
          });
        }
        const wd = pieces.join(' ').replace(/\s+/g, ' ').trim();
        if (wd) out.ens.push({ word: wd, pos: pos, zh: zh });
      });
    });
  }

  /* ce_new（新汉英大辞典）：补充更多对应词 + 词组示例 */
  const nw = (data.ce_new && data.ce_new.word && data.ce_new.word[0]) || null;
  if (nw) {
    (nw.trs || []).forEach(function (t) {
      (t.tr || []).forEach(function (x) {
        const l = (x && x.l) || {};
        const v = l.i;
        const str = typeof v === 'string'
          ? v
          : (Array.isArray(v) ? v.filter(function (z) { return typeof z === 'string'; }).join('') : '');
        str.split(/[;；]/).forEach(function (piece) {
          const word = piece.replace(/[:：]\s*$/, '').trim();
          if (!word) return;
          const dup = out.ens.some(function (e) {
            return e.word.toLowerCase() === word.toLowerCase();
          });
          if (!dup) out.ens.push({ word: word, pos: '', zh: '' });
        });
        (x.exam || []).forEach(function (ex) {
          const i = ex && ex.i;
          if (!i) return;
          const en = pickString(i.f).trim();
          const zh = pickString(i.n).trim();
          if (en && zh) out.phrases.push({ en: en, zh: zh });
        });
      });
    });
  }

  /* 双语例句 */
  const pairs = (data.blng_sents_part && data.blng_sents_part['sentence-pair']) || [];
  pairs.forEach(function (p) {
    const en = stripTags(p.sentence || p['sentence-eng'] || '');
    const zh = stripTags(p['sentence-translation'] || '');
    if (en && zh) out.examples.push({ en: en, zh: zh });
  });

  if (!out.ens.length) throw new Error('汉英词典未收录该词');

  /* 纯文本释义，供存储 / 导出使用 */
  out.trans = out.ens.map(function (e) {
    return (e.pos ? e.pos + ' ' : '') + e.word + (e.zh ? '　' + e.zh : '');
  });

  return out;
}

async function lookupYoudaoCE(text, timeoutMs) {
  return parseYoudaoCE(await fetchJSON(YD_DICT + '?q=' + encodeURIComponent(text), timeoutMs), text);
}

/** 有道词典 jsonapi —— 数据最全（音标 / 释义 / 词形 / 考纲标签 / 双语例句 / 原型） */
function parseYoudaoDict(data, query) {
  const out = {
    text: query,
    query: query,
    lang: 'en',
    inflected: false,
    kind: 'word',
    phonetic: '',
    trans: [],
    examples: [],
    forms: [],
    tags: [],
    source: '有道词典'
  };

  const ec = data.ec;
  if (ec) {
    if (Array.isArray(ec.exam_type)) out.tags = ec.exam_type.slice();
    const w = (ec.word && ec.word[0]) || null;
    if (w) {
      out.phonetic = w.usphone || w.ukphone || '';

      /* 词形还原：有道会给出 prototype（原型）。不同则说明用户选中的是变形词。
         个别同形词有道判得不对，用 LEMMA_FIX 纠正。 */
      const q = String(query).trim();
      const rp = pickString(w['return-phrase']).trim();
      let base = pickString(w.prototype).trim();
      if (base && base.toLowerCase() !== q.toLowerCase()) {
        const fixed = LEMMA_FIX[q.toLowerCase()];
        if (fixed) base = fixed;
        out.text = base;
        out.inflected = true;
      } else {
        /* 没有 prototype 说明本身就是原形。但用户选中的可能是句子开头或标题里的大写
           （在「Liability Landmine」里选中 Liability），背单词要的是小写。
           词典的 return-phrase 会给规范词形：普通词转小写（Liability → liability），
           专有名词保持大写（London → London、AI → AI），比任何启发式规则都准。
           所以这里以词典为准，而不是照抄用户选中的原文。 */
        out.text = rp || q;
      }

      const trs = w.trs || [];
      trs.forEach(function (t) {
        (t.tr || []).forEach(function (x) {
          const v = x && x.l ? x.l.i : null;
          if (typeof v === 'string') out.trans.push(v);
          else if (Array.isArray(v)) v.forEach(function (one) { if (typeof one === 'string') out.trans.push(one); });
        });
      });
      (w.wfs || []).forEach(function (f) {
        if (f && f.wf) out.forms.push(f.wf.name + '：' + f.wf.value);
      });
    }
  }

  const part = data.blng_sents_part;
  const pairs = (part && part['sentence-pair']) || [];
  pairs.forEach(function (p) {
    const en = stripTags(p.sentence || p['sentence-eng'] || '');
    const zh = stripTags(p['sentence-translation'] || '');
    if (en && zh) out.examples.push({ en: en, zh: zh });
  });

  if (!out.trans.length) throw new Error('词典未收录该词条');
  return out;
}

/** 有道翻译（aidemo）—— 句子与词组保底，附带发音音频 */
async function lookupYoudaoTrans(text, from, to, timeoutMs) {
  from = from || 'en';
  to = to || 'zh-CHS';
  const url = YD_TRANS + '?q=' + encodeURIComponent(text) + '&from=' + from + '&to=' + to;
  const data = await fetchJSON(url, timeoutMs);
  const tr = (data.translation || []).filter(Boolean);
  if (!tr.length) throw new Error('无译文');
  return {
    text: text,
    query: text,
    lang: from === 'zh-CHS' ? 'zh' : 'en',
    inflected: false,
    kind: 'sentence',
    trans: tr.map(decodeEntities),
    phonetic: '',
    ens: [],
    phrases: [],
    examples: [],
    forms: [],
    tags: [],
    speakUrl: data.speakUrl || '',
    source: from === 'zh-CHS' ? '有道翻译（中→英）' : '有道翻译'
  };
}

/** MyMemory —— 最后兜底 */
async function lookupMyMemory(text, pair, timeoutMs) {
  pair = pair || 'en|zh-CN';
  const url = MM_API + '?q=' + encodeURIComponent(text) + '&langpair=' + encodeURIComponent(pair);
  const data = await fetchJSON(url, timeoutMs);
  const t = data && data.responseData ? data.responseData.translatedText : '';
  if (!t) throw new Error('无译文');
  return {
    text: text,
    query: text,
    lang: pair.indexOf('zh') === 0 ? 'zh' : 'en',
    inflected: false,
    kind: 'sentence',
    trans: [decodeEntities(t)],
    phonetic: '',
    ens: [],
    phrases: [],
    examples: [],
    forms: [],
    tags: [],
    source: 'MyMemory'
  };
}

async function translate(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('没有选中任何内容');
  if (text.length > 1000) throw new Error('内容过长，上限 1000 字符');

  /* 命中缓存直接返回，零网络往返 */
  const ck = normalizeKey(text);
  await loadCache();
  const hit = cacheGet(ck);
  if (hit) return hit;

  const out = await translateFresh(text);
  cacheSet(ck, out);
  return out;
}

/* 整个降级链的总时间预算。单看每一档都能等 6 秒，
   但三档串行就是 18 秒 —— 网络真出问题时用户会以为卡死了。
   这里给一个总上限，每一档只能用「剩余预算」。 */
const TOTAL_BUDGET = 12000;

async function translateFresh(text) {
  const fails = [];
  const lang = detectLang(text);
  const deadline = Date.now() + TOTAL_BUDGET;
  const budget = function (want) {
    return Math.max(1200, Math.min(want, deadline - Date.now()));
  };

  if (lang === 'zh') {
    /* 中文：短的先试汉英词典拿对应词，其余走整句中译英 */
    if (isChineseWordLike(text)) {
      try { return await lookupYoudaoCE(text, budget(6000)); }
      catch (e) { fails.push('汉英词典(' + e.message + ')'); }
    }
    try { return await lookupYoudaoTrans(text, 'zh-CHS', 'en', budget(5000)); }
    catch (e) { fails.push('中译英(' + e.message + ')'); }
    try { return await lookupMyMemory(text, 'zh-CN|en', budget(5000)); }
    catch (e) { fails.push('MyMemory(' + e.message + ')'); }
  } else {
    if (isWordLike(text) && Date.now() > dictDownUntil) {
      try {
        return await parseYoudaoDict(
          await fetchJSON(YD_DICT + '?q=' + encodeURIComponent(text), budget(6000)), text);
      } catch (e) {
        /* 被拦或超时：两分钟内不再试它，省掉每个词一个来回的等待 */
        if (/403|超时/.test(e.message)) dictDownUntil = Date.now() + 120000;
        fails.push('有道词典(' + e.message + ')');
      }
    }
    try { return await lookupYoudaoTrans(text, 'en', 'zh-CHS', budget(5000)); }
    catch (e) { fails.push('有道翻译(' + e.message + ')'); }
    try { return await lookupMyMemory(text, 'en|zh-CN', budget(5000)); }
    catch (e) { fails.push('MyMemory(' + e.message + ')'); }
  }

  throw new Error('翻译失败：' + fails.join('，'));
}

/* ----------------------------- 词条操作 ----------------------------- */

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase();
}

async function saveEntry(raw) {
  const words = await getWords();
  const key = normalizeKey(raw.text);
  const idx = words.findIndex(function (w) { return normalizeKey(w.text) === key; });

  if (idx >= 0) {
    const old = words[idx];
    old.hits = (old.hits || 1) + 1;
    old.updatedAt = Date.now();
    if (!old.phonetic && raw.phonetic) old.phonetic = raw.phonetic;
    if ((!old.trans || !old.trans.length) && raw.trans && raw.trans.length) old.trans = raw.trans;
    if ((!old.examples || !old.examples.length) && raw.examples && raw.examples.length) old.examples = raw.examples;
    if ((!old.tags || !old.tags.length) && raw.tags && raw.tags.length) old.tags = raw.tags;
    if (!old.context && raw.context) old.context = raw.context;
    if (!old.note && raw.note) old.note = raw.note;
    if (!old.origin && raw.origin) old.origin = raw.origin;
    words[idx] = old;
    await setWords(words);
    return { ok: true, duplicated: true, entry: old, total: words.length };
  }

  const entry = {
    id: uid(),
    text: raw.text,
    origin: raw.origin || '',
    lang: raw.lang === 'zh' ? 'zh' : 'en',
    ens: raw.ens || [],
    phrases: raw.phrases || [],
    kind: raw.kind === 'word' ? 'word' : 'sentence',
    phonetic: raw.phonetic || '',
    trans: raw.trans || [],
    examples: raw.examples || [],
    forms: raw.forms || [],
    tags: raw.tags || [],
    context: raw.context || '',
    sourceTitle: raw.sourceTitle || '',
    sourceUrl: raw.sourceUrl || '',
    note: raw.note || '',
    starred: false,
    mastered: false,
    hits: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  words.unshift(entry);
  await setWords(words);
  return { ok: true, duplicated: false, entry: entry, total: words.length };
}

/* ------------------------------ 导出 ------------------------------ */

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

/** 二进制转 base64 —— 消息通道只能传 JSON，二进制得转一下 */
function toBase64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}

function exportName(fmt) {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const base = '六级词汇本-' + day;
  if (fmt === 'docx') return base + '.docx';
  if (fmt === 'xlsx') return base + '.xlsx';
  if (fmt === 'html') return base + '.html';
  if (fmt === 'anki') return base + '-Anki.txt';
  if (fmt === 'csv') return base + '.csv';
  return base + '.json';
}

async function doExport(fmt) {
  ensureExporters();
  const words = await getWords();
  const filename = exportName(fmt);

  if (fmt === 'docx') {
    return { ok: true, filename: filename, mime: MIME.docx, base64: toBase64(WBExport.buildDOCX(words)) };
  }
  if (fmt === 'xlsx') {
    return { ok: true, filename: filename, mime: MIME.xlsx, base64: toBase64(WBExport.buildXLSX(words)) };
  }
  if (fmt === 'html') {
    return { ok: true, filename: filename, mime: 'text/html;charset=utf-8', text: WBExport.buildHTML(words) };
  }
  if (fmt === 'anki') {
    return { ok: true, filename: filename, mime: 'text/plain;charset=utf-8', text: WBExport.buildAnki(words) };
  }
  if (fmt === 'csv') {
    return { ok: true, filename: filename, mime: 'text/csv;charset=utf-8', text: WBExport.buildCSV(words) };
  }
  return { ok: true, filename: filename, mime: 'application/json', text: JSON.stringify(words, null, 2) };
}

/* ----------------------------- 消息路由 ----------------------------- */

async function handle(msg) {
  const type = msg && msg.type;

  switch (type) {
    case 'TRANSLATE':
      return { ok: true, data: await translate(msg.text) };

    case 'SAVE':
      return await saveEntry(msg.entry || {});

    case 'LIST': {
      const st = await getState();
      return { ok: true, words: st.words, settings: st.settings };
    }

    case 'UPDATE': {
      const words = await getWords();
      const i = words.findIndex(function (w) { return w.id === msg.id; });
      if (i < 0) return { ok: false, error: '词条不存在' };
      Object.assign(words[i], msg.patch || {}, { updatedAt: Date.now() });
      await setWords(words);
      return { ok: true, entry: words[i] };
    }

    case 'DELETE': {
      let words = await getWords();
      words = words.filter(function (w) { return w.id !== msg.id; });
      await setWords(words);
      return { ok: true, total: words.length };
    }

    case 'CLEAR':
      await setWords([]);
      return { ok: true, total: 0 };

    case 'IMPORT': {
      const incoming = Array.isArray(msg.words) ? msg.words : [];
      const words = await getWords();
      const seen = new Set(words.map(function (w) { return normalizeKey(w.text); }));
      let added = 0;
      incoming.forEach(function (w) {
        if (!w || !w.text) return;
        const k = normalizeKey(w.text);
        if (seen.has(k)) return;
        seen.add(k);
        words.unshift(Object.assign({
          id: uid(), origin: '', lang: 'en', ens: [], phrases: [],
          kind: 'word', phonetic: '', trans: [], examples: [], forms: [],
          tags: [], context: '', sourceTitle: '', sourceUrl: '', note: '',
          starred: false, mastered: false, hits: 1,
          createdAt: Date.now(), updatedAt: Date.now()
        }, w));
        added++;
      });
      await setWords(words);
      return { ok: true, added: added, total: words.length };
    }

    case 'EXPORT':
      return await doExport(msg.format || 'docx');

    case 'SET_SETTINGS': {
      const s = await chrome.storage.local.get({ settings: null });
      const merged = Object.assign({}, DEFAULT_SETTINGS, s.settings || {}, msg.patch || {});
      await chrome.storage.local.set({ settings: merged });
      return { ok: true, settings: merged };
    }

    case 'OPEN_NOTEBOOK':
      await chrome.tabs.create({ url: chrome.runtime.getURL('notebook.html') });
      return { ok: true };

    default:
      return { ok: false, error: '未知指令：' + type };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  handle(msg)
    .then(sendResponse)
    .catch(function (e) { sendResponse({ ok: false, error: (e && e.message) || String(e) }); });
  return true;
});

/* --------------------------- 右键菜单 --------------------------- */

function installMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: 'wb-translate', title: '翻译选中内容', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'wb-save', title: '存入单词本', contexts: ['selection'] });
  });
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  const text = String(info.selectionText || '').trim();
  if (!text || !tab || tab.id == null) return;
  const type = info.menuItemId === 'wb-save' ? 'WB_SAVE_SELECTION' : 'WB_TRANSLATE_SELECTION';
  chrome.tabs.sendMessage(tab.id, { type: type, text: text }).catch(function () {
    /* 该页面没有注入内容脚本（如浏览器内置页），忽略 */
  });
});

/* --------------------------- 生命周期 --------------------------- */

chrome.runtime.onInstalled.addListener(async function () {
  installMenus();
  const s = await chrome.storage.local.get({ settings: null });
  if (!s.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  paintBadge((await getWords()).length);
});

chrome.runtime.onStartup.addListener(async function () {
  installMenus();
  paintBadge((await getWords()).length);
});

chrome.commands && chrome.commands.onCommand && chrome.commands.onCommand.addListener(function () { /* 预留 */ });
