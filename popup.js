'use strict';

const $ = function (id) { return document.getElementById(id); };

function send(msg) {
  /* 直接双击打开 popup.html 时没有扩展环境，给个明确提示而不是一直转圈 */
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return Promise.resolve({ ok: false, error: '预览模式（未在扩展环境中打开）' });
  }
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        resolve(chrome.runtime.lastError
          ? { ok: false, error: chrome.runtime.lastError.message }
          : (res || { ok: false, error: '没有响应' }));
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
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
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  const res = await send({ type: 'EXPORT', format: fmt });
  if (btn) { btn.disabled = false; btn.textContent = old; }

  if (!res.ok) {
    alert('导出失败：' + (res.error || '未知错误'));
    return;
  }
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
}

function stamp() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderRecent(words) {
  const ul = $('recent');
  ul.innerHTML = '';
  if (!words.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有词条，去网页上选一个词试试';
    ul.appendChild(li);
    return;
  }
  words.slice(0, 5).forEach(function (w) {
    const li = document.createElement('li');

    const a = document.createElement('span');
    a.className = 'w';
    a.textContent = w.text;
    li.appendChild(a);

    const b = document.createElement('span');
    b.className = 't';
    b.textContent = (w.trans || []).join('；') || '（无释义）';
    li.appendChild(b);

    const exam = (w.tags || []).find(function (t) { return /CET4|CET6|考研|GRE|TOEFL|IELTS/.test(t); });
    if (exam) {
      const c = document.createElement('span');
      c.className = 'tag';
      c.textContent = exam;
      li.appendChild(c);
    }
    ul.appendChild(li);
  });
}

function renderStat(words) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const n = words.filter(function (w) { return (w.createdAt || 0) >= today.getTime(); }).length;
  $('stat').textContent = '共 ' + words.length + ' 条 · 今日新增 ' + n + ' 条';
}

async function load() {
  const res = await send({ type: 'LIST' });
  if (!res.ok) { $('stat').textContent = '读取失败：' + (res.error || ''); return; }

  renderStat(res.words || []);
  renderRecent(res.words || []);

  const s = res.settings || {};
  $('trigger').value = s.trigger || 'button';
  $('showExamples').checked = s.showExamples !== false;
  $('maxExamples').value = String(s.maxExamples || 2);
  $('autoSave').checked = !!s.autoSave;
}

function bindSettings() {
  $('trigger').addEventListener('change', function () {
    send({ type: 'SET_SETTINGS', patch: { trigger: this.value } });
  });
  $('showExamples').addEventListener('change', function () {
    send({ type: 'SET_SETTINGS', patch: { showExamples: this.checked } });
  });
  $('maxExamples').addEventListener('change', function () {
    send({ type: 'SET_SETTINGS', patch: { maxExamples: Number(this.value) } });
  });
  $('autoSave').addEventListener('change', function () {
    send({ type: 'SET_SETTINGS', patch: { autoSave: this.checked } });
  });
}

