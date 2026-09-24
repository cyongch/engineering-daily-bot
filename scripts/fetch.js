#!/usr/bin/env node
/**
 * fetch.js v2 —— 工程行业早报 多源采集器
 * 改进点：
 *   1) Playwright 无头浏览器降级抓取（JS 渲染站点不再抓空）
 *   2) 页面正文日期解析（避免全部回退到当天）
 *   3) 政策裁剪提取为共享函数，单点控制
 *   4) 缩减煤炭/能源源配比，增加造价垂直源
 *   5) 兜底池时效校验（仅近 30 天内有效）
 */
const fs = require('fs');
const { execSync } = require('child_process');
const {
  fetchCurl, fetchPlaywright, fetchHtml, extract, extractDateFromHtml,
  capPolicyItems, todayBJ, closeBrowser, UA,
} = require('../lib/fetcher');

function classify(t) {
  const REV = /解读|评析|评论|观点|观察|分析|解析|详解|探析|透视|梳理|述评|问答|焦点|研读|看法|随笔/;
  if (/争议|纠纷|仲裁|调解|索赔|案例|裁定|判决|败诉|胜诉|最高法|指导案例|司法解释/.test(t)) return 'case';
  if (/信息价|指导价|综合价|综合单价|消耗量|劳务|人工费|人工成本|工日|材料价|价格指数|造价指数|指数|螺纹|焦炭|焦煤|铁矿|骨料|熟料|水泥|混凝土|砂石|钢材|建材/.test(t)) return 'price';
  if (/办法|条例|规定|令|标准|规范|通知|意见|指引|细则|导则/.test(t)) return REV.test(t) ? 'review' : 'policy';
  if (REV.test(t)) return 'review';
  if (/EPC|总承包|工程总承包|设计施工|联合体|发包人要求|概算|施工图预算|招标项目|发包|承包|基建|城市更新|拟在建|中标公示|招标公告|中标公告|成交公告|采购结果/.test(t)) return 'epc';
  return 'policy';
}

const KW = /造价|工程|EPC|基建|市政|定额|结算|招标|投标|中标|建材|水泥|混凝土|砂石|钢材|装配式|智能建造|全过程咨询|工程咨询|工程造价|计价|工程量清单|施工|总承包|发包|承包|审计|司法解释|标准|规范|煤矿|煤炭|矿山|矿区|矿井|井巷|矿建|煤化工|公共资源|采购|概算|信息价|指导价|综合价|综合单价|消耗量|劳务|人工费|人工成本|工日|争议|索赔|仲裁|调解|评审|纠纷/;
const TITLE_DROP = /(大会|论坛|峰会|研讨会|交流会|推进会|座谈会|审查会|网站开通|正式上线|成功上线|上线|蝉联|公众号|视频号|评选结果|表彰|获奖|荣获|年会|换届|开业|签约仪式|开幕式|致辞|培训班|研修班|开班|招募|征集|入库|遴选|入围|比选|竞争性磋商|财务收支|委托第三方|专题讲座|宣讲|讲座|培训|在京召开|于北京召开|在北京举行|顺利召开|成功召开|圆满|会费|交纳会费|会员费|会刊|工作简报|问卷调查|招聘简章|收费指南|召开|举行|揭牌|启动仪式|贺信|致贺)/;
const OFFDOMAIN = /(物业管理|业主权益|业委会|小区|商品房|楼市|房贷|限购)/;
const NAV_DROP = /(技术支持|服务电话|客服|版权所有|版权|ICP备|公安备案|协会简介|协会章程|组织架构|组织机构|领导成员|常务理事|理事名单|监事会|专家库|专家委|会员之窗|会员风采|入会须知|入会申请|继续教育|证书查询|友情链接|网站地图|联系我们|关于我们|工作简报|会刊|青年专家|秘书处|课程回放|培训课程|党建|党支部|党总支|二十大|红心连新|应知应会|党课|主题党日|党史|观影|长征|运动会|诚信杯|倡议书|人才评价|工程师协会|专家库成员|通讯录|定额及其调整|文件下载|资料下载|竞赛|职业技能|选拔赛|好房子|慰问|看望|走访|干部职工|筹建|委员会|视察|座谈|举报|变更登记|专项整治|商会|行业协会$)/;
const TOPIC_BOOST = /争议|索赔|仲裁|调解|纠纷|劳务|人工费|人工成本|工日|信息价|指导价|综合价|综合单价|消耗量|材料价|市场参考价/;
const BID_DROP = /(预中标|中标人|评标结果|开标结果|中标价|投标人|投标报价|招标公告|招标公示|招标信息|中标公告|中标公示|中标结果|中标候选人|成交公告|成交结果|采购公告|采购结果|询价公告|询比|询价采购|竞争性谈判|竞争性磋商|竞价公告|资格预审|开标|评标|定标|废标|流标|邀标|比选公告|采购服务|供应商|采购项目|招标项目|发包公告|招标预告|拟建项目|在建项目)/;
const IDX_SUBJECT = /(水泥|混凝土|砂石|钢材|螺纹钢|焦炭|焦煤|铁矿|骨料|熟料|预拌砂浆|玻璃|沥青|铜|铝)/;
const URL_BLACKLIST = /(taskcode|guidance|bmfwtest|bmfw\.|\/bsdt\/|zwfw\.|login| Login|注册页)/i;
const TITLE_BLACKLIST = /^建筑业企业资质核准|信息系统$|办事指南$|在线办理$|查询系统$|领导活动$|领导简历$/;
const DYNAMIC_NOISE = /(赴|到访|来访|莅临|走访|看望|慰问){1}[^，。]{0,14}(座谈|交流|调研|考察|参观|指导|洽谈)|调研指导|莅临.{0,8}指导|走访办|党建|主题教育|党日|工会|团委|妇联|换届|年会召开|慰问信|倡议书|理事会|届中调整|人选公示|负责人人选|理事候选人|表决|表彰|评选结果|发布会|更名暨|品牌发布|签约仪式|致辞中表示|开幕致辞|招聘|公开招聘|招录|准考证|成绩查询|证书领取|竞赛|文体|运动会/;

