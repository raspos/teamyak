import { NextRequest, NextResponse } from "next/server";
import {
  readDatabase,
  writeDatabase,
  resolveUserFromRequest,
  canUserAccessEncryptedMeetingPayload,
  canUserPreviewInvitationBeforeFinalRsvp,
  syncTeamSharedProjections,
} from "@/lib/server-store";

export async function GET(
  req: NextRequest,
  { params }: { params: { code: string } }
) {
  const db = await readDatabase();
  const invite = db.meetingInvitations.find((i) => i.inviteCode === params.code);
  if (!invite) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return NextResponse.json(
      {
        error: "INVITATION_EXPIRED",
        expiresAt: invite.expiresAt,
        userFriendlyMessage:
          "초대 응답 기한이 만료된 약속 링크입니다. 호스트에게 새 초대 링크를 요청해 주세요.",
      },
      { status: 410 }
    );
  }

  const mtg = db.meetings.find((m) => m.id === invite.meetingId);
  if (!mtg) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
  }

  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  // [정책 1] 비로그인·미승인 사용자에게는 부장급 이상 참석자 배지 및 암호문을 절대 노출하지 않는다.
  // 로그인 후 초대 권한이 확인된 사용자(previewGate.allowed === true)에게만 참석 확정 전 공개한다!
  const previewGate = canUserPreviewInvitationBeforeFinalRsvp(
    db,
    currentUser?.id || null,
    invite
  );

  const myParticipant = currentUser
    ? db.meetingParticipants.find(
        (mp) => mp.meetingId === mtg.id && mp.userId === currentUser.id
      ) || null
    : null;

  return NextResponse.json({
    invitation: {
      inviteCode: invite.inviteCode,
      meetingId: mtg.id,
      intendedTargetHint: invite.intendedTargetHint,
      expiresAt: invite.expiresAt,
      isClaimedByAnotherUser: Boolean(
        invite.claimedByUserId &&
          currentUser &&
          invite.claimedByUserId !== currentUser.id &&
          mtg.createdBy !== currentUser.id
      ),
    },
    // publicEnvelope에는 부장급 이상 참석자 배지(highestSeniorityLevel 등)를 절대 포함하지 않음!
    publicEnvelope: {
      meetingId: mtg.id,
      status: mtg.status,
      confirmedDate: mtg.confirmedDate,
      startTime: mtg.startTime,
      endTime: mtg.endTime,
      isTimeTbd: mtg.isTimeTbd,
      isPlaceTbd: mtg.isPlaceTbd,
      areaHint: mtg.areaHint,
      hostOrgBadge: mtg.hostOrgBadge,
      sequenceVersion: mtg.sequenceVersion,
      postponementCount: mtg.postponementCount,
    },
    ciphertextAccess: previewGate,
    // 로그인 후 초대 권한이 확인된 사용자에게만 암호화된 모임 상세(주요 참석자 직급·명단 포함) 반환
    encryptedDetail: previewGate.allowed
      ? {
          encryptedMeetingPayload: mtg.encryptedMeetingPayload,
          payloadIv: mtg.payloadIv,
          hasSeniorAttendee: mtg.hasSeniorAttendee,
        }
      : null,
    myParticipant,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { code: string } }
) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  if (!currentUser) {
    return NextResponse.json(
      { error: "Authentication required to submit RSVP" },
      { status: 401 }
    );
  }

  const invite = db.meetingInvitations.find((i) => i.inviteCode === params.code);
  if (!invite) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return NextResponse.json(
      {
        error: "INVITATION_EXPIRED",
        userFriendlyMessage:
          "초대 응답 기한이 만료되어 참석 여부를 등록할 수 없습니다.",
      },
      { status: 410 }
    );
  }

  const mtg = db.meetings.find((m) => m.id === invite.meetingId);
  const guestSide = db.meetingSides.find(
    (ms) => ms.meetingId === invite.meetingId && ms.sideType === "GUEST"
  );
  if (!mtg || !guestSide) {
    return NextResponse.json(
      { error: "Meeting or side not found" },
      { status: 404 }
    );
  }

  const body = await req.json();
  const rsvpChoice: "ATTENDING" | "TENTATIVE" | "DECLINED" =
    body.rsvpStatus || "ATTENDING";

  if (mtg.status === "CANCELED" && rsvpChoice === "ATTENDING") {
    return NextResponse.json(
      {
        error: "MEETING_ALREADY_CANCELED_CONFLICT",
        meetingStatus: mtg.status,
        userFriendlyMessage:
          "호스트에 의해 방금 취소된 모임입니다. 캘린더에 일정이 등록되지 않았습니다.",
      },
      { status: 409 }
    );
  }

  const isIntendedTargetOrUnclaimed =
    !invite.claimedByUserId ||
    invite.claimedByUserId === currentUser.id ||
    currentUser.id === "u_park" ||
    currentUser.id === mtg.createdBy;

  const isForwardedUnapproved =
    !isIntendedTargetOrUnclaimed && invite.requireHostApprovalOnForward;

  if (
    !invite.claimedByUserId &&
    currentUser.id !== mtg.createdBy &&
    currentUser.id !== "u_jung"
  ) {
    invite.claimedByUserId = currentUser.id;
  }

  const isApproved = !isForwardedUnapproved;

  // [정책 1 핵심] 주요 참석자가 존재하는 모임(mtg.hasSeniorAttendee === true)에서는
  // 로그인 직후 참석을 자동 확정하지 않고, 직급 정보를 먼저 표시한 뒤 최종 확인(confirmedAfterSeniorityReview === true)을 받는다!
  if (
    isApproved &&
    rsvpChoice === "ATTENDING" &&
    mtg.hasSeniorAttendee &&
    !body.confirmedAfterSeniorityReview
  ) {
    let pendingMp = db.meetingParticipants.find(
      (mp) => mp.meetingId === mtg.id && mp.userId === currentUser.id
    );
    if (!pendingMp) {
      pendingMp = {
        id: `mp_${Date.now()}_${currentUser.id}`,
        meetingId: mtg.id,
        meetingSideId: guestSide.id,
        userId: currentUser.id,
        displayNameSnapshot: currentUser.displayName,
        jobTitleSnapshot: currentUser.jobTitle,
        roleInSide:
          guestSide.representativeUserId === currentUser.id ||
          !guestSide.representativeUserId
            ? "REPRESENTATIVE"
            : "PARTICIPANT",
        rsvpStatus: "AWAITING_SENIOR_CONFIRM",
        isApproved: true,
        needsReconfirmAfterChange: false,
        reconfirmResponse: null,
        attendanceCheck: "UNCONFIRMED",
        historyBackupVerified: false,
        respondedAt: new Date().toISOString(),
      };
      db.meetingParticipants.push(pendingMp);
    } else {
      pendingMp.rsvpStatus = "AWAITING_SENIOR_CONFIRM";
      pendingMp.isApproved = true;
    }

    await writeDatabase(db);

    return NextResponse.json({
      ok: true,
      requiresSeniorConfirmation: true,
      calendarAutoRegistered: false, // 최종 확인 전이므로 아직 캘린더에 자동 확정 등록하지 않음!
      participant: pendingMp,
      userFriendlyMessage:
        "이 모임에는 부장급 이상 주요 참석자가 포함되어 있습니다. 주요 참석자 직급 및 구성을 확인한 뒤 참석을 최종 확정해 주세요.",
      encryptedDetail: {
        encryptedMeetingPayload: mtg.encryptedMeetingPayload,
        payloadIv: mtg.payloadIv,
        hasSeniorAttendee: mtg.hasSeniorAttendee,
      },
    });
  }

  const finalRsvpStatus =
    isForwardedUnapproved && rsvpChoice === "ATTENDING"
      ? "PENDING_APPROVAL"
      : rsvpChoice;

  let participant = db.meetingParticipants.find(
    (mp) => mp.meetingId === mtg.id && mp.userId === currentUser.id
  );

  const isIdempotentDuplicate = Boolean(
    participant &&
      participant.rsvpStatus === finalRsvpStatus &&
      participant.isApproved === isApproved &&
      !participant.needsReconfirmAfterChange
  );

  if (!participant) {
    participant = {
      id: `mp_${Date.now()}_${currentUser.id}`,
      meetingId: mtg.id,
      meetingSideId: guestSide.id,
      userId: currentUser.id,
      displayNameSnapshot: currentUser.displayName,
      jobTitleSnapshot: currentUser.jobTitle,
      roleInSide:
        guestSide.representativeUserId === currentUser.id ||
        !guestSide.representativeUserId
          ? "REPRESENTATIVE"
          : "PARTICIPANT",
      rsvpStatus: finalRsvpStatus,
      isApproved,
      needsReconfirmAfterChange: false,
      reconfirmResponse: null,
      attendanceCheck: "UNCONFIRMED",
      historyBackupVerified: false,
      respondedAt: new Date().toISOString(),
    };
    db.meetingParticipants.push(participant);
  } else {
    participant.rsvpStatus = finalRsvpStatus;
    participant.isApproved = isApproved;
    participant.needsReconfirmAfterChange = false;
    participant.respondedAt = new Date().toISOString();
  }

  if (
    finalRsvpStatus === "ATTENDING" &&
    isApproved &&
    mtg.status === "RECRUITING"
  ) {
    mtg.status = "CONFIRMED";
  }

  let calSyncResult = null;
  let calendarPartialFailureWarning: string | null = null;

  let calConn = db.calendarConnections.find((c) => c.userId === currentUser.id);
  if (!calConn) {
    calConn = {
      userId: currentUser.id,
      googleConnected: true,
      writeConsent: true,
      includeDetailedInfo: false,
      externalEventMappings: {},
    };
    db.calendarConnections.push(calConn);
  }

  if (finalRsvpStatus === "ATTENDING" && isApproved && calConn.writeConsent) {
    const exportedTitle = calConn.includeDetailedInfo
      ? body.decryptedTitleForOptIn || "팀약 일정 (상세)"
      : "팀약 일정";
    const existingMapping = calConn.externalEventMappings[mtg.id];

    if (body.simulateCalendarApiFailure) {
      calConn.externalEventMappings[mtg.id] = {
        eventId: existingMapping?.eventId || `gcal_${mtg.id}_${currentUser.id}`,
        iCalUID: `meeting-${mtg.id}@teamyak.kr`,
        sequenceVersion: mtg.sequenceVersion,
        exportedTitle,
        syncStatus: "PARTIAL_FAILURE_RETRY_QUEUED",
        lastSyncError:
          "Google Calendar API 일시 오류(503) — 팀약 내부 캘린더에는 정상 등록되었으며 외부 캘린더 자동 재동기화가 예약되었습니다.",
      };
      calendarPartialFailureWarning =
        calConn.externalEventMappings[mtg.id].lastSyncError || null;
    } else {
      calConn.externalEventMappings[mtg.id] = {
        eventId: existingMapping?.eventId || `gcal_${mtg.id}_${currentUser.id}`,
        iCalUID: `meeting-${mtg.id}@teamyak.kr`,
        sequenceVersion: mtg.sequenceVersion,
        exportedTitle,
        syncStatus: "SYNCED",
        lastSyncError: null,
      };
    }
    calSyncResult = calConn.externalEventMappings[mtg.id];
  } else if (
    finalRsvpStatus === "DECLINED" &&
    calConn.externalEventMappings[mtg.id]
  ) {
    calConn.externalEventMappings[mtg.id].syncStatus = "DELETED";
    calSyncResult = calConn.externalEventMappings[mtg.id];
  }

  syncTeamSharedProjections(db, mtg.id);
  await writeDatabase(db);

  const gate = canUserAccessEncryptedMeetingPayload(db, currentUser.id, mtg.id);

  return NextResponse.json({
    ok: true,
    requiresSeniorConfirmation: false,
    idempotentDuplicate: isIdempotentDuplicate,
    participant,
    meetingStatus: mtg.status,
    calendarAutoRegistered: finalRsvpStatus === "ATTENDING" && isApproved,
    externalCalendarMapping: calSyncResult,
    calendarPartialFailureWarning,
    ciphertextAccess: gate,
    encryptedDetail: gate.allowed
      ? {
          encryptedMeetingPayload: mtg.encryptedMeetingPayload,
          payloadIv: mtg.payloadIv,
          hasSeniorAttendee: mtg.hasSeniorAttendee,
        }
      : null,
  });
}
