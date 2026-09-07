#!/usr/bin/env node
/**
 * build.js —— 注入构建
 * 读 template.html + data/items.json + data/bless.txt，下载各源 favicon 到 dist/thumbs/，
 * 注入 ITEMS / BLESS / DOMAIN_THUMB，预渲染静态卡，输出 dist/engineering-daily.html。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const tplPath = path.join(ROOT, 'template.html');
const dataDir = path.join(ROOT, 'data');
const distDir = path.join(ROOT, 'dist');
const thumbDir = path.join(distDir, 'thumbs');
fs.mkdirSync(thumbDir, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CAT_LABEL = { policy: '造价政策', epc: 'EPC管理', price: '市场价格', case: '典型案例', review: '热评' };

let tpl = fs.readFileSync(tplPath, 'utf8');
const items = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8'));
const bless = fs.readFileSync(path.join(dataDir, 'bless.txt'), 'utf8').trim();

// ---- 下载各源 favicon（复用既有逻辑）----
function slug(d) { return d.replace(/^www\./, '').replace(/[^a-z0-9.\-]/gi, '_'); }
function tryGet(url, out) {
  let code = '000', ct = '';
  try {
    const r = execSync('curl -sL -A "' + UA + '" --max-time 12 -o "' + out + '" -w "%{http_code}|%{content_type}" "' + url + '"', { encoding: 'utf8', maxBuffer: 1e7 }).trim();
    const p = r.lastIndexOf('|'); code = r.slice(0, p); ct = r.slice(p + 1);
  } catch (e) {}
  return { code, ct };
}
const domains = Array.from(new Set(items.map(it => { try { return new URL(it.url).hostname; } catch (e) { return null; } }).filter(Boolean)));
const DOMAIN_THUMB = {};
for (const d of domains) {
  let saved = null;
  const cands = ['https://' + d + '/favicon.ico', 'http://' + d + '/favicon.ico', 'https://' + d + '/favicon.png'];
  for (const c of cands) {
    const out = path.join(thumbDir, slug(d) + '_t');
    const res = tryGet(c, out);
    if (res.code === '200' && res.ct && res.ct.indexOf('image') === 0) {
      const ext = /png/.test(res.ct) ? '.png' : /svg/.test(res.ct) ? '.svg' : '.ico';
      const fin = path.join(thumbDir, slug(d) + ext);
      try { fs.renameSync(out, fin); } catch (e) { try { fs.copyFileSync(out, fin); fs.unlinkSync(out); } catch (e2) {} }
      saved = 'thumbs/' + slug(d) + ext; break;
    } else { try { fs.unlinkSync(out); } catch (e) {} }
  }
  if (!saved) {
    try {
      const page = execSync('curl -sL -A "' + UA + '" --max-time 12 "' + (d.indexOf('http') === 0 ? d : 'https://' + d) + '"', { encoding: 'utf8', maxBuffer: 5e6 });
      const lm = page.match(/<link[^>]+rel="[^"]*icon[^"]*"[^>]+href="([^"]+)"/i) || page.match(/<link[^>]+href="([^"]+)"[^>]+rel="[^"]*icon[^"]*"/i);
      if (lm) {
        let href = lm[1];
        if (href.indexOf('//') === 0) href = 'https:' + href;
        else if (href.indexOf('/') === 0) href = 'https://' + d + href;
        else if (!/^https?:/.test(href)) href = 'https://' + d + '/' + href;
        const out = path.join(thumbDir, slug(d) + '_t');
        const res = tryGet(href, out);
        if (res.code === '200' && res.ct && res.ct.indexOf('image') === 0) {
          const ext = /png/.test(res.ct) ? '.png' : /svg/.test(res.ct) ? '.svg' : '.ico';
          const fin = path.join(thumbDir, slug(d) + ext);
          try { fs.renameSync(out, fin); } catch (e) { try { fs.copyFileSync(out, fin); fs.unlinkSync(out); } catch (e2) {} }
          saved = 'thumbs/' + slug(d) + ext;
        } else { try { fs.unlinkSync(out); } catch (e) {} }
      }
    } catch (e) {}
  }
  DOMAIN_THUMB[d] = saved;
}

// ---- 注入占位 ----
const itemsJson = JSON.stringify(items);
const dtJson = JSON.stringify(DOMAIN_THUMB);
const blessJson = JSON.stringify(bless); // 转义引号，用作 JS 字符串字面量
tpl = tpl.replace('__BLESS__', blessJson.slice(1, -1));
tpl = tpl.replace('__ITEMS__', itemsJson);
tpl = tpl.replace('__DOMAIN_THUMB__', dtJson);

// ---- 预渲染静态卡（保证预览面板/无 JS 环境可见）----
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function thumbFor(it) {
  let dm = ''; try { dm = new URL(it.url).hostname; } catch (e) {}
  const t = DOMAIN_THUMB[dm];
  if (!t) return '';
  return '<img class="fav" src="' + t + '" alt="" loading="lazy" onerror="favFail(this)">';
}
const cards = items.map((it, idx) => {
  const label = CAT_LABEL[it.cat] || '资讯';
  const ph = '<div class="ph" style="background:#2E9BFF33;color:#2E9BFF">' + label + '</div>';
  const meta = [it.src, it.date].filter(Boolean).join(' · ');
  const comment = it.note ? '<div class="item-comment"><p>' + esc(it.note) + '</p>' + (meta ? '<span class="src">— ' + esc(meta) + '</span>' : '') + '</div>' : '';
  return '<div class="item reveal">' +
    '<div class="item-thumb">' + thumbFor(it) + ph + '</div>' +
    '<div class="item-body">' +
    '<span class="item-idx">' + (idx + 1) + '</span>' +
    '<span class="item-tag ' + it.cat + '">' + label + '</span>' +
    '<div class="item-title"><a href="' + it.url + '" target="_blank" rel="noopener">' + esc(it.title) + '</a></div>' +
    comment +
    '</div></div>';
}).join('\n');
tpl = tpl.replace(/<div id="list"><\/div>/, '<div id="list">\n' + cards + '\n    </div>');

fs.writeFileSync(path.join(distDir, 'engineering-daily.html'), tpl);
console.log('BUILD OK items=' + items.length + ' thumbs=' + Object.values(DOMAIN_THUMB).filter(Boolean).length + ' out=dist/engineering-daily.html');
