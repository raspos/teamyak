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

  const preference =
    db.notificationPreferences.find((np) => np.userId === currentUser.id) || {
      userId: currentUser.id,
      morningBriefingEnabled: true,
      morningBriefingTime: "08:00",
      notifyOnScheduleChange: true,
      notifyOnSeniorAttendeeChange: true,
    };

  const calendarConnection =
    db.calendarConnections.find((c) => c.userId === currentUser.id) || {
      userId: currentUser.id,
      googleConnected: true,
      writeConsent: true,
      includeDetailedInfo: false,
      externalEventMappings: {},
    };

  const deliveries = db.notificationDeliveries.filter(
    (nd) => nd.userId === currentUser.id
  );

  return NextResponse.json({
    preference,
    calendarConnection,
    deliveries,
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
  const { action } = body;

  if (action === "UPDATE_PREFERENCES") {
    let pref = db.notificationPreferences.find(
      (np) => np.userId === currentUser.id
    );
    if (!pref) {
      pref = {
        userId: currentUser.id,
        morningBriefingEnabled: true,
        morningBriefingTime: "08:00",
        notifyOnScheduleChange: true,
        notifyOnSeniorAttendeeChange: true,
      };
      db.notificationPreferences.push(pref);
    }
    if (body.morningBriefingTime) {
      pref.morningBriefingTime = body.morningBriefingTime;
    }
    if (body.morningBriefingEnabled !== undefined) {
      pref.morningBriefingEnabled = Boolean(body.morningBriefingEnabled);
    }
    if (body.notifyOnSeniorAttendeeChange !== undefined) {
      pref.notifyOnSeniorAttendeeChange = Boolean(
        body.notifyOnSeniorAttendeeChange
      );
    }

    let cal = db.calendarConnections.find((c) => c.userId === currentUser.id);
    if (!cal) {
      cal = {
        userId: currentUser.id,
        googleConnected: true,
        writeConsent: true,
        includeDetailedInfo: false,
        externalEventMappings: {},
      };
      db.calendarConnections.push(cal);
    }
    if (body.includeDetailedInfo !== undefined) {
      cal.includeDetailedInfo = Boolean(body.includeDetailedInfo);
      for (const mtgId of Object.keys(cal.externalEventMappings)) {
        cal.externalEventMappings[mtgId].exportedTitle = cal.includeDetailedInfo
          ? body.detailedTitleHint || "팀약 일정 (상세 포함)"
          : "팀약 일정";
      }
    }

    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      preference: pref,
      calendarConnection: cal,
    });
  }

  if (action === "RETRY_DELIVERY") {
    const { deliveryId } = body;
    const item = db.notificationDeliveries.find(
      (nd) => nd.id === deliveryId && nd.userId === currentUser.id
    );
    if (!item) {
      return NextResponse.json(
        { error: "Delivery item not found" },
        { status: 404 }
      );
    }
    item.attemptCount += 1;
    item.status = "SENT";
    item.lastError = null;
    item.nextRetryAt = null;
    item.deliveredAt = new Date().toISOString();
    await writeDatabase(db);
    return NextResponse.json({ ok: true, delivery: item });
  }

  if (action === "RETRY_CALENDAR_SYNC") {
    const { meetingId } = body;
    const cal = db.calendarConnections.find((c) => c.userId === currentUser.id);
    if (cal && cal.externalEventMappings[meetingId]) {
      cal.externalEventMappings[meetingId].syncStatus = "SYNCED";
      cal.externalEventMappings[meetingId].lastSyncError = null;
      await writeDatabase(db);
      return NextResponse.json({
        ok: true,
        mapping: cal.externalEventMappings[meetingId],
      });
    }
    return NextResponse.json({ error: "Mapping not found" }, { status: 404 });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