const LIMIT = { policy: 10, epc: 6, price: 8, case: 3, review: 7 };
const PER_SOURCE_MAX = 6;

const SOURCES = [
  { name: '住房城乡建设部', url: 'https://www.mohurd.gov.cn/' },
  { name: '全国公共资源交易平台', url: 'https://www.ggzy.gov.cn/' },
  // 造价垂直源（信息价/劳务/争议调解）—— 全国协会 + 主要省市
  { name: '中国建设工程造价管理协会', url: 'http://www.ceca.org.cn/' },
  { name: '浙江省建设工程造价管理协会', url: 'http://www.zjzjxh.com/' },
  { name: '四川省造价工程师协会', url: 'http://www.sccea.net/' },
  { name: '陕西省建设工程造价管理协会', url: 'http://www.sxzjxh.cn/' },
  { name: '江苏省工程造价管理协会', url: 'https://www.jszjxh.com/w/portal/index' },
  { name: '山东省工程建设标准造价协会', url: 'http://www.sdbzzj.org.cn/' },
  { name: '河南省工程造价信息网', url: 'http://www.hncost.com/' },
  { name: '福建省建设工程造价管理协会', url: 'http://www.fjgczjxh.com/' },
  { name: '安徽省建设工程造价管理协会', url: 'http://www.ahzjxh.org.cn/' },
  { name: '广东省工程造价协会', url: 'http://www.gdcost.com/' },
  { name: '北京市建设工程造价管理协会', url: 'http://www.bjzjxh.org.cn/' },
  { name: '上海市建设工程咨询行业协会', url: 'http://www.scca.com.cn/' },
  // （天津/重庆/河北/江西/辽宁造价协会暂无有效域名，已转用对应住建厅源）
  // 行业协会/研究机构
  { name: '中国建筑业协会', url: 'http://www.zgjzy.org.cn/' },
  { name: '中国建设监理协会', url: 'http://www.zgjsjl.org/' },
  { name: '中国建筑科学研究院', url: 'http://www.cabr.com.cn/' },
  { name: '预制建筑网', url: 'https://www.precast.com.cn/' },
  // 行业材料价格源
  { name: '中国水泥网', url: 'https://www.ccement.com/' },
  { name: '中国砂石骨料网', url: 'https://www.cssglw.com/' },
  { name: '百年建筑网', url: 'https://www.100njz.com/' },
  { name: '我的钢铁网', url: 'https://www.mysteel.com/' },
  { name: '卓创资讯', url: 'https://www.sci99.com/' },
  { name: '中国玻璃工业网', url: 'http://www.glass.com.cn/' },
  // （中国有色金属工业协会暂无可用域名，暂不接入）
  // 省级住建厅（政策/定额/招投标管理）
  { name: '内蒙古住建厅', url: 'http://zjt.nmg.gov.cn/' },
  { name: '新疆住建厅', url: 'https://zjt.xinjiang.gov.cn/' },
  { name: '陕西住建厅', url: 'https://js.shaanxi.gov.cn/' },
  { name: '山东住建厅', url: 'http://zjt.shandong.gov.cn/' },
  { name: '湖南住建厅', url: 'https://zjt.hunan.gov.cn/' },
  { name: '广东住建厅', url: 'http://zfcxjst.gd.gov.cn/' },
  { name: '湖北住建厅', url: 'https://zjt.hubei.gov.cn/zfxxgk/zc/gfxwj/' },
  { name: '河北住建厅', url: 'https://zfcxjst.hebei.gov.cn/' },
  { name: '江西住建厅', url: 'http://zjt.jiangxi.gov.cn/' },
  { name: '辽宁住建厅', url: 'https://zjt.ln.gov.cn/' },
  { name: '天津住建委', url: 'http://zfcxjs.tj.gov.cn/' },
  { name: '重庆住建委', url: 'https://zfcxjw.cq.gov.cn/' },
  // 招标采购 / 基建
  { name: '中国招标投标公共服务平台', url: 'https://www.cebpubservice.com/' },
  { name: '中国拟在建项目网', url: 'https://www.bhi.com.cn/' },
  { name: '北极星电力网', url: 'https://www.bjx.com.cn/' },
  { name: '中国政府采购网', url: 'http://www.ccgp.gov.cn/' },
  // 煤炭/能源源（缩减至 2 个核心源）
  { name: '国家能源局', url: 'https://www.nea.gov.cn/' },
  { name: '中国煤炭加工利用协会', url: 'https://www.ccpua.org/' },
];

