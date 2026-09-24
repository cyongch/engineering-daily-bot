#!/usr/bin/env node
/**
 * notify-wxmp.js — 把当日工程早报推送到微信公众号「草稿箱」。
 *
 * 为何独立、不进云端 cron：
 *   公众号所有接口调用前都要换 access_token，而微信对 token 接口强制校验
 *   IP 白名单（40164 invalid ip）。GitHub Actions 云端出口 IP 动态变化无法写死，
 *   因此本脚本只能在【白名单 IP 的机器】上运行（本机 / 自托管 runner）。
 *
 * 数据来源：data/items.json + data/bless.txt（由 fetch→summarize→build 产出）。
 *
 * 凭证（任选其一，优先级 env > 本地文件）：
 *   - 环境变量 WX_APPID / WX_SECRET
 *   - 本地文件 config/wx.local.json：{ "appid": "...", "secret": "..." }
 *   可选：WX_THUMB_MEDIA_ID（封面图 media_id，缺省用公众号默认封面）
 *
 * 用法：
 *   WX_APPID=xxx WX_SECRET=yyy node scripts/notify-wxmp.js
 */

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// 按协议选择模块（便于本地 mock / 内网代理用 http）
function pickModule(url) {
  return url.startsWith('https://') ? https : http;
}

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CFG_PATH = path.join(ROOT, 'config', 'wx.local.json');

// ---------- 凭证读取 ----------
function loadCreds() {
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_SECRET;
  if (appid && secret) return { appid, secret };
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    if (j.appid && j.secret) return { appid: j.appid, secret: j.secret };
  } catch (_) { /* 无本地文件 */ }
  return null;
}

// ---------- 极简 HTTP POST ----------
function httpPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const req = pickModule(url).request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error('响应非 JSON: ' + buf.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 兼容测试：用 env WX_API_BASE 覆盖 base（mock 服务器）
const API_BASE = process.env.WX_API_BASE || 'https://api.weixin.qq.com';

// 极简 HTTP GET（用于 token 接口）
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = pickModule(url).request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(new Error('响应非 JSON: ' + b.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------- 生成文章 HTML ----------
const CAT_LABEL = {
  policy: '政策·标准',
  epc: 'EPC·总包',
  price: '价格·指数',
  case: '争议·案例',
  review: '研究·观点',
};

function buildArticleHtml(items, bless, dateStr) {
  const sections = items
    .map((it) => {
      const cat = CAT_LABEL[it.cat] || it.cat || '资讯';
      const titleHtml = it.url
        ? `<a href="${escapeAttr(it.url)}">${escapeHtml(it.title)}</a>`
        : escapeHtml(it.title);
      const note = it.note ? `<p style="margin:6px 0 0;color:#444;line-height:1.8;">${escapeHtml(it.note)}</p>` : '';
      const src = it.source ? `<span style="color:#999;font-size:13px;">来源：${escapeHtml(it.source)}</span>` : '';
      return `<section style="margin:0 0 18px;padding:12px 14px;background:#f7f9fc;border-left:4px solid #2f6fed;border-radius:6px;">
  <p style="margin:0 0 4px;font-weight:600;color:#2f6fed;font-size:13px;">${escapeHtml(cat)}</p>
  <p style="margin:0;font-size:16px;font-weight:600;line-height:1.6;">${titleHtml}</p>
  ${note}
  <p style="margin:6px 0 0;">${src}</p>
</section>`;
    })
    .join('\n');

  const blessHtml = bless
    ? `<section style="margin:0 0 16px;padding:10px 14px;background:#fff7e6;border-radius:6px;color:#8a6d3b;font-style:italic;line-height:1.8;">${escapeHtml(bless)}</section>`
    : '';

  return `<section style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2329;line-height:1.8;">
  <h1 style="font-size:22px;margin:0 0 6px;">工程行业早报 · ${escapeHtml(dateStr)}</h1>
  <p style="margin:0 0 16px;color:#888;font-size:13px;">造价 · EPC · 价格 · 争议 — 每日精选</p>
  ${blessHtml}
  ${sections}
  <p style="margin:20px 0 0;color:#999;font-size:12px;">本早报由工程行业早报自动化生成，点击「查看原文」可浏览完整网页版。</p>
</section>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/ /g, '%20');
}

// ---------- 主流程 ----------
async function main() {
  const creds = loadCreds();
  if (!creds) {
    console.error('[wxmp] 未找到公众号凭证：请设置 WX_APPID/WX_SECRET 环境变量，或创建 config/wx.local.json');
    process.exit(1);
  }

  let items = [], bless = '', dateStr = '';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'items.json'), 'utf8'));
    items = Array.isArray(raw) ? raw : (raw.items || []);
    bless = (() => { try { return fs.readFileSync(path.join(DATA_DIR, 'bless.txt'), 'utf8').trim(); } catch (_) { return ''; } })();
    dateStr = raw.date || raw.dateStr || new Date().toISOString().slice(0, 10);
  } catch (e) {
    console.error('[wxmp] 读取 data/items.json 失败：' + e.message);
    process.exit(1);
  }

  if (!items.length) {
    console.error('[wxmp] 当日无条目，跳过推送');
    process.exit(0);
  }

  // 1) 换 access_token（GET 接口）
  const tokenUrl = `${API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(creds.appid)}&secret=${encodeURIComponent(creds.secret)}`;
  const tokenRes = await httpGetJson(tokenUrl);
  if (tokenRes.errcode) {
    console.error(`[wxmp] 获取 access_token 失败：${tokenRes.errcode} ${tokenRes.errmsg}`);
    process.exit(1);
  }
  const accessToken = tokenRes.access_token;
  console.log('[wxmp] access_token 获取成功');

  // 2) 草稿箱新增
  const html = buildArticleHtml(items, bless, dateStr);
  const article = {
    title: `工程行业早报 · ${dateStr}`,
    author: '工程行业早报',
    digest: bless || `今日 ${items.length} 条造价/EPC/价格/争议精选`,
    content: html,
    content_source_url: process.env.SITE_URL || 'https://cyongch.github.io/engineering-daily-bot/',
    need_open_comment: 0,
    only_fans_can_comment: 0,
  };
  if (process.env.WX_THUMB_MEDIA_ID) article.thumb_media_id = process.env.WX_THUMB_MEDIA_ID;

  const draftRes = await httpPostJson(`${API_BASE}/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`, { articles: [article] });
  if (draftRes.errcode) {
    console.error(`[wxmp] 草稿箱新增失败：${draftRes.errcode} ${draftRes.errmsg}`);
    process.exit(1);
  }
  console.log(`[wxmp] ✅ 已推送到公众号草稿箱 media_id=${draftRes.media_id}（共 ${items.length} 条，请在公众号后台预览并发布）`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[wxmp] 异常：' + e.message);
  process.exit(1);
});