function bindActions() {
  /* ---------- 快速查词 ---------- */
  async function quickLookup(raw) {
    const text = String(raw || '').trim();
    const box = $('quickResult');
    box.hidden = false;
    box.innerHTML = '';
    if (!text) { box.appendChild(el('div', 'qr-err', '先粘贴一个单词或句子')); return; }

    box.appendChild(el('div', 'qr-sub', '查询中…'));
    const res = await send({ type: 'TRANSLATE', text: text });

    box.innerHTML = '';
    if (!res.ok) {
      box.appendChild(el('div', 'qr-err', res.error || '查询失败'));
      return;
    }
    const d = res.data;
    const isZh = d.lang === 'zh';
    box.appendChild(el('div', isZh ? 'qr-word is-zh' : 'qr-word', d.text));
    if (d.phonetic) {
      box.appendChild(el('div', 'qr-sub', isZh ? d.phonetic : '/' + d.phonetic + '/'));
    }
    if (d.inflected && d.query && d.query !== d.text) {
      const lemma = el('div', 'qr-lemma');
      lemma.appendChild(document.createTextNode('选中形式 '));
      lemma.appendChild(el('b', null, d.query));
      lemma.appendChild(document.createTextNode('　→　原形 '));
      lemma.appendChild(el('b', null, d.text));
      box.appendChild(lemma);
    }
    if (isZh || (d.tags || []).length) {
      const tags = el('div', 'qr-tags');
      if (isZh) {
        const i = document.createElement('i');
        i.textContent = '汉 → 英';
        tags.appendChild(i);
      }
      (d.tags || []).forEach(function (t) {
        const i = document.createElement('i');
        i.textContent = t;
        tags.appendChild(i);
      });
      box.appendChild(tags);
    }
    if (isZh && (d.ens || []).length) {
      /* 汉→英：英文对应词 */
      const list = el('div', 'qr-ens');
      d.ens.slice(0, 6).forEach(function (e) {
        const row = el('div', 'qr-en');
        row.appendChild(el('span', 'qr-en-word', e.word));
        if (e.pos) row.appendChild(el('span', 'qr-en-pos', e.pos));
        if (e.zh) row.appendChild(el('span', 'qr-en-zh', e.zh));
        list.appendChild(row);
      });
      box.appendChild(list);
    } else {
      const transBox = el('div', 'qr-trans');
      (d.trans || []).forEach(function (t) {
        const line = el('div');
        const m = String(t).match(/^([a-z]{1,6}\.\s*)([\s\S]+)$/i);
        if (m) {
          line.appendChild(el('span', 'wb-pos', m[1].trim()));
          line.appendChild(document.createTextNode(' ' + m[2]));
        } else {
          line.textContent = t;
        }
        transBox.appendChild(line);
      });
      box.appendChild(transBox);
    }
    if ((d.examples || []).length) {
      box.appendChild(el('div', 'qr-ex', d.examples[0].en + ' / ' + d.examples[0].zh));
    }

    const save = el('button', 'btn', '加入单词本');
    save.addEventListener('click', async function () {
      save.disabled = true;
      save.textContent = '保存中…';
      const r = await send({
        type: 'SAVE',
        entry: {
          text: d.text,
          origin: d.inflected && d.query ? d.query : '',
          kind: d.kind || 'word', phonetic: d.phonetic || '',
          trans: d.trans || [], examples: d.examples || [], forms: d.forms || [],
          tags: d.tags || [], context: '',
          sourceTitle: '快速查词', sourceUrl: ''
        }
      });
      save.disabled = false;
      if (r && r.ok) {
        save.textContent = r.duplicated ? '已在单词本（+1）' : '已加入单词本';
        load();
      } else {
        save.textContent = '加入单词本';
        box.appendChild(el('div', 'qr-err', (r && r.error) || '保存失败'));
      }
    });
    box.appendChild(save);
  }

  $('quickGo').addEventListener('click', function () { quickLookup($('quickInput').value); });
  $('quickInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); quickLookup(this.value); }
  });

  /* ---------- 检测当前页面 ---------- */
  $('testPage').addEventListener('click', async function () {
    const out = $('pageResult');
    const btn = this;
    btn.disabled = true;
    btn.textContent = '检测中…';
    out.innerHTML = '正在检测…';

    let tab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0];
    } catch (e) { /* ignore */ }

    btn.disabled = false;
    btn.textContent = '检测当前页面';

    if (!tab || tab.id == null) {
      out.innerHTML = '<span class="bad">拿不到当前标签页</span>';
      return;
    }

    const url = tab.url || tab.pendingUrl || '';
    const scheme = url ? url.split(':')[0].toLowerCase() : '';

    const ping = await new Promise(function (resolve) {
      chrome.tabs.sendMessage(tab.id, { type: 'WB_PING' }, function (res) {
        resolve(chrome.runtime.lastError
          ? { ok: false, err: chrome.runtime.lastError.message }
          : (res || { ok: false }));
      });
    });

    if (ping && ping.ok) {
      out.innerHTML = '<span class="ok">已注入，可以正常划词。</span>' +
        (ping.isTop ? '' : '<br>（当前位于 iframe 内）');
      return;
    }

    let why;
    if (scheme === 'file') {
      why = '这是<b>本地文件</b>页面。请到 <b>edge://extensions/</b> → 找到本扩展 → <b>详情</b> → 打开「<b>允许访问文件 URL</b>」，然后刷新页面。';
    } else if (scheme === 'edge' || scheme === 'chrome' || scheme === 'about' ||
               scheme === 'devtools' || scheme === 'extension') {
      why = '这是<b>浏览器内置页面</b>，浏览器不允许任何扩展注入脚本，无法划词。';
    } else if (/\.pdf(\?|#|$)/i.test(url)) {
      why = '这是 <b>PDF 文件</b>。浏览器内置的 PDF 阅读器不允许注入脚本。<br>请用上面的「<b>快速查词</b>」：在 PDF 里选中并复制文字，粘贴进来查询。';
    } else {
      why = '页面里没有注入脚本。最常见的原因是——<b>这个页面在装扩展之前就打开了</b>，内容脚本不会追溯注入。<br>按 <b>F5 刷新一次</b>再试。';
    }
    out.innerHTML = '<span class="bad">未注入</span><br>' + why;
  });

  $('testApi').addEventListener('click', async function () {
    const out = $('apiResult');
    const btn = this;
    btn.disabled = true;
    btn.textContent = '检测中…';
    out.innerHTML = '正在请求…';

    const res = await send({ type: 'TRANSLATE', text: 'sustainability' });

    btn.disabled = false;
    btn.textContent = '检测翻译源';

    if (!res.ok) {
      out.innerHTML = '<span class="bad">全部接口不可用</span><br>' + (res.error || '');
      return;
    }
    const d = res.data;
    const rich = !!d.phonetic || (d.tags || []).length > 0;
    out.innerHTML =
      '当前可用：<b>' + d.source + '</b> ' + (rich ? '<span class="ok">（完整档）</span>' : '<span class="ok">（基础档）</span>') +
      '<br>音标：' + (d.phonetic || '—') +
      '　标签：' + ((d.tags || []).join('/') || '—') +
      '<br>释义：' + ((d.trans || []).join('；').slice(0, 60) || '—') +
      (rich ? '' : '<br><span class="bad">未能拿到音标与考纲标签，说明词典接口被拦，翻译仍可用。</span>');
  });

  $('openNotebook').addEventListener('click', function (e) {
    e.preventDefault();
    send({ type: 'OPEN_NOTEBOOK' });
    window.close();
  });

  $('exportDocx').addEventListener('click', function () { exportAs('docx', this); });
  $('exportHtml').addEventListener('click', function () { exportAs('html', this); });
  $('exportXlsx').addEventListener('click', function () { exportAs('xlsx', this); });
  $('exportAnki').addEventListener('click', function () { exportAs('anki', this); });
  $('exportCsv').addEventListener('click', function () { exportAs('csv', this); });

  $('clearAll').addEventListener('click', async function () {
    const btn = this;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = '再点一次确认清空';
      setTimeout(function () {
        btn.dataset.armed = '0';
        btn.textContent = '清空全部';
      }, 3200);
      return;
    }
    btn.disabled = true;
    await send({ type: 'CLEAR' });
    btn.dataset.armed = '0';
    btn.textContent = '清空全部';
    btn.disabled = false;
    load();
  });
}

bindSettings();
bindActions();
load();
