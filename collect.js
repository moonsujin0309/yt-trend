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

// 최근 급상승 프록시 — 검색 API가 q 없는 요청에 결과를 주지 않으므로(2025년 트렌딩 폐지 이후),
// 언어별로 거의 모든 제목에 등장하는 초광역 OR 검색어를 넣어 전체 커버리지를 근사한다.
const H = 3600e3;
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const BROAD_Q = {
  ko: '이|의|는|하|고', en: 'a|the|i|to|you', ja: 'の|は|が|に|と', hi: 'है|के|का|की',
  id: 'yang|di|dan|ini', pt: 'de|que|o|e|um', vi: 'của|và|là|có'
};

async function collectHot(cc, lang) {
  const q = BROAD_Q[lang] || BROAD_Q.en;
  for (const hours of [48, 7 * 24]) {
    const s = await api('search', {
      part: 'snippet', type: 'video', maxResults: '25', q,
      order: 'viewCount', publishedAfter: iso(now - hours * H),
      regionCode: cc, relevanceLanguage: lang
    }, 100);
    const ids = (s.items || []).map(x => x.id.videoId).filter(Boolean);
    console.log(`  search[q, ${hours}h] ${cc}: ${ids.length}개`);
    if (ids.length) return details(ids, cc);
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
