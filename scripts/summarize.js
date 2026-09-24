#!/usr/bin/env node
/**
 * summarize.js v2 —— 资讯「内容简述」生成
 *
 * 改进点：
 *   1) curl + Playwright 降级抓取正文（抽不出段落才降级），提升正文抓取率
 *   2) 移除重复的政策裁剪（已由 fetch.js 统一处理）
 *   3) 增强规则模式：EPC 类提取项目金额/地点/工期
 */
const fs = require('fs');
const path = require('path');
const { fetchCurl, fetchPlaywright, extractDateFromHtml, todayBJ, closeBrowser, capPolicyItems } = require('../lib/fetcher');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const itemsPath = path.join(ROOT, 'data', 'items.json');
const today = todayBJ();

let items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));

const NOISE = /版权|转载|免责声明|客服|致电|联系电话|热线|登录|注册|验证码|Copyright|ICP|公安|备案|扫一扫|二维码|分享|上一篇|下一篇|返回顶部|友情链接|您所在的位置|首页\s*>/;

function parseParagraphs(h) {
  const s = h.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<!--[\s\S]*?-->/g, '');
  return (s.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [])
    .map(x => x.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length >= 25 && !NOISE.test(t));
}

function pickBest(ps) {
  if (!ps.length) return '';
  const scored = ps.map(t => {
    let sc = 0;
    if (/\d{4}年\d{1,2}月|\d+号令|自.*起施行|通知|公告|解读|发布/.test(t)) sc += 2;
    if (/造价|结算|计价|定额|招标|投标|资质|材料|价格|标准|管理|施工/.test(t)) sc += 1;
    if (t.length > 40 && t.length < 300) sc += 1;
    return { t, s: sc };
  }).sort((a, b) => b.s - a.s);
  return scored[0] ? scored[0].t : '';
}

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

// EPC 类增强：尝试提取项目金额、地点、工期
function noteEpc(h, title) {
  if (!/EPC|总承包|工程总承包|设计施工|招标项目|承包/.test(title)) return '';
  const parts = [];
  const amountM = h.match(/(?:估算?投资|概算|预算|中标价|合同额|金额)\s*[：:]?\s*([\d.]+\s*[万亿]?元)/);
  const locM = h.match(/(\S{2,6}(?:省|市|区|县))\s*(?:拟建|在建|建设)/);
  const periodM = h.match(/工期\s*(\d+\s*(?:天|月|年))/);
  if (amountM) parts.push('投资额 ' + amountM[1]);
  if (locM) parts.push('地点 ' + locM[1]);
  if (periodM) parts.push('工期 ' + periodM[1]);
  if (!parts.length) return '';
  let s = '【项目动态】' + parts.join('，') + '。';
  return s.length > 95 ? s.slice(0, 95) + '。' : s;
}

function noteGeneric(ps, title) {
  const t = pickBest(ps);
  if (!t) return '';
  const norm = s => s.replace(/[《》〈〉（）()\s、，。；：""'']/g, '');
  if (norm(t) === norm(title) || (norm(title) && norm(t).indexOf(norm(title)) === 0 && t.length - title.length < 12)) return '';
  let s = t.length > 95 ? t.slice(0, 95) : t;
  const last = Math.max(s.lastIndexOf('。'), s.lastIndexOf('；'));
  if (last > 40) s = s.slice(0, last + 1);
  return s;
}

function noteCatchAll(it) {
  let t = String(it.title || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*20\d{2}[-/.]\d{1,2}([-/.]\d{1,2})?\s*$/, '').trim();
  const LEAD = { policy: '政策要点', epc: '项目动态', price: '市场行情', case: '案例要点', review: '行业观察' };
  const lead = LEAD[it.cat] || '行业要点';
  const core = t.length > 64 ? t.slice(0, 64) + '…' : t;
  const tail = [it.src, it.date].filter(Boolean).join(' · ');
  return '【' + lead + '】' + core + '。' + (tail ? '（' + tail + '）' : '') + '详见原文。';
}

function fallbackNote(ps, it, h) {
  return notePrice(it.title) || noteEpc(h, it.title) || noteRegulation(h, it.title) || noteGeneric(ps, it.title) || noteCatchAll(it);
}

const NOTE_JUNK = /(技术支持|服务电话|QQ：|版权所有|版权|ICP备|公安备案|协会简介|协会章程|组织架构|组织机构|领导成员|常务理事|理事名单|监事会|会员之窗|友情链接|网站地图|联系我们|关于我们|二十大|红心连新|应知应会|观影|长征|人才评价|通讯录|主办：|指导单位：|搜索|首页\s*>>)/;

