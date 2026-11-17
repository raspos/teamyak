import { NextRequest, NextResponse } from "next/server";
import {
  readDatabase,
  writeDatabase,
  resolveUserFromRequest,
  generateAppleFeedToken,
  DbCalendarConnection,
} from "@/lib/server-store";

// ============================================================================
// TEAMYAK — Apple Calendar (아이폰 기본 캘린더) 연동 관리 API
// 
// [제공 기능]
// 1. GET: 사용자 전용 ICS 구독 URL(webcal:// 및 https://), 구독 상태, 갱신 지연 안내문 반환
// 2. POST (action: REGENERATE_TOKEN): 구독 토큰 재발급 (기존 토큰 즉시 무효화)
// 3. POST (action: REVOKE_FEED): 구독 피드 비활성화 (피드 접근 차단)
// 4. POST (action: ENABLE_FEED): 구독 피드 활성화
// 5. POST (action: UPDATE_PRIVACY): 상세 정보 노출 여부(includeDetailedInfo) 설정
// ============================================================================

const REFRESH_DELAY_NOTICE =
  "아이폰 캘린더의 일정 갱신 주기는 Apple/iCloud의 백그라운드 폴링 정책(보통 수십 분~수 시간 주기)에 따릅니다. 팀약에서 일정이 변경·취소되더라도 아이폰 화면에 즉시 반영되지 않고 지연될 수 있습니다. 즉시 반영을 원하실 경우 아이폰 [캘린더 앱 > 하단 '캘린더' > 화면을 아래로 당겨 새로고침]을 실행해 주세요.";

