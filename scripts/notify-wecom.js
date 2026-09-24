#!/usr/bin/env node
/**
 * notify-wecom.js —— 把当日工程早报推送到「企业微信群机器人」Webhook
 *
 * 为什么用企业微信群机器人而不是公众号：
 *   微信公众平台 API 有 IP 白名单硬约束，GitHub Actions 出口 IP 动态、无法白名单 → 推不了；
 *   企业微信群机器人 Webhook 无需 IP 白名单、无需 AppID/Secret，Actions 可直接调用。
 *
 * 用法：
 *   WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" node scripts/notify-wecom.js
 *   （GitHub Actions 中经 secrets.WECOM_WEBHOOK 注入；未设置时静默跳过、退出码 0）
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const SITE = (process.env.SITE_URL || 'https://cyongch.github.io/engineering-daily-bot/').trim();
const HOOK = (process.env.WECOM_WEBHOOK || '').trim();

let items = [];
try { items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'items.json'), 'utf8')); } catch (e) {}
let bless = '';
try { bless = fs.readFileSync(path.join(ROOT, 'data', 'bless.txt'), 'utf8').trim(); } catch (e) {}

const LABELS = { policy: '造价政策', epc: 'EPC管理', price: '市场价格', case: '典型案例', review: '热评' };
const cnt = {};
items.forEach(i => { cnt[i.cat] = (cnt[i.cat] || 0) + 1; });
const parts = Object.keys(LABELS).filter(k => cnt[k]).map(k => LABELS[k] + ' ' + cnt[k]).join(' / ');

const d = new Date(Date.now() + 8 * 3600 * 1000);
const dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日';

function clip(s, n) {
  s = String(s || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function buildMarkdown(maxItems, titleLen) {
  const list = items.slice(0, maxItems)
    .map((it, i) => `${i + 1}. [${clip(it.title, titleLen)}](${it.url})`).join('\n');
  return [
    `**工程行业早报 · ${dateStr}**`,
    bless ? `> ${bless}` : '',
    `今日 ${items.length} 条｜${parts}`,
    '',
    list,
    '',
    `[查看完整早报](${SITE})`,
  ].filter(Boolean).join('\n');
}

// 企业微信 markdown 上限 4096 字节，超长自动收敛条目数/标题长度
let md = buildMarkdown(8, 38);
if (Buffer.byteLength(md, 'utf8') > 4000) md = buildMarkdown(5, 32);
if (Buffer.byteLength(md, 'utf8') > 4000) md = buildMarkdown(3, 28);

(async () => {
  if (!HOOK) { console.error('未设置 WECOM_WEBHOOK —— 跳过企业微信推送'); process.exit(0); }
  if (!items.length) { console.error('无 data/items.json 内容 —— 跳过'); process.exit(0); }
  try {
    const resp = await fetch(HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: md } }),
    });
    const j = await resp.json().catch(() => ({}));
    console.log('WECOM 推送返回：', JSON.stringify(j));
    if (j && j.errcode !== 0) { process.exit(1); }
    console.log('已推送至企业微信');
  } catch (e) {
    console.error('WECOM 推送失败：', e.message);
    process.exit(1);
  }
})();
