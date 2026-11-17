/**
 * TEAMYAK — Cross-Platform Client SDK (@teamyak/client)
 * 
 * [설계 및 보안 원칙]
 * 1. Framework-Agnostic: Next.js 모바일 웹과 향후 iOS/Android 네이티브 앱(React Native / Expo / Flutter / Swift / Kotlin)이
 *    동일하게 임포트하여 사용할 수 있는 순수 TypeScript isomorphic 클라이언트 SDK.
 * 2. Universal Auth & Secure Storage:
 *    - 웹 브라우저: HttpOnly Cookie 자동 유지 (token 미지정 시 Authorization 헤더를 누락하여 쿠키 인증 유지).
 *    - 모바일 네이티브: OS 보안 저장소(iOS Keychain / Android EncryptedSharedPreferences / Expo SecureStore) 어댑터 지원.
 *    - Token Sanitization: Bearer Token, 세션 ID, 프래그먼트 키가 오류 메시지나 스택 추적에 노출되지 않도록 마스킹 처리.
 * 3. Production Hardening:
 *    - 개발/샌드박스 편의를 위한 loginWithTestAccount()는 프로덕션(APP_ENV=production) 환경에서 호출 시 즉각 차단.
 * 4. Multi-Device Session Isolation:
 *    - 인스턴스별 상태 격리: 클라이언트 인스턴스 간 인증 토큰 및 캐시 혼합 원천 방지 (서버 SSR/API 동시 호출 안전).
 *    - 기기별 세션 독립 폐기(REVOKE_DEVICE_SESSION) 지원.
 * 5. Zero-Knowledge Crypto Bridge:
 *    - W3C SubtleCrypto 표준 기반 클라이언트 암호화/복호화 기능 및 플랫폼별 암호화 어댑터 규격 내장.
 */

import {
  generateFragmentKey,
  encryptMeetingPayload,
  decryptMeetingPayload,
  encryptHistoryBlob,
  decryptHistoryBlob,
} from "../crypto.ts";
import type {
  SensitiveMeetingPayload,
  SensitiveHistoryPayload,
  SeniorityLevel,
} from "../crypto.ts";

/**
 * 모바일 OS 보안 저장소 어댑터 인터페이스
 * - Web: In-Memory / sessionStorage
 * - Native: Expo SecureStore / react-native-keychain
 */
export interface TeamyakTokenStorage {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
}

export interface TeamyakClientConfig {
  baseUrl?: string;
  token?: string | null;
  storage?: TeamyakTokenStorage;
  storageKey?: string;
  onTokenChange?: (token: string | null) => void;
  fetchFn?: typeof fetch;
}

/**
 * 민감 토큰 및 암호화 키 마스킹 헬퍼
 * - 오류 메시지, 로그 등에 Bearer 토큰이나 세션 토큰, #k= 키가 평문 노출되는 것 방지
 */
