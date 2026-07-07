# 📊 유튜브 글로벌 트렌드 분석

GitHub Actions가 6시간마다 8개국(🇰🇷🇺🇸🇯🇵🇬🇧🇮🇳🇮🇩🇧🇷🇻🇳) 유튜브 인기 영상을 자동 수집하고,
"왜 떴는지"(알고리즘 픽 vs 구독자 파워)를 분석해서 보여주는 정적 사이트.

**사이트**: https://moonsujin0309.github.io/yt-trend/

## 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 사이트 전체. `data/latest.json`이 있으면 그걸 보여주고(키 불필요), 없으면 본인 API 키로 직접 조회하는 로컬 모드로 동작 |
| `collect.js` | 수집기 (Node 20, 의존성 없음). 국가별 48시간 급상승 + 공식 차트 수집 |
| `.github/workflows/collect.yml` | 6시간마다 `collect.js` 실행 → `data/` 커밋 |
| `data/latest.json` | 최신 수집 결과 (자동 생성) |
| `data/history.json` | 영상별 조회수 변화 기록, 7일 보관 (자동 생성) |

## 설정 (최초 1회)

1. **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `YT_API_KEY` / Value: YouTube Data API v3 키
2. **Settings → Pages → Source: Deploy from a branch → main / (root)**
3. **Actions 탭 → collect → Run workflow** (첫 수집. 이후엔 6시간마다 자동)

API 사용량: 회당 약 840포인트 × 하루 4회 ≈ 3,400 / 무료 한도 10,000. 요금 발생 없음 (결제수단 미등록 시 과금 자체가 불가).
