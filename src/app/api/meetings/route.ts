import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  readDatabase,
  writeDatabase,
  resolveUserFromRequest,
  canUserAccessEncryptedMeetingPayload,
  syncTeamSharedProjections,
} from "@/lib/server-store";

export async function GET(req: NextRequest) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  if (!currentUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const myDirectMeetings = db.meetings
    .filter((m) =>
      canUserAccessEncryptedMeetingPayload(db, currentUser.id, m.id).allowed
    )
    .map((m) => {
      const sides = db.meetingSides.filter((ms) => ms.meetingId === m.id);
      const visibilities = db.meetingVisibilities.filter((mv) =>
        sides.some((s) => s.id === mv.meetingSideId)
      );
      const participants = db.meetingParticipants.filter(
        (mp) => mp.meetingId === m.id
      );
      const invite = db.meetingInvitations.find((i) => i.meetingId === m.id);
      // [보안 보완 6] 다른 이용자의 음식 취향은 조회되지 않도록 오직 본인(userId === currentUser.id) 취향만 반환!
      const preferences = db.meetingPreferences.filter(
        (p) => p.meetingId === m.id && p.userId === currentUser.id
      );
      const recommendations = db.placeRecommendations.filter(
        (r) => r.meetingId === m.id
      );
      const scheduleChanges = db.meetingScheduleChanges.filter(
        (sc) => sc.meetingId === m.id
      );
      const selectedPlace = m.placeId
        ? db.places.find((p) => p.id === m.placeId) || null
        : null;

      return {
        ...m,
        sides,
        visibilities,
        participants,
        preferences,
        recommendations,
        scheduleChanges,
        selectedPlace,
        inviteCode: invite?.inviteCode || null,
      };
    });

  const activeTeamIds = db.teamMemberships
    .filter((tm) => tm.userId === currentUser.id && tm.status === "ACTIVE")
    .map((tm) => tm.teamId);

  const myTeamSharedSchedules = db.teamSharedSchedules.filter((tss) =>
    activeTeamIds.includes(tss.teamId)
  );

  const calendarConnection =
    db.calendarConnections.find((c) => c.userId === currentUser.id) || {
      userId: currentUser.id,
      googleConnected: true,
      writeConsent: true,
      includeDetailedInfo: false,
      externalEventMappings: {},
    };

  return NextResponse.json({
    directMeetings: myDirectMeetings,
    teamSharedSchedules: myTeamSharedSchedules,
    calendarConnection,
    placesCatalog: db.places,
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
  const {
    confirmedDate = "2026-11-19",
    startTime = "12:00",
    endTime = "13:30",
    isTimeTbd = false,
    isPlaceTbd = true,
    placeId = null,
    areaHint = "여의도",
    hostOrgBadge = "삼성생명 홍보팀",
    guestSideLabel = "중앙일보 금융팀",
    intendedTargetHint = "중앙일보 박서연 기자",
    encryptedMeetingPayload,
    payloadIv,
    seedFragmentKeyForTest,
    hostShareToTeam = false,
    hasSeniorAttendee = false,
  } = body;

  if (!encryptedMeetingPayload || !payloadIv) {
    return NextResponse.json(
      {
        error:
          "encryptedMeetingPayload and payloadIv are required for Hybrid Encryption",
      },
      { status: 400 }
    );
  }

  const meetingId = `mtg_${Date.now()}`;
  const hostSideId = `ms_${meetingId}_host`;
  const guestSideId = `ms_${meetingId}_guest`;
  const inviteCode = `inv_${Math.random().toString(36).substring(2, 8)}`;

  const newMeeting = {
    id: meetingId,
    status: (isTimeTbd ? "SCHEDULING" : "CONFIRMED") as
      | "SCHEDULING"
      | "RECRUITING"
      | "CONFIRMED",
    confirmedDate,
    initialConfirmedDate: confirmedDate,
    candidateDates: [confirmedDate],
    startTime: isTimeTbd ? null : startTime,
    endTime: isTimeTbd ? null : endTime,
    isTimeTbd: Boolean(isTimeTbd),
    isPlaceTbd: Boolean(isPlaceTbd && !placeId),
    placeId: placeId || null,
    areaHint,
    hostOrgBadge,
    sequenceVersion: 1,
    postponementCount: 0,
    scheduleChangeCount: 0,
    hasSeniorAttendee: Boolean(hasSeniorAttendee),
    seniorAttendeeChangedAt: null,
    encryptedMeetingPayload,
    payloadIv,
    seedFragmentKeyForTest,
    completedAt: null,
    purgeAfterAt: null,
    hardPurgeAfterAt: null,
    graceReminderSent: false,
    graphPurged: false,
    createdBy: currentUser.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.meetings.unshift(newMeeting);

  db.meetingSides.push(
    {
      id: hostSideId,
      meetingId,
      sideType: "HOST",
      organizationId: currentUser.organizationId || "org_samsung_life",
      teamId: currentUser.teamId || "team_samsung_pr",
      representativeUserId: currentUser.id,
      sideLabel: hostOrgBadge,
    },
    {
      id: guestSideId,
      meetingId,
      sideType: "GUEST",
      organizationId: "org_joongang",
      teamId: "team_joongang_fin",
      representativeUserId: "u_park",
      sideLabel: guestSideLabel,
    }
  );

  db.meetingVisibilities.push(
    {
      id: `mv_${hostSideId}`,
      meetingSideId: hostSideId,
      teamId: currentUser.teamId || "team_samsung_pr",
      shareScope: hostShareToTeam
        ? "TEAM_SHARED"
        : "PRIVATE_PARTICIPANTS_ONLY",
      decidedBy: currentUser.id,
      updatedAt: new Date().toISOString(),
    },
    {
      id: `mv_${guestSideId}`,
      meetingSideId: guestSideId,
      teamId: "team_joongang_fin",
      shareScope: "PRIVATE_PARTICIPANTS_ONLY",
      decidedBy: "u_park",
      updatedAt: new Date().toISOString(),
    }
  );

  db.meetingParticipants.push({
    id: `mp_${Date.now()}_${currentUser.id}`,
    meetingId,
    meetingSideId: hostSideId,
    userId: currentUser.id,
    displayNameSnapshot: currentUser.displayName,
    jobTitleSnapshot: currentUser.jobTitle,
    roleInSide: "REPRESENTATIVE",
    rsvpStatus: "ATTENDING",
    isApproved: true,
    needsReconfirmAfterChange: false,
    reconfirmResponse: null,
    attendanceCheck: "UNCONFIRMED",
    historyBackupVerified: false,
    respondedAt: new Date().toISOString(),
  });

  db.meetingScheduleChanges.push({
    id: `msc_init_${meetingId}`,
    meetingId,
    changeType: "INITIAL_CONFIRM",
    postponementNumber: 0,
    previousDate: null,
    newDate: confirmedDate,
    previousStartTime: null,
    newStartTime: isTimeTbd ? null : startTime,
    sequenceVersion: 1,
    changeReasonPrivate: "최초 일정 생성 및 확정",
    reasonIsPrivate: true,
    changedByUserId: currentUser.id,
    changedAt: new Date().toISOString(),
  });

  db.meetingInvitations.push({
    id: `inv_${Date.now()}`,
    meetingId,
    meetingSideId: guestSideId,
    inviteCode,
    tokenHash: crypto.createHash("sha256").update(inviteCode).digest("hex"),
    intendedTargetHint,
    claimedByUserId: null,
    requireHostApprovalOnForward: true,
    expiresAt: body.expiresAt || "2026-12-31T23:59:59Z",
    createdBy: currentUser.id,
  });

  syncTeamSharedProjections(db, meetingId);
  await writeDatabase(db);

  return NextResponse.json({
    ok: true,
    meeting: newMeeting,
    inviteCode,
  });
}