const today = todayBJ();
const curYear = +today.slice(0, 4);

// ===== 跨天去重（data/history.json 记录近期已收录条目的指纹，避免每天重复上榜） =====
const HIST_PATH = require('path').join(__dirname, '..', 'data', 'history.json');
function loadHist() {
  try { return JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')) || {}; } catch (e) { return {}; }
}
let HIST = loadHist();
const HIST_KEEP = 7; // 指纹保留窗口（天），与时效上限一致

// 指纹：归一 URL（去协议/query/hash/www/尾斜杠）
function urlFinger(u) {
  try {
    return String(u)
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split(/[?#]/)[0]
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch (e) { return String(u); }
}
// 指纹：规范化标题（去装饰符/空白/日期，阿拉伯数字占位；中文批次数字保留）
function titleFinger(t) {
  return String(t).toLowerCase()
    .replace(/[●◆▶■▲►【】\[\]{}()（）《》<>：:、，,。.\s]/g, '')
    .replace(/\d{4}年\d{1,2}月\d{1,2}日/g, '')
    .replace(/\d+(\.\d+)?(万|亿|元|㎡|米|×|个|台|套|条|名)?/g, 'X');
}
// 是否已被近期早报收录过（price 类只认 URL，避免每天的指数/价格标题互相干扰）
function isSeen(a) {
  if (HIST[urlFinger(a.url)]) return true;
  if (classify(a.title) !== 'price' && HIST[titleFinger(a.title)]) return true;
  return false;
}

function daysDiff(a, b) {
  return Math.round((new Date(a) - new Date(b)) / (24 * 3600 * 1000));
}

async function main() {
  const pools = [];

  // 时效上限：所有分类统一 7 天，确保早报只收录近一周内容
  function maxAge(cat) {
    return 7;
  }

  // 单源候选抽取：extract + 全部过滤 + 议题提位 + 时效约束
  function pickCandidates(src, html) {
    if (!html) return [];
    const arr = extract(src.url, html, src.kw || KW)
      .filter(a => {
        if (URL_BLACKLIST.test(a.url)) return false;
        if (TITLE_BLACKLIST.test(a.title)) return false;
        if (DYNAMIC_NOISE.test(a.title)) return false;
        if (TITLE_DROP.test(a.title)) return false;
        if (OFFDOMAIN.test(a.title)) return false;
        if (NAV_DROP.test(a.title)) return false;
        if (BID_DROP.test(a.title)) return false;
        if (isSeen(a)) return false;                               // 跨天去重
        // 优先用列表页抓到的日期（无需再抓详情页），回退到 URL 解析
        const dy = a.date || extractDateFromHtml('', a.url);
        if (dy && /^\d{4}-\d{2}-\d{2}$/.test(dy)) {
          const age = daysDiff(today, dy);
          if (age < 0) return false;                 // 未来日期，异常
          if (age > maxAge(classify(a.title))) return false; // 超过类别时效上限
        }
        return true;
      })
      .slice(0, 40);
    // 议题提位后，同一源内让「新」文章更早入选
    arr.sort((a, b) => {
      const tb = (TOPIC_BOOST.test(b.title) ? 1 : 0) - (TOPIC_BOOST.test(a.title) ? 1 : 0);
      if (tb) return tb;
      const k = d => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '0000-00-00');
      return k(b.date).localeCompare(k(a.date));      // yyyy-mm-dd 大者=更新，在前
    });
    return arr;
  }

  // 阶段 1：收集各源候选
  // 降级判据用「候选数为 0」而非「HTML 长度」：JS 壳页往往体积不小但抽不出任何链接，
  // 按长度判断会漏降级；按候选数判断则精准命中真正抓不到内容的源。
  let pwUsed = 0;
  for (const s of SOURCES) {
    let arr = pickCandidates(s, fetchCurl(s.url));
    if (!arr.length) {
      const pw = await fetchPlaywright(s.url);
      const arr2 = pickCandidates(s, pw);
      if (arr2.length) { arr = arr2; pwUsed++; console.log('PW_RESCUE', s.name, '->', arr2.length); }
    }
    if (!arr.length) { console.log('FAIL', s.name); continue; }
    pools.push({ name: s.name, list: arr, added: 0 });
  }
  console.log('PLAYWRIGHT_RESCUED', pwUsed, 'sources');

  // 阶段 2：公平轮询填充
  let items = [];
  const usedTitles = new Set();
  const usedIdx = new Set();
  let cnt = {};
  let round = 0;

  while (round < 60) {
    let progressed = false;
    for (const p of pools) {
      if (round >= p.list.length) continue;
      if (p.added >= PER_SOURCE_MAX) continue;
      progressed = true;
      const a = p.list[round];
      if (usedTitles.has(a.title)) continue;
      const idxHit = /指数/.test(a.title) ? (a.title.replace(/\s+/g, '').match(IDX_SUBJECT) || [])[1] : '';
      if (idxHit && usedIdx.has(idxHit)) continue;
      const cat = classify(a.title);
      if ((cnt[cat] || 0) >= LIMIT[cat]) continue;
      usedTitles.add(a.title);
      if (idxHit) usedIdx.add(idxHit);
      cnt[cat] = (cnt[cat] || 0) + 1;
      p.added++;
      const date = a.date || extractDateFromHtml('', a.url) || today;
      items.push({ cat, title: a.title, url: a.url, src: p.name, date, note: '' });
    }
    if (!progressed) break;
    round++;
  }
  pools.forEach(p => { if (p.added) console.log(p.name, '->', p.added); });

  // 兜底池（仅当某分类当日为 0 时补 1 条，且只保留近 7 天内）
  const POOLS = [
    { cat: 'epc', title: '北京工程总承包迈入 EPC 标准文本时代', url: 'https://www.junhe.com/legal-updates/3094', src: '君合律师事务所', date: '2026-08-01' },
    { cat: 'epc', title: 'EPC 合同风险分担、价格调整与暗标评审机制', url: 'https://www.dtlawyers.com.cn/page/research/detail.html?id=7090&lang=zh', src: '北京市道可特律所', date: '2026-08' },
    { cat: 'case', title: '最高法发布六件建工纠纷典型案例', url: 'https://www.court.gov.cn/zixun/xiangqing/504211.html', src: '最高人民法院', date: '2026-06-29' },
    { cat: 'case', title: '建工解释二第十三条：审计结算条款的适用边界', url: 'https://jianweicd.com/index.php?c=show&id=890', src: '上海建纬(成都)律所', date: '2026' },
    { cat: 'review', title: '袁华之：从条文解读到实践回应——《建工解释二》观察', url: 'http://jlzy.e-court.gov.cn/article/detail/2026/07/id/9416202.shtml', src: '吉林中院 / 袁华之', date: '2026-07' },
    { cat: 'review', title: '湖北审计实务：人工材料价差哪些能调、哪些必扣', url: 'https://www.toutiao.com/a7679819422882513449', src: '今日头条 · 基建审计实务', date: '2026-08' },
  ];

  for (const p of POOLS) {
    if ((cnt[p.cat] || 0) > 0) continue;
    if (usedTitles.has(p.title)) continue;
    // 兜底池时效校验：只保留近 7 天内
    const d = p.date.length >= 10 ? p.date.slice(0, 10) : (p.date + '-01').slice(0, 10);
    if (daysDiff(today, d) > 7) { console.log('POOL_EXPIRED', p.cat, p.title); continue; }
    const ph = await fetchHtml(p.url, 200);
    if (!ph || ph.length < 200) { console.log('POOL_SKIP', p.cat, p.url); continue; }
    usedTitles.add(p.title);
    cnt[p.cat] = (cnt[p.cat] || 0) + 1;
    items.push({ cat: p.cat, title: p.title, url: p.url, src: p.src, date: p.date, note: '' });
  }

  // 阶段 3：政策占比硬约束（统一调用共享函数）
  const before = items.length;
  items = capPolicyItems(items, 0.2);
  if (items.length !== before) {
    console.log('POLICY_CAP: 剔除', before - items.length, '条政策（≤20%）');
  }

  // 重算 cnt
  cnt = {};
  for (const it of items) cnt[it.cat] = (cnt[it.cat] || 0) + 1;

  const LABELS = { policy: '造价政策', epc: 'EPC管理', price: '市场价格', case: '典型案例', review: '热评' };

  const BLESS_POOL = [
    '功崇惟志，业广惟勤。|《尚书·周书》',
    '工欲善其事，必先利其器。|《论语·卫灵公》',
    '不积跬步，无以至千里；不积小流，无以成江海。|荀子《劝学》',
    '泰山不让土壤，故能成其大。|李斯《谏逐客书》',
    '图难于其易，为大于其细。|《道德经》',
    '路虽远，行则将至；事虽难，做则必成。|《荀子·修身》',
    '宝剑锋从磨砺出，梅花香自苦寒来。|《警世贤文》',
    '千淘万漉虽辛苦，吹尽狂沙始到金。|刘禹锡《浪淘沙》',
    '纸上得来终觉浅，绝知此事要躬行。|陆游《冬夜读书示子聿》',
    '博观而约取，厚积而薄发。|苏轼《稼说送张琥》',
    '锲而不舍，金石可镂。|荀子《劝学》',
    '天下难事，必作于易；天下大事，必作于细。|《道德经》'
  ];
  function fallbackBless() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const idx = (d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate()) % BLESS_POOL.length;
    const [t, s] = BLESS_POOL[idx].split('|');
    return t + '——' + s;
  }
  function genBless() {
    try {
      const raw = execSync('curl -s --max-time 10 -A "' + UA + '" "https://v1.jinrishici.com/all.json"', { encoding: 'utf8', maxBuffer: 1e6 });
      const j = JSON.parse(raw);
      if (j && j.content) {
        const src = (j.author || '') + (j.origin ? '《' + j.origin + '》' : '');
        return j.content + (src ? '——' + src : '');
      }
    } catch (e) {}
    return fallbackBless();
  }
  const bless = genBless();

  // 更新跨天去重历史：记录本轮已收录条目的指纹，并清理超过保留窗口的旧指纹
  for (const it of items) {
    HIST[urlFinger(it.url)] = today;
    if (it.cat !== 'price') HIST[titleFinger(it.title)] = today;
  }
  for (const fp of Object.keys(HIST)) {
    if (daysDiff(today, HIST[fp]) > HIST_KEEP) delete HIST[fp];
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(HIST_PATH, JSON.stringify(HIST, null, 0));
  fs.writeFileSync('data/items.json', JSON.stringify(items, null, 2));
  fs.writeFileSync('data/bless.txt', bless);
  console.log('TOTAL', items.length, '| BLESS:', bless);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => closeBrowser());