function sanitizeSecurityTokens(msg: string): string {
  if (!msg || typeof msg !== "string") return msg;
  return msg
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [MASKED]")
    .replace(/sess_[A-Za-z0-9_\-]+/gi, "sess_[MASKED]")
    .replace(/tyfeed_[A-Za-z0-9_\-]+/gi, "tyfeed_[MASKED]")
    .replace(/#k=[A-Za-z0-9]+/gi, "#k=[MASKED]");
}

export class TeamyakClient {
  private baseUrl: string;
  private token: string | null;
  private storage?: TeamyakTokenStorage;
  private storageKey: string;
  private onTokenChange?: (token: string | null) => void;
  private fetchFn: typeof fetch;

  constructor(config: TeamyakClientConfig = {}) {
    this.baseUrl = config.baseUrl || "";
    this.token = config.token || null;
    this.storage = config.storage;
    this.storageKey = config.storageKey || "teamyak_auth_token_v37";
    this.onTokenChange = config.onTokenChange;
    this.fetchFn = config.fetchFn || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : (undefined as any));
  }

  /**
   * 보안 저장소로부터 인증 토큰 복원 (네이티브 앱 시작 시 호출)
   */
  public async initFromStorage(): Promise<string | null> {
    if (!this.storage) return this.token;
    try {
      const stored = await this.storage.getItem(this.storageKey);
      if (stored) {
        this.setToken(stored);
        return stored;
      }
    } catch {
      // 보안 저장소 접근 불가 시 조용히 무시
    }
    return null;
  }

  public setToken(token: string | null) {
    this.token = token;
    if (this.storage) {
      if (token) {
        Promise.resolve(this.storage.setItem(this.storageKey, token)).catch(() => {});
      } else {
        Promise.resolve(this.storage.removeItem(this.storageKey)).catch(() => {});
      }
    }
    if (this.onTokenChange) {
      this.onTokenChange(token);
    }
  }

  public getToken(): string | null {
    return this.token;
  }

  private async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    // [보안 원칙] 토큰이 명시적으로 주입된 경우에만 Bearer 헤더 추가.
    // 웹 브라우저 환경에서는 Authorization 헤더가 없으면 브라우저의 HttpOnly 쿠키로 자동 인증됨.
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    try {
      const res = await this.fetchFn(url, {
        ...options,
        headers,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const rawMsg = data.message || data.error || `HTTP ${res.status}`;
        const sanitizedMsg = sanitizeSecurityTokens(rawMsg);
        const error = new Error(sanitizedMsg);
        (error as any).status = res.status;
        (error as any).data = data;
        throw error;
      }

      return data as T;
    } catch (err: any) {
      if (err.message) {
        err.message = sanitizeSecurityTokens(err.message);
      }
      throw err;
    }
  }

  // ==========================================================================
  // 1. 인증 및 세션 관리 (Authentication & Multi-Device Sessions)
  // ==========================================================================
  
  /**
   * [보안 가드] 테스트 계정 로그인
   * - 프로덕션 환경(APP_ENV=production 또는 NODE_ENV=production)에서는 즉시 차단
   */
  public async loginWithTestAccount(userId: string) {
    if (
      typeof process !== "undefined" &&
      (process.env?.APP_ENV === "production" || process.env?.NODE_ENV === "production")
    ) {
      throw new Error(
        "TEST_LOGIN_DISABLED_IN_PRODUCTION: 프로덕션 환경에서는 테스트 계정 로그인이 비활성화되어 있습니다. 카카오 OAuth를 이용해 주세요."
      );
    }

    const res = await this.request("/api/auth", {
      method: "POST",
      body: JSON.stringify({ action: "LOGIN_ACCOUNT", userId }),
    });
    if (res.sessionToken) {
      this.setToken(res.sessionToken);
    }
    return res;
  }

  public async getMe() {
    return this.request("/api/auth?mode=me");
  }

  /**
   * 로그아웃 (현재 기기 세션 폐기 및 저장소 삭제)
   */
  public async logout() {
    try {
      await this.request("/api/auth", {
        method: "POST",
        body: JSON.stringify({ action: "LOGOUT" }),
      });
    } finally {
      this.setToken(null);
    }
  }

  /**
   * 기기별 세션 독립 폐기 (특정 기기 원격 로그아웃)
   */
  public async revokeDeviceSession(targetSessionId: string) {
    return this.request("/api/auth", {
      method: "POST",
      body: JSON.stringify({ action: "REVOKE_DEVICE_SESSION", targetSessionId }),
    });
  }

  /**
   * 현재 계정의 활성 기기 세션 목록 조회
   */
  public async getActiveSessions() {
    return this.request("/api/auth", {
      method: "POST",
      body: JSON.stringify({ action: "GET_ACTIVE_SESSIONS" }),
    });
  }

  // ==========================================================================
  // 2. 모임 관리 (Meetings & Independent Projections)
  // ==========================================================================
  public async getMeetings() {
    return this.request("/api/meetings");
  }

  public async getMeeting(id: string) {
    return this.request(`/api/meetings/${id}`);
  }

  public async createMeeting(payload: {
    hostOrgBadge: string;
    confirmedDate: string;
    startTime: string;
    endTime: string;
    areaHint: string;
    candidateDates?: string[];
    isTimeTbd?: boolean;
    isPlaceTbd?: boolean;
    placeId?: string | null;
    encryptedMeetingPayload: string;
    payloadIv: string;
    fragmentKey?: string;
  }) {
    return this.request("/api/meetings", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  public async updateSchedule(
    meetingId: string,
    data: {
      confirmedDate?: string;
      startTime?: string;
      endTime?: string;
      areaHint?: string;
      changeReason?: string;
      reasonIsPrivate?: boolean;
      encryptedMeetingPayload?: string;
      payloadIv?: string;
    }
  ) {
    return this.request(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "UPDATE_SCHEDULE", ...data }),
    });
  }

  public async toggleCancel(meetingId: string) {
    return this.request(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "TOGGLE_CANCEL" }),
    });
  }

  public async toggleVisibility(meetingId: string, sideType: "HOST" | "GUEST") {
    return this.request(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "TOGGLE_VISIBILITY", sideType }),
    });
  }

  public async reconfirmSchedule(
    meetingId: string,
    reconfirmResponse: "CONFIRMED_NEW_DATE" | "TENTATIVE" | "DECLINED"
  ) {
    return this.request(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "RECONFIRM_SCHEDULE", reconfirmResponse }),
    });
  }

  public async completeMeeting(meetingId: string) {
    return this.request(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "COMPLETE_MEETING" }),
    });
  }

  // ==========================================================================
  // 3. 초대장 & 참석 수락 (Invitations & 2-Step Gate)
  // ==========================================================================
  public async getInvitation(code: string) {
    return this.request(`/api/invitations/${code}`);
  }

  public async submitRsvp(
    code: string,
    data: {
      rsvpStatus: "ATTENDING" | "TENTATIVE" | "DECLINED";
      confirmedAfterSeniorityReview?: boolean;
    }
  ) {
    return this.request(`/api/invitations/${code}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ==========================================================================
  // 4. 캘린더 연동 (Apple Calendar Webcal & Google Calendar)
  // ==========================================================================
  public async getAppleCalendar() {
    return this.request("/api/calendar/apple");
  }

  public async postAppleCalendarAction(
    action: "REGENERATE_TOKEN" | "REVOKE_FEED" | "ENABLE_FEED" | "UPDATE_PRIVACY",
    extra: Record<string, any> = {}
  ) {
    return this.request("/api/calendar/apple", {
      method: "POST",
      body: JSON.stringify({ action, ...extra }),
    });
  }

  public async syncGoogleCalendar(meetingId: string) {
    return this.request("/api/calendar/google", {
      method: "POST",
      body: JSON.stringify({ action: "SYNC_EVENT", meetingId }),
    });
  }

  // ==========================================================================
  // 5. 개인 이력, 알림, AI 장소 추천, 뉴스
  // ==========================================================================
  public async getHistories() {
    return this.request("/api/histories");
  }

  public async getNotifications() {
    return this.request("/api/notifications");
  }

  public async searchPlaces(q: string, area?: string) {
    const params = new URLSearchParams({ q });
    if (area) params.set("area", area);
    return this.request(`/api/places/search?${params.toString()}`);
  }

  public async getNews(q: string) {
    return this.request(`/api/news?q=${encodeURIComponent(q)}`);
  }

  // ==========================================================================
  // 6. 클라이언트 암호화 헬퍼 (Cross-Platform Web Crypto API)
  // ==========================================================================
  public static crypto = {
    generateFragmentKey,
    encryptMeetingPayload,
    decryptMeetingPayload,
    encryptHistoryBlob,
    decryptHistoryBlob,
  };
}