export async function GET(req: NextRequest) {
  try {
    const db = await readDatabase();
    const authHeader = req.headers.get("authorization");
    const cookieToken =
      req.cookies.get("teamyak_session")?.value ||
      req.cookies.get("teamyak_uid")?.value;
    const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let calConn = db.calendarConnections.find(
      (c) => c.userId === currentUser.id
    );

    let isModified = false;
    if (!calConn) {
      calConn = {
        userId: currentUser.id,
        googleConnected: false,
        writeConsent: true,
        includeDetailedInfo: false,
        appleFeedToken: generateAppleFeedToken(),
        appleFeedEnabled: true,
        appleFeedCreatedAt: new Date().toISOString(),
        externalEventMappings: {},
      };
      db.calendarConnections.push(calConn);
      isModified = true;
    } else if (!calConn.appleFeedToken) {
      calConn.appleFeedToken = generateAppleFeedToken();
      calConn.appleFeedEnabled = true;
      calConn.appleFeedCreatedAt = new Date().toISOString();
      isModified = true;
    }

    if (isModified) {
      await writeDatabase(db);
    }

    // 활성 모임 수 집계
    const userAttendances = db.meetingParticipants.filter(
      (mp) =>
        mp.userId === currentUser.id &&
        mp.isApproved &&
        (mp.rsvpStatus === "ATTENDING" || mp.attendanceCheck === "VERIFIED_ATTENDED")
    );
    const attendedMeetingIds = new Set(userAttendances.map((mp) => mp.meetingId));
    const activeMeetingsCount = db.meetings.filter(
      (m) => attendedMeetingIds.has(m.id) && m.status !== "CANCELED"
    ).length;

    const host =
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host") ||
      req.nextUrl.host;
    const protocol =
      req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "");
    const origin = `${protocol}://${host}`;

    const feedPath = `/api/calendar/feed/${calConn.appleFeedToken}.ics`;
    const httpsUrl = `${origin}${feedPath}`;
    const webcalUrl = httpsUrl.replace(/^https?:\/\//i, "webcal://");

    return NextResponse.json({
      ok: true,
      appleCalendar: {
        token: calConn.appleFeedToken,
        enabled: calConn.appleFeedEnabled ?? true,
        createdAt: calConn.appleFeedCreatedAt,
        lastAccessedAt: calConn.appleFeedLastAccessedAt || null,
        webcalUrl,
        httpsUrl,
        activeEventsCount: activeMeetingsCount,
        refreshDelayNotice: REFRESH_DELAY_NOTICE,
      },
      privacySettings: {
        defaultTitle: "팀약 일정",
        includeDetailedInfo: calConn.includeDetailedInfo ?? false,
        notice:
          "외부 캘린더 피드에는 상대방 직함 등 민감 정보가 배제되며, 기본적으로 '팀약 일정' 중립 명칭으로 안전하게 등록됩니다.",
      },
    });
  } catch (err: any) {
    console.error("GET /api/calendar/apple Error:", err);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: err.message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const db = await readDatabase();
    const authHeader = req.headers.get("authorization");
    const cookieToken =
      req.cookies.get("teamyak_session")?.value ||
      req.cookies.get("teamyak_uid")?.value;
    const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    let calConn = db.calendarConnections.find(
      (c) => c.userId === currentUser.id
    );

    if (!calConn) {
      calConn = {
        userId: currentUser.id,
        googleConnected: false,
        writeConsent: true,
        includeDetailedInfo: false,
        appleFeedToken: generateAppleFeedToken(),
        appleFeedEnabled: true,
        appleFeedCreatedAt: new Date().toISOString(),
        externalEventMappings: {},
      };
      db.calendarConnections.push(calConn);
    }

    let message = "";

    if (action === "REGENERATE_TOKEN") {
      const oldToken = calConn.appleFeedToken;
      calConn.appleFeedToken = generateAppleFeedToken();
      calConn.appleFeedEnabled = true;
      calConn.appleFeedCreatedAt = new Date().toISOString();
      calConn.appleFeedLastAccessedAt = undefined;
      message = `캘린더 구독 URL이 성공적으로 재발급되었습니다. 기존 토큰(${oldToken?.slice(0, 10)}...)은 즉시 무효화되었습니다.`;
    } else if (action === "REVOKE_FEED") {
      calConn.appleFeedEnabled = false;
      message = "아이폰 캘린더 구독 피드가 비활성화되었습니다. 외부 요청이 차단됩니다.";
    } else if (action === "ENABLE_FEED") {
      calConn.appleFeedEnabled = true;
      message = "아이폰 캘린더 구독 피드가 다시 활성화되었습니다.";
    } else if (action === "UPDATE_PRIVACY") {
      calConn.includeDetailedInfo = Boolean(body.includeDetailedInfo);
      message = `캘린더 상세 정보 노출 설정이 변경되었습니다: ${
        calConn.includeDetailedInfo ? "상세 정보 표시" : "중립 일정명('팀약 일정') 표시"
      }`;
    } else {
      return NextResponse.json(
        { error: "INVALID_ACTION", message: `Unknown action: ${action}` },
        { status: 400 }
      );
    }

    await writeDatabase(db);

    const host =
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host") ||
      req.nextUrl.host;
    const protocol =
      req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "");
    const origin = `${protocol}://${host}`;

    const feedPath = `/api/calendar/feed/${calConn.appleFeedToken}.ics`;
    const httpsUrl = `${origin}${feedPath}`;
    const webcalUrl = httpsUrl.replace(/^https?:\/\//i, "webcal://");

    return NextResponse.json({
      ok: true,
      message,
      appleCalendar: {
        token: calConn.appleFeedToken,
        enabled: calConn.appleFeedEnabled ?? true,
        createdAt: calConn.appleFeedCreatedAt,
        lastAccessedAt: calConn.appleFeedLastAccessedAt || null,
        webcalUrl,
        httpsUrl,
        refreshDelayNotice: REFRESH_DELAY_NOTICE,
      },
      privacySettings: {
        defaultTitle: "팀약 일정",
        includeDetailedInfo: calConn.includeDetailedInfo ?? false,
      },
    });
  } catch (err: any) {
    console.error("POST /api/calendar/apple Error:", err);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: err.message },
      { status: 500 }
    );
  }
}
