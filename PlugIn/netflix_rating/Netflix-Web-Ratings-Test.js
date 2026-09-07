// Local, single-title proof of display. No network calls and no credential access.
// Values are source snapshots retrieved on 2026-09-07, NOT live ratings.
// IMDb: https://www.imdb.com/title/tt10638036/ (whole series)
// Douban: https://movie.douban.com/subject/35334903/ (season 1)
(function () {
  try {
    const body = $response.body;
    if (typeof body !== 'string' || !/<\/body\s*>/i.test(body) || body.includes('surge-netflix-rating-proof')) {
      $done({});
      return;
    }
    const contentType = Object.keys($response.headers || {}).find(k => k.toLowerCase() === 'content-type');
    if (contentType && !/text\/html/i.test($response.headers[contentType])) {
      $done({});
      return;
    }
    const nonceMatch = body.match(/<script\b[^>]*\bnonce=(['"])([^'"]+)\1/i);
    const nonce = nonceMatch && /^[A-Za-z0-9+/_=-]+$/.test(nonceMatch[2]) ? ' nonce="' + nonceMatch[2] + '"' : '';
    const code = '(' + browserProof.toString() + ')();';
    const injection = '<script id="surge-netflix-rating-proof"' + nonce + '>' + code + '</script>';
    console.log('[NetflixWebRatingsTest] HTML injected; source snapshots, not live ratings.');
    $done({body: body.replace(/<\/body\s*>/i, injection + '</body>')});
  } catch (_) {
    console.log('[NetflixWebRatingsTest] Injection skipped; original response preserved.');
    $done({});
  }

  function browserProof() {
    'use strict';
    const marker = 'surge-netflix-rating-snapshot';
    let scheduled = false;
    function sync() {
      scheduled = false;
      const url = new URL(location.href);
      const titleId = url.searchParams.get('jbv') || (url.pathname.match(/^\/title\/(\d+)/) || [])[1];
      const existing = document.getElementById(marker);
      if (titleId !== '81059939') {
        if (existing) existing.remove();
        return;
      }
      const synopsis = document.querySelector('.preview-modal-synopsis');
      if (!synopsis || existing) return;
      const span = document.createElement('span');
      span.id = marker;
      const imdb = document.createElement('a');
      imdb.href = 'https://www.imdb.com/title/tt10638036/';
      imdb.target = '_blank';
      imdb.rel = 'noopener noreferrer';
      imdb.textContent = 'IMDb 8.5/10（整剧）';
      const douban = document.createElement('a');
      douban.href = 'https://movie.douban.com/subject/35334903/';
      douban.target = '_blank';
      douban.rel = 'noopener noreferrer';
      douban.textContent = '豆瓣 8.9/10（第 1 季）';
      span.append(imdb, document.createTextNode(' · '), douban,
        document.createTextNode('〔Surge 显示测试 / 来源快照，非实时〕'), document.createElement('br'));
      synopsis.prepend(span);
    }
    const observer = new MutationObserver(function () {
      if (!scheduled) {
        scheduled = true;
        setTimeout(sync, 150);
      }
    });
    observer.observe(document.body, {childList: true, subtree: true});
    addEventListener('popstate', sync);
    addEventListener('pagehide', () => observer.disconnect(), {once:true});
    sync();
  }
})();
