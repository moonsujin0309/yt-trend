// 유튜브 글로벌 트렌드 수집기 — GitHub Actions에서 6시간마다 실행
// 필요 환경변수: YT_API_KEY (YouTube Data API v3 키)
// 출력: data/latest.json (사이트가 읽는 데이터), data/history.json (조회수 변화 추적용)
'use strict';
const fs = require('fs');

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error('YT_API_KEY 환경변수가 없습니다. 저장소 Settings → Secrets에 등록하세요.'); process.exit(1); }

// 수집 국가: 코드 → 검색 언어
const COUNTRIES = { KR:'ko', US:'en', JP:'ja', GB:'en', IN:'hi', ID:'id', BR:'pt', VN:'vi' };
const now = Date.now();
let quota = 0;

async function api(resource, params, cost) {
  const q = new URLSearchParams({ ...params, key: KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${resource}?${q}`);
  const j = await res.json();
  if (j.error) throw new Error(`${resource}: ${j.error.message}`);
  quota += cost;
  return j;
}

// ---- 조회수 히스토리 (스냅샷 간 증가량 계산) ----
let history = {};
try { history = JSON.parse(fs.readFileSync('data/history.json', 'utf8')); } catch (e) {}
const pushed = new Set();
function delta(id, views) {
  const h = history[id] || (history[id] = []);
  const prev = h.length ? h[h.length - 1] : null;
  if (!pushed.has(id)) {
    h.push([now, views]);
    if (h.length > 30) h.splice(0, h.length - 30);
    pushed.add(id);
  }
  if (prev && views > prev[1]) return { dv: views - prev[1], hrs: +((now - prev[0]) / 3600e3).toFixed(1) };
  return null;
}

function parseDur(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

// index.html의 buildVideo와 같은 스키마로 출력
function build(v, chMap, cc) {
  const st = v.statistics || {}, ch = chMap[v.snippet.channelId];
  const views = +st.viewCount || 0, likes = +st.likeCount || 0, comments = +st.commentCount || 0;
  let subs = -1;
  if (ch && ch.statistics && !ch.statistics.hiddenSubscriberCount) subs = +ch.statistics.subscriberCount || 0;
  const hrs = Math.max(1, (now - new Date(v.snippet.publishedAt).getTime()) / 3600e3);
  return {
    id: v.id, title: v.snippet.title, ch: v.snippet.channelTitle,
    thumb: ((v.snippet.thumbnails && (v.snippet.thumbnails.medium || v.snippet.thumbnails.default)) || {}).url || '',
    pub: v.snippet.publishedAt, cc, views, likes, comments, subs,
    dur: parseDur(v.contentDetails && v.contentDetails.duration),
    vph: +(views / hrs).toFixed(1),
    ratio: subs > 0 ? +(views / subs).toFixed(2) : -1,
    eng: views > 0 ? +((likes + comments) / views * 100).toFixed(2) : 0,
    delta: delta(v.id, views)
  };
}

async function details(ids, cc) {
  if (!ids.length) return [];
  const v = await api('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: '50' }, 1);
  const chIds = [...new Set((v.items || []).map(i => i.snippet.channelId))];
  const chMap = {};
  if (chIds.length) {
    const c = await api('channels', { part: 'statistics', id: chIds.join(','), maxResults: '50' }, 1);
    (c.items || []).forEach(i => chMap[i.id] = i);
  }
  return (v.items || []).map(i => build(i, chMap, cc));
}

// 최근 급상승 프록시 — 검색 파라미터 조합을 순서대로 시도하고, 결과가 나오는 조합을 채택
const H = 3600e3;
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const VARIANTS = [
  { name: '48h+region+lang', p: (cc, lang) => ({ order: 'viewCount', publishedAfter: iso(now - 48 * H), regionCode: cc, relevanceLanguage: lang }) },
  { name: '48h+region',      p: (cc)       => ({ order: 'viewCount', publishedAfter: iso(now - 48 * H), regionCode: cc }) },
  { name: '7d+region',       p: (cc)       => ({ order: 'viewCount', publishedAfter: iso(now - 7 * 24 * H), regionCode: cc }) },
  { name: '7d+lang',         p: (cc, lang) => ({ order: 'viewCount', publishedAfter: iso(now - 7 * 24 * H), relevanceLanguage: lang }) },
  { name: '30d+region',      p: (cc)       => ({ order: 'viewCount', publishedAfter: iso(now - 30 * 24 * H), regionCode: cc }) }
];
let winner = -1; // 첫 성공 조합을 기억해서 다음 국가부터는 그것부터 시도 (쿼터 절약)

async function collectHot(cc, lang) {
  const tryOrder = winner >= 0
    ? [winner, ...VARIANTS.keys()].filter((v, i, a) => a.indexOf(v) === i)
    : [...VARIANTS.keys()];
  for (const i of tryOrder) {
    let s;
    try {
      s = await api('search', { part: 'snippet', type: 'video', maxResults: '25', ...VARIANTS[i].p(cc, lang) }, 100);
    } catch (e) { console.log(`  search[${VARIANTS[i].name}] ${cc}: 에러 - ${e.message}`); continue; }
    const ids = (s.items || []).map(x => x.id.videoId).filter(Boolean);
    console.log(`  search[${VARIANTS[i].name}] ${cc}: ${ids.length}개`);
    if (ids.length) {
      if (winner < 0) { winner = i; console.log(`  → 채택된 검색 조합: ${VARIANTS[i].name}`); }
      return details(ids, cc);
    }
  }
  return [];
}

// 공식 인기 차트 (음악·영화·게임)
async function collectChart(cc) {
  const c = await api('videos', { part: 'id', chart: 'mostPopular', regionCode: cc, maxResults: '25' }, 1);
  return details((c.items || []).map(i => i.id), cc);
}

(async () => {
  const sources = { hot: {}, chart: {} };
  for (const [cc, lang] of Object.entries(COUNTRIES)) {
    try { sources.hot[cc] = await collectHot(cc, lang); }
    catch (e) { console.error(`hot ${cc} 실패: ${e.message}`); sources.hot[cc] = []; }
    try { sources.chart[cc] = await collectChart(cc); }
    catch (e) { console.error(`chart ${cc} 실패: ${e.message}`); sources.chart[cc] = []; }
    console.log(`${cc}: 급상승 ${sources.hot[cc].length}개, 차트 ${sources.chart[cc].length}개`);
  }

  // 7일 넘게 목록에 안 나타난 영상의 기록은 정리
  for (const id of Object.keys(history)) {
    const h = history[id];
    if (!h.length || now - h[h.length - 1][0] > 7 * 24 * 3600e3) delete history[id];
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/latest.json', JSON.stringify({ t: now, countries: Object.keys(COUNTRIES), sources }));
  fs.writeFileSync('data/history.json', JSON.stringify(history));
  console.log(`완료 — 이번 실행 API 사용량: 약 ${quota} 포인트 (하루 4회 = 약 ${quota * 4}/10,000)`);
})().catch(e => { console.error(e); process.exit(1); });
