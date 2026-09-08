'use strict';
/*
 * Netflix 网页端豆瓣 + IMDb 评分
 * 版本:2026.09.07.7    最后更新:2026-09-07
 * 作者:thexxxroy    项目:https://github.com/thexxxroy/Surge
 *
 * 本文件同时用于 Surge 运行时与 Node 测试:
 *   - 底部 module.exports 守卫让 Surge(无 module)不报错
 *   - 底部 $done 守卫让 Node 加载时不执行分派逻辑
 *
 * 【发布流程】改动脚本后更新本文件的 VERSION 常量与上面的版本注释。
 * script-path 不带 ?v=N 缓存参数。Surge 按 URL 缓存远程脚本,URL 不变
 * 就不会自动重新拉取,需要在 Surge 里对模块手动「更新」才会取到新脚本。
 * 排查时看页面里 <script id="surge-nfr-agent" data-v="..."> 或
 * #surge-nfr-badge 的 data-v,即可知道实际加载的是哪一版。
 */

const VERSION = '2026.09.07.7';

// ==================== 缓存 ====================

const CACHE_PREFIX = 'nfr:v1:';
const CACHE_INDEX_KEY = CACHE_PREFIX + 'index';
const CACHE_MAX_ENTRIES = 500;

function cacheWrap(value, ttlMs, now) {
  return JSON.stringify({ v: value, exp: now + ttlMs });
}

function cacheRead(raw, now) {
  if (!raw) return null;
  let box;
  try { box = JSON.parse(raw); } catch (_) { return null; }
  if (!box || typeof box.exp !== 'number' || box.exp <= now) return null;
  return box.v;
}

function indexPush(indexRaw, key, max) {
  let list;
  try { list = JSON.parse(indexRaw); } catch (_) { list = null; }
  if (!Array.isArray(list)) list = [];
  list = list.filter(function (k) { return k !== key; });
  list.push(key);
  const evicted = list.length > max ? list.splice(0, list.length - max) : [];
  return { list: list, evicted: evicted };
}

// ==================== 解析 ====================

function parseNetflixJsonLd(html) {
  const m = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  let d;
  try { d = JSON.parse(m[1]); } catch (_) { return null; }
  if (!d || !d.name) return null;
  const type = d['@type'] === 'Movie' ? 'movie'
             : d['@type'] === 'TVSeries' ? 'series'
             : null;
  const ym = /^(\d{4})/.exec(String(d.dateCreated || ''));
  return { name: d.name, year: ym ? ym[1] : null, type: type };
}

function parseOmdb(text) {
  let d;
  try { d = JSON.parse(text); } catch (_) { return null; }
  if (!d || d.Response !== 'True' || !d.imdbID) return null;
  return {
    imdbId: d.imdbID,
    rating: d.imdbRating && d.imdbRating !== 'N/A' ? d.imdbRating : null,
    votes: d.imdbVotes && d.imdbVotes !== 'N/A' ? d.imdbVotes : null
  };
}

// 豆瓣搜索页每条结果是一个 <div class="result"> 块。取出全部候选,
// 由 pickDoubanCandidate 按年份与类型挑选——按标题搜索时首条结果经常是错的
// (例如搜 Heartstopper,首条是 2026 年的同系列电影,而非 2022 年的剧集)。
function parseDoubanCandidates(html) {
  const out = [];
  let i = html.indexOf('<div class="result">');
  while (i !== -1) {
    const next = html.indexOf('<div class="result">', i + 1);
    const block = html.slice(i, next === -1 ? html.length : next);
    const sid = /\bsid:\s*(\d+)/.exec(block);
    if (sid) {
      const rating = /class="rating_nums"[^>]*>\s*([\d.]+)\s*</.exec(block);
      const votes = /\((\d[\d,]*)人评价\)/.exec(block);
      const kind = /<span>\[([^\]]+)\]<\/span>/.exec(block);
      // subject-cast 形如 "原名:Heartstopper / 尤洛斯·林 / 2022",年份在末尾
      const cast = /subject-cast">([^<]*)</.exec(block);
      const year = cast ? /(\d{4})\s*$/.exec(cast[1].trim()) : null;
      out.push({
        url: 'https://movie.douban.com/subject/' + sid[1] + '/',
        rating: rating ? rating[1] : null,
        votes: votes ? votes[1] : null,
        year: year ? year[1] : null,
        kind: kind ? kind[1] : null
      });
    }
    i = next;
  }
  return out;
}

