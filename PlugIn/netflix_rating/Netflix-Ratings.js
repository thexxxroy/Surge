'use strict';
/*
 * Netflix 网页端豆瓣 + IMDb 评分
 * 设计文档:docs/superpowers/specs/2026-09-07-netflix-ratings-design.md
 *
 * 本文件同时用于 Surge 运行时与 Node 测试:
 *   - 底部 module.exports 守卫让 Surge(无 module)不报错
 *   - 底部 $done 守卫让 Node 加载时不执行分派逻辑
 */

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

const TTL_OK = 7 * 24 * 60 * 60 * 1000;
const TTL_FAIL = 10 * 60 * 1000;

async function resolveRatings(titleId, deps) {
  const meta = await deps.fetchMeta(titleId);
  if (!meta || !meta.name) return { ok: false };

  // 未配置 OMDb key 时 fetchOmdb 返回 null,此时降级为按英文名 + 年份 + 类型
  // 启发式匹配豆瓣;有 imdbID 时按 ID 精确匹配。
  const omdb = await deps.fetchOmdb(meta);
  const douban = omdb && omdb.imdbId
    ? await deps.fetchDoubanById(omdb.imdbId)
    : await deps.fetchDoubanByTitle(meta);

  const imdb = omdb && omdb.rating
    ? { rating: omdb.rating, votes: omdb.votes,
        url: 'https://www.imdb.com/title/' + omdb.imdbId + '/' }
    : null;
  const db = douban && douban.rating ? douban : null;
  if (!imdb && !db) return { ok: false };

  return { ok: true, title: meta, imdb: imdb, douban: db };
}

async function serveRatings(titleId, store, deps, now) {
  // 缓存键必须区分「已配置 key」与「未配置 key」两种形态:两者的结果不同
  // (前者带 IMDb 评分且豆瓣为精确匹配),否则用户新增或移除 key 后仍会命中旧缓存。
  const key = CACHE_PREFIX + 'res:' + (deps.variant || 'n') + ':' + titleId;
  const hit = cacheRead(store.read(key), now);
  if (hit) return hit;

  const result = await resolveRatings(titleId, deps);
  store.write(cacheWrap(result, result.ok ? TTL_OK : TTL_FAIL, now), key);

  const pushed = indexPush(store.read(CACHE_INDEX_KEY), key, CACHE_MAX_ENTRIES);
  pushed.evicted.forEach(function (k) { store.write('', k); });
  store.write(JSON.stringify(pushed.list), CACHE_INDEX_KEY);

  return result;
}

// ==================== Surge 运行时 ====================

const API_PATH = '/__nfr';
const EN_HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' };

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
      try {
        // Accept-Language 强制英文:Netflix 的本地化译名与豆瓣不一致,
        // 必须拿英文原名才能经 OMDb 换到 imdbID。
        return parseNetflixJsonLd(await httpGet(buildTitleUrl(titleId), EN_HEADERS));
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
  try {
    titleId = new URL($request.url).searchParams.get('id');
  } catch (_) { /* 落到下面的空值分支 */ }
  if (!titleId || !/^\d+$/.test(titleId)) { $done(jsonResponse({ ok: false })); return; }

  serveRatings(titleId, surgeStore(), surgeDeps($argument), Date.now())
    .then(function (result) { $done(jsonResponse(result)); })
    .catch(function () { $done(jsonResponse({ ok: false })); });
}

// 在浏览器页面中运行。经 toString() 序列化注入,因此不得引用本文件的其他变量;
// extractTitleId 作为实参传入,这样它既能被单元测试也能在页面中使用,只维护一份。
function pageAgent(extractTitleId) {
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

  function link(text, href) {
    var a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    return a;
  }

  function paint(anchor, id, data) {
    var old = document.getElementById(MARK);
    if (old) old.remove();
    if (!data || !data.ok) return;
    var parts = [];
    if (data.douban) parts.push(link('豆瓣 ' + data.douban.rating, data.douban.url));
    if (data.imdb) parts.push(link('IMDb ' + data.imdb.rating, data.imdb.url));
    if (!parts.length) return;
    var span = document.createElement('span');
    span.id = MARK;
    span.dataset.nfrId = id;
    for (var i = 0; i < parts.length; i++) {
      if (i) span.appendChild(document.createTextNode(' · '));
      span.appendChild(parts[i]);
    }
    span.appendChild(document.createElement('br'));
    anchor.prepend(span);
  }

  function sync() {
    scheduled = false;
    var id = extractTitleId(location.href);
    var existing = document.getElementById(MARK);
    if (!id) { if (existing) existing.remove(); return; }
    if (existing && existing.dataset.nfrId === id) return;

    var anchor = findAnchor();
    if (!anchor) return;

    var cached = memGet(id);
    if (cached) { paint(anchor, id, cached); return; }

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
      .catch(function () {});
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
    const code = '(' + pageAgent.toString() + ')(' + extractTitleId.toString() + ');';
    const tag = '<script id="surge-nfr-agent"' + nonce + '>' + code + '</script>';
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
    dispatch: dispatch
  };
}

// 仅在 Surge 运行时执行。Node 加载时 $done 未定义,不会触发。
if (typeof $done !== 'undefined') {
  dispatch();
}
