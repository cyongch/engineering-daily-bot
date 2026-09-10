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

function fallbackNote(ps, title, h) {
  return notePrice(title) || noteRegulation(h, title) || noteGeneric(ps, title);
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
      // 页面拿不到时仍尝试价格类模板（标题自含数据）
      const t = notePrice(it.title);
      if (t) { fbOk++; it.note = t; console.log('[规则]', it.src, '|', t.slice(0, 50)); continue; }
      miss++; console.log('[缺失]', it.src, '|', it.title.slice(0, 26)); it.note = ''; continue;
    }
    const ps = parseParagraphs(h);
    let note = KEY ? await aiNote(it, ps.join(' '), KEY) : '';
    if (note) { aiOk++; console.log('[AI]  ', it.src, '|', note.slice(0, 50)); }
    else {
      note = fallbackNote(ps, it.title, h);
      if (note) { fbOk++; console.log('[规则]', it.src, '|', note.slice(0, 50)); }
      else { miss++; console.log('[缺失]', it.src, '|', it.title.slice(0, 26)); }
    }
    it.note = note;
  }

  // 按用户要求：无正文/拿不到简述的条目不出现在卡片中，位置由其他有内容的条目替补。
  // fetch.js 已"宽进"产出多余候选，此处收敛后即为最终展示条目。
  const kept = items.filter(x => x.note && x.note.length >= 8);
  const dropped = items.length - kept.length;
  if (dropped) {
    console.log('--- 剔除无正文条目 ' + dropped + ' 条 ---');
    items.filter(x => !x.note || x.note.length < 8).forEach(x => console.log('   [剔除]', x.src, '|', x.title.slice(0, 30)));
  }
  fs.writeFileSync(itemsPath, JSON.stringify(kept), 'utf8');
  console.log('=== 汇总 === 候选', items.length, '| 保留', kept.length, '(AI', aiOk, '/规则', fbOk, ') | 剔除',
    dropped, '| 简述覆盖率', ((aiOk + fbOk) / items.length * 100).toFixed(0) + '%');
})();