// want = { year, type },type 为 'movie' / 'series' / null
function pickDoubanCandidate(candidates, want) {
  const wantKind = want && want.type === 'series' ? '电视剧'
                 : want && want.type === 'movie' ? '电影'
                 : null;
  let best = null;
  let bestScore = 0;
  candidates.forEach(function (c, idx) {
    let score = 0;
    if (want && want.year && c.year) {
      const gap = Math.abs(Number(c.year) - Number(want.year));
      score += gap === 0 ? 100 : gap <= 1 ? 60 : 0;
    }
    if (wantKind && c.kind) score += c.kind === wantKind ? 50 : -40;
    if (c.rating) score += 5;
    score -= idx; // 同分时靠前的优先
    if (score > bestScore) { bestScore = score; best = c; }
  });
  return best;
}

function doubanResult(c) {
  return c ? { url: c.url, rating: c.rating, votes: c.votes } : null;
}

// ==================== URL ====================

// 注意:此函数会被 toString() 序列化后注入页面,不得引用任何外部变量。
function extractTitleId(href) {
  let u;
  try { u = new URL(href); } catch (_) { return null; }
  const jbv = u.searchParams.get('jbv');
  if (jbv) return /^\d+$/.test(jbv) ? jbv : null;
  const m = /^\/title\/(\d+)/.exec(u.pathname);
  return m ? m[1] : null;
}

function buildTitleUrl(titleId) {
  return 'https://www.netflix.com/title/' + titleId;
}

// Surge 的 #!arguments 必须有默认值,模块里用 none 占位。
// 用形状校验而非等值比较,顺带挡掉空值与其他占位写法。
function hasApiKey(apiKey) {
  return typeof apiKey === 'string' && /^[A-Za-z0-9]{6,}$/.test(apiKey.trim());
}

function buildOmdbUrl(apiKey, meta) {
  let u = 'https://www.omdbapi.com/?apikey=' + encodeURIComponent(apiKey) +
          '&t=' + encodeURIComponent(meta.name);
  if (meta.year) u += '&y=' + encodeURIComponent(meta.year);
  if (meta.type) u += '&type=' + encodeURIComponent(meta.type);
  return u;
}

function buildDoubanUrl(query) {
  return 'https://www.douban.com/search?cat=1002&q=' + encodeURIComponent(query);
}

// ==================== 编排 ====================

// 24 小时:评分一天内基本不动,几乎不损失命中率,
// 但把「出错后自愈」的窗口从一周缩短到一天。
const TTL_OK = 24 * 60 * 60 * 1000;
// 配了 key 却没拿到 IMDb,多半是上游抖动而非真的没有评分。
// 若按成功缓存 7 天,一次抖动会被冻结一周,因此单列一档短 TTL。
const TTL_PARTIAL = 30 * 60 * 1000;
const TTL_FAIL = 10 * 60 * 1000;

