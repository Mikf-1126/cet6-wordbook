/* 在 Node 里用 mock 的 chrome 环境跑真实 background.js，验证翻译链路与存词逻辑。
 *
 * 用法（在 CET6-WordBook-dev 目录下）：
 *     node selftest.js
 *
 * 默认读 ~/CET6-WordBook/background.js。扩展目录不在默认位置时：
 *     WB_EXT=D:/somewhere/MyExt node selftest.js
 *
 * 注意：扩展目录内不能出现任何以下划线开头的文件（Chrome/Edge 保留前缀），
 * 所以本脚本必须放在扩展目录之外。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');

const EXT_DIR = process.env.WB_EXT || path.join(os.homedir(), 'CET6-WordBook');

const store = { words: [], settings: null };
const listeners = [];

const chrome = {
  runtime: {
    onMessage: { addListener: function (fn) { listeners.push(fn); } },
    onInstalled: { addListener: function () {} },
    onStartup: { addListener: function () {} },
    getURL: function (p) { return 'chrome-extension://test/' + p; },
    lastError: null
  },
  storage: {
    local: {
      get: function (defaults) {
        const out = {};
        Object.keys(defaults || {}).forEach(function (k) {
          out[k] = (k in store) ? store[k] : defaults[k];
        });
        return Promise.resolve(out);
      },
      set: function (obj) { Object.assign(store, obj); return Promise.resolve(); }
    },
    onChanged: { addListener: function () {} }
  },
  action: {
    setBadgeText: function () {},
    setBadgeBackgroundColor: function () {},
    setBadgeTextColor: function () {}
  },
  contextMenus: {
    removeAll: function (cb) { if (cb) cb(); },
    create: function () {},
    onClicked: { addListener: function () {} }
  },
  tabs: { create: function () {}, sendMessage: function () { return Promise.resolve(); } },
  commands: null
};

const bgPath = path.join(EXT_DIR, 'background.js');
if (!fs.existsSync(bgPath)) {
  console.error('找不到 ' + bgPath);
  console.error('用 WB_EXT=<扩展目录> node selftest.js 指定。');
  process.exit(1);
}
const code = fs.readFileSync(bgPath, 'utf8');
vm.runInContext(code, vm.createContext({
  chrome: chrome, console: console, fetch: fetch, URL: URL, Date: Date,
  Math: Math, JSON: JSON, Set: Set, Array: Array, Object: Object,
  String: String, Number: Number, Promise: Promise, setTimeout: setTimeout,
  encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
  Error: Error, RegExp: RegExp, isNaN: isNaN
}));

function ask(msg) {
  return new Promise(function (res) { listeners[0](msg, {}, res); });
}

const CASES = [
  'sustainability',
  'inadequate',
  'surrendered',
  'building',
  'worries',
  'studies',
  'went',
  'better',
  'children',
  'running',
  'Employment growth',
  'The quick brown fox jumps over the lazy dog.'
];

(async function () {
  let pass = 0, fail = 0;

  for (const t of CASES) {
    const r = await ask({ type: 'TRANSLATE', text: t });
    if (r.ok) {
      const d = r.data;
      pass++;
      const lemma = d.inflected
        ? ('  ' + d.query + ' → ' + d.text)
        : '  （已是原形）';
      console.log('OK   [' + d.source + '] ' + t + lemma);
      console.log('     音标: ' + (d.phonetic || '—') + ' | 标签: ' + ((d.tags || []).join('/') || '—'));
      console.log('     释义: ' + (d.trans || []).join('；').slice(0, 80));
    } else {
      fail++;
      console.log('FAIL ' + t + ' -> ' + r.error);
    }
  }

  console.log('=== 存词 / 去重 / 导出 ===');
  const first = await ask({ type: 'TRANSLATE', text: 'surrendered' });
  const s1 = await ask({
    type: 'SAVE',
    entry: {
      text: first.data.text,
      origin: first.data.inflected ? first.data.query : '',
      kind: 'word', phonetic: first.data.phonetic,
      trans: first.data.trans, examples: first.data.examples, tags: first.data.tags,
      context: 'The soldiers surrendered at dawn.',
      sourceTitle: 'Test Page', sourceUrl: 'https://example.com/a'
    }
  });
  console.log('存入变形词 "surrendered" → 主词 =', JSON.stringify(s1.entry.text),
              '| origin =', JSON.stringify(s1.entry.origin));

  const s2 = await ask({ type: 'SAVE', entry: { text: 'surrender', trans: ['x'] } });
  console.log('再存原形 "surrender" → 是否判为重复:', s2.duplicated,
              '| 总数:', s2.total, '| 查词次数:', s2.entry.hits);

  const list = await ask({ type: 'LIST' });
  console.log('列表条数:', list.words.length, '| 标签:', (list.words[0].tags || []).join('/'), '| 上下文已存:', !!list.words[0].context);

  const ex = await ask({ type: 'EXPORT' });
  console.log('CSV 首两行:');
  ex.csv.split('\r\n').slice(0, 2).forEach(function (l) { console.log('   ' + l.slice(0, 110)); });
  console.log('Anki 行:');
  console.log('   ' + ex.tsv.split('\n')[0].slice(0, 140));

  const up = await ask({ type: 'UPDATE', id: list.words[0].id, patch: { note: '记：sustain + ability', starred: true } });
  console.log('更新备注/收藏:', up.ok, '|', up.entry.note, '| starred=', up.entry.starred);

  const del = await ask({ type: 'DELETE', id: list.words[0].id });
  console.log('删除后剩余:', del.total);

  console.log('');
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
})();
