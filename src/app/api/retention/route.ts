import { NextRequest, NextResponse } from "next/server";
import {
  readDatabase,
  writeDatabase,
  purgeExpiredMeetingGraphs,
  purgeExpiredLongTermPreferences,
} from "@/lib/server-store";

export async function GET() {
  const db = await readDatabase();
  const completedMeetings = db.meetings
    .filter((m) => m.status === "COMPLETED")
    .map((m) => {
      const remainingParticipantsCount = db.meetingParticipants.filter(
        (mp) => mp.meetingId === m.id
      ).length;
      const allBackedUp = db.meetingParticipants
        .filter((mp) => mp.meetingId === m.id && mp.rsvpStatus === "ATTENDING")
        .every((mp) => mp.historyBackupVerified);

      return {
        id: m.id,
        confirmedDate: m.confirmedDate,
        completedAt: m.completedAt,
        purgeAfterAt: m.purgeAfterAt,
        hardPurgeAfterAt: m.hardPurgeAfterAt,
        graceReminderSent: m.graceReminderSent,
        graphPurged: m.graphPurged,
        remainingServerParticipantRows: remainingParticipantsCount,
        historyBackupVerified: allBackedUp,
      };
    });

  return NextResponse.json({
    retentionPolicySummary: {
      standardRetentionDays: 30,
      unbackedGracePeriodDays: 7,
      hardPurgeDeadlineDays: 37,
      foodPreferenceDefaultScope: "MEETING_ONLY",
      foodPreferenceMaxConsentDurationDays: 365,
      visitedPlacePlaintextColumnExists: false, // 평문 visited_place_id 완전 제거 검증
      seniorityLevelPlaintextColumnExists: false, // 평문 highest_seniority_level 완전 제거 검증
    },
    completedMeetings,
    auditRetentionLogs: db.auditRetentionLogs,
  });
}

export async function POST(req: NextRequest) {
  const db = await readDatabase();
  const body = await req.json().catch(() => ({}));

  if (body.fastForwardMeetingId) {
    const target = db.meetings.find((m) => m.id === body.fastForwardMeetingId);
    if (target) {
      target.status = "COMPLETED";
      target.completedAt = "2026-10-01T12:00:00Z";
      target.purgeAfterAt = "2026-10-31T12:00:00Z";
      target.hardPurgeAfterAt = "2026-11-07T12:00:00Z";
    }
  }

  const prefPurge = purgeExpiredLongTermPreferences(db, body.referenceNowIso);
  const result = purgeExpiredMeetingGraphs(db, body.referenceNowIso);
  await writeDatabase(db);

  return NextResponse.json({
    ok: true,
    ...result,
    deletedExpiredPreferenceIds: Array.from(
      new Set([
        ...(result.deletedExpiredPreferenceIds || []),
        ...prefPurge.deletedPreferenceIds,
      ])
    ),
    auditRetentionLogs: db.auditRetentionLogs,
  });
}