async function resolveRatings(titleId, deps) {
  // diag 会随响应一起返回。此前排查「为什么这部片没有 IMDb」只能靠反复猜,
  // 现在在浏览器 Network 面板看 /__nfr 的响应即可定位是哪一步断的。
  const diag = { name: null, omdb: null, douban: null, path: null };

  const meta = await deps.fetchMeta(titleId);
  if (!meta || !meta.name) {
    diag.omdb = 'skipped';
    return { ok: false, diag: Object.assign(diag, { meta: 'fail' }) };
  }
  diag.meta = 'ok';
  diag.name = meta.name + ' (' + (meta.year || '?') + ', ' + (meta.type || '?') + ')';

  const omdb = await deps.fetchOmdb(meta);
  diag.omdb = !deps.variant || deps.variant === 'n' ? 'no-key'
            : !omdb ? 'no-match'
            : !omdb.rating ? 'no-rating'
            : 'ok';

  // 有 imdbID 就按 ID 精确匹配,否则按英文名 + 年份 + 类型启发式匹配。
  diag.path = omdb && omdb.imdbId ? 'by-id' : 'by-title';
  const douban = omdb && omdb.imdbId
    ? await deps.fetchDoubanById(omdb.imdbId)
    : await deps.fetchDoubanByTitle(meta);
  diag.douban = !douban ? 'no-match' : !douban.rating ? 'no-rating' : 'ok';

  const imdb = omdb && omdb.rating
    ? { rating: omdb.rating, votes: omdb.votes,
        url: 'https://www.imdb.com/title/' + omdb.imdbId + '/' }
    : null;
  const db = douban && douban.rating ? douban : null;
  if (!imdb && !db) return { ok: false, diag: diag };

  return { ok: true, title: meta, imdb: imdb, douban: db, diag: diag };
}

async function serveRatings(titleId, store, deps, now, fresh) {
  // 缓存键必须区分「已配置 key」与「未配置 key」两种形态:两者的结果不同
  // (前者带 IMDb 评分且豆瓣为精确匹配),否则用户新增或移除 key 后仍会命中旧缓存。
  const key = CACHE_PREFIX + 'res:' + (deps.variant || 'n') + ':' + titleId;
  if (!fresh) {
    const hit = cacheRead(store.read(key), now);
    if (hit) return hit;
  }

  const result = await resolveRatings(titleId, deps);
  // 配了 key 却缺 IMDb 视为部分成功,只短暂缓存,以便下次自动重试。
  const partial = result.ok && deps.variant === 'k' && !result.imdb;
  const ttl = !result.ok ? TTL_FAIL : partial ? TTL_PARTIAL : TTL_OK;
  store.write(cacheWrap(result, ttl, now), key);

  const pushed = indexPush(store.read(CACHE_INDEX_KEY), key, CACHE_MAX_ENTRIES);
  pushed.evicted.forEach(function (k) { store.write('', k); });
  store.write(JSON.stringify(pushed.list), CACHE_INDEX_KEY);

  return result;
}

// ==================== Surge 运行时 ====================

const API_PATH = '/__nfr';
// Netflix 详情页未压缩约 936KB,gzip 后约 126KB,实测可省约 1 秒。
// 但无法确认 $httpClient 是否总会解压,故解析失败时回退到不带该头的请求。
const EN_HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' };
const EN_HEADERS_GZIP = {
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate'
};

function httpGet(url, headers) {
  return new Promise(function (resolve, reject) {
    $httpClient.get({ url: url, headers: headers || {} }, function (err, resp, body) {
      if (err) { reject(err); return; }
      if (!resp || resp.status < 200 || resp.status >= 400) {
        reject(new Error('HTTP ' + (resp && resp.status)));
        return;
      }
      resolve(body);
    });
  });
}

function surgeStore() {
  return {
    read: function (key) { return $persistentStore.read(key); },
    write: function (value, key) { $persistentStore.write(value, key); }
  };
}

function surgeDeps(apiKey) {
  return {
    variant: hasApiKey(apiKey) ? 'k' : 'n',
    fetchMeta: async function (titleId) {
      // Accept-Language 强制英文:Netflix 的本地化译名与豆瓣不一致,
      // 必须拿英文原名才能经 OMDb 换到 imdbID。
      const url = buildTitleUrl(titleId);
      try {
        const meta = parseNetflixJsonLd(await httpGet(url, EN_HEADERS_GZIP));
        if (meta) return meta;
      } catch (_) { /* 落到下面的非压缩重试 */ }
      try {
        return parseNetflixJsonLd(await httpGet(url, EN_HEADERS));
      } catch (_) { return null; }
    },
    fetchOmdb: async function (meta) {
      if (!hasApiKey(apiKey)) return null;
      try {
        return parseOmdb(await httpGet(buildOmdbUrl(apiKey.trim(), meta), {}));
      } catch (_) { return null; }
    },
    // 按 imdbID 搜索是精确匹配,结果唯一,直接取第一条候选
    fetchDoubanById: async function (imdbId) {
      try {
        const cands = parseDoubanCandidates(await httpGet(buildDoubanUrl(imdbId), {}));
        return doubanResult(cands[0] || null);
      } catch (_) { return null; }
    },
    // 无 key 时的降级路径:按英文名搜索,再用年份与类型打分挑选
    fetchDoubanByTitle: async function (meta) {
      try {
        const cands = parseDoubanCandidates(await httpGet(buildDoubanUrl(meta.name), {}));
        return doubanResult(pickDoubanCandidate(cands, meta));
      } catch (_) { return null; }
    }
  };
}

