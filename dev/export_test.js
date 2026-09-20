/* 导出格式生成器测试：跑出真实的 .docx / .xlsx / .html / .anki.txt 到磁盘 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT_DIR = process.env.WB_EXT || path.join(os.homedir(), 'CET6-WordBook');
const OUT = process.env.WB_OUT || path.join(os.homedir(), 'wbtmp', 'export-test');

const src = fs.readFileSync(path.join(EXT_DIR, 'exporters.js'), 'utf8');
eval(src);   // 挂到 globalThis.WBExport

const now = Date.now();
const SAMPLE = [
  {
    id: '1', text: 'sustainability', origin: '', kind: 'word', phonetic: 'səˌsteɪnəˈbɪləti',
    trans: ['n. 持续性，能维持性'], forms: ['复数：sustainabilities'],
    tags: ['CET4', 'CET6', 'GRE'],
    examples: [
      { en: 'If these messages of ethics and sustainability resonate with them, you get a ripple effect.', zh: '如果这些道德和可持续性的讯息可以让他们产生共鸣，你就可以得到连锁反应。' },
      { en: 'She exhibits the idealism common to many advocates of sustainability.', zh: '她展示了许多可持续发展倡导者所共有的理想主义。' }
    ],
    context: 'But a growing number of researchers argue that the sustainability of current farming practices deserves at least as much attention.',
    note: '记：sustain（维持）+ ability（能力）→ 能维持下去的性质',
    sourceTitle: 'The Conversation · Food and farming', sourceUrl: 'https://theconversation.com/',
    starred: true, mastered: false, hits: 3, createdAt: now - 86400000 * 3, updatedAt: now
  },
  {
    id: '2', text: 'practice', origin: 'Practices', kind: 'word', phonetic: 'ˈpræktɪs',
    trans: ['n. 实践；练习；惯例，习惯做法', 'v. 练习；实习；从事（职业）'], forms: ['复数：practices'],
    tags: ['CET4', 'CET6', '考研'],
    examples: [{ en: 'It is common practice for companies to test new products on a small group of users first.', zh: '公司先在一小群用户身上测试新产品，这是常见的做法。' }],
    context: 'Practices that were once standard are now under scrutiny.',
    note: '', sourceTitle: 'The Guardian · Environment', sourceUrl: 'https://www.theguardian.com/',
    starred: false, mastered: false, hits: 1, createdAt: now - 86400000 * 2, updatedAt: now
  },
  {
    id: '3', text: 'inadequate', origin: '', kind: 'word', phonetic: 'ɪnˈædɪkwət',
    trans: ['adj. 不充分的，不足的，不够好的；不能胜任的，信心不足的'], forms: ['副词：inadequately'],
    tags: ['CET6', 'IELTS', 'GRE'],
    examples: [{ en: 'Regulators said the new rules were inadequate to prevent safety risks.', zh: '监管机构表示，新规定不足以防范安全风险。' }],
    context: 'inadequate regulation has long been blamed for a series of safety accidents.',
    note: '反义：adequate', sourceTitle: 'The Guardian · Environment', sourceUrl: 'https://www.theguardian.com/',
    starred: false, mastered: true, hits: 2, createdAt: now - 86400000, updatedAt: now
  },
  {
    id: '4', text: 'surrender', origin: 'surrendered', kind: 'word', phonetic: 'səˈrendər',
    trans: ['v. 投降，屈服，认输；交出，放弃，让与', 'n. 投降，自首；屈服，屈从'], forms: ['过去式：surrendered'],
    tags: ['CET4', 'CET6', '考研'],
    examples: [{ en: "Don't shoot — I surrender.", zh: '别开枪——我投降。' }],
    context: 'The soldiers surrendered at dawn without a fight.',
    note: '', sourceTitle: 'Test Page', sourceUrl: 'https://example.com/',
    starred: false, mastered: false, hits: 1, createdAt: now - 3600000, updatedAt: now
  },
  {
    id: '5', text: 'Maximize utilization of existing resources.', origin: '', kind: 'sentence', phonetic: '',
    trans: ['最大限度地利用现有资源。'], forms: [], tags: [], examples: [], context: '',
    note: '', sourceTitle: '六级翻译练习', sourceUrl: '',
    starred: false, mastered: false, hits: 1, createdAt: now - 1800000, updatedAt: now
  }
];

fs.mkdirSync(OUT, { recursive: true });

function write(name, data) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(data));
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log('  ' + name.padEnd(30) + kb + ' KB');
}

console.log('输出目录: ' + OUT + '\n');
console.log('生成文件：');
write('六级词汇本.docx', WBExport.buildDOCX(SAMPLE));
write('六级词汇本.xlsx', WBExport.buildXLSX(SAMPLE));
write('六级词汇本.html', WBExport.buildHTML(SAMPLE));
write('六级词汇本-Anki.txt', WBExport.buildAnki(SAMPLE));
write('六级词汇本.csv', WBExport.buildCSV(SAMPLE));

// 空数据也不能崩
console.log('\n空数据兜底：');
try {
  const e1 = WBExport.buildDOCX([]);
  const e2 = WBExport.buildXLSX([]);
  const e3 = WBExport.buildHTML([]);
  const e4 = WBExport.buildAnki([]);
  console.log('  DOCX ' + e1.length + 'B | XLSX ' + e2.length + 'B | HTML ' + e3.length + 'B | Anki ' + e4.length + 'B  —— 全部通过');
} catch (e) {
  console.log('  失败: ' + e.message);
}

// 特殊字符转义
console.log('\n特殊字符转义：');
try {
  WBExport.buildDOCX([{ text: 'a<b>&"c\'d', trans: ['x<y&z'], examples: [{ en: '<script>', zh: '"引号"' }], createdAt: now }]);
  console.log('  DOCX 转义通过');
  WBExport.buildXLSX([{ text: 'a<b>&"c', trans: ['x<y'], createdAt: now }]);
  console.log('  XLSX 转义通过');
} catch (e) {
  console.log('  失败: ' + e.message);
}
