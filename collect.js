// 유튜브 글로벌 트렌드 수집기 — GitHub Actions에서 6시간마다 실행
// 필요 환경변수: YT_API_KEY (YouTube Data API v3 키)
// 선택 환경변수: ANTHROPIC_API_KEY (AI 트렌드 브리핑 — 없으면 브리핑만 생략, 수집은 정상 진행)
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
    cat: +v.snippet.categoryId || 0, // 수익 추정용 카테고리 (추가 API 호출 없음 — snippet에 이미 들어있음)
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

/* ================= 🤖 AI 트렌드 브리핑 =================
   수집 시점에 한 번만 Claude를 호출해 인사이트 3개를 만들어 latest.json에 구워 넣는다.
   → 사이트 방문자는 API 키 없이 결과만 읽는다.
   ⚠️ 이 블록은 어떤 이유로 실패해도 유튜브 수집을 죽이면 안 된다 — 전부 try/catch, exit 금지. */
const AI_SYS = `당신은 유튜브 트렌드 분석가입니다. 독자는 유튜브 채널을 새로 키우려는 1인 창작자입니다.
주어진 "지금 뜨는 영상 목록"만 보고 인사이트 정확히 3개를 한국어로 작성하세요.

각 인사이트는 세 부분입니다.
- headline: 지금 무엇이 뜨는지 한 문장. 반드시 구체적 고유명사(대회명·게임명·인물명·이슈명)를 쓸 것.
  "쇼츠가 인기다", "음악이 강세다" 같은 뻔한 일반론은 금지.
- detail: 왜 뜨는지 + 근거가 되는 숫자 한두 개(조회수·시간당 조회수·구독자 대비 배율 등).
  제목에서 읽어낸 맥락을 쓸 것.
- action: 독자가 오늘 만들 수 있는 구체적인 영상 아이디어 한 줄. 이게 가장 중요합니다.
  "월드컵 관련 콘텐츠를 만드세요" 같은 추상적 지시는 금지.
  "16강 탈락팀 감독 인터뷰 반응 쇼츠" 수준으로 소재·형식이 바로 잡히게 쓸 것.

규칙:
- 데이터에 근거가 없는 추측은 금지. 제목만으로 사건의 배경을 모르면 아는 만큼만 쓰고 지어내지 말 것.
- 3개는 서로 다른 주제여야 합니다. 같은 영상군을 세 번 우려먹지 말 것.
- 각 문장은 짧고 담백하게. 과장 형용사·감탄사 금지.`;

const INS_SCHEMA = {
  type: 'object',
  properties: {
    insights: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object',
        properties: { headline: { type: 'string' }, detail: { type: 'string' }, action: { type: 'string' } },
        required: ['headline', 'detail', 'action'],
        additionalProperties: false
      }
    }
  },
  required: ['insights'],
  additionalProperties: false
};

// 전체 JSON을 넣으면 토큰 낭비 — 판단에 쓰이는 필드만 한 줄로 압축한다
function briefLine(v, i) {
  const sub = v.subs > 0 ? `구독 ${Math.round(v.subs / 1000)}천` : '구독 비공개';
  const ratio = v.ratio > 0 ? `구독대비 ${v.ratio}배` : '구독대비 -';
  const fmt = v.dur > 0 && v.dur <= 180 ? `쇼츠 ${v.dur}초` : `롱폼 ${Math.round(v.dur / 60)}분`;
  return `${i + 1}. [${v.cc}] ${v.title} | ${v.ch} | ${sub} | 조회 ${v.views} | 시간당 ${Math.round(v.vph)} | ${ratio} | ${fmt}`;
}

async function makeInsights(hot) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️ ANTHROPIC_API_KEY가 없어 AI 브리핑을 건너뜁니다 (유튜브 수집은 정상 완료).');
    return null;
  }
  const seen = new Set();
  const top = Object.values(hot).flat()
    .filter(v => !seen.has(v.id) && seen.add(v.id))
    .sort((a, b) => b.views - a.views).slice(0, 40);
  if (top.length < 5) {
    console.warn(`⚠️ 브리핑용 영상이 ${top.length}개뿐이라 AI 브리핑을 건너뜁니다.`);
    return null;
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  // messages.parse = 구조화 출력을 SDK가 검증·파싱해 parsed_output으로 준다.
  // 직접 JSON.parse 하면 thinking 블록이 섞이거나 스키마가 어긋났을 때 무인 실행에서 조용히 터진다.
  const r = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 4000,
    system: AI_SYS,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: INS_SCHEMA } },
    messages: [{ role: 'user', content: `지금 뜨는 영상 ${top.length}개 (조회수 순):\n\n` + top.map(briefLine).join('\n') }]
  });
  const out = r.parsed_output && r.parsed_output.insights;
  if (!Array.isArray(out) || out.length !== 3) throw new Error('브리핑 응답 형식이 예상과 다릅니다');
  console.log(`AI 브리핑 생성 — 입력 ${r.usage.input_tokens} / 출력 ${r.usage.output_tokens} 토큰`);
  out.forEach(x => console.log(`  · ${x.headline}`));
  return out;
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

  // AI 브리핑 — 실패는 경고만 남기고 넘어간다 (insights 키가 없으면 사이트가 블록 자체를 숨김)
  let insights = null, insightsAt = null;
  try {
    insights = await makeInsights(sources.hot);
    if (insights) insightsAt = Date.now();
  } catch (e) {
    console.warn(`⚠️ AI 브리핑 실패 — 브리핑 없이 계속 진행합니다: ${e.message}`);
    insights = null;
  }

  fs.mkdirSync('data', { recursive: true });
  const out = { t: now, countries: Object.keys(COUNTRIES), sources };
  if (insights) { out.insights = insights; out.insightsAt = insightsAt; }
  fs.writeFileSync('data/latest.json', JSON.stringify(out));
  fs.writeFileSync('data/history.json', JSON.stringify(history));
  console.log(`완료 — 이번 실행 API 사용량: 약 ${quota} 포인트 (하루 4회 = 약 ${quota * 4}/10,000)`);
})().catch(e => { console.error(e); process.exit(1); });