function jsonResponse(obj) {
  return {
    response: {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify(obj)
    }
  };
}

function handleApiRequest() {
  let titleId = null;
  let fresh = false;
  try {
    const params = new URL($request.url).searchParams;
    titleId = params.get('id');
    // 手动强刷:在浏览器直接访问 /__nfr?id=<id>&fresh=1 可绕过缓存重查,
    // 响应里的 diag 字段会说明每一步的结果。页面自身不会带这个参数。
    fresh = params.get('fresh') === '1';
  } catch (_) { /* 落到下面的空值分支 */ }
  if (!titleId || !/^\d+$/.test(titleId)) { $done(jsonResponse({ ok: false })); return; }

  serveRatings(titleId, surgeStore(), surgeDeps($argument), Date.now(), fresh)
    .then(function (result) { $done(jsonResponse(result)); })
    .catch(function () { $done(jsonResponse({ ok: false })); });
}

// 在浏览器页面中运行。经 toString() 序列化注入,因此不得引用本文件的其他变量;
// extractTitleId 作为实参传入,这样它既能被单元测试也能在页面中使用,只维护一份。
function pageAgent(extractTitleId, VERSION) {
  'use strict';
  var MARK = 'surge-nfr-badge';
  // Netflix 的 class 是构建期生成的,会随发版失效。用候选数组而非单一选择器,
  // 全部落空时静默跳过。这是预期中的维护点。
  var ANCHORS = ['.preview-modal-synopsis', '[data-uia="preview-modal-synopsis"]'];
  var scheduled = false;

  function memGet(id) {
    try {
      var s = sessionStorage.getItem('nfr:' + id);
      return s ? JSON.parse(s) : null;
    } catch (_) { return null; }
  }
  function memSet(id, d) {
    try { sessionStorage.setItem('nfr:' + id, JSON.stringify(d)); } catch (_) {}
  }

  function findAnchor() {
    for (var i = 0; i < ANCHORS.length; i++) {
      var el = document.querySelector(ANCHORS[i]);
      if (el) return el;
    }
    return null;
  }

  // CSP 只允许用 CSSOM 设值,不能注入 <style>,也就没有 :hover 伪类与 @keyframes,
  // 因此悬停用事件、脉冲用 Web Animations API。
  var SOURCES = {
    douban: { label: '豆瓣', accent: '#41B96A' },
    imdb: { label: 'IMDb', accent: '#F5C518' }
  };
  var IDLE_BG = 'rgba(255,255,255,0.10)';
  var HOVER_BG = 'rgba(255,255,255,0.18)';
  var reduceMotion = false;
  try { reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}

  // 查询中 / 有评分 / 无评分 三种状态共用同一个胶囊外形,
  // 保证状态切换时高度一致、不产生跳动。
  function pill(tag, accent) {
    var el = document.createElement(tag);
    el.style.display = 'inline-flex';
    el.style.alignItems = 'stretch'; // 让色条贯通上下边缘,而非浮在中间
    el.style.padding = '0 9px 0 0';
    el.style.borderRadius = '3px';
    el.style.overflow = 'hidden';
    el.style.background = IDLE_BG;
    el.style.textDecoration = 'none';
    el.style.lineHeight = '1';
    el.style.verticalAlign = 'middle';

    var bar = document.createElement('span');
    bar.style.width = '2px';
    bar.style.flex = '0 0 2px';
    bar.style.background = accent;

    // 垂直留白放在内层,这样色条能贯通整个徽章高度
    var inner = document.createElement('span');
    inner.style.display = 'inline-flex';
    inner.style.alignItems = 'center';
    inner.style.gap = '6px';
    inner.style.padding = '4px 0';
    inner.style.marginLeft = '8px';

    el.append(bar, inner);
    return { el: el, inner: inner };
  }

  function labelSpan(text) {
    var el = document.createElement('span');
    el.textContent = text;
    el.style.fontSize = '11px';
    el.style.fontWeight = '500';
    el.style.color = '#9c9c9c';
    el.style.whiteSpace = 'nowrap';
    el.style.lineHeight = '15px';
    return el;
  }

  function chit(kind, score, votes, href) {
    var meta = SOURCES[kind];
    var p = pill('a', meta.accent);
    var a = p.el;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // 投票数放进 tooltip,避免占用弹窗本就紧张的视觉空间
    a.title = votes ? meta.label + ' ' + score + ' · ' + votes + ' 人评价'
                    : meta.label + ' ' + score;
    if (!reduceMotion) a.style.transition = 'background 120ms ease';

    var num = document.createElement('span');
    num.textContent = score;
    num.style.fontSize = '15px';
    num.style.fontWeight = '700';
    num.style.color = '#f2f2f2';
    num.style.fontVariantNumeric = 'tabular-nums'; // 让 8.9 与 10 对齐,便于横向比较
    num.style.letterSpacing = '0.01em';

    p.inner.append(labelSpan(meta.label), num);
    a.addEventListener('mouseenter', function () { a.style.background = HOVER_BG; });
    a.addEventListener('mouseleave', function () { a.style.background = IDLE_BG; });
    return a;
  }

  function shell(id, state) {
    var box = document.createElement('span');
    box.id = MARK;
    box.dataset.nfrId = id;
    box.dataset.v = VERSION; // 便于在 Elements 面板确认实际加载的脚本版本
    box.dataset.state = state;
    box.style.display = 'flex';
    box.style.flexWrap = 'wrap';
    box.style.alignItems = 'center';
    box.style.gap = '8px';
    box.style.marginBottom = '10px';
    return box;
  }

  function replaceBadge(anchor, box) {
    var old = document.getElementById(MARK);
    if (old) old.remove();
    anchor.prepend(box);
  }

  // 弹窗刚打开时先占位。冷启动要串行请求 Netflix 详情页 + OMDb + 豆瓣,
  // 可能耗时数秒,没有占位的话用户无从判断脚本是否生效。
  function paintPending(anchor, id) {
    var box = shell(id, 'pending');
    var p = pill('span', '#6b6b6b');
    p.inner.appendChild(labelSpan('评分查询中'));
    box.appendChild(p.el);
    replaceBadge(anchor, box);
    if (!reduceMotion && p.el.animate) {
      try {
        p.el.animate([{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }],
                     { duration: 1400, iterations: Infinity });
      } catch (_) {}
    }
  }

  function paint(anchor, id, data) {
    var parts = [];
    if (data && data.ok) {
      if (data.douban) parts.push(chit('douban', data.douban.rating, data.douban.votes, data.douban.url));
      if (data.imdb) parts.push(chit('imdb', data.imdb.rating, data.imdb.votes, data.imdb.url));
    }
    if (!parts.length) {
      // 明确给出终态。直接移除的话,占位转一会儿凭空消失,看起来像出了故障。
      var box = shell(id, 'empty');
      var p = pill('span', '#6b6b6b');
      p.el.title = '豆瓣与 IMDb 均未匹配到该片';
      p.inner.appendChild(labelSpan('暂无评分'));
      box.appendChild(p.el);
      replaceBadge(anchor, box);
      return;
    }
    var full = shell(id, 'done');
    for (var i = 0; i < parts.length; i++) full.appendChild(parts[i]);
    replaceBadge(anchor, full);
  }

  function sync() {
    scheduled = false;
    var id = extractTitleId(location.href);
    var existing = document.getElementById(MARK);
    if (!id) { if (existing) existing.remove(); return; }
    // pending 也要提前返回:请求已在飞行中,其 .then 会负责重绘。
    // 否则 MutationObserver 每触发一次就会重复发起请求。
    if (existing && existing.dataset.nfrId === id) return;

    var anchor = findAnchor();
    if (!anchor) return;

    var cached = memGet(id);
    if (cached) { paint(anchor, id, cached); return; }

    paintPending(anchor, id);
    fetch('/__nfr?id=' + encodeURIComponent(id), { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        memSet(id, d);
        // 取数期间用户可能已切走,重新确认当前仍是同一部片
        if (extractTitleId(location.href) === id) {
          var a = findAnchor();
          if (a) paint(a, id, d);
        }
      })
      .catch(function () {
        var box = document.getElementById(MARK);
        if (box && box.dataset.state === 'pending') box.remove();
      });
  }

  var observer = new MutationObserver(function () {
    if (!scheduled) { scheduled = true; setTimeout(sync, 150); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  addEventListener('popstate', sync);
  addEventListener('pagehide', function () { observer.disconnect(); }, { once: true });
  sync();
}

function handleInject() {
  try {
    const body = $response.body;
    if (typeof body !== 'string' || !/<\/body\s*>/i.test(body) ||
        body.indexOf('surge-nfr-agent') !== -1) {
      $done({});
      return;
    }
    const ctKey = Object.keys($response.headers || {}).find(function (k) {
      return k.toLowerCase() === 'content-type';
    });
    if (ctKey && !/text\/html/i.test($response.headers[ctKey])) { $done({}); return; }

    const nonceMatch = body.match(/<script\b[^>]*\bnonce=(['"])([^'"]+)\1/i);
    const nonce = nonceMatch && /^[A-Za-z0-9+/_=-]+$/.test(nonceMatch[2])
      ? ' nonce="' + nonceMatch[2] + '"' : '';
    const code = '(' + pageAgent.toString() + ')(' + extractTitleId.toString() +
                 ', ' + JSON.stringify(VERSION) + ');';
    const tag = '<script id="surge-nfr-agent" data-v="' + VERSION + '"' + nonce + '>' +
                code + '</script>';
    $done({ body: body.replace(/<\/body\s*>/i, tag + '</body>') });
  } catch (_) {
    // 任何异常都原样放行,绝不影响 Netflix 本身
    $done({});
  }
}

function dispatch() {
  if (typeof $request !== 'undefined' && $request.url &&
      $request.url.indexOf(API_PATH) !== -1) {
    handleApiRequest();
    return;
  }
  handleInject();
}

// ==================== 导出与分派 ====================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CACHE_PREFIX: CACHE_PREFIX,
    CACHE_INDEX_KEY: CACHE_INDEX_KEY,
    CACHE_MAX_ENTRIES: CACHE_MAX_ENTRIES,
    TTL_OK: TTL_OK,
    TTL_PARTIAL: TTL_PARTIAL,
    TTL_FAIL: TTL_FAIL,
    cacheWrap: cacheWrap,
    cacheRead: cacheRead,
    indexPush: indexPush,
    parseNetflixJsonLd: parseNetflixJsonLd,
    parseOmdb: parseOmdb,
    parseDoubanCandidates: parseDoubanCandidates,
    pickDoubanCandidate: pickDoubanCandidate,
    doubanResult: doubanResult,
    extractTitleId: extractTitleId,
    buildTitleUrl: buildTitleUrl,
    hasApiKey: hasApiKey,
    buildOmdbUrl: buildOmdbUrl,
    buildDoubanUrl: buildDoubanUrl,
    resolveRatings: resolveRatings,
    serveRatings: serveRatings,
    surgeDeps: surgeDeps,
    dispatch: dispatch,
    VERSION: VERSION
  };
}

// 仅在 Surge 运行时执行。Node 加载时 $done 未定义,不会触发。
if (typeof $done !== 'undefined') {
  dispatch();
}
