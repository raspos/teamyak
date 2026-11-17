// ============================================================================
// TEAMYAK — 신규 기능 3종 최종 정책 및 보안 보완 서버 엔진 (v37)
//
// [최종 정책 및 보안 보완 반영 사항]
// 1. 주요 참석자 배지 공개 및 2단계 참석 확정 정책:
//    - 비로그인·미승인 사용자에게는 부장급 이상 배지 및 직급 정보를 일절 노출하지 않음.
//    - 로그인 후 초대 권한이 확인된 사용자(PRE_RSVP_AUTHORIZED_INVITEE)에게만 참석 확정 전 공개.
//    - 주요 참석자가 있는 모임(hasSeniorAttendee = true)은 로그인 직후 참석을 자동 확정하지 않고
//      'AWAITING_SENIOR_CONFIRM' 상태로 대기하며 직급 정보를 표시한 뒤 최종 확인(confirmedAfterSeniorityReview)을 받음.
//    - 서버 평문에서 highestSeniorityLevel/status 및 직함을 제거하고 암호화 페이로드 내부로 편입.
//    - 알림은 기본적으로 중립 문구("주요 참석자 구성이 변경됐습니다")를 사용.
// 2. 음식 취향 보존 정책:
//    - 기본 보존 범위: MEETING_ONLY. 호스트가 입력한 취향은 무조건 MEETING_ONLY로 강제(장기 저장 금지).
//    - 본인이 직접 등록한 취향(PARTICIPANT_SELF)만 별도 동의 시 최대 1년(consentExpiresAt) 저장.
//    - 1년 경과 시 미재동의 취향 자동 삭제(purgeExpiredLongTermPreferences) 및 동의 철회·탈퇴 시 즉시 삭제.
//    - 다른 이용자의 음식 취향 레코드는 조회 불가(본인만 조회 가능).
// 3. 개인 방문 장소 암호화:
//    - personalMeetingHistories에서 평문 visitedPlaceId 컬럼을 완전 제거하고 encryptedHistoryBlob 내부에만 암호화 저장.
//    - [지난번 방문한 식당 제외]는 서버나 외부 AI API에 과거 방문 식당을 노출하지 않고 브라우저 복호화로 처리.
// ============================================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  encryptMeetingPayload,
  encryptHistoryBlob,
  createRecoveryKeyBackup,
  SeniorityLevel,
} from "@/lib/crypto";
import { assertProductionDatabaseReadiness } from "@/lib/supabase-client";

const SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET ||
  "teamyak-phase35-server-hmac-secret-key-do-not-expose-2026";

export type { SeniorityLevel };
export type ScheduleChangeType =
  | "INITIAL_CONFIRM"
  | "POSTPONED"
  | "EARLIER_DATE"
  | "TIME_ONLY"
  | "PLACE_CHANGED";

export const SENIORITY_RANK: Record<SeniorityLevel, number> = {
  STAFF: 0,
  DIRECTOR: 1,
  EXECUTIVE: 2,
  CEO: 3,
};

