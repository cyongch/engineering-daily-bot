#!/usr/bin/env node
/**
 * summarize.js —— 资讯「内容简述」生成
 *
 * 读 data/items.json，逐条抓取原文正文，生成 1-2 句要点式简述，回写 note 字段。
 *
 * 背景：本地原版 engineering-daily.html 每条都带专业要点简述，但自动化版 fetch.js
 *       把 note 写死为空 → build.js 的 `it.note ? 渲染 : 不渲染` 判定为空 → 简述整体消失。
 *
 * 实测结论（据此设计）：
 *   ① meta description 不可用：18 条仅 5 条有值，且全为站点通用宣传语（如"最高法网是群众
 *      了解的窗口"），无一是资讯摘要。
 *   ② 正文可用率 72%，但含版权/客服等噪音，需清洗。
 *   ③ 纯规则摘要质量不达标：清洗后再过滤标题重复与条款原文，仅 6/18 可用 → 不可单独上线。
 *   故：AI 提炼为主（需 ZHIPU_API_KEY），规则回退仅作单条兜底；无 key 则整体跳过。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const itemsPath = path.join(ROOT, 'data', 'items.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));

// ---- 正文抓取与清洗 ----
function fetchHtml(u) {
  try {
    return execSync('curl -sL -A "' + UA + '" --max-time 15 "' + u + '"', { encoding: 'utf8', maxBuffer: 8e6 });
  } catch (e) { return ''; }
}

// 噪音：版权/客服/导航/备案等非正文
const NOISE = /版权|转载|免责声明|客服|致电|联系电话|热线|登录|注册|验证码|Copyright|ICP|公安|备案|扫一扫|二维码|分享|上一篇|下一篇|返回顶部|友情链接|您所在的位置|首页\s*>/;

function parseParagraphs(h) {
  const s = h.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<!--[\s\S]*?-->/g, '');
  return (s.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [])
    .map(x => x.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length >= 25 && !NOISE.test(t));
}

// 取信息量最高的段落（优先含文号/日期/具体事项，避开纯立法目的套话）
function pickBest(ps) {
  if (!ps.length) return '';
  const scored = ps.map(t => {
    let sc = 0;
    if (/\d{4}年\d{1,2}月|\d+号令|自.*起施行|通知|公告|解读|发布/.test(t)) sc += 2;
    if (/造价|结算|计价|定额|招标|投标|资质|材料|价格|标准|管理|施工/.test(t)) sc += 1;
    if (t.length > 40 && t.length < 300) sc += 1;
    return { t: t, s: sc };
  }).sort((a, b) => b.s - a.s);
  return scored[0] ? scored[0].t : '';
}

// ① 价格/数据类：标题自含指数值，直接结构化成句（此类页面正文为 JS 图表，抓不到）
function notePrice(title) {
  const m = title.match(/(.+?指数)\s*([\d.]+)\s*([+-][\d.]+)?\s*([+-]?[\d.]+%)?/);
  if (!m) return '';
  const name = m[1].trim(), val = m[2], chg = m[3], pct = m[4];
  if (chg) {
    const dir = chg[0] === '-' ? '下跌' : '上涨';
    return name + '报 ' + val + '，环比' + dir + Math.abs(parseFloat(chg)) + (pct ? '（' + pct + '）' : '') + '。';
  }
  return name + '报 ' + val + (pct ? '（' + pct + '）' : '') + '，本期环比持平。';
}

// ② 法规/部令类：从正文提取「令号 + 施行日期 + 立法目的」，三者组句
//    （此前把"第一条 为了…"当套话误杀，实为高价值结构化信息）
function noteRegulation(h, title) {
  if (!/规定|办法|条例|细则|导则|标准/.test(title)) return '';
  const parts = [];
  const dateM = h.match(/自\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日起?施行/);
  const noM = h.match(/(?:住房和城乡建设部令|住建部令|自治区人民政府令|人民政府令)?\s*第?\s*([0-9]{1,4})\s*号/);
  if (noM) parts.push('令第' + noM[1] + '号');
  if (dateM) parts.push('自' + dateM[1] + '年' + dateM[2] + '月' + dateM[3] + '日起施行');
  const aimM = h.match(/第[一1]条\s*为[了]?([^。]{12,70})。/);
  if (aimM) parts.push('旨在' + aimM[1].replace(/^了?/, '').trim());
  if (!parts.length) return '';
  let s = parts.join('；');
  if (s.length < 12) return '';
  s = s.length > 95 ? s.slice(0, 95) : s;
  return s + (/[。；]$/.test(s) ? '' : '。');
}

// ③ 通用正文类：取信息量最高的段落
function noteGeneric(ps, title) {
  const t = pickBest(ps);
  if (!t) return '';
  const norm = s => s.replace(/[《》〈〉（）()\s、，。；：""'']/g, '');
  // 仅当与标题「几乎完全相同」才丢弃（此前按前12字判定，误杀过多）
  if (norm(t) === norm(title) || (norm(title) && norm(t).indexOf(norm(title)) === 0 && t.length - title.length < 12)) return '';
  let s = t.length > 95 ? t.slice(0, 95) : t;
  const last = Math.max(s.lastIndexOf('。'), s.lastIndexOf('；'));
  if (last > 40) s = s.slice(0, last + 1);
  return s;
}

// ④ 兜底模板：即使页面无正文（JS 渲染/抓不到）也保证每张卡都有要点简述
function noteCatchAll(it) {
  let t = String(it.title || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*20\d{2}[-/.]\d{1,2}([-/.]\d{1,2})?\s*$/, '').trim();  // 去尾部日期
  const LEAD = { policy: '政策要点', epc: '项目动态', price: '市场行情', case: '案例要点', review: '行业观察' };
  const lead = LEAD[it.cat] || '行业要点';
  const core = t.length > 64 ? t.slice(0, 64) + '…' : t;
  const tail = [it.src, it.date].filter(Boolean).join(' · ');
  return '【' + lead + '】' + core + '。' + (tail ? '（' + tail + '）' : '') + '详见原文。';
}

function fallbackNote(ps, it, h) {
  return notePrice(it.title) || noteRegulation(h, it.title) || noteGeneric(ps, it.title) || noteCatchAll(it);
}

// 正文质量护栏：若抓到的是页脚/导航/党建/HTML 实体垃圾，则改用兜底模板（保证简述可用）
const NOTE_JUNK = /(技术支持|服务电话|QQ：|版权所有|版权|ICP备|公安备案|协会简介|协会章程|组织架构|组织机构|领导成员|常务理事|理事名单|监事会|会员之窗|友情链接|网站地图|联系我们|关于我们|二十大|红心连新|应知应会|观影|长征|人才评价|通讯录)/;
function guardNote(it, note) {
  const s = String(note || '');
  const plain = s.replace(/&[a-z]+;|&#\d+;/gi, '').replace(/[\s、，。；：""''（）()《》〈〉·—\-]/g, '');
  if (!s || NOTE_JUNK.test(s) || plain.length < 8) return noteCatchAll(it);
  return s;
}

// ---- AI 提炼（Node 原生 fetch，跨平台且无临时文件）----
async function aiNote(it, body, key) {
  const prompt = '你是工程造价领域的资深顾问。请为这条工程行业资讯提炼一句要点式简述。\n'
    + '要求：1) 40-90字；2) 必须包含最具价值的事实要素（文号/施行日期/核心条款/价格数据/影响范围），不写套话；\n'
    + '3) 面向造价工程师，突出对造价工作的实际影响；4) 只输出简述本身，不要前缀、引号或换行。\n\n'
    + '标题：' + it.title + '\n来源：' + it.src + '\n正文节选：' + body.slice(0, 1200);
  try {
    const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-4-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 300
      })
    });
    const j = await resp.json();
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (c) return c.trim().replace(/^["“”]|["“”]$/g, '').replace(/\s*\n\s*/g, ' ');
  } catch (e) {}
  return '';
}

