#!/usr/bin/env node
/**
 * fetch.js —— 工程行业早报 多源采集器
 * 抓取造价/EPC 垂直资讯源，解析为 ITEMS 数组 + 当日 BLESS 寄语。
 * 设计要点：
 *   - 多源冗余：单源失败/解析空不影响其他源。
 *   - 分类限量：每类取前 N 条，控制每日总量 ~15。
 *   - 真实链接：只输出可点击原文 URL + 来源 + 日期。
 *   - note（行业观点）阶段一留空，由后续 AI 步骤补充；卡片无 note 时不显示评论块。
 */
const fs = require('fs');
const { execSync } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function fetchHtml(url) {
  try {
    return execSync('curl -sL -A "' + UA + '" --max-time 25 "' + url + '"', { encoding: 'utf8', maxBuffer: 30e6 });
  } catch (e) { return ''; }
}

function toAbs(href, base) {
  if (/^https?:\/\//i.test(href)) return href;
  try { return new URL(href, base).href; } catch (e) { return ''; }
}

// 抽取页面所有 <a>：标题优先用 title 属性，否则用可见文本
function extract(base, html, kw) {
  const re = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
  const out = []; let m; const seen = new Set();
  while ((m = re.exec(html))) {
    const attrs = m[1]; const inner = m[2];
    const href = (attrs.match(/href=["']([^"']+)["']/) || [])[1] || '';
    const title = (attrs.match(/title=["']([^"']+)["']/) || [])[1] || '';
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const label = (title && title.length >= 4) ? title : text;
    if (!href || !label || label.length < 8) continue;
    if (kw && !kw.test(label)) continue;
    const abs = toAbs(href, base);
    if (!abs) continue;
    if (/\.(pdf|zip|docx?|xlsx?|png|jpe?g|gif|css|js|ico)(\?|$)/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ title: label, url: abs });
  }
  return out;
}

// 从 URL 提取日期：优先 YYYY-MM-DD / YYMMDD（百年建筑 /a/YYMMDDXX/）
function dateFromUrl(u) {
  let mt = u.match(/(\d{4})[-._/]?(\d{2})[-._/]?(\d{2})/);
  if (mt) return mt[1] + '-' + mt[2] + '-' + mt[3];
  mt = u.match(/\/a\/(\d{2})(\d{2})(\d{2})\d*\//);
  if (mt) return '20' + mt[1] + '-' + mt[2] + '-' + mt[3];
  return '';
}

// 源配置：按已实证可达性选取。后续可增 EPC/案例/热评 源。
const SOURCES = [
  { name: '住房城乡建设部', cat: 'policy', url: 'https://www.mohurd.gov.cn/',
    kw: /造价|工程|EPC|清单|价格|住房|建筑|市政|标准|定额|结算/ },
  { name: '湖北省住建厅', cat: 'policy', url: 'https://zjt.hubei.gov.cn/zfxxgk/zc/gfxwj/',
    kw: /造价|工程|EPC|清单|价格|建筑|市政|标准|定额|结算|风险/ },
  { name: '百年建筑网', cat: 'price', url: 'https://www.100njz.com/',
    kw: /水泥|混凝土|砂石|价格|钢材|建材|工程|骨料|熟料|指数/ },
  { name: '我的钢铁网', cat: 'price', url: 'https://www.mysteel.com/',
    kw: /水泥|钢材|混凝土|砂石|价格|指数|建材|螺纹|焦炭|焦煤|铁矿/ },
];

const LIMIT = { policy: 4, epc: 3, price: 4, case: 2, review: 3 };
const items = [];
const usedTitles = new Set();
const today = new Date().toISOString().slice(0, 10);

for (const s of SOURCES) {
  const html = fetchHtml(s.url);
  if (!html) { console.log('FAIL', s.name); continue; }
  const arr = extract(s.url, html, s.kw).slice(0, 10);
  let n = 0;
  for (const a of arr) {
    if (n >= LIMIT[s.cat]) break;
    if (usedTitles.has(a.title)) continue;
    usedTitles.add(a.title);
    const date = dateFromUrl(a.url) || today;
    items.push({ cat: s.cat, title: a.title, url: a.url, src: s.name, date: date, note: '' });
    n++;
  }
  console.log(s.name, '->', n);
}

// BLESS：统计驱动，与当日真实内容联动
const cnt = {};
items.forEach(i => { cnt[i.cat] = (cnt[i.cat] || 0) + 1; });
const LABELS = { policy: '造价政策', epc: 'EPC管理', price: '市场价格', case: '典型案例', review: '热评' };
const parts = Object.keys(cnt).map(k => LABELS[k] + cnt[k] + '条').join('、');
const bless = parts
  ? '今日聚焦：' + parts + '。规则在更新，确定性在提前读条款、算波动。'
  : '今日资讯采集暂未命中，规则未变：把条款读在前、把波动算在早。';

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/items.json', JSON.stringify(items, null, 2));
fs.writeFileSync('data/bless.txt', bless);
console.log('TOTAL', items.length, '| BLESS:', bless);