// 结构性噪音：图表页坐标轴标签（"月-- 市场价月-- 预测价--…"）与导航词堆（"不锈钢 卷板 平板…"）
// 这类文本无句末标点、由空格分隔的短词组成，NOTE_JUNK 关键词表覆盖不到，需按形态判定
function looksLikeJunk(s) {
  if ((s.match(/--/g) || []).length >= 2) return true;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length >= 6) {
    const short = tokens.filter(t => t.length <= 4).length;
    if (short / tokens.length > 0.7 && !/[。；！？]/.test(s)) return true;
  }
  return false;
}

function guardNote(it, note) {
  const s = String(note || '');
  const plain = s.replace(/&[a-z]+;|&#\d+;/gi, '').replace(/[\s、，。；：""''（）()《》〈〉·—\-]/g, '');
  if (!s || NOTE_JUNK.test(s) || plain.length < 8 || looksLikeJunk(s)) return noteCatchAll(it);
  return s;
}

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
    if (c) return c.trim().replace(/^[""""]|[""""]$/g, '').replace(/\s*\n\s*/g, ' ');
  } catch (e) {}
  return '';
}

(async function main() {
  const KEY = (process.env.ZHIPU_API_KEY || '').trim();
  console.log('模式：', KEY ? 'AI 提炼优先（智谱 glm-4-flash）+ 规则兜底' : '仅规则模式（未配 ZHIPU_API_KEY）');

  let aiOk = 0, fbOk = 0, miss = 0, dropOld = 0;
  const dayDiff = a => Math.round((new Date(today) - new Date(a)) / 864e5);
  const maxAge = cat => 7;   // 所有分类统一 7 天，配合 fetch 阶段确保早报只含近一周内容

  for (let i = items.length - 1; i >= 0; i--) {   // 倒序便于删除超龄条目
    const it = items[i];
    // 降级判据用「段落数为 0」：正文页若是 JS 壳，HTML 体积可能正常但抽不出段落
    let h = fetchCurl(it.url);
    let ps = parseParagraphs(h);
    if (!ps.length) {
      const pw = await fetchPlaywright(it.url);
      if (pw) {
        const ps2 = parseParagraphs(pw);
        if (ps2.length) { h = pw; ps = ps2; }
      }
    }
    if (!h || h.length < 500) {
      const isPrice = !!notePrice(it.title);
      it.note = notePrice(it.title) || noteCatchAll(it);
      fbOk++;
      console.log(isPrice ? '[规则]' : '[兜底]', it.src, '|', it.note.slice(0, 50));
      continue;
    }
    // 回填详情页真实发布日期（列表页/URL 常解析不到，date 退化为 today，会造成「旧文伪装当天」）
    const real = extractDateFromHtml(h, it.url);
    if (real && real <= today && real !== it.date) {
      console.log('[回填日期]', it.date, '->', real, '|', it.title.slice(0, 22));
      it.date = real;
    }
    // 若回填/解析出的真实日期超龄，说明是列表页漏判的旧文 → 直接剔除
    if (it.date && /^\d{4}-\d{2}-\d{2}$/.test(it.date) && dayDiff(it.date) > maxAge(it.cat)) {
      items.splice(i, 1); dropOld++;
      console.log('[剔除超龄]', it.date, it.cat, '|', it.title.slice(0, 24));
      continue;
    }
    let note = KEY ? await aiNote(it, ps.join(' '), KEY) : '';
    if (note) { aiOk++; console.log('[AI]  ', it.src, '|', note.slice(0, 50)); }
    else {
      note = guardNote(it, fallbackNote(ps, it, h));
      if (note) { fbOk++; console.log('[规则]', it.src, '|', note.slice(0, 50)); }
      else { miss++; console.log('[缺失]', it.src, '|', it.title.slice(0, 26)); }
    }
    it.note = note;
  }

  // 兜底模板 guarantee note 非空，不再剔除条目

  // 最终政策占比硬约束（summarize 剔除超龄条目后比例可能反弹，需二次校准）
  const beforeCap = items.length;
  items = capPolicyItems(items, 0.2);
  if (items.length !== beforeCap) {
    console.log('POLICY_CAP: 剔除', beforeCap - items.length, '条政策（≤20%）');
  }

  const total = items.length;
  const covered = items.filter(x => x.note && x.note.length > 0).length;
  fs.writeFileSync(itemsPath, JSON.stringify(items, null, 2), 'utf8');
  console.log('=== 汇总 === 保留', total, '(AI', aiOk, '/规则', fbOk, ') | 简述覆盖率', (covered / total * 100).toFixed(0) + '%');
})()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => closeBrowser());