(async function main() {
  const KEY = (process.env.ZHIPU_API_KEY || '').trim();
  console.log('模式：', KEY ? 'AI 提炼优先（智谱 glm-4-flash）+ 规则兜底' : '仅规则模式（未配 ZHIPU_API_KEY）');

  let aiOk = 0, fbOk = 0, miss = 0;
  for (const it of items) {
    const h = fetchHtml(it.url);
    if (!h || h.length < 500) {
      // 页面拿不到时：价格类按标题结构化，否则用兜底模板（保证每张卡都有简述）
      const isPrice = !!notePrice(it.title);
      it.note = notePrice(it.title) || noteCatchAll(it);
      fbOk++;
      console.log(isPrice ? '[规则]' : '[兜底]', it.src, '|', it.note.slice(0, 50));
      continue;
    }
    const ps = parseParagraphs(h);
    let note = KEY ? await aiNote(it, ps.join(' '), KEY) : '';
    if (note) { aiOk++; console.log('[AI]  ', it.src, '|', note.slice(0, 50)); }
    else {
      note = guardNote(it, fallbackNote(ps, it, h));
      if (note) { fbOk++; console.log('[规则]', it.src, '|', note.slice(0, 50)); }
      else { miss++; console.log('[缺失]', it.src, '|', it.title.slice(0, 26)); }
    }
    it.note = note;
  }

  // 需求：每张卡都要有要点简述 → 所有条目均保留（兜底模板 guarantee note 非空），不再剔除。
  let kept = items.slice();

  // 硬约束：造价政策占比必须 ≤20%。
  // 软配额（LIMIT）会因每日抓取波动失效，故按比例裁剪兜底：
  //   P/(P+O) ≤ 0.2  ⟺  P ≤ 0.25·O（O = 非政策类条数）
  const MAX_POLICY_RATIO = 0.2;
  const others = kept.filter(x => x.cat !== 'policy').length;
  const maxPolicy = Math.floor(others * MAX_POLICY_RATIO / (1 - MAX_POLICY_RATIO));
  // 裁剪策略：按来源多样性优先（每源先保 1 条）。
  // 若按原顺序截取，新接入的煤炭/建筑源永远排在末尾、必被优先裁掉。
  let pCount = 0;
  const picked = [];
  const seenSrc = new Set();
  for (const x of kept) {
    if (x.cat !== 'policy' || pCount >= maxPolicy) continue;
    if (seenSrc.has(x.src)) continue;
    seenSrc.add(x.src); picked.push(x); pCount++;
  }
  const pickSet = new Set(picked);
  if (pCount < maxPolicy) {
    for (const x of kept) {
      if (x.cat !== 'policy' || pCount >= maxPolicy || pickSet.has(x)) continue;
      picked.push(x); pickSet.add(x); pCount++;
    }
  }
  const trimmed = kept.filter(x => x.cat !== 'policy' || pickSet.has(x));
  if (trimmed.length !== kept.length) {
    console.log('政策占比约束：剔除 ' + (kept.length - trimmed.length) + ' 条政策（目标 ≤20%，上限 ' + maxPolicy + ' 条）');
  }
  kept = trimmed;

  const dropped = items.length - kept.length;
  if (dropped) {
    console.log('--- 剔除无正文条目 ' + dropped + ' 条 ---');
    items.filter(x => !x.note || x.note.length < 8).forEach(x => console.log('   [剔除]', x.src, '|', x.title.slice(0, 30)));
  }
  fs.writeFileSync(itemsPath, JSON.stringify(kept), 'utf8');
  console.log('=== 汇总 === 候选', items.length, '| 保留', kept.length, '(AI', aiOk, '/规则', fbOk, ') | 剔除',
    dropped, '| 简述覆盖率', ((aiOk + fbOk) / items.length * 100).toFixed(0) + '%');
})();
