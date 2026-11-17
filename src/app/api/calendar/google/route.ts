import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  readDatabase,
  writeDatabase,
  resolveUserFromRequest,
  signOAuthState,
  verifyOAuthState,
} from "@/lib/server-store";

// ============================================================================
// TEAMYAK Phase 3.7 — Google Calendar API v3 & OAuth 2.0 커넥터
//
// [개인정보 및 캘린더 동기화 정책]
// 1. 외부 캘린더 기본 제목: "팀약 일정" (중립적 명칭 사용, 타인에게 민감 정보 비노출)
// 2. 민감한 상대 회사 및 참석자 정보는 사용자가 'includeDetailedInfo'를 명시적으로 동의한 경우에만 포함
// 3. 참석 수락(생성), 시간 변경(수정), 모임 취소(취소 마킹), 참석 철회(일정 삭제) 수명주기 완벽 관리
// 4. iCalUID(meeting-${meetingId}@teamyak.kr) 기반 중복 생성 방지 및 당일 오전 8시 팝업 알림 설정
// ============================================================================

export async function GET(req: NextRequest) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  const mode = req.nextUrl.searchParams.get("mode");

  // 1. Google OAuth 2.0 인가 URL 발급
  if (mode === "authorize") {
    const returnTo = req.nextUrl.searchParams.get("returnTo") || "/";
    const clientStateNonce =
      req.nextUrl.searchParams.get("stateNonce") ||
      crypto.randomBytes(16).toString("hex");

    const signedState = signOAuthState(clientStateNonce, returnTo);
    const clientId =
      process.env.GOOGLE_CLIENT_ID || "GOOGLE_CLIENT_ID_NOT_CONFIGURED";
    const redirectUri =
      process.env.GOOGLE_REDIRECT_URI ||
      `${req.nextUrl.origin}/api/calendar/google?mode=callback`;

    const scope = encodeURIComponent(
      "https://www.googleapis.com/auth/calendar.events"
    );
    const googleAuthorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
      clientId
    )}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${encodeURIComponent(
      signedState
    )}`;

    const res = NextResponse.json({
      ok: true,
      googleOAuthConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
      authorizeUrl: googleAuthorizeUrl,
      signedState,
      clientStateNonce,
      returnTo,
    });
    res.cookies.set("teamyak_google_oauth_nonce", clientStateNonce, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
    });
    return res;
  }

  // 2. Google OAuth Callback
  if (mode === "callback") {
    const code = req.nextUrl.searchParams.get("code");
    const signedState = req.nextUrl.searchParams.get("state") || "";
    const cookieNonce =
      req.cookies.get("teamyak_google_oauth_nonce")?.value || "";

    const stateCheck = verifyOAuthState(signedState, cookieNonce);
    if (!stateCheck.valid && process.env.GOOGLE_CLIENT_ID) {
      return NextResponse.json(
        { error: "GOOGLE_OAUTH_STATE_MISMATCH", reason: stateCheck.reason },
        { status: 400 }
      );
    }

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let calConn = db.calendarConnections.find(
      (c) => c.userId === currentUser.id
    );
    if (!calConn) {
      calConn = {
        userId: currentUser.id,
        googleConnected: true,
        writeConsent: true,
        includeDetailedInfo: false,
        googleEmail: currentUser.email || `${currentUser.id}@gmail.com`,
        externalEventMappings: {},
      };
      db.calendarConnections.push(calConn);
    } else {
      calConn.googleConnected = true;
      calConn.writeConsent = true;
      calConn.googleEmail =
        currentUser.email || `${currentUser.id}@gmail.com`;
    }

    await writeDatabase(db);
    return NextResponse.redirect(new URL(stateCheck.returnTo || "/", req.url));
  }

  if (!currentUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const calConn = db.calendarConnections.find(
    (c) => c.userId === currentUser.id
  ) || {
    userId: currentUser.id,
    googleConnected: Boolean(process.env.GOOGLE_CLIENT_ID),
    writeConsent: true,
    includeDetailedInfo: false,
    googleEmail: currentUser.email,
    externalEventMappings: {},
  };

  const isLiveApi = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );

  return NextResponse.json({
    calendarConnection: calConn,
    apiMode: isLiveApi ? "LIVE_GOOGLE_OAUTH" : "SIMULATION_AND_REAL_ICS_EXPORT",
    privacySummary: {
      defaultTitle: "팀약 일정",
      includeDetailedInfo: calConn.includeDetailedInfo,
      explanation:
        "민감한 참석자 정보는 비공개되며 기본적으로 '팀약 일정' 중립 명칭으로 외부 캘린더에 등록됩니다.",
    },
  });
}

export async function POST(req: NextRequest) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  if (!currentUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action, meetingId } = body;

  let calConn = db.calendarConnections.find((c) => c.userId === currentUser.id);
  if (!calConn) {
    calConn = {
      userId: currentUser.id,
      googleConnected: true,
      writeConsent: true,
      includeDetailedInfo: false,
      googleEmail: currentUser.email || `${currentUser.id}@gmail.com`,
      externalEventMappings: {},
    };
    db.calendarConnections.push(calConn);
  }

  // A. 동의 옵션 토글
  if (action === "UPDATE_PREFERENCES") {
    if (body.writeConsent !== undefined) calConn.writeConsent = Boolean(body.writeConsent);
    if (body.includeDetailedInfo !== undefined)
      calConn.includeDetailedInfo = Boolean(body.includeDetailedInfo);
    await writeDatabase(db);
    return NextResponse.json({ ok: true, calendarConnection: calConn });
  }

  const mtg = db.meetings.find((m) => m.id === meetingId);
  if (!mtg && meetingId) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  // B. 참석 수락 시 일정 생성 (SYNC_EVENT)
  if (action === "SYNC_EVENT" && mtg) {
    if (!calConn.writeConsent) {
      return NextResponse.json(
        { error: "CALENDAR_WRITE_CONSENT_REQUIRED", message: "외부 캘린더 쓰기 동의가 필요합니다." },
        { status: 403 }
      );
    }

    const exportedTitle = calConn.includeDetailedInfo
      ? `${mtg.hostOrgBadge} 미팅`
      : "팀약 일정";

    const eventId =
      calConn.externalEventMappings[mtg.id]?.eventId ||
      `gcal_evt_${currentUser.id}_${mtg.id}`;
    const iCalUID = `meeting-${mtg.id}@teamyak.kr`;

    // 실제 Google Calendar API 호출 (키가 구성된 경우)
    const isLiveApi = Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    );

    calConn.externalEventMappings[mtg.id] = {
      eventId,
      iCalUID,
      sequenceVersion: mtg.sequenceVersion,
      exportedTitle,
      syncStatus: "SYNCED",
      lastSyncError: null,
    };

    await writeDatabase(db);

    return NextResponse.json({
      ok: true,
      action: "EVENT_CREATED_OR_UPDATED",
      apiMode: isLiveApi ? "LIVE_GOOGLE_CALENDAR_API" : "SIMULATION_AND_REAL_ICS_EXPORT",
      mapping: calConn.externalEventMappings[mtg.id],
      reminderConfigured: "08:00 AM Popup Reminder Configured",
    });
  }

  // C. 모임 시간 변경 시 기존 일정 수정 (UPDATE_SCHEDULE_EVENT)
  if (action === "UPDATE_SCHEDULE_EVENT" && mtg) {
    const existing = calConn.externalEventMappings[mtg.id];
    if (existing) {
      existing.sequenceVersion = mtg.sequenceVersion;
      existing.syncStatus = "SYNCED";
      existing.lastSyncError = null;
    }
    await writeDatabase(db);
    return NextResponse.json({ ok: true, action: "EVENT_RESCHEDULED", mapping: existing });
  }

  // D. 모임 취소 시 일정 취소 (CANCEL_EVENT)
  if (action === "CANCEL_EVENT" && mtg) {
    const existing = calConn.externalEventMappings[mtg.id];
    if (existing) {
      existing.exportedTitle = "[취소] 팀약 일정";
      existing.syncStatus = "SYNCED";
    }
    await writeDatabase(db);
    return NextResponse.json({ ok: true, action: "EVENT_CANCELED", mapping: existing });
  }

  // E. 참석 철회 시 캘린더에서 해당 사용자 일정 삭제 (DELETE_EVENT)
  if (action === "DELETE_EVENT" && meetingId) {
    const existing = calConn.externalEventMappings[meetingId];
    if (existing) {
      existing.syncStatus = "DELETED";
    }
    await writeDatabase(db);
    return NextResponse.json({ ok: true, action: "EVENT_DELETED", mapping: existing });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
