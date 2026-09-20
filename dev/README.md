# 开发笔记

这个项目没有构建步骤，改完直接在扩展管理页点「重新加载」就行。
下面记的是开发过程中踩过的坑和几个关键实现，省得以后重新摸一遍。

---

## 自测

在 Node 里用 mock 的 `chrome` 全局跑**真实的** `background.js`，不需要装进浏览器：

```bash
cd dev
node selftest.js        # 翻译链路 / 词形还原 / 存词去重 / 导出
node export_test.js     # 生成真实的 .docx / .xlsx 到磁盘
```

原理是用 `vm` 模块把 `background.js` 跑在一个假环境里，捕获它注册的 `onMessage` 监听器：

```js
const listeners = [];
const chrome = {
  runtime: { onMessage: { addListener: fn => listeners.push(fn) }, getURL: p => p, lastError: null },
  storage: { local: { get: d => Promise.resolve(/* 内存 store */), set: o => { Object.assign(store, o); return Promise.resolve(); } } },
  action: { setBadgeText(){}, setBadgeBackgroundColor(){}, setBadgeTextColor(){} },
  contextMenus: { removeAll(cb){ cb && cb(); }, create(){}, onClicked: { addListener(){} } },
  tabs: { create(){}, sendMessage(){ return Promise.resolve(); } },
  commands: null
};
vm.runInContext(fs.readFileSync('background.js', 'utf8'), vm.createContext({ chrome, console, fetch, URL, Date, ... }));
// 然后 listeners[0]({ type: 'TRANSLATE', text: 'surrendered' }, {}, resolve)
```

**能验的**：接口解析、降级链、词形还原、去重、导出格式、CRUD。
**验不了的**：DNR 是否生效（Node 没有 Origin）、content script 的 DOM 交互、CSS。

生成图标需要 PIL + 微软雅黑：

```bash
python dev/make_icons.py
```

---

## 一、有道接口的 Origin 拦截（最大的坑）

扩展发出的跨域请求会带 `Origin: chrome-extension://<id>`。有道会**直接 403**。

实测结果：

| 请求头 | 结果 |
|---|---|
| 无 `Origin` | 200 |
| `Origin: https://dict.youdao.com` | 200 |
| `Origin: chrome-extension://<id>` | **403** |
| `Origin: null` | **403** |
| `Origin: https://www.example.com` | **403** |

它只认自己的域名。

### 解法

`rules.json` 里用 `declarativeNetRequest` 的 `modifyHeaders` 改写请求头：

```json
[{
  "id": 1, "priority": 1,
  "action": {
    "type": "modifyHeaders",
    "requestHeaders": [
      { "header": "Origin",  "operation": "set", "value": "https://dict.youdao.com" },
      { "header": "Referer", "operation": "set", "value": "https://dict.youdao.com/" }
    ]
  },
  "condition": { "urlFilter": "||dict.youdao.com/", "resourceTypes": ["xmlhttprequest"] }
}]
```

注意：`Origin` / `Referer` **不能 `append`**（不在 Chrome 的 append 允许列表里），只能 `set` / `remove`。
而且 Chrome 文档没有明确承诺支持 `set Origin`，**所以必须有降级方案**。

### 调试姿势

用 curl 显式带上 Origin 探，别等装进浏览器才发现：

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop" \
  "https://dict.youdao.com/jsonapi?q=test"
```

> **curl 默认不发 Origin**，所以「本地测着好好的，装进浏览器全挂」是这类问题的典型症状。
> 一定要显式加 `-H "Origin: ..."` 再测一遍。

---

## 二、三级降级链

```
第 1 档  有道词典 jsonapi   → 音标 + 释义 + 词形 + 考纲标签 + 例句 + 原型
第 2 档  有道翻译 aidemo    → 译文 + 发音音频（任何 Origin 都放行）
第 3 档  MyMemory          → 纯译文
```

单词或 3 词以内的短语先试第 1 档，其余（句子）直接走第 2 档。
**卡片上会显示当前命中的档位**，方便用户反馈时定位。

### 接口速查

```
GET https://dict.youdao.com/jsonapi?q=<word>
    ec.exam_type              → ['CET4','CET6','考研',...]  考纲标签
    ec.word[0].usphone        → 美式音标
    ec.word[0].prototype      → ★ 原型（见下节）
    ec.word[0].trs[].tr[].l.i → 释义（i 可能是字符串也可能是数组）
    ec.word[0].wfs[].wf       → {name:'过去式', value:'surrendered'}
    blng_sents_part['sentence-pair'] → 双语例句

GET https://aidemo.youdao.com/trans?q=<text>&from=en&to=zh-CHS
    translation / speakUrl / tSpeakUrl / errorCode

GET https://api.mymemory.translated.net/get?q=<text>&langpair=en|zh-CN
    responseData.translatedText   （可能含 HTML 实体，要 decode）

