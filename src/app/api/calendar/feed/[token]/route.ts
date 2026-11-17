import { NextRequest, NextResponse } from "next/server";
import { readDatabase, writeDatabase } from "@/lib/server-store";
import { generateIcsFeedContent, CalendarExportOptions } from "@/lib/ics";

// ============================================================================
// TEAMYAK — Apple Calendar (Webcal / RFC 5545) 구독 피드 엔드포인트
// 
// [보안 및 동작 원칙]
// 1. 엔드포인트 URL: /api/calendar/feed/[token] 또는 /api/calendar/feed/[token].ics
// 2. Apple/iCloud 캘린더 데몬이 정기적으로 백그라운드에서 fetch하므로 무상태 토큰 기반 인증 사용
// 3. 사용자별 고유 feedToken으로 해당 사용자의 확정된(ATTENDING/VERIFIED_ATTENDED) 모임만 격리하여 제공
// 4. 모임 취소(CANCELED) 및 참석 철회(DECLINED) 시 구독 피드에서 해당 일정 자동 제거
// 5. 날짜/시간 변경 시 동일 UID(meeting-${id}@teamyak.kr) 유지 및 SEQUENCE 버전 증가
// 6. 기본 일정 제목은 '팀약 일정' 중립 명칭 사용 (상대방/회사 민감 정보 배제)
// ============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    if (!token) {
      return new NextResponse("Token is required", { status: 400 });
    }

    // .ics 확장자가 붙어 요청된 경우 접미사 제거
    const cleanToken = token.replace(/\.ics$/i, "");

    const db = await readDatabase();

    // 1. 해당 토큰을 보유한 사용자 캘린더 연결 조회
    const conn = db.calendarConnections.find(
      (c) => c.appleFeedToken === cleanToken
    );

    if (!conn || conn.appleFeedEnabled === false) {
      return new NextResponse(
        "Calendar feed not found, revoked, or disabled",
        {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        }
      );
    }

    // 2. 대상 사용자 확인
    const user = db.users.find((u) => u.id === conn.userId);
    if (!user) {
      return new NextResponse("User not found", { status: 404 });
    }

    // 3. 사용자가 참석 확정(ATTENDING 또는 VERIFIED_ATTENDED)한 모임 참가 레코드 필터링
    const userAttendances = db.meetingParticipants.filter(
      (mp) =>
        mp.userId === user.id &&
        mp.isApproved &&
        (mp.rsvpStatus === "ATTENDING" || mp.attendanceCheck === "VERIFIED_ATTENDED")
    );

    const attendedMeetingIds = new Set(userAttendances.map((mp) => mp.meetingId));

    // 4. 활성 모임 필터링 (취소된 모임은 피드에서 제거)
    const activeMeetings = db.meetings.filter(
      (m) => attendedMeetingIds.has(m.id) && m.status !== "CANCELED"
    );

    // 5. RFC 5545 이벤트 옵션 생성
    const events: CalendarExportOptions[] = activeMeetings.map((mtg) => {
      let placeName: string | undefined = undefined;
      if (mtg.placeId) {
        const p = db.places?.find((pl) => pl.id === mtg.placeId);
        if (p) placeName = p.name;
      }

      return {
        meetingId: mtg.id,
        confirmedDate: mtg.confirmedDate,
        startTime: mtg.startTime || "12:00",
        endTime: mtg.endTime || "13:30",
        sequenceVersion: mtg.sequenceVersion || 1,
        status: mtg.status,
        areaHint: mtg.areaHint || "서울",
        includeDetailedInfo: Boolean(conn.includeDetailedInfo),
        detailedPlace: placeName,
        morningAlarmTime: "08:00",
      };
    });

    // 6. 다중 일정 RFC 5545 ICS 피드 생성
    const calendarTitle = "팀약 일정";
    const icsContent = generateIcsFeedContent(events, calendarTitle);

    // 7. 최근 폴링 접근 시각 갱신
    conn.appleFeedLastAccessedAt = new Date().toISOString();
    await writeDatabase(db);

    return new NextResponse(icsContent, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="teamyak-${user.id}.ics"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "X-Published-TTL": "PT1H",
      },
    });
  } catch (err: any) {
    console.error("Apple Calendar Feed Error:", err);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
