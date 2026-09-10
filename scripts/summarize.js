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

// 规则回退（仅作单条兜底）：过滤标题重复与纯条款原文，避免无信息增量的"伪简述"
function fallbackNote(ps, title) {
  const t = pickBest(ps);
  if (!t) return '';
  const norm = s => s.replace(/[《》〈〉（）()\s、，。；：""'']/g, '');
  if (norm(t).indexOf(norm(title).slice(0, 12)) === 0) return '';
  if (/^第[一二三四五六七八九十百]+条/.test(t)) return '';
  let s = t.length > 95 ? t.slice(0, 95) : t;
  const last = Math.max(s.lastIndexOf('。'), s.lastIndexOf('；'));
  if (last > 40) s = s.slice(0, last + 1);
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
  if (!KEY) {
    console.log('SKIP 未配置 ZHIPU_API_KEY，跳过简述生成（规则回退实测仅 6/18 可用，宁缺毋滥）');
    return;
  }
  console.log('模式：AI 提炼（智谱 glm-4-flash）');

  let aiOk = 0, fbOk = 0, miss = 0;
  for (const it of items) {
    const h = fetchHtml(it.url);
    if (!h || h.length < 500) { miss++; console.log('[无正文]', it.title.slice(0, 28)); it.note = ''; continue; }
    const ps = parseParagraphs(h);
    let note = await aiNote(it, ps.join(' '), KEY);
    if (note) { aiOk++; console.log('[AI]  ', note.slice(0, 56)); }
    else {
      note = fallbackNote(ps, it.title);
      if (note) { fbOk++; console.log('[回退]', note.slice(0, 56)); }
      else { miss++; console.log('[缺失]', it.title.slice(0, 28)); }
    }
    it.note = note;
  }
  fs.writeFileSync(itemsPath, JSON.stringify(items), 'utf8');
  console.log('=== 汇总 === 总数', items.length, '| AI', aiOk, '| 回退', fbOk, '| 缺失', miss,
    '| 覆盖率', (((aiOk + fbOk) / items.length) * 100).toFixed(0) + '%');
})();
