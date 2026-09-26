'use strict';

/* =========================================================================
 *  exporters.js —— 导出格式生成器
 *  纯函数，不依赖任何 chrome API，可以直接在 Node 里跑测试。
 *
 *  产出：
 *    buildDOCX  真正的 .docx（自己写 OOXML + ZIP 打包，不是 HTML 改后缀）
 *    buildXLSX  真正的 .xlsx（带列宽、表头样式、冻结首行）
 *    buildHTML  自包含的美化网页（可直接打印成 PDF）
 *    buildAnki  Anki 导入用 TSV，字段内嵌 HTML 样式
 *    buildCSV   纯数据备份
 * ========================================================================= */

(function (root) {

  /* ====================== 通用工具 ====================== */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function escHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function concat(list) {
    let n = 0;
    list.forEach(function (a) { n += a.length; });
    const out = new Uint8Array(n);
    let o = 0;
    list.forEach(function (a) { out.set(a, o); o += a.length; });
    return out;
  }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** 打包成 ZIP（store 模式，不压缩 —— Office 能正常读，省掉 deflate 实现） */
  function zipStore(files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    files.forEach(function (f) {
      const nameBytes = utf8(f.name);
      const data = typeof f.data === 'string' ? utf8(f.data) : f.data;
      const crc = crc32(data);
      const size = data.length;

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + size;
    });

    let centralSize = 0;
    central.forEach(function (c) { centralSize += c.length; });

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return concat(chunks.concat(central).concat([end]));
  }

  /* ====================== 数据整理 ====================== */

  function sortWords(words) {
    return (words || []).slice().sort(function (a, b) {
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  function stamp() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function statLine(words) {
    const cet6 = words.filter(function (w) { return (w.tags || []).indexOf('CET6') >= 0; }).length;
    const exam = words.filter(function (w) {
      return (w.tags || []).some(function (t) { return /CET4|CET6|考研|GRE|TOEFL|IELTS/.test(t); });
    }).length;
    const mastered = words.filter(function (w) { return w.mastered; }).length;
    return '共 ' + words.length + ' 条　·　六级词 ' + cet6 + ' 条　·　考纲词 ' + exam +
           ' 条　·　已掌握 ' + mastered + ' 条　·　导出于 ' + stamp();
  }

  function firstExample(w) {
    const ex = (w.examples || [])[0];
    if (!ex) return null;
    return { en: ex.en || '', zh: ex.zh || '' };
  }

  /** 备注加「记：」前缀，但用户自己已经写了就不重复加 */
  function noteText(n) {
    const s = String(n == null ? '' : n).trim();
    if (!s) return '';
    return /^(记|注|note)\s*[:：]/i.test(s) ? s : '记：' + s;
  }

  /* ====================== CSV ====================== */

  function csvCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  }

  function buildCSV(words) {
    const list = sortWords(words);
    const head = ['序号', '单词/句子', '选中形式', '音标', '释义', '例句', '例句译文',
                  '原文上下文', '考纲标签', '备注', '收藏', '已掌握', '查词次数',
                  '来源标题', '来源网址', '添加时间'];
    const lines = [head.map(csvCell).join(',')];
    list.forEach(function (w, i) {
      const ex = firstExample(w);
      lines.push([
        i + 1,
        w.text,
        w.origin || '',
        w.phonetic ? (w.lang === 'zh' ? w.phonetic : '/' + w.phonetic + '/') : '',
        (w.trans || []).join('；'),
        ex ? ex.en : '',
        ex ? ex.zh : '',
        w.context || '',
        (w.tags || []).join('/'),
        w.note || '',
        w.starred ? '是' : '',
        w.mastered ? '是' : '',
        w.hits || 1,
        w.sourceTitle || '',
        w.sourceUrl || '',
        new Date(w.createdAt || Date.now()).toLocaleString('zh-CN')
      ].map(csvCell).join(','));
    });
    return '\ufeff' + lines.join('\r\n');
  }

  /* ====================== Anki（字段内嵌样式） ====================== */

  function buildAnki(words) {
    const list = sortWords(words);
    const out = [];
    list.forEach(function (w) {
      const back = [];
      if (w.phonetic) {
        back.push('<div style="font-family:Georgia,serif;font-size:14px;color:#8A8279;letter-spacing:.02em">' +
                  escHTML(w.lang === 'zh' ? w.phonetic : '/' + w.phonetic + '/') + '</div>');
      }
      if ((w.tags || []).length) {
        back.push('<div style="margin-top:6px">' + w.tags.map(function (t) {
          return '<span style="display:inline-block;font-size:10px;letter-spacing:.05em;' +
                 'padding:3px 8px;border-radius:20px;background:rgba(201,169,106,.16);' +
                 'color:#A2803C;border:1px solid rgba(162,128,60,.22);margin-right:5px">' +
                 escHTML(t) + '</span>';
        }).join('') + '</div>');
      }
      back.push('<div style="margin-top:12px;font-size:16px;line-height:1.7;color:#2F2F2F">' +
                (w.trans || []).map(escHTML).join('<br>') + '</div>');

      const ex = firstExample(w);
      if (ex) {
        back.push('<div style="margin-top:14px;padding:10px 13px;background:#FBF8F3;border-radius:9px">' +
                  '<div style="font-family:Georgia,serif;font-size:13px;color:#3A3733;line-height:1.6">' +
                  escHTML(ex.en) + '</div>' +
                  (ex.zh ? '<div style="font-size:12.5px;color:#8A8279;margin-top:4px">' + escHTML(ex.zh) + '</div>' : '') +
                  '</div>');
      }
      if (w.context) {
        back.push('<div style="margin-top:10px;padding-left:11px;border-left:2px solid rgba(201,169,106,.55);' +
                  'font-size:12px;color:#8A8279;line-height:1.7">' + escHTML(w.context) + '</div>');
      }
      if (w.note) {
        back.push('<div style="margin-top:10px;font-size:12.5px;color:#A2803C">' + escHTML(noteText(w.note)) + '</div>');
      }
      if (w.origin && w.origin !== w.text) {
        back.push('<div style="margin-top:10px;font-size:11.5px;color:#B5ADA1">选中形式 ' + escHTML(w.origin) + '</div>');
      }

      const front = '<div style="font-family:Georgia,serif;font-size:22px;font-weight:700;' +
                    'color:#191919;letter-spacing:-.01em">' + escHTML(w.text) + '</div>';

      out.push(front.replace(/[\t\n\r]/g, ' ') + '\t' + back.join('').replace(/[\t\n\r]/g, ' '));
    });
    return '#separator:tab\n#html:true\n#columns:单词\t释义\n' + out.join('\n');
  }

  /* ====================== HTML（自包含美化网页） ====================== */

  function buildHTML(words) {
    const list = sortWords(words);
    const rows = list.map(function (w, i) {
      const ex = firstExample(w);
      const tags = (w.tags || []).map(function (t) {
        return '<i>' + escHTML(t) + '</i>';
      }).join('');
      return '' +
        '<article class="row">' +
          '<div class="idx">' + (i + 1) + '</div>' +
          '<div class="main">' +
            '<div class="head">' +
              '<span class="word">' + escHTML(w.text) + '</span>' +
              (w.phonetic ? '<span class="ipa">' + escHTML(w.lang === 'zh' ? w.phonetic : '/' + w.phonetic + '/') + '</span>' : '') +
              (tags ? '<span class="tags">' + tags + '</span>' : '') +
              (w.mastered ? '<span class="flag">已掌握</span>' : '') +
              (w.starred ? '<span class="star">★</span>' : '') +
            '</div>' +
            (w.origin && w.origin !== w.text
              ? '<div class="origin">选中形式 ' + escHTML(w.origin) + '</div>' : '') +
            '<ul class="trans">' + (w.trans || []).map(function (t) {
              return '<li>' + escHTML(t) + '</li>';
            }).join('') + '</ul>' +
            (ex
              ? '<div class="ex"><div class="ex-en">' + escHTML(ex.en) + '</div>' +
                (ex.zh ? '<div class="ex-zh">' + escHTML(ex.zh) + '</div>' : '') + '</div>'
              : '') +
            (w.context ? '<div class="ctx"><b>原文上下文</b>' + escHTML(w.context) + '</div>' : '') +
            (w.note ? '<div class="note">' + escHTML(noteText(w.note)) + '</div>' : '') +
            '<div class="meta">' + escHTML(w.sourceTitle || '') +
              (w.hits > 1 ? '　·　查过 ' + w.hits + ' 次' : '') + '</div>' +
          '</div>' +
        '</article>';
    }).join('');

    return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>六级词汇本</title><style>' +
      ':root{--ink:#191919;--ink-2:#3A3733;--ink-3:#8A8279;--ink-4:#B5ADA1;' +
      '--gold:#A2803C;--gold-2:#C9A96A;--hair:rgba(162,128,60,.16);' +
      '--paper:#fff;--paper-2:#FBF8F3;--line:#EBE5DA;' +
      '--ff-latin:Georgia,"Times New Roman",serif;' +
      '--ff-sans:-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}' +
      '*{box-sizing:border-box}' +
      'body{margin:0;padding:56px 20px 90px;background:var(--paper-2);color:var(--ink-2);' +
      'font-family:var(--ff-sans);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}' +
      '.wrap{max-width:860px;margin:0 auto}' +
      'header{padding-bottom:26px;border-bottom:2px solid var(--gold-2);margin-bottom:34px}' +
      'h1{margin:0 0 10px;font-size:30px;color:var(--ink);letter-spacing:-.01em}' +
      '.eyebrow{font-family:var(--ff-latin);font-size:11px;letter-spacing:.22em;text-transform:uppercase;' +
      'color:var(--gold-2);margin:0 0 12px}' +
      '.stat{font-size:13.5px;color:var(--ink-3);margin:0}' +
      '.row{position:relative;display:flex;gap:16px;background:var(--paper);border:1px solid var(--hair);' +
      'border-radius:14px;padding:17px 20px 15px;margin-bottom:13px;overflow:hidden;' +
      'box-shadow:0 1px 2px rgba(25,25,25,.04),0 6px 18px rgba(162,128,60,.05)}' +
      '.row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;' +
      'background:linear-gradient(180deg,var(--gold-2) 0%,rgba(201,169,106,.45) 38%,rgba(201,169,106,0) 100%)}' +
      '.idx{flex:0 0 30px;font-family:var(--ff-latin);font-size:12.5px;color:var(--ink-4);padding-top:6px}' +
      '.main{flex:1;min-width:0}' +
      '.head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}' +
      '.word{font-family:var(--ff-latin);font-size:22px;font-weight:700;color:var(--ink);letter-spacing:-.015em}' +
      '.ipa{font-size:12.5px;color:var(--ink-3);background:rgba(201,169,106,.08);border-radius:6px;padding:2px 8px}' +
      '.tags{display:flex;gap:5px}' +
      '.tags i{font-style:normal;font-size:10px;line-height:1;padding:4px 8px;border-radius:20px;' +
      'background:rgba(201,169,106,.14);color:var(--gold);border:1px solid var(--hair);' +
      'font-weight:600;letter-spacing:.05em}' +
      '.flag{font-size:11px;color:#3B6D11;background:#EAF3DE;border-radius:20px;padding:3px 9px}' +
      '.star{color:var(--gold-2)}' +
      '.origin{display:inline-block;margin-top:9px;padding:4px 9px;background:rgba(201,169,106,.09);' +
      'border-radius:6px;font-size:11.5px;color:var(--ink-3)}' +
      '.trans{margin:10px 0 0;padding:0;list-style:none}' +
      '.trans li{font-size:15px;color:var(--ink-2);padding:2px 0;line-height:1.68}' +
      '.ex{margin-top:10px;padding:11px 13px;background:rgba(251,248,243,.75);border-radius:11px}' +
      '.ex-en{font-family:var(--ff-latin);font-size:13.5px;color:var(--ink-2);line-height:1.62}' +
      '.ex-zh{font-size:13px;color:var(--ink-3);margin-top:4px}' +
      '.ctx{margin-top:12px;padding-left:12px;border-left:2px solid rgba(201,169,106,.55);' +
      'font-size:12.5px;color:var(--ink-3);line-height:1.72}' +
      '.ctx b{display:block;color:var(--ink-4);font-size:9px;letter-spacing:.16em;margin-bottom:3px;font-weight:600}' +
      '.note{margin-top:10px;font-size:13px;color:var(--gold)}' +
      '.meta{margin-top:11px;padding-top:9px;border-top:1px solid var(--hair);' +
      'font-size:11.5px;color:var(--ink-4)}' +
      'footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);' +
      'font-size:12.5px;color:var(--ink-4);text-align:center}' +
      '@media print{body{background:#fff;padding:0;font-size:12pt}' +
      '.row{break-inside:avoid;page-break-inside:avoid;box-shadow:none;border-color:#E6E0D6;' +
      'margin-bottom:10px;padding:12px 16px}' +
      '.word{font-size:16pt}.trans li{font-size:10.5pt}header{padding-bottom:16px;margin-bottom:20px}' +
      'h1{font-size:20pt}.eyebrow{display:none}}' +
      '</style></head><body><div class="wrap">' +
      '<header><p class="eyebrow">CET-6 Vocabulary Notebook</p>' +
      '<h1>六级词汇本</h1><p class="stat">' + escHTML(statLine(list)) + '</p></header>' +
      (list.length ? rows : '<p style="color:#8A8279">还没有词条。</p>') +
      '<footer>由「划词单词本 · CET-6」导出　·　浏览器打印即可存为 PDF</footer>' +
      '</div></body></html>';
  }

  /* ====================== DOCX ====================== */

  const FONT_CN = '微软雅黑';
  const FONT_EN = 'Georgia';

  function docxRun(text, o) {
    o = o || {};
    const rPr = [];
    rPr.push('<w:rFonts w:ascii="' + (o.latin || FONT_EN) + '" w:hAnsi="' + (o.latin || FONT_EN) +
             '" w:eastAsia="' + FONT_CN + '" w:cs="' + (o.latin || FONT_EN) + '"/>');
    if (o.bold) rPr.push('<w:b/>');
    if (o.italic) rPr.push('<w:i/>');
    if (o.color) rPr.push('<w:color w:val="' + o.color + '"/>');
    if (o.sz) rPr.push('<w:sz w:val="' + o.sz + '"/><w:szCs w:val="' + o.sz + '"/>');
    if (o.spacing) rPr.push('<w:spacing w:val="' + o.spacing + '"/>');
    return '<w:r><w:rPr>' + rPr.join('') + '</w:rPr><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
  }

  function docxPara(runs, o) {
    o = o || {};
    const pPr = [];
    if (o.style) pPr.push('<w:pStyle w:val="' + o.style + '"/>');
    if (o.align) pPr.push('<w:jc w:val="' + o.align + '"/>');
    const sp = [];
    if (o.before != null) sp.push('w:before="' + o.before + '"');
    if (o.after != null) sp.push('w:after="' + o.after + '"');
    if (o.line) sp.push('w:line="' + o.line + '" w:lineRule="auto"');
    if (sp.length) pPr.push('<w:spacing ' + sp.join(' ') + '/>');
    if (o.border) {
      pPr.push('<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="6" w:color="C9A96A"/></w:pBdr>');
    }
    return '<w:p>' + (pPr.length ? '<w:pPr>' + pPr.join('') + '</w:pPr>' : '') +
           (runs || '') + '</w:p>';
  }

  function docxCell(contentXml, o) {
    o = o || {};
    const tcPr = ['<w:tcW w:w="' + o.w + '" w:type="dxa"/>'];
    if (o.fill) tcPr.push('<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>');
    if (o.valign) tcPr.push('<w:vAlign w:val="' + o.valign + '"/>');
    tcPr.push('<w:tcMar>' +
      '<w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>' +
      '<w:start w:w="80" w:type="dxa"/><w:end w:w="80" w:type="dxa"/></w:tcMar>');
    return '<w:tc><w:tcPr>' + tcPr.join('') + '</w:tcPr>' + contentXml + '</w:tc>';
  }

  const COLS = [
    { w: 480, title: '#' },
    { w: 1900, title: '单词' },
    { w: 2800, title: '释义' },
    { w: 2820, title: '例句' },
    { w: 1638, title: '备注' }
  ];

  function buildDOCX(words) {
    const list = sortWords(words);
    const body = [];

    /* 封面区 */
    body.push(docxPara(docxRun('六级词汇本', { bold: true, sz: 40, color: '1F1F1F', latin: FONT_CN }),
      { style: 'Heading1', align: 'center', before: 0, after: 60 }));
    body.push(docxPara(docxRun('CET-6 VOCABULARY NOTEBOOK', { sz: 16, color: 'C9A96A', spacing: 60 }),
      { align: 'center', after: 120 }));
    body.push(docxPara(docxRun(statLine(list), { sz: 17, color: '8A8279' }),
      { align: 'center', after: 200, border: true }));

    /* 速记表 */
    body.push(docxPara(docxRun('词汇速记表', { bold: true, sz: 26, color: 'A2803C', latin: FONT_CN }),
      { style: 'Heading2', before: 320, after: 160 }));

    if (!list.length) {
      body.push(docxPara(docxRun('还没有词条。', { sz: 21, color: '8A8279' }), { after: 120 }));
    } else {
      const trs = [];

      /* 表头 */
      trs.push('<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' +
        COLS.map(function (c) {
          return docxCell(
            docxPara(docxRun(c.title, { bold: true, sz: 18, color: 'A2803C', latin: FONT_CN }),
              { after: 0, line: 240 }),
            { w: c.w, fill: 'FAF7F2', valign: 'center' });
        }).join('') + '</w:tr>');

      /* 数据行 */
      list.forEach(function (w, i) {
        const ex = firstExample(w);
        const zebra = (i % 2 === 1) ? 'FCFAF8' : null;

        const wordCell = [
          docxPara(docxRun(w.text, { bold: true, sz: 22, color: '1F1F1F' }), { after: 20, line: 240 }),
          w.phonetic
            ? docxPara(docxRun(w.lang === 'zh' ? w.phonetic : '/' + w.phonetic + '/', { sz: 15, color: '8A8279' }), { after: 0, line: 240 })
            : '',
          (w.tags || []).length
            ? docxPara(docxRun(w.tags.join(' · '), { sz: 14, color: 'C9A96A' }), { after: 0, line: 240 })
            : ''
        ].join('');

        const defCell = [
          (w.trans || []).map(function (t) {
            return docxPara(docxRun(t, { sz: 19, color: '3A3733' }), { after: 30, line: 264 });
          }).join('') || docxPara(docxRun('（暂无释义）', { sz: 18, color: 'B5ADA1' }), { after: 0 })
        ].join('');

        const exCell = ex
          ? docxPara(docxRun(ex.en, { sz: 18, color: '3A3733' }), { after: 30, line: 264 }) +
            (ex.zh ? docxPara(docxRun(ex.zh, { sz: 17, color: '8A8279' }), { after: 0, line: 264 }) : '')
          : docxPara(docxRun('—', { sz: 18, color: 'B5ADA1' }), { after: 0 });

        const noteBits = [];
        if (w.note) noteBits.push(docxPara(docxRun(noteText(w.note), { sz: 17, color: 'A2803C' }), { after: 30, line: 264 }));
        if (w.context) noteBits.push(docxPara(docxRun(w.context, { sz: 15, color: 'B5ADA1' }), { after: 0, line: 264 }));
        if (w.origin && w.origin !== w.text) {
          noteBits.push(docxPara(docxRun('选中形式 ' + w.origin, { sz: 15, color: 'B5ADA1' }), { after: 0, line: 264 }));
        }
        if (w.mastered) noteBits.push(docxPara(docxRun('已掌握', { sz: 15, color: '3B6D11' }), { after: 0, line: 264 }));
        const noteCell = noteBits.length ? noteBits.join('') : docxPara('', { after: 0 });

        trs.push('<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
          docxCell(docxPara(docxRun(String(i + 1), { sz: 17, color: 'B5ADA1' }), { align: 'center', after: 0, line: 240 }),
            { w: COLS[0].w, fill: zebra, valign: 'top' }) +
          docxCell(wordCell, { w: COLS[1].w, fill: zebra, valign: 'top' }) +
          docxCell(defCell, { w: COLS[2].w, fill: zebra, valign: 'top' }) +
          docxCell(exCell, { w: COLS[3].w, fill: zebra, valign: 'top' }) +
          docxCell(noteCell, { w: COLS[4].w, fill: zebra, valign: 'top' }) +
          '</w:tr>');
      });

      const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (k) {
        const color = (k === 'insideH' || k === 'insideV') ? 'F3EEE5' : 'EBE5DA';
        return '<w:' + k + ' w:val="single" w:sz="4" w:space="0" w:color="' + color + '"/>';
      }).join('');

      body.push('<w:tbl><w:tblPr>' +
        '<w:tblW w:w="9638" w:type="dxa"/>' +
        '<w:tblBorders>' + borders + '</w:tblBorders>' +
        '<w:tblLayout w:type="fixed"/>' +
        '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>' +
        '<w:start w:w="80" w:type="dxa"/><w:end w:w="80" w:type="dxa"/></w:tblCellMar>' +
        '</w:tblPr><w:tblGrid>' +
        COLS.map(function (c) { return '<w:gridCol w:w="' + c.w + '"/>'; }).join('') +
        '</w:tblGrid>' + trs.join('') + '</w:tbl>');

      body.push(docxPara('', { after: 0 }));
    }

    const sectPr = '<w:sectPr>' +
      '<w:footerReference w:type="default" r:id="rId2"/>' +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1247" w:right="1134" w:bottom="1134" w:left="1134" ' +
      'w:header="851" w:footer="992" w:gutter="0"/>' +
      '<w:cols w:space="425"/><w:docGrid w:linePitch="312"/>' +
      '</w:sectPr>';

    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:body>' + body.join('') + sectPr + '</w:body></w:document>';

    const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="' + FONT_EN + '" w:hAnsi="' + FONT_EN + '" w:eastAsia="' + FONT_CN + '" w:cs="' + FONT_EN + '"/>' +
      '<w:color w:val="3A3733"/><w:sz w:val="21"/><w:szCs w:val="21"/>' +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="84" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
      '</w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
      '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/>' +
      '<w:spacing w:before="0" w:after="60"/><w:jc w:val="center"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + FONT_CN + '" w:eastAsia="' + FONT_CN + '"/><w:b/>' +
      '<w:color w:val="1F1F1F"/><w:sz w:val="40"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
      '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/>' +
      '<w:spacing w:before="320" w:after="160"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="' + FONT_CN + '" w:eastAsia="' + FONT_CN + '"/><w:b/>' +
      '<w:color w:val="A2803C"/><w:sz w:val="26"/></w:rPr></w:style>' +
      '</w:styles>';

    const footerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="' + FONT_EN + '" w:eastAsia="' + FONT_CN + '"/>' +
      '<w:color w:val="B5ADA1"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">第 </w:t></w:r>' +
      '<w:r><w:rPr><w:color w:val="B5ADA1"/><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:rPr><w:color w:val="B5ADA1"/><w:sz w:val="16"/></w:rPr>' +
      '<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
      '<w:r><w:rPr><w:color w:val="B5ADA1"/><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:rPr><w:color w:val="B5ADA1"/><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r>' +
      '<w:r><w:rPr><w:color w:val="B5ADA1"/><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:r><w:rPr><w:rFonts w:ascii="' + FONT_EN + '" w:eastAsia="' + FONT_CN + '"/>' +
      '<w:color w:val="B5ADA1"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve"> 页　·　六级词汇本</w:t></w:r>' +
      '</w:p></w:ftr>';

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';

    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';

    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
      '</Relationships>';

    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>六级词汇本</dc:title><dc:creator>划词单词本 · CET-6</dc:creator>' +
      '<cp:lastModifiedBy>划词单词本 · CET-6</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().slice(0, 19) + 'Z</dcterms:created>' +
      '</cp:coreProperties>';

    const appXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>划词单词本 · CET-6</Application><Company></Company>' +
      '</Properties>';

    return zipStore([
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rels },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'docProps/app.xml', data: appXml },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml },
      { name: 'word/footer1.xml', data: footerXml },
      { name: 'word/_rels/document.xml.rels', data: docRels }
    ]);
  }

  /* ====================== XLSX ====================== */

  function xlsxCell(ref, value, styleIdx, isNumber) {
    if (value === '' || value == null) {
      return '<c r="' + ref + '" s="' + styleIdx + '"/>';
    }
    if (isNumber) {
      return '<c r="' + ref + '" s="' + styleIdx + '"><v>' + Number(value) + '</v></c>';
    }
    return '<c r="' + ref + '" s="' + styleIdx + '" t="inlineStr"><is><t xml:space="preserve">' +
           esc(value) + '</t></is></c>';
  }

  function colName(i) {
    let s = '';
    i += 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function buildXLSX(words) {
    const list = sortWords(words);
    const headers = ['序号', '单词/句子', '音标', '释义', '例句', '例句译文',
                     '原文上下文', '考纲标签', '备注', '已掌握', '查词次数', '来源', '添加时间'];
    const widths = [6, 24, 18, 40, 52, 34, 42, 18, 28, 9, 10, 26, 20];

    const rows = [];
    rows.push('<row r="1" ht="26" customHeight="1">' + headers.map(function (h, i) {
      return xlsxCell(colName(i) + '1', h, 1, false);
    }).join('') + '</row>');

    list.forEach(function (w, idx) {
      const ex = firstExample(w);
      const r = idx + 2;
      const vals = [
        [idx + 1, true],
        [w.text, false],
        [w.phonetic ? (w.lang === 'zh' ? w.phonetic : '/' + w.phonetic + '/') : '', false],
        [(w.trans || []).join('\n'), false],
        [ex ? ex.en : '', false],
        [ex ? ex.zh : '', false],
        [w.context || '', false],
        [(w.tags || []).join(' / '), false],
        [w.note || '', false],
        [w.mastered ? '是' : '', false],
        [w.hits || 1, true],
        [w.sourceTitle || '', false],
        [new Date(w.createdAt || Date.now()).toLocaleString('zh-CN'), false]
      ];
      rows.push('<row r="' + r + '">' + vals.map(function (v, i) {
        return xlsxCell(colName(i) + r, v[0], 2, v[1]);
      }).join('') + '</row>');
    });

    const cols = widths.map(function (wd, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + wd + '" customWidth="1"/>';
    }).join('');

    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="16"/>' +
      '<cols>' + cols + '</cols>' +
      '<sheetData>' + rows.join('') + '</sheetData>' +
      '<autoFilter ref="A1:M' + (list.length + 1) + '"/>' +
      '</worksheet>';

    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="六级词汇本" sheetId="1" r:id="rId1"/></sheets></workbook>';

    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    /* 三种单元格样式：0 普通、1 表头、2 正文（自动换行 + 顶对齐） */
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="3">' +
      '<font><sz val="11"/><name val="微软雅黑"/><color rgb="FF3A3733"/></font>' +
      '<font><b/><sz val="11"/><name val="微软雅黑"/><color rgb="FFA2803C"/></font>' +
      '<font><sz val="10.5"/><name val="微软雅黑"/><color rgb="FF3A3733"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFAF7F2"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FFEBE5DA"/></left>' +
      '<right style="thin"><color rgb="FFEBE5DA"/></right>' +
      '<top style="thin"><color rgb="FFEBE5DA"/></top>' +
      '<bottom style="thin"><color rgb="FFEBE5DA"/></bottom><diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"' +
      ' applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"' +
      ' applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';

    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';

    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>六级词汇本</dc:title><dc:creator>划词单词本 · CET-6</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().slice(0, 19) + 'Z</dcterms:created>' +
      '</cp:coreProperties>';

    const appXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>划词单词本 · CET-6</Application></Properties>';

    return zipStore([
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rels },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'docProps/app.xml', data: appXml },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
      { name: 'xl/styles.xml', data: styles },
      { name: 'xl/worksheets/sheet1.xml', data: sheet }
    ]);
  }

  root.WBExport = {
    buildCSV: buildCSV,
    buildHTML: buildHTML,
    buildDOCX: buildDOCX,
    buildXLSX: buildXLSX,
    buildAnki: buildAnki,
    _zipStore: zipStore,
    _crc32: crc32
  };

})(typeof self !== 'undefined' ? self : globalThis);