GET https://dict.youdao.com/dictvoice?audio=<word>&type=2   → 美式发音 mp3（type=1 英式）
```

**取值注意**：有道同一个字段有时给字符串、有时给 `{l:{i:...}}`，
统一写一个 `pickString()` 兼容两种形态，否则会随机取到 `undefined`。

---

## 三、词形还原：一个没文档的字段

`return-phrase` 只会**原样回显你查的词**，不做还原。
真正的原型在 `ec.word[0].prototype`：

```
surrendered  → surrender      worries  → worry
studies      → study          children → child
running      → run            sustainability → null（本来就是原形）
```

### 词典自己会判错

| 查询 | 有道给的 | 应该是 | 原因 |
|---|---|---|---|
| `went` | `wend` | **go** | went 也是 wend 的过去式 |
| `better` | `well` | **good** | 同形词干扰 |

所以 `background.js` 里配了一张 60 多条的不规则变形表（`LEMMA_FIX`），
**只在 `prototype` 与查询词不同时才覆盖**——这样查 `well` 本身不会被误改。

---

## 四、从零实现 OOXML 导出

`exporters.js` 里没有任何依赖，自己写 OOXML + ZIP 打包。

### ZIP 用 store 模式就够

不压缩，省掉 deflate 实现，Office 照样读。关键是**三个头部的偏移量**：
local header 30 字节、central directory 46 字节、end of central directory 22 字节。
写完先用 `zipfile.testzip()` 验一遍 CRC。

### DOCX 最小 8 个部件

```
[Content_Types].xml
_rels/.rels
docProps/core.xml
docProps/app.xml
word/document.xml          ★ 正文
word/styles.xml            命名样式
word/footer1.xml           页脚（要页码就得有）
word/_rels/document.xml.rels
```

**单位坑**：全是 twip（1 英寸 = 1440）。A4 = 11906×16838；2cm 页边距 = 1134。
**字号坑**：`w:sz` 是**半磅**（10.5pt → `w:sz="21"`）。

**表格坑**：
- `w:tblGrid` 的 `gridCol` 宽度之和必须等于 `w:tblW`
- `w:tblLayout w:type="fixed"` 才会严格按你给的宽度渲染
- 表头行加 `<w:trPr><w:tblHeader/></w:trPr>` 才能跨页重复
- 行加 `<w:trPr><w:cantSplit/></w:trPr>` 防止一行被拆到两页
- 隔行底色写在 `w:tcPr/w:shd` 上，**不能写在行上**
- 单元格内边距用 `w:tcPr/w:tcMar`，且要用 `w:start` / `w:end`，不是 `w:left` / `w:right`

**页脚页码坑**：`fldChar` 和 `instrText` **每个都必须是独立的 `<w:r>` 且各自带 rPr**，
塞进一个 run 里不生效。

### XLSX 最小 8 个部件

用 `t="inlineStr"` 可以省掉 sharedStrings 表。

**fills 坑**：`fills[0]` 必须是 `none`、`fills[1]` 必须是 `gray125`（Excel 硬性约定），
自定义底色从索引 2 开始。

**cellXfs 坑**：`applyFont` / `applyFill` / `applyBorder` / `applyAlignment` 都要显式写 `1`，
否则 Excel 可能忽略。颜色写 `rgb="FFFAF7F2"`（前两位是 alpha）。

好用的三件套：

```xml
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>   <!-- 冻结首行 -->
<col min="1" max="1" width="24" customWidth="1"/>                            <!-- 列宽 -->
<autoFilter ref="A1:M6"/>                                                    <!-- 筛选 -->
```

### 二进制过消息通道要转 base64

`chrome.runtime.sendMessage` 只能传 JSON，`Uint8Array` 会变成普通对象。
`btoa` 要分块（每 0x8000 字节一次），避免 `String.fromCharCode.apply` 参数过多。

### 验完才算数

生成器是纯函数，可以写盘后用 Python 读回来核对：

```python
from docx import Document
d = Document(path)
print([p.style.name for p in d.paragraphs[:4]])       # Heading 样式生效没
print([c.text for c in d.tables[0].rows[0].cells])    # 表格内容
print('PAGE' in d.sections[0].footer.paragraphs[0]._p.xml)   # 页码域