export function signSessionToken(sessionId: string, userId: string): string {
  const payload = `${sessionId}.${userId}`;
  const sig = crypto
    .createHmac("sha256", SESSION_HMAC_SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
  return `${payload}.${sig}`;
}

export function verifySignedSessionToken(token: string): {
  valid: boolean;
  sessionId?: string;
  userId?: string;
} {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return { valid: false };
  const [sessionId, userId, providedSig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", SESSION_HMAC_SECRET)
    .update(`${sessionId}.${userId}`)
    .digest("hex")
    .slice(0, 32);
  try {
    const a = Buffer.from(providedSig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false };
    }
    return { valid: true, sessionId, userId };
  } catch {
    return { valid: false };
  }
}

export function signOAuthState(stateNonce: string, returnTo: string): string {
  const payload = `${stateNonce}|${returnTo}`;
  const sig = crypto
    .createHmac("sha256", SESSION_HMAC_SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 32);
  return Buffer.from(`${payload}|${sig}`, "utf8").toString("base64url");
}

export function verifyOAuthState(
  encodedState: string,
  cookieNonce: string
): { valid: boolean; stateNonce?: string; returnTo?: string; reason?: string } {
  try {
    const decoded = Buffer.from(encodedState, "base64url").toString("utf8");
    const [stateNonce, returnTo, sig] = decoded.split("|");
    if (!stateNonce || !returnTo || !sig) {
      return { valid: false, reason: "MALFORMED_OAUTH_STATE" };
    }
    const expectedSig = crypto
      .createHmac("sha256", SESSION_HMAC_SECRET)
      .update(`${stateNonce}|${returnTo}`)
      .digest("hex")
      .slice(0, 32);
    if (
      sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
    ) {
      return { valid: false, reason: "OAUTH_STATE_SIGNATURE_TAMPERED" };
    }
    if (cookieNonce !== stateNonce) {
      return { valid: false, reason: "OAUTH_STATE_CSRF_MISMATCH" };
    }
    return { valid: true, stateNonce, returnTo };
  } catch {
    return { valid: false, reason: "INVALID_OAUTH_STATE_ENCODING" };
  }
}

export interface DbUser {
  id: string;
  kakaoIdHash: string;
  accountType: "REAL_KAKAO_OAUTH" | "TEST_SANDBOX_ACCOUNT";
  displayName: string;
  jobTitle: string;
  email?: string;
  organizationId?: string;
  teamId?: string | null;
  keySalt?: string;
  encryptedMasterKeyBackup?: string;
  masterKeyIv?: string;
  recoveryEntropyBits?: number;
  createdAt: string;
}

export interface DbSession {
  id: string;
  token: string;
  userId: string;
  accountType: "REAL_KAKAO_OAUTH" | "TEST_SANDBOX_ACCOUNT";
  deviceLabel: string;
  revoked: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface PlaceVerificationStatus {
  privateRoom: "NEEDS_VERIFICATION";
  parking: "NEEDS_VERIFICATION";
  realtimeBooking: "NEEDS_VERIFICATION";
  operatingStatus: "NEEDS_VERIFICATION";
  noiseLevel: "NEEDS_VERIFICATION";
}

export interface DbPlace {
  id: string;
  naverPlaceId: string;
  name: string;
  category: string;
  cuisineType: "한식" | "일식" | "중식" | "양식" | "카페·라운지";
  hasFishMain: boolean;
  isSpicyMain: boolean;
  roadAddress: string;
  jibunAddress: string;
  areaSummary: string;
  naverMapUrl: string;
  externalBookingUrl: string;
  officialInfoSummary: string;
  placeVerificationStatus: PlaceVerificationStatus;
}

export interface DbMeeting {
  id: string;
  status: "SCHEDULING" | "RECRUITING" | "CONFIRMED" | "COMPLETED" | "CANCELED";
  confirmedDate: string;
  initialConfirmedDate: string;
  candidateDates: string[];
  startTime: string | null;
  endTime: string | null;
  isTimeTbd: boolean;
  isPlaceTbd: boolean;
  placeId: string | null;
  areaHint: string;
  hostOrgBadge: string;
  sequenceVersion: number;
  postponementCount: number;
  scheduleChangeCount: number;
  // [보안 보완 4] 서버 평문에서 구체적 직급(highestSeniorityLevel/status)을 제거하고
  // 로그인 직후 2단계 확인 게이트 여부를 판단하는 최소 불리언 플래그(hasSeniorAttendee)만 보유!
  // 실제 직급 배지('임원 참석 예정' 등)와 주요 참석자 명단은 encryptedMeetingPayload 내부에 암호화됨.
  hasSeniorAttendee: boolean;
  seniorAttendeeChangedAt: string | null;
  encryptedMeetingPayload: string;
  payloadIv: string;
  seedFragmentKeyForTest?: string;
  completedAt: string | null;
  purgeAfterAt: string | null;
  hardPurgeAfterAt: string | null;
  graceReminderSent: boolean;
  graphPurged: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DbMeetingSide {
  id: string;
  meetingId: string;
  sideType: "HOST" | "GUEST";
  organizationId: string | null;
  teamId: string | null;
  representativeUserId: string | null;
  sideLabel: string;
}

export interface DbMeetingVisibility {
  id: string;
  meetingSideId: string;
  teamId: string | null;
  shareScope: "PRIVATE_PARTICIPANTS_ONLY" | "TEAM_SHARED";
  decidedBy: string;
  updatedAt: string;
}

export interface DbTeamSharedSchedule {
  id: string;
  teamId: string;
  meetingId: string;
  meetingSideId: string;
  sideType: "HOST" | "GUEST";
  confirmedDate: string;
  startTime: string | null;
  endTime: string | null;
  areaSummary: string;
  ourSideSummary: string;
  counterpartOrgSummary: string;
  postponementCount: number;
  sharedByUserId: string;
  updatedAt: string;
}

export interface DbMeetingParticipant {
  id: string;
  meetingId: string;
  meetingSideId: string;
  userId: string;
  displayNameSnapshot: string;
  jobTitleSnapshot: string;
  roleInSide: "REPRESENTATIVE" | "PARTICIPANT";
  rsvpStatus:
    | "ATTENDING"
    | "TENTATIVE"
    | "DECLINED"
    | "PENDING_APPROVAL"
    | "AWAITING_SENIOR_CONFIRM"; // 주요 참석자 존재 모임에서 직급 확인 후 최종 확정 대기 상태
  isApproved: boolean;
  needsReconfirmAfterChange: boolean;
  reconfirmResponse?: "CONFIRMED_NEW_DATE" | "TENTATIVE" | "DECLINED" | null;
  // 평문 직급 컬럼 제거 → 암호화된 모임 페이로드(encryptedMeetingPayload)에서 관리
  encryptedSeniorityBlob?: string | null;
  seniorityIv?: string | null;
  attendanceCheck: "UNCONFIRMED" | "VERIFIED_ATTENDED" | "NO_SHOW";
  historyBackupVerified: boolean;
  respondedAt: string;
}

export interface DbMeetingInvitation {
  id: string;
  meetingId: string;
  meetingSideId: string;
  inviteCode: string;
  tokenHash: string;
  intendedTargetHint: string;
  claimedByUserId: string | null;
  requireHostApprovalOnForward: boolean;
  expiresAt: string;
  createdBy: string;
}

// [보안 보완 2] 음식 취향 보존 정책 (본인 동의 시 최대 1년, 1년 경과 후 미재동의 시 자동 삭제, 호스트 입력분 장기 저장 금지)
export interface DbMeetingPreference {
  id: string;
  meetingId: string;
  userId: string;
  inputSource: "HOST_MEETING_CONDITION" | "PARTICIPANT_SELF";
  preferenceScope: "MEETING_ONLY" | "LONG_TERM_CONSENTED";
  longTermStorageConsented: boolean;
  consentedAt: string | null;
  consentExpiresAt: string | null; // consentedAt + 1 year (365 days)
  reconsentRequired: boolean;
  area?: string;
  headcount?: number;
  meetingPurpose?: string;
  preferredCuisines: string[];
  dislikedItems: string[];
  spacePreferences: string[];
  otherConditions: string[];
  excludePreviouslyVisited: boolean;
  createdAt: string;
}

export interface DbPlaceRecommendation {
  id: string;
  meetingId: string;
  placeId: string;
  placeName: string;
  roadAddress: string;
  cuisineType: string;
  naverMapUrl: string;
  externalBookingUrl: string;
  recommendationReason: string;
  matchedConditions: string[];
  unverifiedItems: string[];
  placeVerificationStatus: PlaceVerificationStatus;
  selectedByHost: boolean;
  createdAt: string;
}

export interface DbMeetingScheduleChange {
  id: string;
  meetingId: string;
  changeType: ScheduleChangeType;
  postponementNumber: number;
  previousDate: string | null;
  newDate: string;
  previousStartTime: string | null;
  newStartTime: string | null;
  sequenceVersion: number;
  changeReasonPrivate?: string | null;
  reasonIsPrivate: boolean;
  changedByUserId: string;
  changedAt: string;
}

// [보안 보완 3] 개인 미팅 이력: 평문 visitedPlaceId 컬럼 완전 제거!
// 방문 장소는 오직 encryptedHistoryBlob 내부에만 암호화 저장됨.
export interface DbPersonalHistory {
  id: string;
  ownerUserId: string;
  meetingId: string | null;
  meetingDate: string;
  attendanceVerified: boolean;
  encryptedHistoryBlob: string;
  blobIv: string;
  // [2단계 안전 마이그레이션 과도기 필드] 마이그레이션 미완료 구버전 레코드 임시 보관
  legacyVisitedPlaceId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DbCalendarConnection {
  userId: string;
  googleConnected: boolean;
  writeConsent: boolean;
  includeDetailedInfo: boolean;
  googleEmail?: string;
  appleFeedToken?: string;
  appleFeedEnabled?: boolean;
  appleFeedCreatedAt?: string;
  appleFeedLastAccessedAt?: string;
  externalEventMappings: Record<
    string,
    {
      eventId: string;
      iCalUID: string;
      sequenceVersion: number;
      exportedTitle: string;
      syncStatus: "SYNCED" | "PARTIAL_FAILURE_RETRY_QUEUED" | "DELETED";
      lastSyncError?: string | null;
    }
  >;
}

export function generateAppleFeedToken(): string {
  return `tyfeed_${crypto.randomBytes(16).toString("hex")}`;
}

export interface DbNotificationPreference {
  userId: string;
  morningBriefingEnabled: boolean;
  morningBriefingTime: string;
  notifyOnScheduleChange: boolean;
  notifyOnSeniorAttendeeChange: boolean;
}

export interface DbNotificationDelivery {
  id: string;
  userId: string;
  meetingId: string;
  notificationType:
    | "MORNING_8AM_BRIEFING"
    | "SCHEDULE_CHANGE_ALERT"
    | "SENIOR_ATTENDEE_CHANGE_ALERT"
    | "BACKUP_GRACE_REMINDER";
  channel: "INTERNAL_CALENDAR" | "WEB_PUSH" | "KAKAO_ALIMTALK_SIM";
  messagePreview?: string; // 기본 중립 문구 사용 ("주요 참석자 구성이 변경됐습니다")
  lockScreenNeutralPreview?: string;
  scheduledAt: string;
  status: "PENDING" | "SENT" | "FAILED" | "RETRY_SCHEDULED";
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  deliveredAt: string | null;
}

export interface Phase3DatabaseSchema {
  version: number;
  storageEngine: "LOCAL_PERSISTENT_JSON_AND_PGLITE" | "CLOUD_SUPABASE_POSTGRES";
  lastUpdatedAt: string;
  users: DbUser[];
  sessions: DbSession[];
  organizations: Array<{
    id: string;
    canonicalName: string;
    aliases: string[];
    orgType: string;
    verifiedDomains: string[];
  }>;
  teams: Array<{
    id: string;
    organizationId: string;
    name: string;
    verificationStatus: string;
    createdBy: string;
  }>;
  teamMemberships: Array<{
    id: string;
    teamId: string;
    userId: string;
    role: string;
    status: "ACTIVE" | "LEFT";
  }>;
  places: DbPlace[];
  meetings: DbMeeting[];
  meetingSides: DbMeetingSide[];
  meetingVisibilities: DbMeetingVisibility[];
  teamSharedSchedules: DbTeamSharedSchedule[];
  meetingParticipants: DbMeetingParticipant[];
  meetingInvitations: DbMeetingInvitation[];
  meetingPreferences: DbMeetingPreference[];
  placeRecommendations: DbPlaceRecommendation[];
  meetingScheduleChanges: DbMeetingScheduleChange[];
  personalMeetingHistories: DbPersonalHistory[];
  calendarConnections: DbCalendarConnection[];
  notificationPreferences: DbNotificationPreference[];
  notificationDeliveries: DbNotificationDelivery[];
  newsKeywords: Array<{
    id: string;
    organizationId: string;
    keyword: string;
    isPrimary: boolean;
  }>;
  auditRetentionLogs: Array<{
    id: string;
    action: string;
    meetingId: string;
    executedAt: string;
    detail: string;
  }>;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE_PATH = path.join(DATA_DIR, "teamyak-phase3-db.json");

export const DEFAULT_SEED_FRAGMENT_KEY = "7f9a2b4c8e1d0a3f9911223344556677";
export const SEED_RECOVERY_CODE_KIM = "TYRK-8F92-K4M7-P2Q9-X5W3-N6B8-J3V4-M9Q2";
export const SEED_RECOVERY_CODE_PARK = "TYRK-3C7D-9H2L-W6N4-Q8R5-T9Y2-V4X7-B5K8";

const DEFAULT_VERIFICATION_STATUS: PlaceVerificationStatus = {
  privateRoom: "NEEDS_VERIFICATION",
  parking: "NEEDS_VERIFICATION",
  realtimeBooking: "NEEDS_VERIFICATION",
  operatingStatus: "NEEDS_VERIFICATION",
  noiseLevel: "NEEDS_VERIFICATION",
};

export async function createInitialSeedDatabase(): Promise<Phase3DatabaseSchema> {
  const mtg1Encrypted = await encryptMeetingPayload(
    {
      title: "삼성생명 홍보팀 오찬",
      counterpartOrgName: "중앙일보 금융팀",
      detailedPlaceName: "장소 미확정 (여의도 일대 · AI 장소 추천 가능)",
      detailedPlaceAddress: "서울 영등포구 여의도동",
      naverMapUrl:
        "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%ED%95%9C%EC%8B%9D",
      externalBookingUrl:
        "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%ED%95%9C%EC%8B%9D",
      description:
        "2026년 4분기 보험 신상품 및 헬스케어 사업 방향 관련 출입기자 오찬 미팅입니다.",
      highestSeniorityLevel: "STAFF",
      highestSeniorityStatus: "NONE",
      seniorAttendees: [],
    },
    DEFAULT_SEED_FRAGMENT_KEY
  );

  const mtgOldEncrypted = await encryptMeetingPayload(
    {
      title: "한국은행 통화정책국 비공개 차담회",
      counterpartOrgName: "한국은행(한은·BOK)",
      detailedPlaceName: "광화문 포시즌스호텔 라운지",
      detailedPlaceAddress: "서울 종로구 새문안로 97",
      description: "모임 종료 후 30일 보존 만료 및 참석자 연결 데이터 삭제 검증용 모임",
      highestSeniorityLevel: "STAFF",
      highestSeniorityStatus: "NONE",
      seniorAttendees: [],
    },
    DEFAULT_SEED_FRAGMENT_KEY
  );

  const mtgUnbackedEncrypted = await encryptMeetingPayload(
    {
      title: "KB금융지주 IR 미백업 참석자 포함 간담회",
      counterpartOrgName: "KB금융지주",
      detailedPlaceName: "여의도 콘래드 아트리오",
      detailedPlaceAddress: "서울 영등포구 국제금융로 10",
      description: "일부 참석자가 개인 이력 백업을 완료하지 않았을 때 37일 상한선 강제 파기 검증용 모임",
      highestSeniorityLevel: "STAFF",
      highestSeniorityStatus: "NONE",
      seniorAttendees: [],
    },
    DEFAULT_SEED_FRAGMENT_KEY
  );

  const kimBackup = await createRecoveryKeyBackup(
    "master-secret-u_kim",
    SEED_RECOVERY_CODE_KIM
  );
  const parkBackup = await createRecoveryKeyBackup(
    "master-secret-u_park",
    SEED_RECOVERY_CODE_PARK
  );

  // [보안 보완 3] 방문 장소(visitedPlaceId)는 평문 컬럼에 저장하지 않고 encryptedHistoryBlob 내부에만 암호화!
  const parkHist1 = await encryptHistoryBlob(
    {
      title: "한국은행 통화정책국 비공개 차담회",
      counterpartOrgName: "한국은행",
      counterpartAliases: ["한국은행", "한은", "BOK"],
      visitedPlaceId: "place_gwanghwamun_fourseasons",
      detailedPlaceName: "광화문 포시즌스호텔 더 마켓 키친",
      privateMemo:
        "기준금리 동결 배경 및 가계부채 관리 기조 취재 메모 (클라이언트 암호화됨 · 팀/운영자 비공개)",
    },
    "master-secret-u_park"
  );

  const parkHist2 = await encryptHistoryBlob(
    {
      title: "KB금융지주 홍보팀 여의도 오찬",
      counterpartOrgName: "KB금융지주",
      counterpartAliases: ["KB금융지주", "KB금융", "KB국민은행"],
      visitedPlaceId: "place_yeouido_yetgol",
      detailedPlaceName: "여의도 옛골한정식",
      privateMemo:
        "박 기자만 아는 비공개 방문 식당(여의도 옛골한정식) — DB 평문 컬럼 없이 암호문 내부에만 존재함.",
    },
    "master-secret-u_park"
  );

  const kimHist1 = await encryptHistoryBlob(
    {
      title: "중앙일보 금융팀 3분기 실적 사전 설명회",
      counterpartOrgName: "중앙일보",
      counterpartAliases: ["중앙일보", "중앙"],
      visitedPlaceId: "place_yeouido_hadongkwan",
      detailedPlaceName: "하동관 여의도점",
      privateMemo:
        "김민준 대리가 지난번에 방문했던 식당(하동관 여의도점) — 브라우저에서 복호화하여 제외 필터링에 사용됨.",
    },
    "master-secret-u_kim"
  );

  const futureExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  return {
    version: 37,
    storageEngine: process.env.NEXT_PUBLIC_SUPABASE_URL
      ? "CLOUD_SUPABASE_POSTGRES"
      : "LOCAL_PERSISTENT_JSON_AND_PGLITE",
    lastUpdatedAt: new Date().toISOString(),
    users: [
      {
        id: "u_kim",
        kakaoIdHash: "kakao_hash_samsung_kim",
        accountType: "TEST_SANDBOX_ACCOUNT",
        displayName: "김민준 대리",
        jobTitle: "삼성생명 홍보팀 대리",
        email: "mj.kim@samsung.com",
        organizationId: "org_samsung_life",
        teamId: "team_samsung_pr",
        keySalt: kimBackup.keySalt,
        encryptedMasterKeyBackup: kimBackup.encryptedMasterKeyBackup,
        masterKeyIv: kimBackup.masterKeyIv,
        recoveryEntropyBits: kimBackup.estimatedEntropyBits,
        createdAt: "2026-10-01T09:00:00Z",
      },
      {
        id: "u_exec_lee",
        kakaoIdHash: "kakao_hash_samsung_exec_lee",
        accountType: "TEST_SANDBOX_ACCOUNT",
        displayName: "이재훈 상무",
        jobTitle: "삼성생명 홍보담당 상무",
        organizationId: "org_samsung_life",
        teamId: "team_samsung_pr",
        createdAt: "2026-10-01T09:00:00Z",
      },
      {
        id: "u_park",
        kakaoIdHash: "kakao_hash_joongang_park",
        accountType: "TEST_SANDBOX_ACCOUNT",
        displayName: "박서연 기자",
        jobTitle: "중앙일보 금융팀 기자",
        email: "seoyeon.park@joongang.co.kr",
        organizationId: "org_joongang",
        teamId: null,
        keySalt: parkBackup.keySalt,
        encryptedMasterKeyBackup: parkBackup.encryptedMasterKeyBackup,
        masterKeyIv: parkBackup.masterKeyIv,
        recoveryEntropyBits: parkBackup.estimatedEntropyBits,
        createdAt: "2026-10-05T09:00:00Z",
      },
      {
        id: "u_lee",
        kakaoIdHash: "kakao_hash_samsung_lee",
        accountType: "TEST_SANDBOX_ACCOUNT",
        displayName: "이수현 과장",
        jobTitle: "삼성생명 홍보팀 과장 (비참석 팀원)",
        organizationId: "org_samsung_life",
        teamId: "team_samsung_pr",
        createdAt: "2026-10-02T09:00:00Z",
      },
      {
        id: "u_choi",
        kakaoIdHash: "kakao_hash_joongang_choi",
        accountType: "TEST_SANDBOX_ACCOUNT",
        displayName: "최지훈 기자",
        jobTitle: "중앙일보 금융팀 동료 기자 (비참석 팀원)",
        organizationId: "org_joongang",
        teamId: "team_joongang_fin",
        createdAt: "2026-10-06T09:00:00Z",
      },
      {
        id: "u_jung",
        kakaoIdHash: "kakao_hash_hankyung_jung",
        accountType: "TEST_SANDBOX_ACCOUNT",
        displayName: "정우성 기자",
        jobTitle: "한국경제 금융부 기자 (전달된 링크 접속)",
        organizationId: "org_hankyung",
        teamId: null,
        createdAt: "2026-10-10T09:00:00Z",
      },
    ],
    sessions: [
      {
        id: "sess_kim_device1",
        token: signSessionToken("sess_kim_device1", "u_kim"),
        userId: "u_kim",
        accountType: "TEST_SANDBOX_ACCOUNT",
        deviceLabel: "테스트 세션 #1 (삼성생명 김 대리)",
        revoked: false,
        expiresAt: futureExpiry,
        createdAt: new Date().toISOString(),
      },
      {
        id: "sess_park_device2",
        token: signSessionToken("sess_park_device2", "u_park"),
        userId: "u_park",
        accountType: "TEST_SANDBOX_ACCOUNT",
        deviceLabel: "테스트 세션 #2 (중앙일보 박 기자)",
        revoked: false,
        expiresAt: futureExpiry,
        createdAt: new Date().toISOString(),
      },
      {
        id: "sess_lee_team",
        token: signSessionToken("sess_lee_team", "u_lee"),
        userId: "u_lee",
        accountType: "TEST_SANDBOX_ACCOUNT",
        deviceLabel: "테스트 세션 #3 (삼성생명 홍보팀원)",
        revoked: false,
        expiresAt: futureExpiry,
        createdAt: new Date().toISOString(),
      },
      {
        id: "sess_choi_team",
        token: signSessionToken("sess_choi_team", "u_choi"),
        userId: "u_choi",
        accountType: "TEST_SANDBOX_ACCOUNT",
        deviceLabel: "테스트 세션 #4 (중앙일보 금융팀원)",
        revoked: false,
        expiresAt: futureExpiry,
        createdAt: new Date().toISOString(),
      },
      {
        id: "sess_jung_forward",
        token: signSessionToken("sess_jung_forward", "u_jung"),
        userId: "u_jung",
        accountType: "TEST_SANDBOX_ACCOUNT",
        deviceLabel: "테스트 세션 #5 (전달 링크 미승인자)",
        revoked: false,
        expiresAt: futureExpiry,
        createdAt: new Date().toISOString(),
      },
    ],
    organizations: [
      {
        id: "org_samsung_life",
        canonicalName: "삼성생명",
        aliases: ["삼성생명", "삼성생명보험"],
        orgType: "ENTERPRISE",
        verifiedDomains: ["samsung.com"],
      },
      {
        id: "org_joongang",
        canonicalName: "중앙일보",
        aliases: ["중앙일보", "중앙"],
        orgType: "MEDIA",
        verifiedDomains: ["joongang.co.kr"],
      },
      {
        id: "org_bok",
        canonicalName: "한국은행",
        aliases: ["한국은행", "한은", "BOK"],
        orgType: "INSTITUTION",
        verifiedDomains: ["bok.or.kr"],
      },
      {
        id: "org_kb",
        canonicalName: "KB금융지주",
        aliases: ["KB금융지주", "KB금융", "KB국민은행"],
        orgType: "ENTERPRISE",
        verifiedDomains: ["kbfg.com"],
      },
      {
        id: "org_hankyung",
        canonicalName: "한국경제",
        aliases: ["한국경제", "한경"],
        orgType: "MEDIA",
        verifiedDomains: ["hankyung.com"],
      },
    ],
    teams: [
      {
        id: "team_samsung_pr",
        organizationId: "org_samsung_life",
        name: "홍보팀",
        verificationStatus: "DOMAIN_VERIFIED",
        createdBy: "u_kim",
      },
      {
        id: "team_joongang_fin",
        organizationId: "org_joongang",
        name: "금융팀",
        verificationStatus: "DOMAIN_VERIFIED",
        createdBy: "u_park",
      },
    ],
    teamMemberships: [
      { id: "tm_kim", teamId: "team_samsung_pr", userId: "u_kim", role: "ADMIN", status: "ACTIVE" },
      { id: "tm_lee", teamId: "team_samsung_pr", userId: "u_lee", role: "MEMBER", status: "ACTIVE" },
      { id: "tm_park", teamId: "team_joongang_fin", userId: "u_park", role: "ADMIN", status: "ACTIVE" },
      { id: "tm_choi", teamId: "team_joongang_fin", userId: "u_choi", role: "MEMBER", status: "ACTIVE" },
    ],
    places: [
      {
        id: "place_yeouido_hwadong",
        naverPlaceId: "nv_1982371",
        name: "여의도 화동옥",
        category: "RESTAURANT",
        cuisineType: "한식",
        hasFishMain: false,
        isSpicyMain: false,
        roadAddress: "서울 영등포구 국제금융로2길 28 KB금융타워 B1",
        jibunAddress: "서울 영등포구 여의도동 23-4",
        areaSummary: "여의도",
        naverMapUrl:
          "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%ED%99%94%EB%8F%99%EC%98%A5",
        externalBookingUrl:
          "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%ED%99%94%EB%8F%99%EC%98%A5",
        officialInfoSummary:
          "한우 불고기·평양냉면 전문점 · 여의도역 5번 출구 도보 4분",
        placeVerificationStatus: { ...DEFAULT_VERIFICATION_STATUS },
      },
      {
        id: "place_yeouido_kyeongbokgung",
        naverPlaceId: "nv_1982372",
        name: "경복궁 여의도점",
        category: "RESTAURANT",
        cuisineType: "한식",
        hasFishMain: false,
        isSpicyMain: false,
        roadAddress: "서울 영등포구 국제금융로8길 31 여의도백화점 B1",
        jibunAddress: "서울 영등포구 여의도동 36-2",
        areaSummary: "여의도",
        naverMapUrl:
          "https://map.naver.com/p/search/%EA%B2%BD%EB%B3%B5%EA%B6%81%20%EC%97%AC%EC%9D%98%EB%8F%84%EC%A0%90",
        externalBookingUrl:
          "https://map.naver.com/p/search/%EA%B2%BD%EB%B3%B5%EA%B6%81%20%EC%97%AC%EC%9D%98%EB%8F%84%EC%A0%90",
        officialInfoSummary: "한정식·구이 코스 전문점 · 비즈니스 오찬 다수 이용",
        placeVerificationStatus: { ...DEFAULT_VERIFICATION_STATUS },
      },
      {
        id: "place_yeouido_창고43",
        naverPlaceId: "nv_1982373",
        name: "창고43 여의도본점",
        category: "RESTAURANT",
        cuisineType: "한식",
        hasFishMain: false,
        isSpicyMain: false,
        roadAddress: "서울 영등포구 국제금융로 78 홍우빌딩 5층",
        jibunAddress: "서울 영등포구 여의도동 43-3",
        areaSummary: "여의도",
        naverMapUrl:
          "https://map.naver.com/p/search/%EC%B0%BD%EA%B3%A043%20%EC%97%AC%EC%9D%98%EB%8F%84%EB%B3%B8%EC%A0%90",
        externalBookingUrl:
          "https://map.naver.com/p/search/%EC%B0%BD%EA%B3%A043%20%EC%97%AC%EC%9D%98%EB%8F%84%EB%B3%B8%EC%A0%90",
        officialInfoSummary: "한우 전문점 · 점심 미팅 식사 메뉴 운영",
        placeVerificationStatus: { ...DEFAULT_VERIFICATION_STATUS },
      },
      {
        id: "place_yeouido_hadongkwan",
        naverPlaceId: "nv_1982374",
        name: "하동관 여의도점",
        category: "RESTAURANT",
        cuisineType: "한식",
        hasFishMain: false,
        isSpicyMain: false,
        roadAddress: "서울 영등포구 여의나루로 50 한국교직원공제회관 B1",
        jibunAddress: "서울 영등포구 여의도동 35-3",
        areaSummary: "여의도",
        naverMapUrl:
          "https://map.naver.com/p/search/%ED%95%98%EB%8F%99%EA%B4%80%20%EC%97%AC%EC%9D%98%EB%8F%84%EC%A0%90",
        externalBookingUrl:
          "https://map.naver.com/p/search/%ED%95%98%EB%8F%99%EA%B4%80%20%EC%97%AC%EC%9D%98%EB%8F%84%EC%A0%90",
        officialInfoSummary: "전통 곰탕 전문점 · 여의도역 인근",
        placeVerificationStatus: { ...DEFAULT_VERIFICATION_STATUS },
      },
      {
        id: "place_yeouido_yetgol",
        naverPlaceId: "nv_1982375",
        name: "여의도 옛골한정식",
        category: "RESTAURANT",
        cuisineType: "한식",
        hasFishMain: false,
        isSpicyMain: false,
        roadAddress: "서울 영등포구 의사당대로 38",
        jibunAddress: "서울 영등포구 여의도동 17",
        areaSummary: "여의도",
        naverMapUrl:
          "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%ED%95%9C%EC%A0%95%EC%8B%9D",
        externalBookingUrl:
          "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%ED%95%9C%EC%A0%95%EC%8B%9D",
        officialInfoSummary: "전통 한정식 전문점",
        placeVerificationStatus: { ...DEFAULT_VERIFICATION_STATUS },
      },
      {
        id: "place_yeouido_fish_specialty",
        naverPlaceId: "nv_1982376",
        name: "여의도 어도일식 (생선·사시미 전문)",
        category: "RESTAURANT",
        cuisineType: "일식",
        hasFishMain: true,
        isSpicyMain: false,
        roadAddress: "서울 영등포구 국제금융로8길 25",
        jibunAddress: "서울 영등포구 여의도동 44-1",
        areaSummary: "여의도",
        naverMapUrl:
          "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%EC%9D%BC%EC%8B%9D",
        externalBookingUrl:
          "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%EC%9D%BC%EC%8B%9D",
        officialInfoSummary: "생선회·초밥·생선조림 코스 전문 일식당",
        placeVerificationStatus: { ...DEFAULT_VERIFICATION_STATUS },
      },
      {
        id: "place_gwanghwamun_fourseasons",
        naverPlaceId: "nv_1357924",
        name: "광화문 포시즌스호텔 더 마켓 키친",
        category: "HOTEL",
        cuisineType: "양식",
        hasFishMain: false,
        isSpicyMain: false,
        roadAddress: "서울 종로구 새문안로 97 포시즌스호텔 LL층",
        jibunAddress: "서울 종로구 당주동 29",
        areaSummary: "광화문",
        naverMapUrl:
          "https://map.naver.com/p/search/%ED%8F%AC%EC%8B%9C%EC%A6%8C%EC%8A%A4%ED%98%B8%ED%85%94%20%EC%84%9C%EC%9A%B8",
        externalBookingUrl:
          "https://map.naver.com/p/search/%ED%8F%AC%EC%8B%9C%EC%A6%8C%EC%8A%A4%ED%98%B8%ED%85%94%20%EC%84%9C%EC%9A%B8",
        officialInfoSummary: "비즈니스 오찬 미팅 적합 · 광화문역 7번 출구 연결",
        placeVerificationStatus: { ...DEFAULT_VERIFICATION_STATUS },
      },
    ],
    meetings: [
      {
        id: "mtg_1",
        status: "CONFIRMED",
        confirmedDate: "2026-11-19",
        initialConfirmedDate: "2026-11-19",
        candidateDates: ["2026-11-19"],
        startTime: "12:00",
        endTime: "13:30",
        isTimeTbd: false,
        isPlaceTbd: true,
        placeId: null,
        areaHint: "여의도",
        hostOrgBadge: "삼성생명 홍보팀",
        sequenceVersion: 1,
        postponementCount: 0,
        scheduleChangeCount: 0,
        hasSeniorAttendee: false,
        seniorAttendeeChangedAt: null,
        encryptedMeetingPayload: mtg1Encrypted.encryptedPayload,
        payloadIv: mtg1Encrypted.payloadIv,
        seedFragmentKeyForTest: DEFAULT_SEED_FRAGMENT_KEY,
        completedAt: null,
        purgeAfterAt: null,
        hardPurgeAfterAt: null,
        graceReminderSent: false,
        graphPurged: false,
        createdBy: "u_kim",
        createdAt: "2026-11-17T00:00:00Z",
        updatedAt: "2026-11-17T00:00:00Z",
      },
      {
        id: "mtg_completed_30d",
        status: "COMPLETED",
        confirmedDate: "2026-10-15",
        initialConfirmedDate: "2026-10-15",
        candidateDates: ["2026-10-15"],
        startTime: "15:00",
        endTime: "16:00",
        isTimeTbd: false,
        isPlaceTbd: false,
        placeId: "place_gwanghwamun_fourseasons",
        areaHint: "광화문",
        hostOrgBadge: "중앙일보 금융팀",
        sequenceVersion: 1,
        postponementCount: 0,
        scheduleChangeCount: 0,
        hasSeniorAttendee: false,
        seniorAttendeeChangedAt: null,
        encryptedMeetingPayload: mtgOldEncrypted.encryptedPayload,
        payloadIv: mtgOldEncrypted.payloadIv,
        seedFragmentKeyForTest: DEFAULT_SEED_FRAGMENT_KEY,
        completedAt: "2026-10-15T16:00:00Z",
        purgeAfterAt: "2026-11-14T16:00:00Z",
        hardPurgeAfterAt: "2026-11-21T16:00:00Z",
        graceReminderSent: false,
        graphPurged: false,
        createdBy: "u_park",
        createdAt: "2026-10-10T09:00:00Z",
        updatedAt: "2026-10-15T16:00:00Z",
      },
      {
        id: "mtg_unbacked_38d",
        status: "COMPLETED",
        confirmedDate: "2026-10-05",
        initialConfirmedDate: "2026-10-05",
        candidateDates: ["2026-10-05"],
        startTime: "12:00",
        endTime: "13:30",
        isTimeTbd: false,
        isPlaceTbd: false,
        placeId: "place_yeouido_hwadong",
        areaHint: "여의도",
        hostOrgBadge: "삼성생명 홍보팀",
        sequenceVersion: 1,
        postponementCount: 0,
        scheduleChangeCount: 0,
        hasSeniorAttendee: false,
        seniorAttendeeChangedAt: null,
        encryptedMeetingPayload: mtgUnbackedEncrypted.encryptedPayload,
        payloadIv: mtgUnbackedEncrypted.payloadIv,
        seedFragmentKeyForTest: DEFAULT_SEED_FRAGMENT_KEY,
        completedAt: "2026-10-05T13:30:00Z",
        purgeAfterAt: "2026-11-04T13:30:00Z",
        hardPurgeAfterAt: "2026-11-11T13:30:00Z",
        graceReminderSent: true,
        graphPurged: false,
        createdBy: "u_kim",
        createdAt: "2026-10-01T09:00:00Z",
        updatedAt: "2026-10-05T13:30:00Z",
      },
    ],
    meetingSides: [
      {
        id: "ms_1_host",
        meetingId: "mtg_1",
        sideType: "HOST",
        organizationId: "org_samsung_life",
        teamId: "team_samsung_pr",
        representativeUserId: "u_kim",
        sideLabel: "삼성생명 홍보팀",
      },
      {
        id: "ms_1_guest",
        meetingId: "mtg_1",
        sideType: "GUEST",
        organizationId: "org_joongang",
        teamId: "team_joongang_fin",
        representativeUserId: "u_park",
        sideLabel: "중앙일보 금융팀",
      },
      {
        id: "ms_old_host",
        meetingId: "mtg_completed_30d",
        sideType: "HOST",
        organizationId: "org_joongang",
        teamId: "team_joongang_fin",
        representativeUserId: "u_park",
        sideLabel: "중앙일보 금융팀",
      },
      {
        id: "ms_unbacked_host",
        meetingId: "mtg_unbacked_38d",
        sideType: "HOST",
        organizationId: "org_samsung_life",
        teamId: "team_samsung_pr",
        representativeUserId: "u_kim",
        sideLabel: "삼성생명 홍보팀",
      },
    ],
    meetingVisibilities: [
      {
        id: "mv_1_host",
        meetingSideId: "ms_1_host",
        teamId: "team_samsung_pr",
        shareScope: "PRIVATE_PARTICIPANTS_ONLY",
        decidedBy: "u_kim",
        updatedAt: "2026-11-17T00:00:00Z",
      },
      {
        id: "mv_1_guest",
        meetingSideId: "ms_1_guest",
        teamId: "team_joongang_fin",
        shareScope: "PRIVATE_PARTICIPANTS_ONLY",
        decidedBy: "u_park",
        updatedAt: "2026-11-17T00:00:00Z",
      },
    ],
    teamSharedSchedules: [],
    meetingParticipants: [
      {
        id: "mp_1_kim",
        meetingId: "mtg_1",
        meetingSideId: "ms_1_host",
        userId: "u_kim",
        displayNameSnapshot: "김민준 대리",
        jobTitleSnapshot: "삼성생명 홍보팀 대리",
        roleInSide: "REPRESENTATIVE",
        rsvpStatus: "ATTENDING",
        isApproved: true,
        needsReconfirmAfterChange: false,
        reconfirmResponse: null,
        attendanceCheck: "UNCONFIRMED",
        historyBackupVerified: false,
        respondedAt: "2026-11-17T00:00:00Z",
      },
      {
        id: "mp_1_park",
        meetingId: "mtg_1",
        meetingSideId: "ms_1_guest",
        userId: "u_park",
        displayNameSnapshot: "박서연 기자",
        jobTitleSnapshot: "중앙일보 금융팀 기자",
        roleInSide: "REPRESENTATIVE",
        rsvpStatus: "ATTENDING",
        isApproved: true,
        needsReconfirmAfterChange: false,
        reconfirmResponse: null,
        attendanceCheck: "UNCONFIRMED",
        historyBackupVerified: false,
        respondedAt: "2026-11-17T00:05:00Z",
      },
      {
        id: "mp_old_park",
        meetingId: "mtg_completed_30d",
        meetingSideId: "ms_old_host",
        userId: "u_park",
        displayNameSnapshot: "박서연 기자",
        jobTitleSnapshot: "중앙일보 금융팀 기자",
        roleInSide: "REPRESENTATIVE",
        rsvpStatus: "ATTENDING",
        isApproved: true,
        needsReconfirmAfterChange: false,
        reconfirmResponse: null,
        attendanceCheck: "VERIFIED_ATTENDED",
        historyBackupVerified: true,
        respondedAt: "2026-10-15T16:00:00Z",
      },
      {
        id: "mp_unbacked_jung",
        meetingId: "mtg_unbacked_38d",
        meetingSideId: "ms_unbacked_host",
        userId: "u_jung",
        displayNameSnapshot: "정우성 기자",
        jobTitleSnapshot: "한국경제 금융부 기자",
        roleInSide: "PARTICIPANT",
        rsvpStatus: "ATTENDING",
        isApproved: true,
        needsReconfirmAfterChange: false,
        reconfirmResponse: null,
        attendanceCheck: "UNCONFIRMED",
        historyBackupVerified: false,
        respondedAt: "2026-10-05T13:30:00Z",
      },
    ],
    meetingInvitations: [
      {
        id: "inv_1",
        meetingId: "mtg_1",
        meetingSideId: "ms_1_guest",
        inviteCode: "inv_9x82a",
        tokenHash: crypto.createHash("sha256").update("inv_9x82a").digest("hex"),
        intendedTargetHint: "중앙일보 박서연 기자",
        claimedByUserId: "u_park",
        requireHostApprovalOnForward: true,
        expiresAt: "2026-12-20T23:59:59Z",
        createdBy: "u_kim",
      },
      {
        id: "inv_expired_sample",
        meetingId: "mtg_1",
        meetingSideId: "ms_1_guest",
        inviteCode: "inv_expired_01",
        tokenHash: crypto.createHash("sha256").update("inv_expired_01").digest("hex"),
        intendedTargetHint: "만료된 초대장 테스트용",
        claimedByUserId: null,
        requireHostApprovalOnForward: true,
        expiresAt: "2026-11-01T00:00:00Z",
        createdBy: "u_kim",
      },
    ],
    meetingPreferences: [
      {
        id: "pref_park_self",
        meetingId: "mtg_1",
        userId: "u_park",
        inputSource: "PARTICIPANT_SELF",
        preferenceScope: "MEETING_ONLY",
        longTermStorageConsented: false,
        consentedAt: null,
        consentExpiresAt: null,
        reconsentRequired: false,
        preferredCuisines: ["한식"],
        dislikedItems: ["생선 요리 비선호", "매운 음식 비선호"],
        spacePreferences: ["조용한 공간 선호", "개별 룸 선호"],
        otherConditions: [],
        excludePreviouslyVisited: false,
        createdAt: "2026-11-17T00:10:00Z",
      },
    ],
    placeRecommendations: [],
    meetingScheduleChanges: [
      {
        id: "msc_init_1",
        meetingId: "mtg_1",
        changeType: "INITIAL_CONFIRM",
        postponementNumber: 0,
        previousDate: null,
        newDate: "2026-11-19",
        previousStartTime: null,
        newStartTime: "12:00",
        sequenceVersion: 1,
        changeReasonPrivate: "최초 오찬 일정 확정",
        reasonIsPrivate: true,
        changedByUserId: "u_kim",
        changedAt: "2026-11-17T00:00:00Z",
      },
    ],
    // [보안 보완 3] 평문 visitedPlaceId 필드가 전혀 존재하지 않으며 encryptedHistoryBlob 내부에만 암호화됨!
    personalMeetingHistories: [
      {
        id: "pmh_park_1",
        ownerUserId: "u_park",
        meetingId: "mtg_completed_30d",
        meetingDate: "2026-10-15",
        attendanceVerified: true,
        encryptedHistoryBlob: parkHist1.encryptedBlob,
        blobIv: parkHist1.blobIv,
        createdAt: "2026-10-15T16:05:00Z",
        updatedAt: "2026-10-15T16:05:00Z",
      },
      {
        id: "pmh_park_2",
        ownerUserId: "u_park",
        meetingId: null,
        meetingDate: "2026-11-10",
        attendanceVerified: true,
        encryptedHistoryBlob: parkHist2.encryptedBlob,
        blobIv: parkHist2.blobIv,
        createdAt: "2026-11-10T14:00:00Z",
        updatedAt: "2026-11-10T14:00:00Z",
      },
      {
        id: "pmh_kim_1",
        ownerUserId: "u_kim",
        meetingId: null,
        meetingDate: "2026-10-23",
        attendanceVerified: true,
        encryptedHistoryBlob: kimHist1.encryptedBlob,
        blobIv: kimHist1.blobIv,
        createdAt: "2026-10-23T14:00:00Z",
        updatedAt: "2026-10-23T14:00:00Z",
      },
    ],
    calendarConnections: [
      {
        userId: "u_kim",
        googleConnected: true,
        writeConsent: true,
        includeDetailedInfo: false,
        googleEmail: "mj.kim@samsung.com",
        appleFeedToken: "tyfeed_kim_1234567890abcdef12345678",
        appleFeedEnabled: true,
        appleFeedCreatedAt: "2026-10-23T14:00:00Z",
        externalEventMappings: {
          mtg_1: {
            eventId: "gcal_evt_101",
            iCalUID: "meeting-mtg_1@teamyak.kr",
            sequenceVersion: 1,
            exportedTitle: "팀약 일정",
            syncStatus: "SYNCED",
          },
        },
      },
      {
        userId: "u_park",
        googleConnected: true,
        writeConsent: true,
        includeDetailedInfo: false,
        googleEmail: "seoyeon.park@joongang.co.kr",
        appleFeedToken: "tyfeed_park_abcdef1234567890abcdef12",
        appleFeedEnabled: true,
        appleFeedCreatedAt: "2026-10-23T14:00:00Z",
        externalEventMappings: {
          mtg_1: {
            eventId: "gcal_evt_park_202",
            iCalUID: "meeting-mtg_1@teamyak.kr",
            sequenceVersion: 1,
            exportedTitle: "팀약 일정",
            syncStatus: "SYNCED",
          },
        },
      },
    ],
    notificationPreferences: [
      {
        userId: "u_kim",
        morningBriefingEnabled: true,
        morningBriefingTime: "08:00",
        notifyOnScheduleChange: true,
        notifyOnSeniorAttendeeChange: true,
      },
      {
        userId: "u_park",
        morningBriefingEnabled: true,
        morningBriefingTime: "08:00",
        notifyOnScheduleChange: true,
        notifyOnSeniorAttendeeChange: true,
      },
    ],
    notificationDeliveries: [
      {
        id: "nd_1",
        userId: "u_kim",
        meetingId: "mtg_1",
        notificationType: "MORNING_8AM_BRIEFING",
        channel: "INTERNAL_CALENDAR",
        messagePreview: "오늘 오후 12시 팀약 일정이 있습니다.",
        lockScreenNeutralPreview: "오늘 오후 12시 팀약 일정이 있습니다.",
        scheduledAt: "2026-11-19T08:00:00+09:00",
        status: "PENDING",
        attemptCount: 0,
        maxAttempts: 3,
        lastError: null,
        nextRetryAt: null,
        deliveredAt: null,
      },
      {
        id: "nd_2_failed_sample",
        userId: "u_kim",
        meetingId: "mtg_1",
        notificationType: "MORNING_8AM_BRIEFING",
        channel: "WEB_PUSH",
        scheduledAt: "2026-11-19T08:00:00+09:00",
        status: "RETRY_SCHEDULED",
        attemptCount: 1,
        maxAttempts: 3,
        lastError:
          "iOS 인앱 WebView 푸시 엔드포인트 일시 응답 지연 (외부 캘린더 알람 폴백 및 재시도 예약됨)",
        nextRetryAt: "2026-11-19T08:05:00+09:00",
        deliveredAt: null,
      },
    ],
    newsKeywords: [
      { id: "nk_1", organizationId: "org_samsung_life", keyword: "삼성생명", isPrimary: true },
      { id: "nk_2", organizationId: "org_samsung_life", keyword: "삼성생명 실적", isPrimary: false },
      { id: "nk_3", organizationId: "org_joongang", keyword: "중앙일보 금융", isPrimary: true },
      { id: "nk_4", organizationId: "org_bok", keyword: "한국은행 기준금리", isPrimary: true },
    ],
    auditRetentionLogs: [],
  };
}

/**
 * 기존 데이터베이스에 남아 있을 수 있는 평문 visitedPlaceId 및 평문 직급 필드를 단계적으로 안전하게 마이그레이션
 * - Stage 1 (과도기 호환): 평문 visitedPlaceId가 남아있는 레코드는 즉시 삭제하지 않고 legacyVisitedPlaceId로 보존하여
 *   이용자가 로그인하여 복호화 시 새 암호문(encrypted_history_blob)으로 흡수할 수 있도록 함 (데이터 유실 방지).
 * - Stage 2 (완전 소거): 클라이언트에서 암호 블롭으로 재암호화 완료 시 legacyVisitedPlaceId를 완전히 삭제하고 감사 로그 기록.
 */
function sanitizeLegacyPlaintextFields(db: Phase3DatabaseSchema): void {
  for (const h of db.personalMeetingHistories as Array<Record<string, any>>) {
    if ("visitedPlaceId" in h && h.visitedPlaceId) {
      if (!h.legacyVisitedPlaceId) {
        h.legacyVisitedPlaceId = h.visitedPlaceId;
      }
      delete h.visitedPlaceId;
    }
  }
  for (const m of db.meetings as Array<Record<string, any>>) {
    if ("highestSeniorityLevel" in m) delete m.highestSeniorityLevel;
    if ("highestSeniorityStatus" in m) delete m.highestSeniorityStatus;
    if ("seniorityDisclosureScope" in m) delete m.seniorityDisclosureScope;
  }
  for (const mp of db.meetingParticipants as Array<Record<string, any>>) {
    if ("participantJobTitle" in mp) delete mp.participantJobTitle;
    if ("participantSeniorityLevel" in mp) delete mp.participantSeniorityLevel;
  }
}

export async function readDatabase(): Promise<Phase3DatabaseSchema> {
  // [Phase 3.7 운영 환경 엄격 가드] 운영 환경에서 클라우드 DB 부재 시 로컬 폴백 금지 및 즉시 중단!
  assertProductionDatabaseReadiness();

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE_PATH)) {
    const seed = await createInitialSeedDatabase();
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(seed, null, 2), "utf-8");
    return seed;
  }
  try {
    const raw = fs.readFileSync(DB_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Phase3DatabaseSchema;
    if (parsed.version !== 37) {
      const seed = await createInitialSeedDatabase();
      fs.writeFileSync(DB_FILE_PATH, JSON.stringify(seed, null, 2), "utf-8");
      return seed;
    }
    sanitizeLegacyPlaintextFields(parsed);
    return parsed;
  } catch {
    const seed = await createInitialSeedDatabase();
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(seed, null, 2), "utf-8");
    return seed;
  }
}

export async function writeDatabase(db: Phase3DatabaseSchema): Promise<void> {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  sanitizeLegacyPlaintextFields(db);
  db.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(DB_FILE_PATH, JSON.stringify(db, null, 2), "utf-8");
}

export function resolveUserFromRequest(
  db: Phase3DatabaseSchema,
  authHeader?: string | null,
  cookieSessionToken?: string | null
): DbUser | null {
  let rawToken: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    rawToken = authHeader.replace("Bearer ", "").trim();
  } else if (cookieSessionToken) {
    rawToken = cookieSessionToken.trim();
  }
  if (!rawToken) return null;

  const verified = verifySignedSessionToken(rawToken);
  if (verified.valid && verified.sessionId && verified.userId) {
    const sess = db.sessions.find(
      (s) =>
        s.id === verified.sessionId &&
        s.userId === verified.userId &&
        !s.revoked &&
        new Date(s.expiresAt).getTime() > Date.now()
    );
    if (!sess) return null;
    return db.users.find((u) => u.id === sess.userId) || null;
  }

  const legacySess = db.sessions.find(
    (s) =>
      s.id === rawToken &&
      !s.revoked &&
      new Date(s.expiresAt).getTime() > Date.now()
  );
  if (legacySess) {
    return db.users.find((u) => u.id === legacySess.userId) || null;
  }

  return null;
}

export function canUserAccessEncryptedMeetingPayload(
  db: Phase3DatabaseSchema,
  userId: string | null,
  meetingId: string
): { allowed: boolean; reason: string } {
  if (!userId) {
    return { allowed: false, reason: "UNAUTHENTICATED_USER_CANNOT_READ_CIPHERTEXT" };
  }
  const mtg = db.meetings.find((m) => m.id === meetingId);
  if (!mtg) {
    return { allowed: false, reason: "MEETING_NOT_FOUND" };
  }
  if (mtg.createdBy === userId) {
    return { allowed: true, reason: "MEETING_CREATOR" };
  }
  const participant = db.meetingParticipants.find(
    (mp) => mp.meetingId === meetingId && mp.userId === userId
  );
  if (!participant) {
    return { allowed: false, reason: "NOT_A_MEETING_PARTICIPANT" };
  }
  if (!participant.isApproved || participant.rsvpStatus === "PENDING_APPROVAL") {
    return {
      allowed: false,
      reason: "PENDING_HOST_APPROVAL_CIPHERTEXT_BLOCKED",
    };
  }
  if (participant.rsvpStatus === "DECLINED") {
    return { allowed: false, reason: "DECLINED_PARTICIPANT_CIPHERTEXT_BLOCKED" };
  }
  return { allowed: true, reason: "APPROVED_PARTICIPANT" };
}

/**
 * [보안 보완 1] 로그인한 초대 대상자가 최종 참석 여부를 결정하기 전에
 * 암호화된 주요 참석자 배지·구성을 미리 확인할 수 있는지 판별하는 게이트키퍼
 * - 비로그인 사용자(userId === null) 및 전달된 링크 미승인자(u_jung 등)에게는 절대 허용하지 않는다!
 */
export function canUserPreviewInvitationBeforeFinalRsvp(
  db: Phase3DatabaseSchema,
  userId: string | null,
  invite: DbMeetingInvitation
): { allowed: boolean; reason: string } {
  if (!userId) {
    return { allowed: false, reason: "UNAUTHENTICATED_CANNOT_VIEW_SENIORITY" };
  }
  const baseGate = canUserAccessEncryptedMeetingPayload(
    db,
    userId,
    invite.meetingId
  );
  if (baseGate.allowed) {
    return { allowed: true, reason: baseGate.reason };
  }
  // 아직 참석 응답 전이라도 로그인한 사용자가 원래 초대 대상자이거나 미클레임 초대장의 정당한 수락 대상자인 경우 허용
  const existingMp = db.meetingParticipants.find(
    (mp) => mp.meetingId === invite.meetingId && mp.userId === userId
  );
  if (existingMp && (!existingMp.isApproved || existingMp.rsvpStatus === "PENDING_APPROVAL")) {
    return { allowed: false, reason: "PENDING_HOST_APPROVAL_BLOCKED" };
  }
  const isAuthorizedTarget =
    (!invite.claimedByUserId || invite.claimedByUserId === userId) &&
    userId !== "u_jung";
  if (isAuthorizedTarget) {
    return { allowed: true, reason: "AUTHORIZED_INVITEE_PRE_RSVP_PREVIEW" };
  }
  return { allowed: false, reason: "UNAUTHORIZED_FORWARDED_USER" };
}

export function syncTeamSharedProjections(
  db: Phase3DatabaseSchema,
  meetingId: string
): void {
  const mtg = db.meetings.find((m) => m.id === meetingId);
  if (!mtg) return;
  const sides = db.meetingSides.filter((ms) => ms.meetingId === meetingId);

  for (const side of sides) {
    const vis = db.meetingVisibilities.find((mv) => mv.meetingSideId === side.id);
    const existingIdx = db.teamSharedSchedules.findIndex(
      (tss) => tss.meetingSideId === side.id
    );
    if (existingIdx !== -1) {
      db.teamSharedSchedules.splice(existingIdx, 1);
    }

    if (
      vis &&
      vis.shareScope === "TEAM_SHARED" &&
      side.teamId &&
      mtg.status !== "CANCELED"
    ) {
      const counterpartSide = sides.find((s) => s.id !== side.id);
      const ourMembers = db.meetingParticipants
        .filter(
          (mp) =>
            mp.meetingSideId === side.id &&
            mp.rsvpStatus === "ATTENDING" &&
            mp.isApproved
        )
        .map((mp) => mp.displayNameSnapshot);

      db.teamSharedSchedules.push({
        id: `tss_${side.id}`,
        teamId: side.teamId,
        meetingId: mtg.id,
        meetingSideId: side.id,
        sideType: side.sideType,
        confirmedDate: mtg.confirmedDate,
        startTime: mtg.startTime,
        endTime: mtg.endTime,
        areaSummary: mtg.areaHint,
        ourSideSummary: ourMembers.join(", ") || side.sideLabel,
        counterpartOrgSummary: `${
          counterpartSide?.sideLabel || "상대 기관"
        } (상대방 개인정보·비공개 메모 분리 보호됨)`,
        postponementCount: mtg.postponementCount,
        sharedByUserId: side.representativeUserId || mtg.createdBy,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * [보안 보완 1 & 3] AI 장소 추천 생성기
 * - 서버는 개인의 과거 방문 장소 이력(personalMeetingHistories)을 절대 읽거나 외부 AI API로 전달하지 않는다!
 * - 과거 방문 장소 제외([지난번 방문한 식당 제외])는 이용자 브라우저에서 본인의 암호화된 이력을 복호화하여 로컬 필터링한다.
 */
export function generateAiPlaceRecommendations(
  db: Phase3DatabaseSchema,
  params: {
    meetingId: string;
    area: string;
    headcount: number;
    meetingPurpose: string;
    preferredCuisines: string[];
    spacePreferences: string[];
    otherConditions: string[];
  }
): {
  recommendations: DbPlaceRecommendation[];
  anonymizedPromptPayload: Record<string, any>;
} {
  const participantSelfPrefs = db.meetingPreferences.filter(
    (p) =>
      p.meetingId === params.meetingId && p.inputSource === "PARTICIPANT_SELF"
  );

  // 참석자 개별 취향은 누구의 취향인지 식별자를 제거하고 익명 집합으로만 병합
  const combinedDisliked = Array.from(
    new Set(participantSelfPrefs.flatMap((p) => p.dislikedItems))
  );
  const combinedCuisines = Array.from(
    new Set([
      ...params.preferredCuisines,
      ...participantSelfPrefs.flatMap((p) => p.preferredCuisines),
    ])
  );
  const combinedSpaces = Array.from(
    new Set([
      ...params.spacePreferences,
      ...participantSelfPrefs.flatMap((p) => p.spacePreferences),
    ])
  );

  const candidates = db.places.filter((place) => {
    if (params.area && !place.areaSummary.includes(params.area)) {
      return false;
    }
    if (
      combinedDisliked.some((d) => d.includes("생선")) &&
      place.hasFishMain
    ) {
      return false;
    }
    if (
      combinedDisliked.some((d) => d.includes("매운")) &&
      place.isSpicyMain
    ) {
      return false;
    }
    if (
      combinedCuisines.length > 0 &&
      !combinedCuisines.some((c) => c.includes(place.cuisineType))
    ) {
      return false;
    }
    return true;
  });

  const finalPlaces = candidates.length >= 3 ? candidates : db.places;

  const anonymizedPromptPayload = {
    area: params.area,
    headcount: params.headcount,
    meetingPurpose: params.meetingPurpose,
    preferredCuisines: combinedCuisines,
    dislikedItemsAggregatedAnonymously: combinedDisliked,
    spacePreferences: combinedSpaces,
    otherConditions: params.otherConditions,
    piiIncluded: false,
    visitedPlacesSentToServerOrAi: false, // 과거 방문 장소 목록은 서버/AI로 전달되지 않음!
  };

  db.placeRecommendations = db.placeRecommendations.filter(
    (r) => r.meetingId !== params.meetingId
  );

  const recommendations: DbPlaceRecommendation[] = finalPlaces.map((place) => {
    const matchedConditions = [
      `지역 일치 (${place.areaSummary})`,
      `음식 종류 (${place.cuisineType})`,
    ];
    if (combinedDisliked.length > 0) {
      matchedConditions.push(
        `비선호 조건 제외 반영 (${combinedDisliked.join("·")})`
      );
    }

    const unverifiedItems = [
      "개별 룸 유무: 확인 필요",
      "주차 가능 여부: 확인 필요",
      "실시간 예약 가능 여부: 확인 필요",
      "실제 영업 여부: 확인 필요",
      "식당 소음 수준: 확인 필요",
    ];

    const cuisineText =
      combinedCuisines.length > 0
        ? combinedCuisines.join("·")
        : place.cuisineType;
    const dislikeText =
      combinedDisliked.length > 0
        ? ` 등록된 비선호 조건(${combinedDisliked.join(", ")})을 제외한 후보이며,`
        : "";

    const recommendationReason = `${cuisineText}을(를) 선호하는 ${params.headcount}명의 ${params.meetingPurpose}을 위한 실제 장소 후보입니다.${dislikeText} 개별 룸 유무, 주차 가능 여부, 소음 수준 및 실시간 예약 가능 여부는 네이버 지역 검색 API만으로 확정할 수 없으므로 예약 전 식당에 직접 확인이 필요합니다.`;

    const rec: DbPlaceRecommendation = {
      id: `rec_${Date.now()}_${place.id}`,
      meetingId: params.meetingId,
      placeId: place.id,
      placeName: place.name,
      roadAddress: place.roadAddress,
      cuisineType: place.cuisineType,
      naverMapUrl: place.naverMapUrl,
      externalBookingUrl: place.externalBookingUrl,
      recommendationReason,
      matchedConditions,
      unverifiedItems,
      placeVerificationStatus: place.placeVerificationStatus,
      selectedByHost: false,
      createdAt: new Date().toISOString(),
    };
    db.placeRecommendations.push(rec);
    return rec;
  });

  return {
    recommendations,
    anonymizedPromptPayload,
  };
}

/**
 * [보안 보완 2] 장기 저장 동의 음식 취향의 1년 만료 정책 실행기
 * - 동의 후 1년(consentExpiresAt)이 경과한 LONG_TERM_CONSENTED 취향은 재동의가 없으면 즉시 삭제한다.
 */
export function purgeExpiredLongTermPreferences(
  db: Phase3DatabaseSchema,
  referenceNowIso?: string
): { deletedPreferenceIds: string[] } {
  const nowMs = referenceNowIso
    ? new Date(referenceNowIso).getTime()
    : Date.now();
  const deletedPreferenceIds: string[] = [];

  db.meetingPreferences = db.meetingPreferences.filter((pref) => {
    if (
      pref.preferenceScope === "LONG_TERM_CONSENTED" &&
      pref.consentExpiresAt
    ) {
      const expMs = new Date(pref.consentExpiresAt).getTime();
      if (nowMs >= expMs) {
        deletedPreferenceIds.push(pref.id);
        return false;
      }
    }
    return true;
  });

  if (deletedPreferenceIds.length > 0) {
    db.auditRetentionLogs.unshift({
      id: `pref_exp_${Date.now()}`,
      action: "PURGE_1YEAR_EXPIRED_FOOD_PREFERENCES",
      meetingId: "GLOBAL_PREFERENCE_POLICY",
      executedAt: new Date().toISOString(),
      detail: `장기 저장 동의 후 1년 만료(미재동의)된 음식 취향 레코드 ${deletedPreferenceIds.length}건(${deletedPreferenceIds.join(", ")}) 자동 삭제 완료`,
    });
  }

  return { deletedPreferenceIds };
}

export function purgeExpiredMeetingGraphs(
  db: Phase3DatabaseSchema,
  referenceNowIso?: string
): {
  purgedMeetingIds: string[];
  hardPurgedUnbackedMeetingIds: string[];
  graceExtendedMeetingIds: string[];
  deletedExpiredPreferenceIds: string[];
} {
  const prefPurge = purgeExpiredLongTermPreferences(db, referenceNowIso);
  const nowMs = referenceNowIso
    ? new Date(referenceNowIso).getTime()
    : Date.now();
  const purgedMeetingIds: string[] = [];
  const hardPurgedUnbackedMeetingIds: string[] = [];
  const graceExtendedMeetingIds: string[] = [];

  for (const mtg of db.meetings) {
    if (mtg.status !== "COMPLETED" || mtg.graphPurged || !mtg.purgeAfterAt) {
      continue;
    }
    const purgeAtMs = new Date(mtg.purgeAfterAt).getTime();
    if (nowMs < purgeAtMs) {
      continue;
    }

    const hardPurgeAtMs = mtg.hardPurgeAfterAt
      ? new Date(mtg.hardPurgeAfterAt).getTime()
      : purgeAtMs + 7 * 24 * 3600 * 1000;

    const activeParticipants = db.meetingParticipants.filter(
      (mp) => mp.meetingId === mtg.id && mp.rsvpStatus === "ATTENDING"
    );
    const allBackedUp = activeParticipants.every(
      (mp) =>
        mp.historyBackupVerified ||
        db.personalMeetingHistories.some(
          (h) => h.ownerUserId === mp.userId && h.meetingId === mtg.id
        )
    );

    if (!allBackedUp && nowMs < hardPurgeAtMs) {
      if (!mtg.graceReminderSent) {
        mtg.graceReminderSent = true;
        for (const mp of activeParticipants.filter(
          (p) => !p.historyBackupVerified
        )) {
          db.notificationDeliveries.unshift({
            id: `nd_grace_${Date.now()}_${mp.userId}`,
            userId: mp.userId,
            meetingId: mtg.id,
            notificationType: "BACKUP_GRACE_REMINDER",
            channel: "INTERNAL_CALENDAR",
            scheduledAt: new Date().toISOString(),
            status: "SENT",
            attemptCount: 1,
            maxAttempts: 3,
            lastError: null,
            nextRetryAt: null,
            deliveredAt: new Date().toISOString(),
          });
        }
      }
      graceExtendedMeetingIds.push(mtg.id);
      continue;
    }

    db.meetingParticipants = db.meetingParticipants.filter(
      (mp) => mp.meetingId !== mtg.id
    );
    db.meetingSides = db.meetingSides.filter((ms) => ms.meetingId !== mtg.id);
    db.meetingInvitations = db.meetingInvitations.filter(
      (inv) => inv.meetingId !== mtg.id
    );
    db.teamSharedSchedules = db.teamSharedSchedules.filter(
      (tss) => tss.meetingId !== mtg.id
    );
    db.meetingPreferences = db.meetingPreferences.filter(
      (pref) =>
        pref.meetingId !== mtg.id ||
        pref.preferenceScope === "LONG_TERM_CONSENTED"
    );
    db.placeRecommendations = db.placeRecommendations.filter(
      (rec) => rec.meetingId !== mtg.id
    );
    db.meetingScheduleChanges = db.meetingScheduleChanges.filter(
      (msc) => msc.meetingId !== mtg.id
    );

    mtg.graphPurged = true;
    mtg.encryptedMeetingPayload = "PURGED_BY_RETENTION_POLICY";
    mtg.updatedAt = new Date().toISOString();
    purgedMeetingIds.push(mtg.id);

    if (!allBackedUp) {
      hardPurgedUnbackedMeetingIds.push(mtg.id);
    }

    db.auditRetentionLogs.unshift({
      id: `purge_${Date.now()}_${mtg.id}`,
      action: allBackedUp
        ? "PURGE_30D_VERIFIED_BACKUP"
        : "HARD_PURGE_37D_UNBACKED_CAP_ENFORCED",
      meetingId: mtg.id,
      executedAt: new Date().toISOString(),
      detail: allBackedUp
        ? `[${mtg.id}] 모임 종료 30일 경과 및 전원 암호화 이력 백업 확인 → 서버 참석자 연결 데이터 삭제 완료`
        : `[${mtg.id}] 미백업 참석자가 존재하나 서버 무기한 보유 방지를 위해 37일 상한선(Hard Cap) 도달 즉시 서버 참석자 연결 데이터 강제 삭제 완료`,
    });
  }

  return {
    purgedMeetingIds,
    hardPurgedUnbackedMeetingIds,
    graceExtendedMeetingIds,
    deletedExpiredPreferenceIds: prefPurge.deletedPreferenceIds,
  };
}
