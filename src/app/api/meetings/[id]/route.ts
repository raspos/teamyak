import { NextRequest, NextResponse } from "next/server";
import {
  readDatabase,
  writeDatabase,
  resolveUserFromRequest,
  canUserAccessEncryptedMeetingPayload,
  syncTeamSharedProjections,
  generateAiPlaceRecommendations,
  SeniorityLevel,
  ScheduleChangeType,
} from "@/lib/server-store";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  const gate = canUserAccessEncryptedMeetingPayload(
    db,
    currentUser?.id || null,
    params.id
  );

  if (!gate.allowed) {
    return NextResponse.json(
      {
        error: "FORBIDDEN_BY_SERVER_AUTHZ_AND_RLS",
        reason: gate.reason,
        message:
          "승인된 직접 참석자가 아니므로 암호화된 모임 상세 데이터 및 참석자 명단을 조회할 수 없습니다.",
      },
      { status: 403 }
    );
  }

  const mtg = db.meetings.find((m) => m.id === params.id);
  if (!mtg) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const sides = db.meetingSides.filter((ms) => ms.meetingId === mtg.id);
  const visibilities = db.meetingVisibilities.filter((mv) =>
    sides.some((s) => s.id === mv.meetingSideId)
  );
  const participants = db.meetingParticipants.filter(
    (mp) => mp.meetingId === mtg.id
  );
  const invite = db.meetingInvitations.find((i) => i.meetingId === mtg.id);

  // [보안 보완 6] 다른 이용자의 음식 취향은 조회되지 않도록 오직 본인(p.userId === currentUser.id) 취향만 반환!
  const preferences = db.meetingPreferences.filter(
    (p) => p.meetingId === mtg.id && p.userId === currentUser?.id
  );
  const recommendations = db.placeRecommendations.filter(
    (r) => r.meetingId === mtg.id
  );
  const scheduleChanges = db.meetingScheduleChanges
    .filter((sc) => sc.meetingId === mtg.id)
    .map((sc) => ({
      ...sc,
      changeReasonDisplay:
        !sc.reasonIsPrivate || sc.changedByUserId === currentUser?.id
          ? sc.changeReasonPrivate
          : "🔒 비공개 사유 (일정 변경 기록만 표시됨)",
    }));

  const selectedPlace = mtg.placeId
    ? db.places.find((p) => p.id === mtg.placeId) || null
    : null;

  return NextResponse.json({
    meeting: {
      ...mtg,
      sides,
      visibilities,
      participants,
      preferences,
      recommendations,
      scheduleChanges,
      selectedPlace,
      inviteCode: invite?.inviteCode || null,
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  if (!currentUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mtg = db.meetings.find((m) => m.id === params.id);
  if (!mtg) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const body = await req.json();
  const { action } = body;

  // ==========================================================================
  // 1. 일정 변경 및 순연 횟수 관리 (UPDATE_SCHEDULE)
  // ==========================================================================
  if (action === "UPDATE_SCHEDULE") {
    const hostSide = db.meetingSides.find(
      (ms) => ms.meetingId === mtg.id && ms.sideType === "HOST"
    );
    if (
      hostSide?.representativeUserId !== currentUser.id &&
      mtg.createdBy !== currentUser.id
    ) {
      return NextResponse.json(
        { error: "호스트 대표만 모임 일시·장소를 변경할 수 있습니다." },
        { status: 403 }
      );
    }

    const prevDate = mtg.confirmedDate;
    const prevStart = mtg.startTime;
    const newDate = body.confirmedDate || prevDate;
    const newStart =
      body.startTime !== undefined ? body.startTime : mtg.startTime;
    const newEnd = body.endTime !== undefined ? body.endTime : mtg.endTime;

    let changeType: ScheduleChangeType = "TIME_ONLY";
    let postponementNumber = 0;

    const wasConfirmedMeeting = mtg.status !== "SCHEDULING";

    if (wasConfirmedMeeting && prevDate && newDate > prevDate) {
      changeType = "POSTPONED";
      mtg.postponementCount += 1;
      postponementNumber = mtg.postponementCount;
    } else if (wasConfirmedMeeting && prevDate && newDate < prevDate) {
      changeType = "EARLIER_DATE";
      postponementNumber = 0;
    } else {
      changeType = "TIME_ONLY";
      postponementNumber = 0;
    }

    mtg.confirmedDate = newDate;
    mtg.startTime = newStart;
    mtg.endTime = newEnd;
    if (body.areaHint) mtg.areaHint = body.areaHint;
    if (body.encryptedMeetingPayload && body.payloadIv) {
      mtg.encryptedMeetingPayload = body.encryptedMeetingPayload;
      mtg.payloadIv = body.payloadIv;
    }

    mtg.isTimeTbd = false;
    mtg.scheduleChangeCount += 1;
    mtg.sequenceVersion += 1;
    mtg.updatedAt = new Date().toISOString();

    db.meetingScheduleChanges.push({
      id: `msc_${Date.now()}_${mtg.sequenceVersion}`,
      meetingId: mtg.id,
      changeType,
      postponementNumber,
      previousDate: prevDate,
      newDate,
      previousStartTime: prevStart,
      newStartTime: newStart,
      sequenceVersion: mtg.sequenceVersion,
      changeReasonPrivate: body.changeReason || null,
      reasonIsPrivate: body.reasonIsPrivate !== false,
      changedByUserId: currentUser.id,
      changedAt: new Date().toISOString(),
    });

    const attendees = db.meetingParticipants.filter(
      (mp) => mp.meetingId === mtg.id && mp.rsvpStatus === "ATTENDING"
    );

    const warning3xText =
      mtg.postponementCount >= 3
        ? " 이 약속은 여러 차례 날짜가 변경됐습니다. 참석 가능 여부를 다시 확인해 주세요."
        : "";

    for (const mp of attendees) {
      if (mp.userId !== currentUser.id) {
        mp.needsReconfirmAfterChange = true;
        mp.reconfirmResponse = null;

        db.notificationDeliveries.unshift({
          id: `nd_chg_${Date.now()}_${mp.userId}`,
          userId: mp.userId,
          meetingId: mtg.id,
          notificationType: "SCHEDULE_CHANGE_ALERT",
          channel: "INTERNAL_CALENDAR",
          messagePreview: `[일정 변경${
            changeType === "POSTPONED" ? ` · ${mtg.postponementCount}회 순연` : ""
          }] ${prevDate} → ${newDate} (${newStart}~${newEnd})으로 변경되었습니다.${warning3xText}`,
          lockScreenNeutralPreview:
            "팀약 일정의 날짜 또는 시간이 변경되었습니다. 앱에서 확인해 주세요.",
          scheduledAt: new Date().toISOString(),
          status: "SENT",
          attemptCount: 1,
          maxAttempts: 3,
          lastError: null,
          nextRetryAt: null,
          deliveredAt: new Date().toISOString(),
        });
      }

      const calConn = db.calendarConnections.find((c) => c.userId === mp.userId);
      if (calConn && calConn.externalEventMappings[mtg.id]) {
        calConn.externalEventMappings[mtg.id].sequenceVersion =
          mtg.sequenceVersion;
        calConn.externalEventMappings[mtg.id].syncStatus = "SYNCED";
      }
    }

    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      changeType,
      postponementCount: mtg.postponementCount,
      scheduleChangeCount: mtg.scheduleChangeCount,
      sequenceVersion: mtg.sequenceVersion,
      meeting: mtg,
      scheduleChanges: db.meetingScheduleChanges.filter(
        (sc) => sc.meetingId === mtg.id
      ),
    });
  }

  // ==========================================================================
  // 2. 호스트 전용 [참석자 전원 재확인 요청]
  // ==========================================================================
  if (action === "REQUEST_ALL_RECONFIRM") {
    if (mtg.createdBy !== currentUser.id) {
      return NextResponse.json(
        { error: "호스트만 참석자 전원 재확인을 요청할 수 있습니다." },
        { status: 403 }
      );
    }
    const targetParticipants = db.meetingParticipants.filter(
      (mp) =>
        mp.meetingId === mtg.id &&
        mp.userId !== currentUser.id &&
        mp.rsvpStatus !== "DECLINED"
    );
    for (const mp of targetParticipants) {
      mp.needsReconfirmAfterChange = true;
      mp.reconfirmResponse = null;
    }
    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      reconfirmRequestedCount: targetParticipants.length,
    });
  }

  // ==========================================================================
  // 3. 참석자의 변경된 날짜 재확인 응답 (RECONFIRM_SCHEDULE)
  // ==========================================================================
  if (action === "RECONFIRM_SCHEDULE") {
    const mp = db.meetingParticipants.find(
      (p) => p.meetingId === mtg.id && p.userId === currentUser.id
    );
    if (!mp) {
      return NextResponse.json(
        { error: "Participant not found" },
        { status: 404 }
      );
    }

    const choice: "CONFIRMED_NEW_DATE" | "TENTATIVE" | "DECLINED" =
      body.reconfirmResponse || "CONFIRMED_NEW_DATE";

    mp.reconfirmResponse = choice;
    mp.needsReconfirmAfterChange = false;
    if (choice === "CONFIRMED_NEW_DATE") {
      mp.rsvpStatus = "ATTENDING";
    } else if (choice === "TENTATIVE") {
      mp.rsvpStatus = "TENTATIVE";
    } else if (choice === "DECLINED") {
      mp.rsvpStatus = "DECLINED";
      const calConn = db.calendarConnections.find(
        (c) => c.userId === currentUser.id
      );
      if (calConn && calConn.externalEventMappings[mtg.id]) {
        calConn.externalEventMappings[mtg.id].syncStatus = "DELETED";
      }
    }

    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({ ok: true, participant: mp });
  }

  // ==========================================================================
  // 4. 음식·공간 취향 등록 및 보존 정책 (SAVE_PREFERENCE / WITHDRAW_PREFERENCE_CONSENT)
  // - 기본 보존 범위는 MEETING_ONLY
  // - 호스트가 입력한 조건(HOST_MEETING_CONDITION)은 장기 저장 원천 금지(무조건 MEETING_ONLY)
  // - 본인이 직접 등록한 취향(PARTICIPANT_SELF)만 별도 동의 시 최대 1년(consentExpiresAt) 저장
  // ==========================================================================
  if (action === "SAVE_PREFERENCE") {
    const gate = canUserAccessEncryptedMeetingPayload(
      db,
      currentUser.id,
      mtg.id
    );
    if (!gate.allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const inputSource: "HOST_MEETING_CONDITION" | "PARTICIPANT_SELF" =
      body.inputSource || "PARTICIPANT_SELF";

    // 호스트가 입력한 조건은 절대 장기 저장될 수 없음!
    const isSelfAndConsented =
      inputSource === "PARTICIPANT_SELF" &&
      Boolean(body.longTermStorageConsented);

    const now = new Date();
    const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    const existingIdx = db.meetingPreferences.findIndex(
      (p) =>
        p.meetingId === mtg.id &&
        p.userId === currentUser.id &&
        p.inputSource === inputSource
    );
    if (existingIdx !== -1) {
      db.meetingPreferences.splice(existingIdx, 1);
    }

    const newPref = {
      id: `pref_${Date.now()}_${currentUser.id}`,
      meetingId: mtg.id,
      userId: currentUser.id,
      inputSource,
      preferenceScope: (isSelfAndConsented
        ? "LONG_TERM_CONSENTED"
        : "MEETING_ONLY") as "MEETING_ONLY" | "LONG_TERM_CONSENTED",
      longTermStorageConsented: isSelfAndConsented,
      consentedAt: isSelfAndConsented ? now.toISOString() : null,
      consentExpiresAt: isSelfAndConsented
        ? body.customConsentExpiresAtForTest || oneYearLater.toISOString()
        : null,
      reconsentRequired: false,
      area: body.area || mtg.areaHint,
      headcount: Number(body.headcount || 5),
      meetingPurpose: body.meetingPurpose || "업무 오찬",
      preferredCuisines: body.preferredCuisines || ["한식"],
      dislikedItems: body.dislikedItems || [],
      spacePreferences: body.spacePreferences || [
        "조용한 공간 선호",
        "개별 룸 선호",
      ],
      otherConditions: body.otherConditions || [],
      excludePreviouslyVisited: Boolean(body.excludePreviouslyVisited),
      createdAt: now.toISOString(),
    };

    db.meetingPreferences.push(newPref);
    await writeDatabase(db);
    return NextResponse.json({ ok: true, preference: newPref });
  }

  // 동의 철회 시 취향 정보 즉시 삭제
  if (action === "WITHDRAW_PREFERENCE_CONSENT") {
    const beforeCount = db.meetingPreferences.length;
    db.meetingPreferences = db.meetingPreferences.filter(
      (p) => p.userId !== currentUser.id
    );
    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      deletedCount: beforeCount - db.meetingPreferences.length,
    });
  }

  // ==========================================================================
  // 5. AI 맞춤 식당·모임 장소 추천 실행 (RECOMMEND_PLACES)
  // - 서버는 개인 방문 장소 이력을 읽지 않으며 브라우저에서 복호화 후 로컬 제외 필터링 수행
  // ==========================================================================
  if (action === "RECOMMEND_PLACES") {
    const gate = canUserAccessEncryptedMeetingPayload(
      db,
      currentUser.id,
      mtg.id
    );
    if (!gate.allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = generateAiPlaceRecommendations(db, {
      meetingId: mtg.id,
      area: body.area || mtg.areaHint || "여의도",
      headcount: Number(
        body.headcount ||
          db.meetingParticipants.filter(
            (p) => p.meetingId === mtg.id && p.rsvpStatus === "ATTENDING"
          ).length ||
          5
      ),
      meetingPurpose: body.meetingPurpose || "업무 오찬",
      preferredCuisines: body.preferredCuisines || ["한식"],
      spacePreferences: body.spacePreferences || ["조용한 곳", "개별 룸"],
      otherConditions: body.otherConditions || ["주차 가능"],
    });

    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      apiMode: process.env.NAVER_CLIENT_ID
        ? "LIVE_NAVER_LOCAL_API"
        : "SIMULATION_NAVER_LOCAL_SANDBOX",
      bookingApiConnected: false,
      browserSideVisitedFilteringRequired: true,
      ...result,
    });
  }

  // ==========================================================================
  // 6. 호스트의 최종 모임 장소 확정 선택 (SELECT_PLACE)
  // ==========================================================================
  if (action === "SELECT_PLACE") {
    if (mtg.createdBy !== currentUser.id) {
      return NextResponse.json(
        { error: "호스트만 최종 장소를 확정할 수 있습니다." },
        { status: 403 }
      );
    }

    const place = db.places.find((p) => p.id === body.placeId);
    if (!place) {
      return NextResponse.json({ error: "Place not found" }, { status: 404 });
    }

    mtg.placeId = place.id;
    mtg.isPlaceTbd = false;
    mtg.areaHint = place.areaSummary;
    mtg.sequenceVersion += 1;
    mtg.updatedAt = new Date().toISOString();

    if (body.encryptedMeetingPayload && body.payloadIv) {
      mtg.encryptedMeetingPayload = body.encryptedMeetingPayload;
      mtg.payloadIv = body.payloadIv;
    }

    for (const rec of db.placeRecommendations) {
      if (rec.meetingId === mtg.id) {
        rec.selectedByHost = rec.placeId === place.id;
      }
    }

    for (const calConn of db.calendarConnections) {
      if (calConn.externalEventMappings[mtg.id]) {
        calConn.externalEventMappings[mtg.id].sequenceVersion =
          mtg.sequenceVersion;
      }
    }

    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      meeting: mtg,
      selectedPlace: place,
      bookingStatusNotice:
        "장소가 모임 상세 페이지에 반영되었습니다 (외부 예약 API가 연결되지 않았으므로 실제 식당 예약은 별도로 진행해야 하며 '예약 완료'로 표시하지 않습니다).",
    });
  }

  // ==========================================================================
  // 7. 부장급 이상 주요 참석자 암호화 수정 (UPSERT_SENIOR_ATTENDEE / WITHDRAW_SENIOR_ATTENDEE / UPDATE_ENCRYPTED_SENIOR_ATTENDEE)
  // - [Zero-Knowledge 보장] 서버는 복호화 키(fragmentKey)를 절대 보유하거나 수신하지 않습니다!
  // - 모든 복호화, 참석자 명단 수정, 재암호화는 클라이언트 브라우저(Web Crypto API)에서 수행되며,
  //   서버는 재암호화된 암호문(encryptedMeetingPayload, payloadIv)만을 전달받아 저장합니다.
  // - 알림은 중립적인 문구("주요 참석자 구성이 변경됐습니다")만 사용합니다.
  // ==========================================================================
  if (
    action === "UPSERT_SENIOR_ATTENDEE" ||
    action === "WITHDRAW_SENIOR_ATTENDEE" ||
    action === "UPDATE_ENCRYPTED_SENIOR_ATTENDEE"
  ) {
    const gate = canUserAccessEncryptedMeetingPayload(
      db,
      currentUser.id,
      mtg.id
    );
    if (!gate.allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 호스트 권한 확인: 모임 생성자 또는 호스트 대표자만 참석자 암호문 수정 가능
    const hostSide = db.meetingSides.find(
      (ms) => ms.meetingId === mtg.id && ms.sideType === "HOST"
    );
    if (
      hostSide?.representativeUserId !== currentUser.id &&
      mtg.createdBy !== currentUser.id
    ) {
      return NextResponse.json(
        { error: "호스트 대표자만 주요 참석자 구성을 변경할 수 있습니다." },
        { status: 403 }
      );
    }

    // [Zero-Knowledge 위반 차단] 클라이언트가 fragmentKey를 전송하려는 경우 단호히 거부!
    if (body.fragmentKey) {
      return NextResponse.json(
        {
          error: "ZERO_KNOWLEDGE_VIOLATION_BLOCKED",
          message:
            "보안 위반: 서버는 모임 복호화 키(fragmentKey)를 절대 수신하거나 처리하지 않습니다. 브라우저에서 직접 Web Crypto API로 재암호화한 암호문만 전송해야 합니다.",
        },
        { status: 400 }
      );
    }

    const { encryptedMeetingPayload, payloadIv } = body;
    if (!encryptedMeetingPayload || !payloadIv) {
      return NextResponse.json(
        {
          error: "INVALID_ENCRYPTED_PAYLOAD",
          message:
            "클라이언트에서 재암호화된 encryptedMeetingPayload 및 payloadIv가 필수입니다.",
        },
        { status: 400 }
      );
    }

    // 동시성 제어 (Optimistic Concurrency Control): sequenceVersion 불일치 시 충돌(409) 반환
    if (
      body.expectedSequenceVersion !== undefined &&
      body.expectedSequenceVersion !== mtg.sequenceVersion
    ) {
      return NextResponse.json(
        {
          error: "CONCURRENT_MODIFICATION_CONFLICT",
          currentSequenceVersion: mtg.sequenceVersion,
          message:
            "다른 기기에서 모임 정보가 이미 변경되었습니다. 최신 모임 암호문을 다시 불러온 후 수정해 주세요.",
        },
        { status: 409 }
      );
    }

    mtg.encryptedMeetingPayload = encryptedMeetingPayload;
    mtg.payloadIv = payloadIv;
    mtg.hasSeniorAttendee = Boolean(body.hasSeniorAttendee);
    mtg.seniorAttendeeChangedAt = new Date().toISOString();
    mtg.sequenceVersion += 1;
    mtg.updatedAt = new Date().toISOString();

    const targetUserId = body.targetUserId || body.userId || "u_exec_lee";

    // [보안 보완] 알림은 기본적으로 중립적인 문구를 사용하며, 이름·직급은 권한 확인 후 앱에서 복호화 표시!
    const neutralAlertText = `${mtg.hostOrgBadge} 오찬의 주요 참석자 구성이 변경됐습니다. 팀약에 접속해 확인해 주세요.`;

    const existingApprovedParticipants = db.meetingParticipants.filter(
      (p) =>
        p.meetingId === mtg.id &&
        p.isApproved &&
        p.rsvpStatus === "ATTENDING" &&
        p.userId !== targetUserId
    );

    for (const receiver of existingApprovedParticipants) {
      const pref = db.notificationPreferences.find(
        (np) => np.userId === receiver.userId
      );
      if (!pref || pref.notifyOnSeniorAttendeeChange !== false) {
        db.notificationDeliveries.unshift({
          id: `nd_sr_${Date.now()}_${receiver.userId}`,
          userId: receiver.userId,
          meetingId: mtg.id,
          notificationType: "SENIOR_ATTENDEE_CHANGE_ALERT",
          channel: "INTERNAL_CALENDAR",
          messagePreview: neutralAlertText,
          lockScreenNeutralPreview:
            "팀약 모임의 참석자 구성이 업데이트되었습니다. 앱에서 확인하세요.",
          scheduledAt: new Date().toISOString(),
          status: "SENT",
          attemptCount: 1,
          maxAttempts: 3,
          lastError: null,
          nextRetryAt: null,
          deliveredAt: new Date().toISOString(),
        });
      }

      const morningItem = db.notificationDeliveries.find(
        (nd) =>
          nd.userId === receiver.userId &&
          nd.meetingId === mtg.id &&
          nd.notificationType === "MORNING_8AM_BRIEFING"
      );
      if (morningItem) {
        morningItem.messagePreview = mtg.hasSeniorAttendee
          ? `오늘 오후 ${mtg.startTime || "12:00"} ${
              mtg.hostOrgBadge
            } 오찬이 있습니다. 주요 참석자가 포함된 자리입니다(앱에서 상세 확인).`
          : `오늘 오후 ${mtg.startTime || "12:00"} ${
              mtg.hostOrgBadge
            } 오찬이 있습니다.`;
        morningItem.lockScreenNeutralPreview = `오늘 오후 ${
          mtg.startTime || "12:00"
        } 팀약 일정이 있습니다.`;
      }
    }

    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      hasSeniorAttendee: mtg.hasSeniorAttendee,
      sequenceVersion: mtg.sequenceVersion,
      neutralAlertText,
      encryptedDetail: {
        encryptedMeetingPayload: mtg.encryptedMeetingPayload,
        payloadIv: mtg.payloadIv,
      },
    });
  }

  // ==========================================================================
  // 8. 기존 기능 유지: 양측 독립 공유 토글 / 전달 링크 승인 / 취소 / 완료
  // ==========================================================================
  if (action === "TOGGLE_VISIBILITY") {
    const { sideType } = body;
    const targetSide = db.meetingSides.find(
      (ms) => ms.meetingId === mtg.id && ms.sideType === sideType
    );
    if (!targetSide) {
      return NextResponse.json(
        { error: "Meeting side not found" },
        { status: 404 }
      );
    }

    if (targetSide.representativeUserId !== currentUser.id) {
      return NextResponse.json(
        {
          error: "FORBIDDEN_NOT_SIDE_REPRESENTATIVE",
          message: `해당 측(${sideType})의 대표자만 본인 소속 팀 공유 여부를 변경할 수 있습니다.`,
        },
        { status: 403 }
      );
    }

    let vis = db.meetingVisibilities.find(
      (mv) => mv.meetingSideId === targetSide.id
    );
    if (!vis) {
      vis = {
        id: `mv_${targetSide.id}`,
        meetingSideId: targetSide.id,
        teamId: targetSide.teamId,
        shareScope: "PRIVATE_PARTICIPANTS_ONLY",
        decidedBy: currentUser.id,
        updatedAt: new Date().toISOString(),
      };
      db.meetingVisibilities.push(vis);
    }

    vis.shareScope =
      vis.shareScope === "TEAM_SHARED"
        ? "PRIVATE_PARTICIPANTS_ONLY"
        : "TEAM_SHARED";
    vis.decidedBy = currentUser.id;
    vis.updatedAt = new Date().toISOString();

    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      visibility: vis,
      teamSharedSchedulesCount: db.teamSharedSchedules.filter(
        (t) => t.meetingId === mtg.id
      ).length,
    });
  }

  if (action === "APPROVE_PARTICIPANT") {
    const { participantId } = body;
    const hostSide = db.meetingSides.find(
      (ms) => ms.meetingId === mtg.id && ms.sideType === "HOST"
    );
    const guestSide = db.meetingSides.find(
      (ms) => ms.meetingId === mtg.id && ms.sideType === "GUEST"
    );
    const isRep =
      hostSide?.representativeUserId === currentUser.id ||
      guestSide?.representativeUserId === currentUser.id;
    if (!isRep) {
      return NextResponse.json(
        { error: "호스트 대표 또는 게스트 대표만 추가 참석자를 승인할 수 있습니다." },
        { status: 403 }
      );
    }

    const mp = db.meetingParticipants.find(
      (p) => p.id === participantId && p.meetingId === mtg.id
    );
    if (!mp) {
      return NextResponse.json(
        { error: "Participant not found" },
        { status: 404 }
      );
    }
    mp.isApproved = true;
    mp.rsvpStatus = "ATTENDING";
    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({ ok: true, participant: mp });
  }

  if (action === "TOGGLE_CANCEL") {
    if (mtg.createdBy !== currentUser.id) {
      return NextResponse.json(
        { error: "호스트만 모임을 취소할 수 있습니다." },
        { status: 403 }
      );
    }
    mtg.status = mtg.status === "CANCELED" ? "CONFIRMED" : "CANCELED";
    mtg.sequenceVersion += 1;
    mtg.updatedAt = new Date().toISOString();

    if (mtg.status === "CANCELED") {
      for (const calConn of db.calendarConnections) {
        if (calConn.externalEventMappings[mtg.id]) {
          calConn.externalEventMappings[mtg.id].syncStatus = "DELETED";
          calConn.externalEventMappings[mtg.id].sequenceVersion =
            mtg.sequenceVersion;
        }
      }
    }

    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({ ok: true, meeting: mtg });
  }

  if (action === "COMPLETE_MEETING") {
    const now = new Date();
    const purgeDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const hardPurgeDate = new Date(now.getTime() + 37 * 24 * 60 * 60 * 1000);
    mtg.status = "COMPLETED";
    mtg.completedAt = now.toISOString();
    mtg.purgeAfterAt = purgeDate.toISOString();
    mtg.hardPurgeAfterAt = hardPurgeDate.toISOString();
    mtg.updatedAt = now.toISOString();
    syncTeamSharedProjections(db, mtg.id);
    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      meeting: mtg,
      retentionPolicy: {
        standardRetentionDays: 30,
        unbackedHardCapDays: 37,
        completedAt: mtg.completedAt,
        purgeAfterAt: mtg.purgeAfterAt,
        hardPurgeAfterAt: mtg.hardPurgeAfterAt,
      },
    });
  }

  if (action === "DELETE_MEETING") {
    const meetingId = params.id;
    const sideIds = db.meetingSides
      .filter((ms) => ms.meetingId === meetingId)
      .map((ms) => ms.id);

    db.meetings = db.meetings.filter((m) => m.id !== meetingId);
    db.meetingSides = db.meetingSides.filter((ms) => ms.meetingId !== meetingId);
    db.meetingVisibilities = db.meetingVisibilities.filter(
      (mv) => !sideIds.includes(mv.meetingSideId)
    );
    db.teamSharedSchedules = db.teamSharedSchedules.filter(
      (ts) => ts.meetingId !== meetingId
    );
    db.meetingParticipants = db.meetingParticipants.filter(
      (mp) => mp.meetingId !== meetingId
    );
    db.meetingInvitations = db.meetingInvitations.filter(
      (mi) => mi.meetingId !== meetingId
    );
    db.meetingPreferences = db.meetingPreferences.filter(
      (mp) => mp.meetingId !== meetingId
    );
    db.placeRecommendations = db.placeRecommendations.filter(
      (pr) => pr.meetingId !== meetingId
    );
    db.meetingScheduleChanges = db.meetingScheduleChanges.filter(
      (sc) => sc.meetingId !== meetingId
    );

    for (const calConn of db.calendarConnections) {
      if (calConn.externalEventMappings && calConn.externalEventMappings[meetingId]) {
        delete calConn.externalEventMappings[meetingId];
      }
    }

    await writeDatabase(db);
    return NextResponse.json({ ok: true, deletedMeetingId: meetingId });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  const mtg = db.meetings.find((m) => m.id === params.id);
  if (!mtg) {
    return NextResponse.json({
      ok: true,
      message: "이미 삭제되었거나 존재하지 않는 약속입니다.",
    });
  }

  const meetingId = params.id;
  const sideIds = db.meetingSides
    .filter((ms) => ms.meetingId === meetingId)
    .map((ms) => ms.id);

  db.meetings = db.meetings.filter((m) => m.id !== meetingId);
  db.meetingSides = db.meetingSides.filter((ms) => ms.meetingId !== meetingId);
  db.meetingVisibilities = db.meetingVisibilities.filter(
    (mv) => !sideIds.includes(mv.meetingSideId)
  );
  db.teamSharedSchedules = db.teamSharedSchedules.filter(
    (ts) => ts.meetingId !== meetingId
  );
  db.meetingParticipants = db.meetingParticipants.filter(
    (mp) => mp.meetingId !== meetingId
  );
  db.meetingInvitations = db.meetingInvitations.filter(
    (mi) => mi.meetingId !== meetingId
  );
  db.meetingPreferences = db.meetingPreferences.filter(
    (mp) => mp.meetingId !== meetingId
  );
  db.placeRecommendations = db.placeRecommendations.filter(
    (pr) => pr.meetingId !== meetingId
  );
  db.meetingScheduleChanges = db.meetingScheduleChanges.filter(
    (sc) => sc.meetingId !== meetingId
  );

  for (const calConn of db.calendarConnections) {
    if (calConn.externalEventMappings && calConn.externalEventMappings[meetingId]) {
      delete calConn.externalEventMappings[meetingId];
    }
  }

  await writeDatabase(db);
  return NextResponse.json({ ok: true, deletedMeetingId: meetingId });
}
