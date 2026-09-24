#!/usr/bin/env node
/**
 * notify-wecom-app.js —— 把当日工程早报推送到「企业微信自建应用」，
 * 成员开启「在微信中接收企业消息」后，消息同显到个人微信。
 *
 * 与群机器人(notify-wecom.js)的区别：
 *   - 群机器人 Webhook 只发群；本脚本用自建应用 API，可发到指定成员 → 经微信插件到个人微信。
 *   - 自建应用 gettoken 默认【不强制 IP 白名单】（可信 IP 留空=允许所有），故可在云端 cron 直接跑，
 *     不像公众号(token 接口强制白名单 40164)那样被 GitHub Actions 动态 IP 卡死。
 *   - 前提：在企业管理后台建一个自建应用，把你自己设为可见成员；成员在企业微信 App 里
 *     开启「设置 → 新消息通知 → 在微信中接收企业消息」。
 *
 * 凭证（env 优先，其次 config/wecom-app.local.json）：
 *   WECOM_CORPID / WECOM_APP_SECRET / WECOM_AGENTID / WECOM_TOUSER(可省，默认 @all)
 * 可选：SITE_URL
 *
 * 本地 mock：设 WECOM_API_BASE=http://127.0.0.1:PORT 指向 mock 服务。
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const DATA = path.join(ROOT, 'data');
const CFG = path.join(ROOT, 'config', 'wecom-app.local.json');
const API_BASE = (process.env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com').trim();
const SITE = (process.env.SITE_URL || 'https://cyongch.github.io/engineering-daily-bot/').trim();

function loadCreds() {
  const corpid = process.env.WECOM_CORPID;
  const appSecret = process.env.WECOM_APP_SECRET;
  const agentid = process.env.WECOM_AGENTID;
  if (corpid && appSecret && agentid) {
    return { corpid, appSecret, agentid, touser: process.env.WECOM_TOUSER || '@all' };
  }
  try {
    const j = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    if (j.corpid && j.app_secret && j.agentid) {
      return { corpid, appSecret: j.app_secret, agentid: j.agentid, touser: j.touser || '@all' };
    }
  } catch (_) {}
  return null;
}

let items = [];
try { items = JSON.parse(fs.readFileSync(path.join(DATA, 'items.json'), 'utf8')); } catch (e) {}
let bless = '';
try { bless = fs.readFileSync(path.join(DATA, 'bless.txt'), 'utf8').trim(); } catch (e) {}

const LABELS = { policy: '造价政策', epc: 'EPC管理', price: '市场价格', case: '典型案例', review: '热评' };
const cnt = {};
items.forEach((i) => { cnt[i.cat] = (cnt[i.cat] || 0) + 1; });
const parts = Object.keys(LABELS).filter((k) => cnt[k]).map((k) => LABELS[k] + ' ' + cnt[k]).join(' / ');

const d = new Date(Date.now() + 8 * 3600 * 1000);
const dateStr = d.getMonth() + 1 + '月' + d.getDate() + '日';

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

function httpGetJson(url) {
  return fetch(url).then((r) => r.json());
}
function httpPostJson(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
}

(async () => {
  const creds = loadCreds();
  if (!creds) {
    console.error('未配置企业微信自建应用凭证（WECOM_CORPID/WECOM_APP_SECRET/WECOM_AGENTID 或 config/wecom-app.local.json）—— 跳过推送');
    process.exit(0);
  }
  if (!items.length) { console.error('无 data/items.json 内容 —— 跳过'); process.exit(0); }

  try {
    // 1) 获取 access_token
    const tokenUrl = `${API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(creds.corpid)}&corpsecret=${encodeURIComponent(creds.appSecret)}`;
    const t = await httpGetJson(tokenUrl);
    if (t.errcode) {
      console.error(`获取 access_token 失败：${t.errcode} ${t.errmsg}（若 60020 请在自建应用「可信 IP」留空或加入 Actions 出口 IP）`);
      process.exit(1);
    }
    // 2) 发送应用消息（markdown）
    const sendUrl = `${API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(t.access_token)}`;
    const body = {
      touser: creds.touser,
      msgtype: 'markdown',
      agentid: Number(creds.agentid),
      markdown: { content: md },
    };
    const r = await httpPostJson(sendUrl, body);
    console.log('企业微信自建应用推送返回：', JSON.stringify(r));
    if (r.errcode !== 0) { process.exit(1); }
    console.log(`已推送到企业微信自建应用（touser=${creds.touser}），开启微信插件后即同显个人微信`);
  } catch (e) {
    console.error('企业微信自建应用推送失败：', e.message);
    process.exit(1);
  }
})();