import openpyxl
ws = openpyxl.load_workbook(path).active
print(ws.dimensions, ws.freeze_panes, ws.auto_filter.ref)
print(ws['A1'].fill.fgColor.rgb, ws['A1'].font.b)
```

---

## 五、浮层实现要点

### 必须用 Shadow DOM

宿主页面的 CSS 会污染浮层。CSS 以字符串内联，不用 manifest 的 `css` 字段：

```js
const host = document.createElement('div');
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = CSS;
shadow.appendChild(style);
```

CSS 首行：`:host{ all: initial; position: fixed; top:0; left:0; width:0; height:0; z-index:2147483647; pointer-events:none; }`
—— 先 `all: initial` 断掉继承，再逐条覆写；子元素用 `pointer-events: auto`。

### 选区读取要延后

```js
document.addEventListener('mouseup', function (ev) {
  if (isOurs(ev.target)) return;
  setTimeout(function () { /* 这里才拿得到选区 */ }, 10);
}, true);
```

`range.getBoundingClientRect()` 全 0 时，退回 `range.getClientRects()` 的最后一个。

### 关闭浮层：三种方式都要给

点外部 / ESC / 点关闭按钮。只给一种用户就会觉得「关不掉」。

**踩过的 bug**：全局 `mousedown` 里只写了 `hideTrigger()`，漏了 `closeCard()`，
结果点页面其他地方小圆钮消失了、卡片却一直杵着。

配套要加防误伤，否则会「点空白关掉 → mouseup 又把同一段选区重开」：

```js
if (Date.now() - closedAt < 400 && sel.text === closedText) return;
```

### `display` 会覆盖 `hidden` 属性

```html
<div class="overlay" hidden>          <!-- 以为这样就藏住了 -->
```
```css
.overlay { display: flex; }           /* 结果它一直显示着 */
```

`hidden` 在 UA 样式表里只是普通优先级。**每个 CSS 文件开头都加一行**：

```css
[hidden]{ display: none !important; }
```

这个 bug 让单词本页的复习弹层一直盖住整页，而且静态检查全绿，只有真渲染才看得见。

---

## 六、内容脚本注入范围

用户说「选中没反应」，九成不是代码问题，是**脚本根本没注入**。按这个顺序查：

| 原因 | 解法 |
|---|---|
| **页面在装扩展之前就打开了**（最常见） | 内容脚本不追溯注入，必须 **F5 刷新** |
| 内容在 iframe 里 | manifest 设 `"all_frames": true` |
| 是 PDF | 注入不可能，给一个不依赖注入的兜底入口（弹窗里放输入框，粘贴即查） |
| 是 `edge://` 内置页 | 注入不可能 |
| 本地 `file://` 文件 | matches 加 `"file:///*"`，并提示用户开「允许访问文件 URL」 |

manifest 里默认就配好：

```json
"content_scripts": [{
  "matches": ["http://*/*", "https://*/*", "file:///*"],
  "js": ["content.js"],
  "run_at": "document_idle",
  "all_frames": true,
  "match_about_blank": true
}]
```

`all_frames: true` 是安全的：选区只可能落在一个 frame 里，不会出现重复浮层。

---

## 七、交付 / 加载相关的坑

| 现象 | 原因 |
|---|---|
| **Cannot load extension with file or directory name _xxx** | 扩展目录里有**你自己放进去的**、`_` 开头的文件。下划线是系统保留前缀。（浏览器生成的 `_metadata` 不算） |
| **清单文件缺失或不可读取** | 路径含中文，或选错文件夹层级 |
| 找不到「开发人员模式」 | 用的是 Edge，开关在左下角 |
| 某个样式莫名不生效 | 内嵌 CSS 被误合并成一行（`}` 后直接跟选择器），解析器会**静默丢弃**。用 `grep -n "}\.[a-z]"` 查 |

### 交付前必查

```bash
EXT="<扩展目录>"

# 1. 下划线文件（排除浏览器生成的 _metadata）
find "$EXT" -name "_*" -not -path "./_metadata*" | wc -l

# 2. manifest 引用的每个文件都存在
# 3. JS 语法
for f in background.js content.js popup.js notebook.js exporters.js; do node --check "$f"; done

# 4. popup.html 的 id 与 popup.js 里 $('...') 的引用一一对应

# 5. CSS 有没有被误合并
grep -n "}\.[a-z]" content.js popup.css notebook.css
```

**前 5 条都是静态检查，一条都抓不到 CSS 和运行时的坑。**
`node --check` 连 CSS 都不看。所以还有第 6 条：

```bash
# 6. 把每个页面真渲染一遍，用眼睛看
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="<临时目录>" --window-size=1000,1400 \
  --screenshot="check.png" "file:///<扩展目录>/notebook.html"
```

> 系统自带的 Edge 就能截图，不用装 Playwright / Puppeteer。
> 注意 HTML 要先复制到纯 ASCII 路径，中文路径下 `--screenshot` 会失败。

---

## 八、设计 token

三块界面（浮层卡片 / 弹窗 / 管理页）共用同一套变量：

```css
--ink:#191919;   --ink-2:#3A3733;   --ink-3:#8A8279;   --ink-4:#B5ADA1;
--gold:#A2803C;  --gold-2:#C9A96A;  --gold-hi:#B5914C; --gold-lo:#94712B;
--hair:rgba(162,128,60,.16);   --hair-2:rgba(162,128,60,.1);
--paper:#FFFFFF; --paper-2:#FBF8F3; --paper-3:#F6F1E8;
--line:#EBE5DA;  --line-2:#F3EEE5;
--ff-latin: Georgia, "Times New Roman", serif;
```

几条刻意的决定：

- 浮层卡片和单词本条目共用**左侧 2px 渐隐金色竖条**作为品牌识别
- 卡片用**半透明磨砂玻璃**（`backdrop-filter`），在任意网页背景上都能浮起来
- 按钮用**垂直微渐变 + 顶部内高光**，不用纯色块
- 标签分两级：考纲标签淡金底 + 细金边，非考纲标签描边空心
- 英文标题和例句用衬线（Georgia），**音标用系统无衬线**（IPA 符号在 Georgia 下会发虚）
