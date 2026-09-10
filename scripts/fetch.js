#!/usr/bin/env node
/**
 * fetch.js —— 工程行业早报 多源采集器
 * 抓取造价/EPC 垂直资讯源，解析为 ITEMS 数组 + 当日 BLESS 寄语。
 *
 * 设计要点：
 *   - 多源冗余：住建部 + 多省住建厅（政策冗余）、水泥/砂石/百年建筑/我的钢铁（价格冗余），
 *     单源反爬抖动/失败不影响整体，杜绝单点塌空。
 *   - 关键词二次分类：统一抓取"工程相关"链接，按标题归并五类（epc>case>review>price>policy）；
 *     招标/中标/基建归入 EPC，材料价格归入 price。
 *   - 真实链接：只输出可点击原文 URL + 来源 + 日期。
 *   - note（行业观点）留空，由后续 AI 步骤补充；卡片无 note 时不显示评论块。
 *   - POOLS 常驻池仅作 case/review 兜底（当日该分类日抓为 0 才补 1 条），守住"每日新鲜"原则。
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

// 从 URL 提取日期：仅接受合法日期（年 2000-2099，月 1-12，日 1-31），避免长数字串误判
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

// 关键词二次分类（优先级 epc > case > review > price > policy）
function classify(t) {
  if (/EPC|总承包|工程总承包|设计施工|联合体|发包人要求|概算|施工图预算|招标|投标|中标|发包|承包|基建|城市更新|拟在建/.test(t)) return 'epc';
  if (/案例|判决|纠纷|裁定|败诉|胜诉|最高法|指导案例|司法解释|审计/.test(t)) return 'case';
  // review 识别词扩充：政策解读/解析/透视类文章归属"热评"，而非"造价政策"。
  // 这是提升热评比重的主要供给杠杆（单纯改配额无效——源里没有解读文章，配额再高也填不满）。
  if (/解读|评析|评论|观点|观察|分析|看法|随笔|研读|解析|详解|探析|透视|梳理|述评|问答|焦点/.test(t)) return 'review';
  if (/水泥|混凝土|砂石|钢材|建材|价格|指数|螺纹|焦炭|焦煤|铁矿|骨料|熟料|信息价/.test(t)) return 'price';
  return 'policy';
}

// 关键词过滤（宽口径）+ 煤炭类扩充（矿井/矿区/井巷/矿建/煤化工）
const KW = /造价|工程|EPC|基建|市政|定额|结算|招标|投标|中标|建材|水泥|混凝土|砂石|钢材|装配式|智能建造|全过程咨询|工程咨询|工程造价|计价|工程量清单|施工|总承包|发包|承包|审计|司法解释|标准|规范|煤矿|煤炭|矿山|矿区|矿井|井巷|矿建|煤化工/;

// 源配置：全部经实测"静态可抓 + 工程相关 + 稳定"后入选
const SOURCES = [
  // 国家住建部
  { name: '住房城乡建设部', url: 'https://www.mohurd.gov.cn/' },
  // 煤炭/建筑行业源（经实测四轮筛选；此类站点多为 JS 壳，以下为确有工程实务内容者）
  // 排位提前：置于数组末尾时配额会被省住建厅占满，导致持续出 0 条（实测煤炭协会 40 候选出 0）
  // 注意：山东省造价类站点请勿用 sdzjxh.com（实为职业技术教育学会，非造价）；
  //       hnzjxh.com 疑似已被抢注（返回 8MB 无关内容），均已排除。
  { name: '浙江省建设工程造价管理协会', url: 'http://www.zjzjxh.com/' },
  { name: '四川省造价工程师协会', url: 'http://www.sccea.net/' },
  { name: '中国煤炭加工利用协会', url: 'https://www.ccpua.org/' },
  { name: '山西省能源局',   url: 'https://nyj.shanxi.gov.cn/' },
  { name: '贵州省能源局',   url: 'https://nyj.guizhou.gov.cn/' },
  { name: '山东省能源局',   url: 'http://nyj.shandong.gov.cn/' },
  { name: '国家能源局',    url: 'https://www.nea.gov.cn/' },
  { name: '中国中煤集团',   url: 'https://www.chinacoal.com/' },
  { name: '中国煤炭地质总局', url: 'https://www.ccgc.cn/' },
  { name: '中国建筑材料联合会', url: 'https://www.cbmf.org/' },
  // 省级住建厅（政策/定额/招投标管理，全国冗余）
  { name: '内蒙古住建厅', url: 'http://zjt.nmg.gov.cn/' },
  { name: '新疆住建厅',   url: 'https://zjt.xinjiang.gov.cn/' },
  { name: '陕西住建厅',   url: 'https://js.shaanxi.gov.cn/' },
  { name: '山东住建厅',   url: 'http://zjt.shandong.gov.cn/' },
  { name: '湖南住建厅',   url: 'https://zjt.hunan.gov.cn/' },
  { name: '广东住建厅',   url: 'http://zfcxjst.gd.gov.cn/' },
  { name: '湖北住建厅',   url: 'https://zjt.hubei.gov.cn/zfxxgk/zc/gfxwj/' },
  // 招标采购 / 基建（EPC 每日源）
  { name: '中国招标投标公共服务平台', url: 'https://www.cebpubservice.com/' },
  { name: '中国拟在建项目网', url: 'https://www.bhi.com.cn/' },
  // 材料价格（price 多源冗余，消除单点塌空）
  { name: '中国水泥网',   url: 'https://www.ccement.com/' },
  { name: '中国砂石骨料网', url: 'https://www.cssglw.com/' },
  { name: '百年建筑网',   url: 'https://www.100njz.com/' },
  { name: '我的钢铁网',   url: 'https://www.mysteel.com/' },
];

// 每类上限（宽进：先多产候选，由 summarize.js 剔除无正文条目后自然收敛）
// 候选配额放宽：新增煤炭/建筑源排位靠后，配额过紧会让它们全部出 0 条（实测煤炭协会 40 候选出 0）。
// policy 最终仍由 summarize.js 按比例裁剪到 ≤20%，此处放宽只为扩大挑选池、保证来源多元。
const LIMIT = { policy: 10, epc: 6, price: 6, case: 3, review: 7 };
// 单源贡献上限：兼顾来源多样性（实测新疆住建厅单源曾占 9/18 条）
const PER_SOURCE_MAX = 6;

// 低价值页面黑名单：此类页面天生无正文或需登录（办事指南/政务系统/项目详情页），
// 进早报后无法生成简述，故在抓取阶段就剔除，避免占用卡片位。
const URL_BLACKLIST = /(taskcode|guidance|bmfwtest|bmfw\.|\/bsdt\/|zwfw\.|login| Login|注册页)/i;
const TITLE_BLACKLIST = /^建筑业企业资质核准|信息系统$|办事指南$|在线办理$|查询系统$|领导活动$|领导简历$/;
// 协会/机构动态过滤：赴访调研、座谈慰问、党建工会等无造价信息量的动态不进早报
const DYNAMIC_NOISE = /(赴|到访|来访|莅临|走访|看望|慰问){1}[^，。]{0,14}(座谈|交流|调研|考察|参观|指导|洽谈)|调研指导|莅临.{0,8}指导|走访办|党建|主题教育|党日|工会|团委|妇联|换届|年会召开|慰问信|倡议书|理事会|届中调整|人选公示|负责人人选|理事候选人|表决|表彰|评选结果|发布会|更名暨|品牌发布|签约仪式|致辞中表示|开幕致辞|招聘|公开招聘|招录|准考证|成绩查询|证书领取|竞赛|文体|运动会/;
let items = [];
const usedTitles = new Set();
let cnt = {};
// GitHub Actions runner 时区为 UTC。cron '30 22' UTC = 北京次日 06:30，
// 此时 UTC 日期仍是"前一天"，直接 toISOString() 会让早报日期比北京晚 1 天。
// 故 +8h 后再取日期，确保与北京时间一致。
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// ---- 阶段 1：收集各源候选（保留过滤后的候选池）----
const pools = [];
for (const s of SOURCES) {
  const html = fetchHtml(s.url);
  if (!html) { console.log('FAIL', s.name); continue; }
  const arr = extract(s.url, html, s.kw || KW)
    .filter(a => !URL_BLACKLIST.test(a.url) && !TITLE_BLACKLIST.test(a.title) && !DYNAMIC_NOISE.test(a.title))
    .slice(0, 40);
  pools.push({ name: s.name, list: arr, added: 0 });
}

// ---- 阶段 2：公平轮询填充 ----
// 不能按源顺序"先到先得"：排在数组后面的源会被前面源占满配额而永远出 0 条
// （实测新增的煤炭/建筑源因此全部为 0）。改为每轮各源取 1 条，兼顾来源多样性。
let round = 0;
while (round < 60) {
  let progressed = false;
  for (const p of pools) {
    if (round >= p.list.length) continue;
    if (p.added >= PER_SOURCE_MAX) continue;           // 单源上限，防富源垄断
    progressed = true;
    const a = p.list[round];
    if (usedTitles.has(a.title)) continue;
    const cat = classify(a.title);
    if ((cnt[cat] || 0) >= LIMIT[cat]) continue;
    usedTitles.add(a.title);
    cnt[cat] = (cnt[cat] || 0) + 1;
    p.added++;
    const date = dateFromUrl(a.url) || today;
    items.push({ cat: cat, title: a.title, url: a.url, src: p.name, date: date, note: '' });
  }
  if (!progressed) break;
  round++;
}
pools.forEach(p => { if (p.added) console.log(p.name, '->', p.added); });

// 常驻精选池（兜底）：EPC/案例/热评 垂直站列表页多为 JS 渲染不可抓，
// 用已验证可达的真实文章 URL 作"分类兜底"——仅当日抓该分类为 0 时补 1 条，
// 保证版面条数不塌空；正常情况早报 100% 由当日抓取源构成（守住"每日新鲜"原则）。
const POOLS = [
  { cat: 'epc', title: '北京工程总承包迈入 EPC 标准文本时代', url: 'https://www.junhe.com/legal-updates/3094', src: '君合律师事务所', date: '2026-08-01' },
  { cat: 'epc', title: 'EPC 合同风险分担、价格调整与暗标评审机制', url: 'https://www.dtlawyers.com.cn/page/research/detail.html?id=7090&lang=zh', src: '北京市道可特律所', date: '2026-08' },
  { cat: 'epc', title: '佛山发布园林绿化工程总承包(EPC)合同示范文本2026', url: 'https://www.foshan.gov.cn/gzjg/fssggzyjyzx/zcfg/zcfg/content/post_7203397.html', src: '佛山市城管局', date: '2026-07-16' },
  { cat: 'case', title: '最高法发布六件建工纠纷典型案例', url: 'https://www.court.gov.cn/zixun/xiangqing/504211.html', src: '最高人民法院', date: '2026-06-29' },
  { cat: 'case', title: '建工解释二第十三条：审计结算条款的适用边界', url: 'https://jianweicd.com/index.php?c=show&id=890', src: '上海建纬(成都)律所', date: '2026' },
  { cat: 'case', title: '《建工解释二》逐条解读：二十三条体系化阐释', url: 'https://shanghai.dacheng.com/Party_2/1544.html', src: '北京大成(上海)律所', date: '2026' },
  { cat: 'review', title: '袁华之：从条文解读到实践回应——《建工解释二》观察', url: 'http://jlzy.e-court.gov.cn/article/detail/2026/07/id/9416202.shtml', src: '吉林中院 / 袁华之', date: '2026-07' },
  { cat: 'review', title: '湖北审计实务：人工材料价差哪些能调、哪些必扣', url: 'https://www.toutiao.com/a7679819422882513449', src: '今日头条 · 基建审计实务', date: '2026-08' },
  { cat: 'review', title: '望衡法评：情势变更与商业风险避坑指南', url: 'https://wanghenglaw.com/index.php?c=show&id=198', src: '北京望衡律师事务所', date: '2026' },
  { cat: 'review', title: '2024 版清单计价风险每日学：无限风险条款为何无效', url: 'https://www.toutiao.com/article/7680810110083416595', src: '今日头条 · 基建无处不在', date: '2026-09' },
];
// 兜底逻辑：仅当某分类当日日抓条数为 0 时才补 1 条（每个分类最多 1 条兜底）
for (const p of POOLS) {
  if ((cnt[p.cat] || 0) > 0) continue;            // 当日已有该分类内容 → 不补，守住每日新鲜
  if (usedTitles.has(p.title)) continue;
  const ph = fetchHtml(p.url);
  if (!ph || ph.length < 200) { console.log('POOL_SKIP', p.cat, p.url); continue; }
  usedTitles.add(p.title);
  cnt[p.cat] = (cnt[p.cat] || 0) + 1;
  items.push({ cat: p.cat, title: p.title, url: p.url, src: p.src, date: p.date, note: '' });
}

// ---- 阶段 3：政策占比硬约束（≤20%，不依赖下游 summarize）----
// 软配额 LIMIT 每日抓取波动会失效；且 summarize.js 的裁剪依赖 note 过滤、无 ZHIPU_API_KEY 时
// 可能不触发，故在 fetch 阶段即锁定约束：P ≤ 0.25·O（O = 非政策条数）⟺ P/(P+O) ≤ 0.2。
// 按来源多样性优先裁剪（每源先保 1 条），避免新接入的煤炭/建筑源因数组排位靠后被优先裁掉。
{
  const O = items.filter(x => x.cat !== 'policy').length;
  const maxP = Math.floor(O * 0.2 / (1 - 0.2));
  const picked = [], seen = new Set(); let pc = 0;
  for (const x of items) {
    if (x.cat !== 'policy' || pc >= maxP) continue;
    if (seen.has(x.src)) continue;
    seen.add(x.src); picked.push(x); pc++;
  }
  const ps = new Set(picked);
  if (pc < maxP) {
    for (const x of items) {
      if (x.cat !== 'policy' || pc >= maxP || ps.has(x)) continue;
      picked.push(x); ps.add(x); pc++;
    }
  }
  const trimmed = items.filter(x => x.cat !== 'policy' || ps.has(x));
  if (trimmed.length !== items.length) {
    console.log('POLICY_CAP: 剔除', items.length - trimmed.length, '条政策（≤20%，上限', maxP, '条）');
  }
  items = trimmed;
}
// 重算 cnt 供寄语使用
cnt = {};
for (const it of items) cnt[it.cat] = (cnt[it.cat] || 0) + 1;

const LABELS = { policy: '造价政策', epc: 'EPC管理', price: '市场价格', case: '典型案例', review: '热评' };
const parts = Object.keys(cnt).map(k => LABELS[k] + cnt[k] + '条').join('、');
const bless = parts
  ? '今日聚焦：' + parts + '。规则在更新，确定性在提前读条款、算波动。'
  : '今日资讯采集暂未命中，规则未变：把条款读在前、把波动算在早。';

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/items.json', JSON.stringify(items, null, 2));
fs.writeFileSync('data/bless.txt', bless);
console.log('TOTAL', items.length, '| BLESS:', bless);
