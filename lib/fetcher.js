const { execSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// GitHub Actions runner 时区为 UTC；+8h 后再取日期，确保与北京时间一致
function todayBJ() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function pad(n) { return String(n).padStart(2, '0'); }

// ---- HTML 抓取：curl 优先，不足则 Playwright 降级 ----
function fetchCurl(url) {
  try {
    return execSync('curl -sL -A "' + UA + '" --max-time 25 "' + url + '"', { encoding: 'utf8', maxBuffer: 30e6 });
  } catch (e) { return ''; }
}

// Playwright 为可选依赖：未安装时静默降级，不产生噪音日志
let _pwState = null;
function pwAvailable() {
  if (_pwState !== null) return _pwState;
  try { require.resolve('playwright'); _pwState = true; }
  catch (e) { _pwState = false; }
  return _pwState;
}

// 复用单个浏览器实例：逐 URL 新建浏览器代价极高（26 源 ≈ 26 次冷启动）
let _browser = null;
async function getBrowser() {
  if (_browser) return _browser;
  const { chromium } = require('playwright');
  _browser = await chromium.launch({ headless: true });
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch (e) {}
    _browser = null;
  }
}

async function fetchPlaywright(url) {
  if (!pwAvailable()) return '';
  let ctx = null;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    // domcontentloaded + 短等待 比 networkidle 更稳：长轮询/广告请求会让 networkidle 永不触发
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1200);
    return await page.content();
  } catch (e) {
    return '';
  } finally {
    if (ctx) { try { await ctx.close(); } catch (e) {} }
  }
}

async function fetchHtml(url, minLength = 500) {
  const html = fetchCurl(url);
  if (html && html.length >= minLength) return html;

  const pw = await fetchPlaywright(url);
  // 降级结果更短时保留 curl 结果，避免"抓到了但被丢弃"
  if (pw && pw.length > (html || '').length) return pw;
  return html || '';
}

// ---- 链接抽取 ----
function toAbs(href, base) {
  if (/^https?:\/\//i.test(href)) return href;
  try { return new URL(href, base).href; } catch (e) { return ''; }
}

function stripEnt(x) {
  return x.replace(/<[^>]+>/g, '').replace(/&nbsp;|&ensp;|&emsp;|&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function parseDateString(s) {
  const m = String(s).match(/(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/);
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  return '';
}

// 列表页日期常在链接后的兄弟节点（<span>2026-09-11</span>），故取链接后一段窗口内首个日期
function dateNear(html, pos, win = 240) {
  const plain = html.slice(pos, pos + win).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
  const full = parseDateString(plain);
  if (full) return full;

  // 省略年份（列表页常见 "09-11"）；若结果晚于今日则判定为去年
  const m = plain.match(/(?:^|[\s|·（(])(\d{1,2})\s*[-/]\s*(\d{1,2})(?=[\s|·）)]|$)/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const t = todayBJ();
      let y = +t.slice(0, 4);
      let iso = `${y}-${pad(mo)}-${pad(d)}`;
      if (iso > t) { y -= 1; iso = `${y}-${pad(mo)}-${pad(d)}`; }
      return iso;
    }
  }
  return '';
}

function extract(base, html, kw) {
  const re = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
  const out = []; let m; const seen = new Set();
  while ((m = re.exec(html))) {
    const attrs = m[1]; const inner = m[2];
    const href = (attrs.match(/href=["']([^"']+)["']/) || [])[1] || '';
    const title = (attrs.match(/title=["']([^"']+)["']/) || [])[1] || '';
    // 剥离 HTML 实体后再判长度：协会站导航常用 &nbsp; 填充绕过长度过滤
    const label = stripEnt((title && title.length >= 4) ? title : inner);
    if (!href || !label || label.length < 8) continue;
    if (kw && !kw.test(label)) continue;
    const abs = toAbs(href, base);
    if (!abs) continue;
    if (/\.(pdf|zip|docx?|xlsx?|png|jpe?g|gif|css|js|ico)(\?|$)/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ title: label, url: abs, date: dateNear(html, re.lastIndex) });
  }
  return out;
}

// ---- 日期解析（URL → meta → 正文）----
function dateFromUrl(u) {
  let mt = u.match(/(\d{4})[-._/](\d{2})[-._/](\d{2})/);
  if (mt) {
    const y = +mt[1], m = +mt[2], d = +mt[3];
    if (y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return mt[1] + '-' + mt[2] + '-' + mt[3];
  }
  mt = u.match(/\/a\/(\d{2})(\d{2})(\d{2})\d*\//);
  if (mt) {
    const y = 2000 + +mt[1], m = +mt[2], d = +mt[3];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return '20' + mt[1] + '-' + mt[2] + '-' + mt[3];
  }
  return '';
}

function extractDateFromHtml(html, url) {
  const urlDate = dateFromUrl(url);
  if (urlDate) return urlDate;
  if (!html) return '';

  const metaPatterns = [
    /<meta[^>]+name=["'](?:article:published_time|pubdate|publishdate|PubDate|date)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:article:published_time|pubdate|publishdate|PubDate|date)["']/i,
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m) { const d = parseDateString(m[1]); if (d) return d; }
  }

  const textPatterns = [
    /(?:发布|发表|更新)[时间日期]?[：:]?\s*(20\d{2}[-年./]\d{1,2}[-月./]\d{1,2})/,
    /(20\d{2}[-年./]\d{1,2}[-月./]\d{1,2})\s*(?:发布|发表|来源)/,
    /class=["'][^"']*(?:time|date|publish)[^"']*["'][^>]*>\s*(20\d{2}-\d{2}-\d{2})/i,
    /(20\d{2}年\s*\d{1,2}月\s*\d{1,2}日)/,
  ];
  for (const re of textPatterns) {
    const m = html.match(re);
    if (m) { const d = parseDateString(m[1]); if (d) return d; }
  }
  return '';
}

// ---- 政策占比硬约束：P/(P+O) ≤ maxRatio ⟺ P ≤ maxRatio/(1-maxRatio)·O ----
// 按来源多样性优先裁剪（每源先保 1 条），避免新接入源因数组排位靠后被优先裁掉
function capPolicyItems(items, maxRatio = 0.2) {
  const others = items.filter(x => x.cat !== 'policy').length;
  const maxP = Math.floor(others * maxRatio / (1 - maxRatio));
  if (maxP <= 0) return items.filter(x => x.cat !== 'policy');

  const picked = [];
  const ps = new Set();
  const seen = new Set();
  let pc = 0;

  for (const x of items) {
    if (x.cat !== 'policy' || pc >= maxP || seen.has(x.src)) continue;
    seen.add(x.src); ps.add(x); picked.push(x); pc++;
  }
  if (pc < maxP) {
    for (const x of items) {
      if (x.cat !== 'policy' || pc >= maxP || ps.has(x)) continue;
      ps.add(x); picked.push(x); pc++;
    }
  }
  return items.filter(x => x.cat !== 'policy' || ps.has(x));
}

module.exports = {
  UA,
  todayBJ,
  fetchCurl,
  fetchPlaywright,
  fetchHtml,
  closeBrowser,
  toAbs,
  stripEnt,
  extract,
  parseDateString,
  dateNear,
  dateFromUrl,
  extractDateFromHtml,
  capPolicyItems,
};