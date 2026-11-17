// ============================================================================
// TEAMYAK (팀약) — 15 Core Entities Type Definitions
// ============================================================================

export type OrgType = "ENTERPRISE" | "MEDIA" | "INSTITUTION" | "ASSOCIATION" | "OTHER";
export type TeamVerificationStatus = "UNVERIFIED" | "DOMAIN_VERIFIED" | "OFFICIAL_APPROVED";
export type MembershipRole = "ADMIN" | "MEMBER";
export type MembershipStatus = "ACTIVE" | "INVITED" | "LEFT";
export type PlaceCategory = "RESTAURANT" | "CAFE" | "HOTEL" | "MEETING_ROOM" | "OFFICE" | "OTHER";
export type MeetingStatus = "SCHEDULING" | "RECRUITING" | "CONFIRMED" | "COMPLETED" | "CANCELED";
export type MeetingSideType = "HOST" | "GUEST";
export type VisibilityScope = "PRIVATE_PARTICIPANTS_ONLY" | "TEAM_SHARED";
export type SideRole = "REPRESENTATIVE" | "PARTICIPANT";
export type RsvpStatus = "ATTENDING" | "TENTATIVE" | "DECLINED" | "PENDING_APPROVAL";
export type AttendanceCheck = "UNCONFIRMED" | "VERIFIED_ATTENDED" | "NO_SHOW";
export type CalendarProvider = "INTERNAL" | "GOOGLE" | "ICS_FEED";

// 1. User
export interface User {
  id: string;
  kakaoId: string;
  displayName: string;
  jobTitle: string;
  email?: string;
  personaRole: "PR_HOST_REP" | "PR_TEAM_MEMBER" | "PRESS_GUEST_REP" | "PRESS_TEAM_MEMBER" | "FORWARDED_GUEST" | "SYSTEM_ADMIN";
  avatarColor: string;
  encryptionPublicKey: string;
}

// 2. Organization
export interface Organization {
  id: string;
  canonicalName: string;
  aliases: string[]; // 예: ['한국은행', '한은', 'BOK']
  orgType: OrgType;
  verifiedDomains: string[];
}

// 3. Team
export interface Team {
  id: string;
  organizationId: string;
  name: string;
  verificationStatus: TeamVerificationStatus;
  verifiedDomain?: string;
  createdBy: string;
}

// 4. TeamMembership
export interface TeamMembership {
  id: string;
  teamId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus; // ACTIVE | INVITED | LEFT (이직/부서이동 분리)
  joinedAt: string;
  leftAt?: string;
}

// 5. Place
export interface Place {
  id: string;
  naverPlaceId: string;
  name: string;
  category: PlaceCategory;
  roadAddress: string;
  jibunAddress: string;
  areaSummary: string; // 비로그인 프리뷰용 요약 지역명 (예: 여의도)
  latitude: number;
  longitude: number;
  naverMapUrl: string;
  externalBookingUrl?: string;
  officialInfoSummary: string;
}

// 6. Meeting
export interface Meeting {
  id: string;
  title: string;
  status: MeetingStatus;
  confirmedDate?: string; // YYYY-MM-DD
  candidateDates: string[];
  startTime?: string; // HH:mm
  endTime?: string;   // HH:mm
  isTimeTbd: boolean;
  placeId?: string;
  placeTbdHint?: string;
  description?: string;
  maxParticipants?: number;
  rsvpDeadline?: string;
  sequenceVersion: number; // 시간/장소 변경 시 +1 (캘린더 중복 생성 없이 업데이트)
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// 7. MeetingSide (호스트 측 vs 게스트 측)
export interface MeetingSide {
  id: string;
  meetingId: string;
  sideType: MeetingSideType;
  organizationId?: string;
  teamId?: string;
  representativeUserId?: string;
  sideLabel: string;
  proposedTimeChange?: {
    proposedDate: string;
    proposedStartTime: string;
    reason: string;
    proposedByUserId: string;
  };
}

// 8. MeetingVisibility (양측 독립적 팀 공유 설정)
export interface MeetingVisibility {
  id: string;
  meetingSideId: string;
  teamId?: string;
  shareScope: VisibilityScope;
  shareParticipantNamesToTeam: boolean;
  decidedBy: string;
  updatedAt: string;
}

// 9. MeetingParticipant
export interface MeetingParticipant {
  id: string;
  meetingId: string;
  meetingSideId: string;
  userId: string;
  roleInSide: SideRole;
  rsvpStatus: RsvpStatus;
  attendanceCheck: AttendanceCheck;
  isForwardedGuest?: boolean;
  respondedAt: string;
}

// 10. MeetingInvitation
export interface MeetingInvitation {
  id: string;
  meetingId: string;
  meetingSideId: string;
  tokenHash: string;
  inviteCode: string; // URL 경로 토큰 (개인정보 미포함)
  intendedTargetHint: string;
  requireHostApprovalOnForward: boolean;
  expiresAt: string;
}

// 11. MeetingHistory (개인 소유 미팅 이력)
export interface MeetingHistory {
  id: string;
  ownerUserId: string;
  meetingId?: string;
  counterpartOrganizationId: string;
  meetingDate: string;
  meetingTitleSnapshot: string;
  attendanceVerified: boolean;
  encryptedPrivateMemo?: string; // AES-256-GCM Base64 암호문
  memoIv?: string;               // Base64 IV
  plaintextMemoPreviewForOwner?: string; // 로컬 복호화 캐시(소유자 기기에서만 복호화 표시)
  sharedToTeamId?: string;       // 명시적으로 팀 기관 이력에 공개 승인한 경우에만 존재
}

// 12. OrganizationContact (기관별 접촉 요약)
export interface OrganizationContact {
  id: string;
  ownerUserId?: string;
  ownerTeamId?: string;
  targetOrganizationId: string;
  lastMetDate: string;
  encryptedContactNote?: string;
}

// 13. CalendarConnection
export interface CalendarConnection {
  id: string;
  userId: string;
  provider: CalendarProvider;
  writeConsent: boolean;
  connectedEmail?: string;
  externalEventMappings: Record<string, string>; // meetingId -> externalEventId
}

// 14. NotificationPreference
export interface NotificationPreference {
  userId: string;
  morningBriefingEnabled: boolean;
  morningBriefingTime: string; // 기본 "08:00"
  notifyOnScheduleChange: boolean;
  preferExternalCalendarAlarm: boolean;
  webPushEnabled: boolean;
}

// 15. NewsKeyword & NewsItem
export interface NewsKeyword {
  id: string;
  teamId?: string;
  organizationId: string;
  keyword: string;
  isPrimary: boolean;
  createdBy: string;
}

export interface NewsArticle {
  id: string;
  organizationId: string;
  matchedKeyword: string;
  title: string;
  pressName: string;
  publishedAt: string;
  originalUrl: string;
  summarySnippet: string; // 본문 무단 복제 금지, 검색 API 요약문만 표시
}
