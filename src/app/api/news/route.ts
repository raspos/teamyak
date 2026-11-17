import { NextRequest, NextResponse } from "next/server";
import { readDatabase } from "@/lib/server-store";

// ============================================================================
// TEAMYAK Phase 3 — 무상태(Stateless) 뉴스 & 장소 검색 API
// 요구사항 7: "검색어와 이용자의 미팅 관계를 결합한 분석 데이터를 수집하지 않는다."
// 본 엔드포인트는 요청자의 user_id나 meeting_id를 읽거나 DB에 기록하지 않습니다.
// ============================================================================

const SANDBOX_ARTICLES = [
  {
    id: "news_1",
    keyword: "삼성생명",
    title: "삼성생명, 3분기 누적 순이익 호조… 건강보험 CSM 확대 견인",
    pressName: "중앙일보",
    publishedAt: "2026-11-16 14:20",
    originalUrl: "https://search.naver.com/search.naver?where=news&query=%EC%82%BC%EC%84%B1%EC%83%9D%EB%AA%85+%EC%8B%A4%EC%A0%81",
  },
  {
    id: "news_2",
    keyword: "삼성생명",
    title: "삼성생명, 시니어 맞춤형 요양·헬스케어 연계 보장보험 라인업 강화",
    pressName: "한국경제",
    publishedAt: "2026-11-16 10:05",
    originalUrl: "https://search.naver.com/search.naver?where=news&query=%EC%82%BC%EC%84%B1%EC%83%9D%EB%AA%85+%EC%8B%A0%EC%83%81%ED%92%88",
  },
  {
    id: "news_3",
    keyword: "중앙일보",
    title: "[금융 라운지] 은행·보험권 연말 인사 및 조직개편 핵심 키워드 분석",
    pressName: "중앙일보",
    publishedAt: "2026-11-16 11:30",
    originalUrl: "https://search.naver.com/search.naver?where=news&query=%EC%A4%91%EC%95%99%EC%9D%BC%EB%B3%B4+%EA%B8%88%EC%9C%B5",
  },
  {
    id: "news_4",
    keyword: "한국은행",
    title: "한국은행(BOK), 물가 안정세 속 외환시장 변동성·가계부채 동시 주시",
    pressName: "연합뉴스",
    publishedAt: "2026-11-16 15:10",
    originalUrl: "https://search.naver.com/search.naver?where=news&query=%ED%95%9C%EA%B5%AD%EC%9D%80%ED%96%89+%EA%B8%B0%EC%A4%80%EA%B8%88%EB%A6%AC",
  },
  {
    id: "news_5",
    keyword: "KB금융지주",
    title: "KB금융지주, 기업가치 제고 계획 이행 및 주주환원 정책 속도",
    pressName: "매일경제",
    publishedAt: "2026-11-15 16:00",
    originalUrl: "https://search.naver.com/search.naver?where=news&query=KB%EA%B8%88%EC%9C%B5%EC%A7%80%EC%A3%BC+%EB%B0%B8%EB%A5%98%EC%97%85",
  },
];

export async function GET(req: NextRequest) {
  const query = (req.nextUrl.searchParams.get("q") || "삼성생명").trim();
  const db = await readDatabase();

  const naverClientId = process.env.NAVER_CLIENT_ID;
  const naverClientSecret = process.env.NAVER_CLIENT_SECRET;

  // 실제 네이버 Open API 키가 설정된 경우 실시간 호출
  if (naverClientId && naverClientSecret) {
    try {
      const apiRes = await fetch(
        `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=5&sort=date`,
        {
          headers: {
            "X-Naver-Client-Id": naverClientId,
            "X-Naver-Client-Secret": naverClientSecret,
          },
        }
      );
      if (apiRes.ok) {
        const data = await apiRes.json();
        return NextResponse.json({
          apiMode: "LIVE_NAVER_OPENAPI",
          zeroProfilingGuarantee: true,
          query,
          articles: (data.items || []).map((it: Record<string, string>, idx: number) => ({
            id: `live_${idx}`,
            keyword: query,
            title: it.title?.replace(/<[^>]+>/g, ""),
            pressName: "네이버 뉴스",
            publishedAt: it.pubDate,
            originalUrl: it.originallink || it.link,
          })),
          places: db.places,
        });
      }
    } catch {
      // Fallback to sandbox below
    }
  }

  const matched = SANDBOX_ARTICLES.filter(
    (a) =>
      a.keyword.includes(query) ||
      query.includes(a.keyword) ||
      a.title.includes(query)
  );

  const articles =
    matched.length > 0
      ? matched
      : [
          {
            id: `dyn_${Date.now()}`,
            keyword: query,
            title: `[최신 기사 검색] '${query}' 관련 언론사 보도 원문 보기`,
            pressName: "네이버 뉴스 검색 연결",
            publishedAt: "2026-11-17",
            originalUrl: `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(query)}`,
          },
        ];

  return NextResponse.json({
    apiMode: "SIMULATION_SANDBOX_NO_API_KEY",
    zeroProfilingGuarantee: true,
    query,
    articles,
    places: db.places,
  });
}
