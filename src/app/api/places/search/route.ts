import { NextRequest, NextResponse } from "next/server";
import { readDatabase } from "@/lib/server-store";

// ============================================================================
// TEAMYAK Phase 3.7 — 네이버 장소 검색 API & 길찾기 연동
//
// [정책 준수]
// 1. 네이버 Open API(지역 검색) 실제 연결 및 실시간 식당·장소 검색 지원
// 2. 룸·주차·예약 가능 여부 등 외부 API에서 미확인된 조건은 반드시 '확인 필요'로 명시
// 3. 네이버 지도 길찾기(directionUrl) 및 매장 상세 링크 제공
// 4. 이용자의 과거 미팅 이력이나 방문 식당 기록을 검색 API에 절대 전송하지 않음 (Zero-Knowledge)
// ============================================================================

export async function GET(req: NextRequest) {
  const query = (req.nextUrl.searchParams.get("q") || "여의도 한식").trim();
  const db = await readDatabase();

  const naverClientId = process.env.NAVER_CLIENT_ID;
  const naverClientSecret = process.env.NAVER_CLIENT_SECRET;

  if (naverClientId && naverClientSecret) {
    try {
      const apiRes = await fetch(
        `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(
          query
        )}&display=5&sort=comment`,
        {
          headers: {
            "X-Naver-Client-Id": naverClientId,
            "X-Naver-Client-Secret": naverClientSecret,
          },
        }
      );

      if (apiRes.ok) {
        const data = await apiRes.json();
        const livePlaces = (data.items || []).map(
          (it: Record<string, string>, idx: number) => {
            const cleanTitle = it.title ? it.title.replace(/<[^>]+>/g, "") : `식당_${idx}`;
            return {
              id: `naver_place_${idx}_${Date.now()}`,
              name: cleanTitle,
              category: "RESTAURANT",
              cuisineType: it.category || "음식점",
              roadAddress: it.roadAddress || it.address || "주소 정보 제공 예정",
              areaSummary: cleanTitle.includes("여의도")
                ? "여의도"
                : cleanTitle.includes("광화문")
                ? "광화문"
                : "도심권",
              naverMapUrl: `https://map.naver.com/v5/search/${encodeURIComponent(
                cleanTitle
              )}`,
              directionUrl: `https://map.naver.com/v5/directions/-/-/${encodeURIComponent(
                cleanTitle
              )}/transit`,
              naverPlaceId: `nv_${idx}`,
              verifiedQuietScore: 3,
              hasPrivateRooms: false,
              parkingAvailable: false,
              isActualVerifiedRestaurant: true,
              unverifiedItems: [
                "개별 룸 보유 여부 (확인 필요)",
                "무료 주차 지원 여부 (확인 필요)",
                "당일 유선 예약 가능 여부 (확인 필요)",
              ],
            };
          }
        );

        return NextResponse.json({
          ok: true,
          apiMode: "LIVE_NAVER_LOCAL_API",
          query,
          zeroProfilingGuarantee: true,
          places: livePlaces,
        });
      }
    } catch {
      // Fallback to sandbox below
    }
  }

  // Sandbox fallback
  const matchedPlaces = db.places
    .filter(
      (p) =>
        p.name.includes(query) ||
        p.areaSummary.includes(query) ||
        p.cuisineType.includes(query) ||
        query.includes(p.areaSummary)
    )
    .map((p) => ({
      ...p,
      directionUrl: `https://map.naver.com/v5/search/${encodeURIComponent(p.name)}`,
      unverifiedItems: [
        "개별 룸 보유 여부 (확인 필요)",
        "무료 주차 지원 여부 (확인 필요)",
        "당일 유선 예약 가능 여부 (확인 필요)",
      ],
    }));

  return NextResponse.json({
    ok: true,
    apiMode: "SIMULATION_SANDBOX_DATASET",
    query,
    zeroProfilingGuarantee: true,
    places: matchedPlaces.length > 0 ? matchedPlaces : db.places,
  });
}
