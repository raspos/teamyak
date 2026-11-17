import { NextRequest, NextResponse } from "next/server";
import {
  readDatabase,
  writeDatabase,
  resolveUserFromRequest,
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

  const requestedOwnerId = req.nextUrl.searchParams.get("ownerUserId");
  if (requestedOwnerId && requestedOwnerId !== currentUser.id) {
    return NextResponse.json(
      {
        error: "FORBIDDEN_CROSS_USER_HISTORY_ACCESS",
        message: "개인 미팅 이력은 소유자 본인 외에는 조회할 수 없습니다.",
      },
      { status: 403 }
    );
  }

  const histories = db.personalMeetingHistories.filter(
    (h) => h.ownerUserId === currentUser.id
  );

  return NextResponse.json({
    ownerUserId: currentUser.id,
    histories,
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
    historyId,
    meetingId = null,
    meetingDate = "2026-11-19",
    attendanceVerified = true,
    encryptedHistoryBlob,
    blobIv,
  } = body;

  if (!encryptedHistoryBlob || !blobIv) {
    return NextResponse.json(
      { error: "encryptedHistoryBlob and blobIv are required" },
      { status: 400 }
    );
  }

  let record = historyId
    ? db.personalMeetingHistories.find(
        (h) => h.id === historyId && h.ownerUserId === currentUser.id
      )
    : undefined;

  if (record) {
    const wasLegacy = Boolean(
      (record as any).legacyVisitedPlaceId || (record as any).visitedPlaceId
    );
    record.encryptedHistoryBlob = encryptedHistoryBlob;
    record.blobIv = blobIv;
    if (attendanceVerified !== undefined) {
      record.attendanceVerified = Boolean(attendanceVerified);
    }
    if ((record as any).legacyVisitedPlaceId) {
      delete (record as any).legacyVisitedPlaceId;
    }
    if ((record as any).visitedPlaceId) {
      delete (record as any).visitedPlaceId;
    }
    record.updatedAt = new Date().toISOString();

    if (wasLegacy) {
      db.auditRetentionLogs.push({
        id: `audit_mig_${Date.now()}_${record.id}`,
        action: "LEGACY_PLAINTEXT_PURGED_AFTER_CLIENT_REENCRYPTION",
        meetingId: record.meetingId || "NONE",
        executedAt: new Date().toISOString(),
        detail: `개인 이력(${record.id})의 구버전 평문 방문장소 정보가 클라이언트 암호화 블롭으로 안전하게 편입되어 서버 평문 필드가 완전 소거되었습니다.`,
      });
    }
  } else {
    record = {
      id: `pmh_${Date.now()}_${currentUser.id}`,
      ownerUserId: currentUser.id,
      meetingId,
      meetingDate,
      attendanceVerified: Boolean(attendanceVerified),
      encryptedHistoryBlob,
      blobIv,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.personalMeetingHistories.unshift(record);
  }

  if (meetingId) {
    const mp = db.meetingParticipants.find(
      (p) => p.meetingId === meetingId && p.userId === currentUser.id
    );
    if (mp) {
      mp.historyBackupVerified = true;
    }
  }

  await writeDatabase(db);
  return NextResponse.json({ ok: true, history: record });
}

export async function DELETE(req: NextRequest) {
  const db = await readDatabase();
  const authHeader = req.headers.get("authorization");
  const cookieToken =
    req.cookies.get("teamyak_session")?.value ||
    req.cookies.get("teamyak_uid")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  if (!currentUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("id");
  const idx = db.personalMeetingHistories.findIndex(
    (h) => h.id === id && h.ownerUserId === currentUser.id
  );
  if (idx === -1) {
    return NextResponse.json(
      { error: "History not found or forbidden" },
      { status: 404 }
    );
  }

  db.personalMeetingHistories.splice(idx, 1);
  await writeDatabase(db);
  return NextResponse.json({ ok: true, deletedId: id });
}
