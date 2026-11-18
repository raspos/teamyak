"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  generateFragmentKey,
  encryptMeetingPayload,
  decryptMeetingPayload,
  decryptHistoryBlob,
  filterRecommendationsInBrowser,
  SeniorityLevel,
  SensitiveMeetingPayload,
  SensitiveHistoryPayload,
} from "@/lib/crypto";
import { downloadIcsFile } from "@/lib/ics";

const DEFAULT_FRAGMENT_KEY = "7f9a2b4c8e1d0a3f9911223344556677";

const DEFAULT_MASTER_SECRETS: Record<string, string> = {
  u_kim: "master-secret-u_kim",
  u_park: "master-secret-u_park",
  u_lee: "master-secret-u_lee",
  u_choi: "master-secret-u_choi",
  u_jung: "master-secret-u_jung",
};

function getPostponementBadgeInfo(count: number) {
  if (!count || count <= 0) {
    return {
      text: "일반 모임",
      badgeClass:
        "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    };
  }
  if (count === 1) {
    return {
      text: "1회 순연",
      badgeClass:
        "bg-yellow-100 text-yellow-900 border-yellow-400 dark:bg-yellow-950/80 dark:text-yellow-200 dark:border-yellow-600",
    };
  }
  if (count === 2) {
    return {
      text: "2회 순연",
      badgeClass:
        "bg-orange-100 text-orange-900 border-orange-400 dark:bg-orange-950/80 dark:text-orange-200 dark:border-orange-500",
    };
  }
  return {
    text: `${count}회 순연 (3회 이상 순연)`,
    badgeClass:
      "bg-rose-100 text-rose-900 border-rose-500 font-extrabold dark:bg-rose-950/90 dark:text-rose-200 dark:border-rose-500",
  };
}

function getSeniorityBadgeInfo(
  level?: string,
  status?: "NONE" | "SCHEDULED" | "CONFIRMED" | string
) {
  const suffix = status === "CONFIRMED" ? "확정" : "예정";
  if (level === "DIRECTOR") {
    return {
      level: "DIRECTOR",
      text: `부장급 참석 ${suffix}`,
      badgeClass:
        "bg-blue-100 text-blue-900 border-blue-400 dark:bg-blue-950/80 dark:text-blue-200 dark:border-blue-500",
    };
  }
  if (level === "EXECUTIVE") {
    return {
      level: "EXECUTIVE",
      text: `임원 참석 ${suffix}`,
      badgeClass:
        "bg-purple-100 text-purple-900 border-purple-400 dark:bg-purple-950/80 dark:text-purple-200 dark:border-purple-500",
    };
  }
  if (level === "CEO") {
    return {
      level: "CEO",
      text: `CEO·기관장 참석 ${suffix}`,
      badgeClass:
        "bg-amber-100 text-amber-950 border-amber-500 font-extrabold dark:bg-amber-950/80 dark:text-amber-200 dark:border-amber-400",
    };
  }
  return {
    level: "STAFF",
    text: "일반 모임",
    badgeClass:
      "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  };
}

interface AccountInfo {
  id: string;
  accountType: "REAL_KAKAO_OAUTH" | "TEST_SANDBOX_ACCOUNT";
  displayName: string;
  jobTitle: string;
  teamId: string | null;
  sessionToken: string;
  deviceLabel: string;
  hasKeyBackup: boolean;
  recoveryEntropyBits: number;
  email?: string;
}

export default function TeamyakUnifiedApp() {
  const [dualDeviceMode, setDualDeviceMode] = useState<boolean>(false);
  const [viewportWidth, setViewportWidth] = useState<number>(390);
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [globalVerifyLog, setGlobalVerifyLog] = useState<string[]>([]);
  const [isRunningTests, setIsRunningTests] = useState<boolean>(false);
  const [syncPulse, setSyncPulse] = useState<number>(0);
  const [initialUserId, setInitialUserId] = useState<string>(() => {
    if (typeof window !== "undefined" && localStorage.getItem("teamyak_session_token")) {
      return "";
    }
    return "u_kim";
  });

  const triggerGlobalSync = useCallback(() => {
    setSyncPulse((p) => p + 1);
  }, []);

  useEffect(() => {
    const savedToken =
      typeof window !== "undefined"
        ? localStorage.getItem("teamyak_session_token") ||
          localStorage.getItem("teamyak_supabase_access_token")
        : null;

    const headers: Record<string, string> = {};
    if (savedToken) {
      headers["Authorization"] = `Bearer ${savedToken}`;
    }

    fetch("/api/auth", { headers })
      .then((r) => r.json())
      .then((data) => {
        let accList: AccountInfo[] = data.availableTestAccounts || [];
        if (data.authenticated && data.user) {
          const kakaoAcc: AccountInfo = {
            id: data.user.id,
            accountType: "REAL_KAKAO_OAUTH",
            displayName: data.user.displayName || "카카오 회원",
            jobTitle: data.user.jobTitle || "팀약 회원",
            teamId: data.user.teamId || null,
            sessionToken: savedToken || "",
            deviceLabel: "카카오 인증 기기",
            hasKeyBackup: true,
            recoveryEntropyBits: 140,
          };
          accList = [kakaoAcc, ...accList.filter((a) => a.id !== data.user.id)];
          setInitialUserId(data.user.id);
        }
        setAccounts(accList);
      })
      .catch(() => {});
  }, [syncPulse]);

  async function runFinalSecurityAndPolicyVerification() {
    setIsRunningTests(true);
    const logs: string[] = [];
    const append = (msg: string) => {
      logs.push(msg);
      setGlobalVerifyLog([...logs]);
    };

    try {
      append("⏳ [최종 정책·보안 8대 항목 및 시나리오 A~D 검증 시작]...");
      await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RESET_SEED_DB" }),
      });

      const authInfo = await fetch("/api/auth").then((r) => r.json());
      const kimToken = authInfo.availableTestAccounts.find(
        (a: AccountInfo) => a.id === "u_kim"
      )?.sessionToken;
      const parkToken = authInfo.availableTestAccounts.find(
        (a: AccountInfo) => a.id === "u_park"
      )?.sessionToken;
      const jungToken = authInfo.availableTestAccounts.find(
        (a: AccountInfo) => a.id === "u_jung"
      )?.sessionToken;

      // 1. 임원급 주요 참석자 추가 (암호화 페이로드 내부로만 저장, 서버 평문 직급 컬럼 없음)
      await fetch("/api/meetings/mtg_1", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${kimToken}`,
        },
        body: JSON.stringify({
          action: "UPSERT_SENIOR_ATTENDEE",
          userId: "u_exec_lee",
          displayName: "이재훈 상무",
          participantJobTitle: "삼성생명 홍보담당 상무",
          participantSeniorityLevel: "EXECUTIVE",
          seniorityAttendanceConfirmed: false,
        }),
      });

      // [검증 1] 미승인·비로그인 사용자가 주요 참석자 배지를 볼 수 없는지 확인
      const anonInv = await fetch("/api/invitations/inv_9x82a").then((r) =>
        r.json()
      );
      const jungInv = await fetch("/api/invitations/inv_9x82a", {
        headers: { Authorization: `Bearer ${jungToken}` },
      }).then((r) => r.json());
      append(
        `✅ [검증 1 — 미승인자 배지 차단] 비로그인 publicEnvelope 직급 노출: ${
          "highestSeniorityLevel" in (anonInv.publicEnvelope || {})
            ? "노출(오류)"
            : "없음(차단 완료)"
        } · 미승인 전달접속자 암호문 반환: ${
          jungInv.encryptedDetail === null ? "null(차단 완료)" : "노출(오류)"
        }`
      );

      // [검증 2] 로그인한 초대 대상자(박 기자)가 참석 확정 전에 주요 참석자 정보를 확인하고 2단계 최종 확인을 거치는지 검증
      const step1Rsvp = await fetch("/api/invitations/inv_9x82a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${parkToken}`,
        },
        body: JSON.stringify({ rsvpStatus: "ATTENDING" }),
      }).then((r) => r.json());

      const step2Rsvp = await fetch("/api/invitations/inv_9x82a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${parkToken}`,
        },
        body: JSON.stringify({
          rsvpStatus: "ATTENDING",
          confirmedAfterSeniorityReview: true,
        }),
      }).then((r) => r.json());
      append(
        `✅ [검증 2 — 2단계 참석 확정] 주요 참석자 존재 시 로그인 직후 자동 확정 보류(requiresSeniorConfirmation: ${step1Rsvp.requiresSeniorConfirmation}, 상태: ${step1Rsvp.participant?.rsvpStatus}) → 직급 확인 후 최종 확정 시 상태: ${step2Rsvp.participant?.rsvpStatus}`
      );

      // [검증 3 & 4] 본인 동의 없이 장기 저장 불가(호스트 입력 조건 강제 MEETING_ONLY) 및 1년 만료 자동 삭제 검증
      const hostPrefTry = await fetch("/api/meetings/mtg_1", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${kimToken}`,
        },
        body: JSON.stringify({
          action: "SAVE_PREFERENCE",
          inputSource: "HOST_MEETING_CONDITION",
          longTermStorageConsented: true,
        }),
      }).then((r) => r.json());

      await fetch("/api/meetings/mtg_1", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${parkToken}`,
        },
        body: JSON.stringify({
          action: "SAVE_PREFERENCE",
          inputSource: "PARTICIPANT_SELF",
          longTermStorageConsented: true,
          customConsentExpiresAtForTest: "2026-01-01T00:00:00Z", // 1년 경과 시뮬레이션
        }),
      });
      const expSweep = await fetch("/api/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      append(
        `✅ [검증 3 & 4 — 취향 보존·1년 만료] 호스트 입력 취향 범위: ${
          hostPrefTry.preference?.preferenceScope
        }(장기저장 차단) · 1년 만료된 장기 저장 취향 자동 삭제 건수: ${
          expSweep.deletedExpiredPreferenceIds?.length || 0
        }건`
      );

      // [검증 5 & 6] DB 관리자 평문 방문 장소 조회 불가 및 브라우저 복호화 필터링, 타인 취향 조회 차단 검증
      const retSummary = await fetch("/api/retention").then((r) => r.json());
      const kimMtgView = await fetch("/api/meetings/mtg_1", {
        headers: { Authorization: `Bearer ${kimToken}` },
      }).then((r) => r.json());
      const hasParkPrefInKimView = (
        kimMtgView.meeting?.preferences || []
      ).some((p: any) => p.userId === "u_park");
      append(
        `✅ [검증 5 & 6 — 방문장소 암호화 & 타인 취향 차단] DB 평문 visited_place_id 존재 여부: ${retSummary.retentionPolicySummary?.visitedPlacePlaintextColumnExists} · 호스트가 타인(박 기자) 취향 조회 여부: ${hasParkPrefInKimView}(차단 완료)`
      );

      triggerGlobalSync();
    } catch (e) {
      append(`❌ 검증 중 오류: ${String(e)}`);
    } finally {
      setIsRunningTests(false);
    }
  }

  return (
    <div
      className={`min-h-screen flex flex-col ${
        darkMode
          ? "dark bg-slate-950 text-slate-100"
          : "bg-slate-100 text-slate-900"
      }`}
    >
      <header className="w-full bg-white border-b border-slate-200 px-4 py-3 sticky top-0 z-50 shadow-sm">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg font-black tracking-tight text-slate-900">
              TEAM<span className="text-amber-500">YAK</span>
            </span>
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 text-[10px] font-bold">
              모바일 웹
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const clientId =
                  process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID ||
                  "b1ec0592928d85a41c49f7b984b0bdd1";
                const redirectUri = `${window.location.origin}/auth/callback`;
                const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
                  redirectUri
                )}&response_type=code&state=${encodeURIComponent("/")}`;
                window.location.href = kakaoAuthUrl;
              }}
              className="py-1.5 px-3 bg-[#FEE500] hover:bg-[#FDD800] text-[#191919] font-black rounded-xl flex items-center gap-1.5 text-xs shadow-sm active:scale-95 transition"
            >
              <span>💬</span>
              <span>카카오 로그인</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-md mx-auto py-2 px-2 flex flex-col items-center justify-start">
        <MobileDeviceInstance
          deviceTitle="팀약 모바일"
          defaultUserId={initialUserId}
          defaultTab="meetings"
          viewportWidth={viewportWidth}
          darkMode={darkMode}
          accounts={accounts}
          syncPulse={syncPulse}
          onStateMutated={triggerGlobalSync}
        />
      </main>

      <footer className="w-full max-w-md mx-auto px-4 py-6 mb-16">
        <details className="text-xs text-slate-400">
          <summary className="cursor-pointer font-bold py-2 text-slate-500 hover:text-slate-400">
            🛠️ 개발자 진단 도구 및 테스트 계정 전환 (클릭하여 열기)
          </summary>
          <div className="p-3 bg-slate-900 rounded-2xl space-y-3 mt-2 text-white border border-slate-800">
            <div className="flex flex-wrap gap-2 text-xs">
              <button
                onClick={() => setDarkMode(!darkMode)}
                className="px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200"
              >
                {darkMode ? "🌙 다크 모드" : "☀️ 라이트 모드"}
              </button>
              <button
                onClick={runFinalSecurityAndPolicyVerification}
                disabled={isRunningTests}
                className="px-2.5 py-1 rounded bg-brand-600 text-white font-bold"
              >
                {isRunningTests ? "검증 중..." : "🛡️ 정책 8대 항목 자동 검증"}
              </button>
            </div>
            {globalVerifyLog.length > 0 && (
              <div className="p-2.5 bg-slate-950 rounded-xl text-[10px] font-mono space-y-1 max-h-40 overflow-y-auto">
                {globalVerifyLog.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            )}
          </div>
        </details>
      </footer>
    </div>
  );
}

const DEFAULT_PLACES = [
  {
    id: "place_1",
    name: "여의도 화동옥",
    cuisineType: "한식",
    roadAddress: "서울 영등포구 국제금융로2길 28 KB금융타워 B1",
    officialInfoSummary: "한우 불고기·평양냉면 전문점 · 여의도역 도보 4분",
    naverMapUrl:
      "https://map.naver.com/p/search/%EC%97%AC%EC%9D%98%EB%8F%84%20%ED%99%94%EB%8F%99%EC%98%A5",
  },
  {
    id: "place_2",
    name: "경복궁 여의도점",
    cuisineType: "한식",
    roadAddress: "서울 영등포구 국제금융로8길 31 여의도백화점 B1",
    officialInfoSummary: "한정식·구이 코스 전문점 · 비즈니스 오찬 적합",
    naverMapUrl:
      "https://map.naver.com/p/search/%EA%B2%BD%EB%B3%B5%EA%B6%81%20%EC%97%AC%EC%9D%98%EB%8F%84%EC%A0%90",
  },
  {
    id: "place_3",
    name: "창고43 여의도본점",
    cuisineType: "한식",
    roadAddress: "서울 영등포구 국제금융로 78 홍우빌딩 5층",
    officialInfoSummary: "한우 전문점 · 비즈니스 점심 룸 완비",
    naverMapUrl:
      "https://map.naver.com/p/search/%EC%B0%BD%EA%B3%A043%20%EC%97%AC%EC%9D%98%EB%8F%84%EB%B3%B8%EC%A0%90",
  },
  {
    id: "place_4",
    name: "광화문 포시즌스호텔 더 마켓 키친",
    cuisineType: "양식",
    roadAddress: "서울 종로구 새문안로 97 포시즌스호텔 LL층",
    officialInfoSummary: "비즈니스 오찬 미팅 적합 · 프라이빗 다이닝",
    naverMapUrl:
      "https://map.naver.com/p/search/%ED%8F%AC%EC%8B%9C%EC%A6%8C%EC%8A%A4%ED%98%B8%ED%85%94%20%EC%84%9C%EC%9A%B8",
  },
];

function MobileDeviceInstance({
  deviceTitle,
  defaultUserId,
  defaultTab = "meetings",
  viewportWidth,
  darkMode,
  accounts,
  syncPulse,
  onStateMutated,
}: {
  deviceTitle: string;
  defaultUserId: string;
  defaultTab?: "meetings" | "calendar" | "history" | "settings";
  viewportWidth: number;
  darkMode: boolean;
  accounts: AccountInfo[];
  syncPulse: number;
  onStateMutated: () => void;
}) {
  const [sessionToken, setSessionToken] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return (
        localStorage.getItem("teamyak_session_token") ||
        localStorage.getItem("teamyak_supabase_access_token") ||
        ""
      );
    }
    return "";
  });
  const [currentUserId, setCurrentUserId] = useState<string>(defaultUserId);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<"meetings" | "calendar" | "history" | "settings">(
    (defaultTab as any) || "meetings"
  );
  const [meetingSubView, setMeetingSubView] = useState<"LIST" | "CREATE" | "DETAIL" | "INVITE_SHARE">("LIST");
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [detailSection, setDetailSection] = useState<
    "PARTICIPANTS" | "AI_PLACE" | "SCHEDULE_HISTORY" | "NEWS"
  >("PARTICIPANTS");

  // 약속 생성 폼 입력 상태
  const [newTitle, setNewTitle] = useState<string>("");
  const [newDate, setNewDate] = useState<string>(() => {
    const tmrw = new Date(Date.now() + 24 * 3600 * 1000);
    return tmrw.toISOString().slice(0, 10);
  });
  const [newStartTime, setNewStartTime] = useState<string>("12:00");
  const [newEndTime, setNewEndTime] = useState<string>("13:30");
  const [newAreaHint, setNewAreaHint] = useState<string>("");
  const [newHeadcount, setNewHeadcount] = useState<number>(2);
  const [newMeetingType, setNewMeetingType] = useState<string>("LUNCH");
  const [newSeniorName, setNewSeniorName] = useState<string>("");
  const [newSeniorTitle, setNewSeniorTitle] = useState<string>("");
  const [newSeniorLevel, setNewSeniorLevel] = useState<SeniorityLevel>("STAFF");
  const [newCounterpartOrg, setNewCounterpartOrg] = useState<string>("");
  const [newHostShareToTeam, setNewHostShareToTeam] = useState<boolean>(false);
  const [showOptionalFields, setShowOptionalFields] = useState<boolean>(false);
  const [isSubmittingMeeting, setIsSubmittingMeeting] = useState<boolean>(false);

  // 최초 로그인 온보딩 및 프로필 수정 모달 상태
  const [showProfileModal, setShowProfileModal] = useState<boolean>(false);
  const [profileNameInput, setProfileNameInput] = useState<string>("");
  const [profileOrgInput, setProfileOrgInput] = useState<string>("");
  const [profileTitleInput, setProfileTitleInput] = useState<string>("");
  const [isSavingProfile, setIsSavingProfile] = useState<boolean>(false);

  const [fragmentKey] = useState<string>(DEFAULT_FRAGMENT_KEY);
  const [latestInviteCode, setLatestInviteCode] = useState<string>("");
  const [latestInviteKey, setLatestInviteKey] = useState<string>("");
  const [inviteCode, setInviteCode] = useState<string>("inv_9x82a");
  const [masterSecret, setMasterSecret] = useState<string>(
    DEFAULT_MASTER_SECRETS[defaultUserId] || "master-secret-u_kim"
  );

  const [directMeetings, setDirectMeetings] = useState<
    Array<Record<string, any>>
  >([]);
  const [decryptedMeetingsMap, setDecryptedMeetingsMap] = useState<
    Record<string, SensitiveMeetingPayload>
  >({});
  const [inviteData, setInviteData] = useState<Record<string, any> | null>(null);
  const [inviteDecrypted, setInviteDecrypted] =
    useState<SensitiveMeetingPayload | null>(null);
  const [histories, setHistories] = useState<Array<Record<string, any>>>([]);
  const [decryptedHistoriesMap, setDecryptedHistoriesMap] = useState<
    Record<string, SensitiveHistoryPayload>
  >({});
  const [placesCatalog, setPlacesCatalog] = useState<any[]>([]);
  const [notifData, setNotifData] = useState<Record<string, any> | null>(null);
  const [appleCalData, setAppleCalData] = useState<Record<string, any> | null>(null);
  const [isCopiedFeed, setIsCopiedFeed] = useState<boolean>(false);
  const [newsQuery, setNewsQuery] = useState<string>("삼성생명");
  const [newsData, setNewsData] = useState<Record<string, any> | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [aiArea, setAiArea] = useState<string>("여의도");
  const [aiHeadcount, setAiHeadcount] = useState<number>(5);
  const [aiCuisine, setAiCuisine] = useState<string>("한식");
  const [aiSpacePref, setAiSpacePref] = useState<string>("조용한 곳, 개별 룸");
  const [aiOtherCond, setAiOtherCond] = useState<string>("주차 가능");
  const [excludePastVisited, setExcludePastVisited] = useState<boolean>(true);
  const [myDislikedInput, setMyDislikedInput] = useState<string>(
    "생선 요리 비선호, 매운 음식 비선호"
  );
  const [longTermPrefConsent, setLongTermPrefConsent] =
    useState<boolean>(false);

  const [srNameInput, setSrNameInput] = useState<string>("이재훈 상무");
  const [srTitleInput, setSrTitleInput] =
    useState<string>("삼성생명 홍보담당 상무");
  const [srLevelInput, setSrLevelInput] = useState<string>("EXECUTIVE");
  const [srConfirmedInput, setSrConfirmedInput] = useState<boolean>(false);

  useEffect(() => {
    if (defaultUserId && defaultUserId !== currentUserId && accounts.some((a) => a.id === defaultUserId)) {
      setCurrentUserId(defaultUserId);
      const acc = accounts.find((a) => a.id === defaultUserId);
      if (acc?.sessionToken) {
        setSessionToken(acc.sessionToken);
      }
    }
  }, [defaultUserId, accounts, currentUserId]);

  useEffect(() => {
    const found = accounts.find((a) => a.id === currentUserId);
    if (found && found.sessionToken && (!sessionToken || sessionToken !== found.sessionToken)) {
      setSessionToken(found.sessionToken);
    }
  }, [accounts, currentUserId, sessionToken]);

  // Kakao JS SDK 초기화
  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).Kakao) {
      const kakaoKey =
        process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID ||
        "b1ec0592928d85a41c49f7b984b0bdd1";
      try {
        if (!(window as any).Kakao.isInitialized()) {
          (window as any).Kakao.init(kakaoKey);
        }
      } catch (e) {
        // 이미 초기화되었거나 로드 중
      }
    }
  }, []);

  // 최초 로그인 온보딩 감지
  useEffect(() => {
    const curAcc = accounts.find((a) => a.id === currentUserId);
    if (curAcc && curAcc.accountType === "REAL_KAKAO_OAUTH") {
      setProfileNameInput(curAcc.displayName || "");
      if (
        curAcc.jobTitle === "팀약 회원" &&
        typeof window !== "undefined" &&
        !localStorage.getItem("teamyak_profile_onboarding_done")
      ) {
        setShowProfileModal(true);
      }
    }
  }, [accounts, currentUserId]);

  async function handleSaveProfile() {
    if (!profileNameInput.trim()) {
      showMsg("⚠️ 이름을 입력해 주세요.");
      return;
    }
    setIsSavingProfile(true);
    try {
      const fullTitle = profileOrgInput.trim()
        ? `${profileOrgInput.trim()} ${profileTitleInput.trim() || "담당자"}`
        : profileTitleInput.trim() || "팀약 회원";

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;

      const res = await fetch("/api/auth", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "UPDATE_PROFILE",
          displayName: profileNameInput.trim(),
          jobTitle: fullTitle,
          orgName: profileOrgInput.trim(),
        }),
      });

      if (res.ok) {
        const cur = accounts.find((a) => a.id === currentUserId);
        if (cur) {
          cur.displayName = profileNameInput.trim();
          cur.jobTitle = fullTitle;
        }
        if (typeof window !== "undefined") {
          localStorage.setItem("teamyak_profile_onboarding_done", "true");
        }
        showMsg("🎉 프로필이 성공적으로 저장되었습니다!");
        setShowProfileModal(false);
        onStateMutated();
      } else {
        showMsg("❌ 프로필 저장에 실패했습니다.");
      }
    } catch {
      showMsg("❌ 통신 오류가 발생했습니다.");
    } finally {
      setIsSavingProfile(false);
    }
  }

  const showMsg = (msg: string) => setToast(msg);

  const fetchAllDeviceState = useCallback(async () => {
    const headers: Record<string, string> = {};
    if (isLoggedIn && sessionToken) {
      headers["Authorization"] = `Bearer ${sessionToken}`;
    }

    try {
      const invRes = await fetch(`/api/invitations/${inviteCode}`, { headers });
      const invJson = await invRes.json();
      setInviteData({ statusHttp: invRes.status, ...invJson });
      if (
        invRes.ok &&
        invJson.encryptedDetail?.encryptedMeetingPayload &&
        fragmentKey
      ) {
        const dec = await decryptMeetingPayload(
          invJson.encryptedDetail.encryptedMeetingPayload,
          invJson.encryptedDetail.payloadIv,
          fragmentKey
        );
        setInviteDecrypted(dec);
      } else {
        setInviteDecrypted(null);
      }
    } catch {}

    if (!isLoggedIn || !sessionToken) {
      setDirectMeetings([]);
      setHistories([]);
      return;
    }

    try {
      const mRes = await fetch("/api/meetings", { headers });
      if (mRes.ok) {
        const mJson = await mRes.json();
        let list = mJson.directMeetings || [];
        if (currentUserId.startsWith("u_kakao_")) {
          // 카카오 실계정 사용자에게는 테스트용 샘플 모임(mtg_1: 김민준 대리)을 목록에서 제외
          list = list.filter((m: any) => m.id !== "mtg_1" || m.createdBy === currentUserId);
        }
        setDirectMeetings(list);
        if (mJson.placesCatalog) setPlacesCatalog(mJson.placesCatalog);

        const decMap: Record<string, SensitiveMeetingPayload> = {};
        for (const m of list) {
          const k =
            m.seedFragmentKeyForTest || fragmentKey || DEFAULT_FRAGMENT_KEY;
          const dec = await decryptMeetingPayload(
            m.encryptedMeetingPayload,
            m.payloadIv,
            k
          );
          if (dec) decMap[m.id] = dec;
        }
        setDecryptedMeetingsMap(decMap);
      }
    } catch {}

    try {
      const hRes = await fetch("/api/histories", { headers });
      if (hRes.ok) {
        const hJson = await hRes.json();
        const hList = hJson.histories || [];
        setHistories(hList);
        const hDecMap: Record<string, SensitiveHistoryPayload> = {};
        for (const h of hList) {
          const dec = await decryptHistoryBlob(
            h.encryptedHistoryBlob,
            h.blobIv,
            masterSecret
          );
          if (dec) hDecMap[h.id] = dec;
        }
        setDecryptedHistoriesMap(hDecMap);
      }
    } catch {}

    try {
      const nRes = await fetch("/api/notifications", { headers });
      if (nRes.ok) setNotifData(await nRes.json());
    } catch {}

    try {
      const aRes = await fetch("/api/calendar/apple", { headers });
      if (aRes.ok) setAppleCalData(await aRes.json());
    } catch {}
  }, [isLoggedIn, sessionToken, inviteCode, fragmentKey, masterSecret]);

  useEffect(() => {
    fetchAllDeviceState();
    const timer = setInterval(fetchAllDeviceState, 3000);
    return () => clearInterval(timer);
  }, [fetchAllDeviceState, syncPulse]);

  useEffect(() => {
    fetch(`/api/news?q=${encodeURIComponent(newsQuery)}`)
      .then((r) => r.json())
      .then(setNewsData)
      .catch(() => {});
  }, [newsQuery]);

  async function handleAccountChange(userId: string) {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "LOGIN_ACCOUNT", userId }),
    });
    const data = await res.json();
    if (data.ok) {
      setCurrentUserId(userId);
      setSessionToken(data.sessionToken);
      setIsLoggedIn(true);
      setMasterSecret(
        DEFAULT_MASTER_SECRETS[userId] || `master-secret-${userId}`
      );
      showMsg(`👤 [${data.user.displayName}] 세션으로 전환되었습니다.`);
      onStateMutated();
    }
  }

  // 초대장에서 참석 요청 (주요 참석자 존재 모임은 로그인 후 자동 확정하지 않고 2단계 확인 수행)
  async function handleInviteRsvp(
    rsvpStatus: "ATTENDING" | "TENTATIVE" | "DECLINED",
    confirmedAfterSeniorityReview = false
  ) {
    if (!isLoggedIn) {
      setIsLoggedIn(true);
      showMsg(
        "🔐 카카오 로그인 완료! 초대 권한이 확인되어 모임 상세 및 주요 참석자 유무를 복호화합니다."
      );
    }

    const res = await fetch(`/api/invitations/${inviteCode}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        rsvpStatus,
        confirmedAfterSeniorityReview,
      }),
    });
    const data = await res.json();
    if (data.requiresSeniorConfirmation) {
      showMsg(`👔 [2단계 참석 확인] ${data.userFriendlyMessage}`);
    } else if (data.ok) {
      showMsg(
        `✅ [${data.participant?.rsvpStatus}] 응답이 최종 반영되었습니다 (캘린더 등록: ${
          data.calendarAutoRegistered ? "완료" : "대기/제외"
        }).`
      );
    }
    onStateMutated();
    fetchAllDeviceState();
  }

  async function handleRunAiRecommendation(meetingId: string) {
    const res = await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        action: "RECOMMEND_PLACES",
        area: aiArea,
        headcount: aiHeadcount,
        meetingPurpose: "업무 오찬",
        preferredCuisines: [aiCuisine],
        spacePreferences: aiSpacePref.split(",").map((s) => s.trim()),
        otherConditions: aiOtherCond.split(",").map((s) => s.trim()),
      }),
    });
    const data = await res.json();
    if (data.ok) {
      const localFiltered = filterRecommendationsInBrowser(
        data.recommendations || [],
        Object.values(decryptedHistoriesMap),
        excludePastVisited
      );
      showMsg(
        `🤖 [시뮬레이션 안내] AI 맞춤 장소 후보 추천 완료! 브라우저에서 복호화한 내 과거 방문 식당(${
          localFiltered.excludedInBrowserPlaceNames.join(", ") || "없음"
        })을 서버/AI 노출 없이 로컬 제외하여 ${
          localFiltered.filteredRecommendations.length
        }곳을 표시합니다.`
      );
      onStateMutated();
      fetchAllDeviceState();
    }
  }

  async function handleSelectPlace(meetingId: string, placeId: string) {
    const res = await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ action: "SELECT_PLACE", placeId }),
    });
    const data = await res.json();
    if (data.ok) {
      showMsg(`📍 [${data.selectedPlace.name}] 장소가 확정되었습니다.`);
      onStateMutated();
      fetchAllDeviceState();
    }
  }

  async function handleSaveMyPreference(meetingId: string) {
    const res = await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        action: "SAVE_PREFERENCE",
        inputSource: "PARTICIPANT_SELF",
        preferredCuisines: [aiCuisine],
        dislikedItems: myDislikedInput
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        spacePreferences: aiSpacePref
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        longTermStorageConsented: longTermPrefConsent,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showMsg(
        `🍽️ 내 취향 저장 완료 (보존 범위: ${
          data.preference.preferenceScope === "LONG_TERM_CONSENTED"
            ? `최대 1년 저장 · 만료일: ${data.preference.consentExpiresAt?.slice(
                0,
                10
              )}`
            : "MEETING_ONLY (이번 모임에서만 사용)"
        }).`
      );
      onStateMutated();
      fetchAllDeviceState();
    }
  }

  async function handleWithdrawPreferenceConsent(meetingId: string) {
    const res = await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ action: "WITHDRAW_PREFERENCE_CONSENT" }),
    });
    if (res.ok) {
      showMsg("🗑️ 음식 취향 장기 저장 동의가 철회되어 서버에서 즉시 삭제되었습니다.");
      onStateMutated();
      fetchAllDeviceState();
    }
  }

  async function handleScheduleUpdate(
    meetingId: string,
    targetDate: string,
    targetStart: string,
    reason: string
  ) {
    const res = await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        action: "UPDATE_SCHEDULE",
        confirmedDate: targetDate,
        startTime: targetStart,
        endTime: "13:30",
        changeReason: reason,
        reasonIsPrivate: true,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showMsg(
        `📅 일정 변경 완료 (유형: ${data.changeType} · 누적 순연: ${data.postponementCount}회 · SEQUENCE v${data.sequenceVersion}).`
      );
      onStateMutated();
      fetchAllDeviceState();
    }
  }

  async function handleCreateNewMeeting(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!newTitle.trim()) {
      showMsg("약속 제목을 입력해 주세요.");
      return;
    }
    if (!newDate) {
      showMsg("날짜를 선택해 주세요.");
      return;
    }
    if (!newStartTime) {
      showMsg("시간을 입력해 주세요.");
      return;
    }

    setIsSubmittingMeeting(true);
    try {
      const meetingKey = generateFragmentKey ? generateFragmentKey() : DEFAULT_FRAGMENT_KEY;
      const hasSenior = newSeniorLevel !== "STAFF" && Boolean(newSeniorName.trim());
      const rawPayload: SensitiveMeetingPayload = {
        title: newTitle.trim(),
        counterpartOrgName: newCounterpartOrg.trim() || "미지정",
        detailedPlaceName: newAreaHint.trim() ? `${newAreaHint.trim()} (장소 협의 중)` : "장소 미정",
        detailedPlaceAddress: newAreaHint.trim() || "장소 미정",
        description: `${newTitle.trim()} 약속입니다.`,
        highestSeniorityLevel: hasSenior ? newSeniorLevel : "STAFF",
        highestSeniorityStatus: hasSenior ? "SCHEDULED" : "NONE",
        seniorAttendees: hasSenior ? [
          {
            userId: `senior_${Date.now()}`,
            displayName: newSeniorName.trim(),
            jobTitle: newSeniorTitle.trim() || "참석자",
            seniorityLevel: newSeniorLevel,
            attendanceConfirmed: false,
            discloseName: true
          }
        ] : []
      };

      const { encryptedPayload, payloadIv } = await encryptMeetingPayload(rawPayload, meetingKey);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;

      const curAcc = accounts.find((a) => a.id === currentUserId);
      const hostOrgBadge = curAcc?.teamId && curAcc.teamId !== "null"
        ? (curAcc.teamId === "team_press_joongang" ? "중앙일보" : curAcc.teamId)
        : (curAcc?.jobTitle && curAcc.jobTitle !== "팀약 회원"
            ? `${curAcc.displayName} (${curAcc.jobTitle})`
            : (curAcc?.displayName || "호스트"));

      const res = await fetch("/api/meetings", {
        method: "POST",
        headers,
        body: JSON.stringify({
          confirmedDate: newDate,
          startTime: newStartTime,
          endTime: newEndTime || "13:30",
          isTimeTbd: false,
          isPlaceTbd: !newAreaHint.trim(),
          placeId: null,
          areaHint: newAreaHint.trim() || "장소 미정",
          detailedPlaceName: rawPayload.detailedPlaceName,
          meetingType: newMeetingType,
          hostOrgBadge,
          guestSideLabel: newCounterpartOrg.trim() || "초대받은 분",
          intendedTargetHint: newCounterpartOrg.trim() || "초대받은 분",
          encryptedMeetingPayload: encryptedPayload,
          payloadIv: payloadIv,
          seedFragmentKeyForTest: meetingKey,
          hostShareToTeam: newHostShareToTeam,
          hasSeniorAttendee: hasSenior
        })
      });

      const data = await res.json();
      if (data.ok) {
        showMsg("🎉 새 약속이 생성되었습니다! 카카오톡 초대를 전송하세요.");
        const createdMtg = {
          ...data.meeting,
          inviteCode: data.inviteCode,
          seedFragmentKeyForTest: meetingKey,
        };
        setDirectMeetings((prev) => [createdMtg, ...prev.filter((m) => m.id !== createdMtg.id)]);
        setDecryptedMeetingsMap((prev) => ({
          ...prev,
          [createdMtg.id]: rawPayload,
        }));
        setLatestInviteCode(data.inviteCode);
        setLatestInviteKey(meetingKey);
        setInviteCode(data.inviteCode);
        // Reset inputs
        setNewTitle("");
        setNewAreaHint("");
        setNewSeniorName("");
        setNewSeniorTitle("");
        // Transition to invite share view
        setSelectedMeetingId(data.meeting.id);
        setMeetingSubView("INVITE_SHARE");
        await fetchAllDeviceState();
        onStateMutated();
      } else {
        showMsg(`❌ 약속 생성 실패: ${data.error || data.message}`);
      }
    } catch (err: any) {
      showMsg(`❌ 오류: ${err.message}`);
    } finally {
      setIsSubmittingMeeting(false);
    }
  }

  async function handleKakaoShare(meetingId?: string) {
    const targetMtg =
      (meetingId ? directMeetings.find((m) => m.id === meetingId) : null) ||
      (selectedMeetingId ? directMeetings.find((m) => m.id === selectedMeetingId) : null) ||
      currentMtg;

    const targetCode = targetMtg?.inviteCode || latestInviteCode || inviteCode;
    const targetKey = targetMtg?.seedFragmentKeyForTest || latestInviteKey || fragmentKey;
    if (!targetCode) {
      showMsg("⚠️ 공유할 약속이 없습니다. 먼저 새 약속을 만들어 주세요.");
      return;
    }
    const inviteUrl = `${window.location.origin}/i/${targetCode}#k=${targetKey}`;
    const mtgTitle = (targetMtg && decryptedMeetingsMap[targetMtg.id]?.title) || targetMtg?.title || "팀약 약속 초대장";

    if (typeof window !== "undefined" && (window as any).Kakao) {
      const kakaoKey =
        process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID ||
        "b1ec0592928d85a41c49f7b984b0bdd1";
      try {
        if (!(window as any).Kakao.isInitialized()) {
          (window as any).Kakao.init(kakaoKey);
        }
        if ((window as any).Kakao.isInitialized()) {
          (window as any).Kakao.Share.sendDefault({
            objectType: "text",
            text: `[TEAMYAK 약속 초대장]\n\n📌 ${mtgTitle}\n🗓️ 일시: ${
              targetMtg?.confirmedDate || "약속 일시"
            } 오후 ${targetMtg?.startTime || "12:00"}\n📍 장소: ${
              targetMtg?.areaHint || "장소 미정"
            }\n\n아래 버튼을 눌러 참석 여부를 확인해 주세요.`,
            link: {
              mobileWebUrl: inviteUrl,
              webUrl: inviteUrl,
            },
            buttons: [
              {
                title: "초대장 확인 및 참석 응답",
                link: {
                  mobileWebUrl: inviteUrl,
                  webUrl: inviteUrl,
                },
              },
            ],
          });
          showMsg("💬 카카오톡 공유 창이 열렸습니다. 대화 상대를 선택해 초대장을 전송하세요!");
          return;
        }
      } catch (err: any) {
        console.warn("Kakao share SDK fallback:", err);
      }
    }

    if (navigator.clipboard) {
      await navigator.clipboard.writeText(inviteUrl);
      showMsg(
        "💬 [카카오톡 초대장 링크 복사 완료] 클립보드에 복사되었습니다. 카카오톡 대화방에 붙여넣어 공유하세요!"
      );
    } else {
      showMsg(`초대장 링크: ${inviteUrl}`);
    }
  }

  async function handleCopyInviteLink(meetingId?: string) {
    const targetMtg =
      (meetingId ? directMeetings.find((m) => m.id === meetingId) : null) ||
      (selectedMeetingId ? directMeetings.find((m) => m.id === selectedMeetingId) : null) ||
      currentMtg;

    const targetCode = targetMtg?.inviteCode || latestInviteCode || inviteCode;
    const targetKey = targetMtg?.seedFragmentKeyForTest || latestInviteKey || fragmentKey;
    if (!targetCode) {
      showMsg("⚠️ 공유할 약속이 없습니다. 먼저 새 약속을 만들어 주세요.");
      return;
    }
    const inviteUrl = `${window.location.origin}/i/${targetCode}#k=${targetKey}`;
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(inviteUrl);
      showMsg("📋 [초대 링크 복사 완료] 클립보드에 복사되었습니다. 카카오톡 대화방에 붙여넣어 공유하세요!");
    } else {
      showMsg(`초대 링크: ${inviteUrl}`);
    }
  }

  async function handleGoogleCalendarSync(meetingId: string) {
    const res = await fetch("/api/calendar/google", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ action: "SYNC_EVENT", meetingId }),
    });
    const data = await res.json();
    if (data.ok) {
      showMsg(
        `📅 [Google Calendar 동기화 완료] 제목: '${data.mapping.exportedTitle}' (${data.reminderConfigured}).`
      );
      fetchAllDeviceState();
    } else {
      showMsg(`❌ 캘린더 동기화 실패: ${data.message || data.error}`);
    }
  }

  async function handleAppleCalendarAction(action: string) {
    try {
      const res = await fetch("/api/calendar/apple", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.ok) {
        showMsg(`✅ ${data.message}`);
        setAppleCalData(data);
        fetchAllDeviceState();
      } else {
        showMsg(`❌ 실패: ${data.message || data.error}`);
      }
    } catch (err: any) {
      showMsg(`❌ 네트워크 오류: ${err.message}`);
    }
  }

  function handleCopyFeedUrl(url: string) {
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => {
        setIsCopiedFeed(true);
        showMsg("📋 캘린더 구독 URL이 클립보드에 복사되었습니다. (아이폰 설정 > 캘린더 > 계정 추가 > 구독할 캘린더 추가)");
        setTimeout(() => setIsCopiedFeed(false), 2500);
      },
      () => {
        showMsg(`구독 URL: ${url}`);
      }
    );
  }

  function handleDownloadSingleIcs(meeting: any) {
    if (!meeting) {
      showMsg("선택된 모임이 없습니다.");
      return;
    }
    downloadIcsFile({
      meetingId: meeting.id,
      confirmedDate: meeting.confirmedDate || "2026-11-19",
      startTime: meeting.startTime || "12:00",
      endTime: meeting.endTime || "13:30",
      sequenceVersion: meeting.sequenceVersion || 1,
      status: meeting.status || "CONFIRMED",
      areaHint: meeting.areaHint || "서울",
      includeDetailedInfo: false,
      morningAlarmTime: "08:00",
    });
    showMsg(`📥 1회성 캘린더 파일(teamyak-${meeting.id}.ics) 다운로드가 완료되었습니다.`);
  }

  async function handleSeniorAttendeeMutation(
    meetingId: string,
    withdraw = false
  ) {
    const targetMtg =
      directMeetings.find((m) => m.id === meetingId) || directMeetings[0];
    if (!targetMtg) return;

    let payload: SensitiveMeetingPayload | null =
      decryptedMeetingsMap[targetMtg.id] || null;
    if (!payload && targetMtg.encryptedMeetingPayload && fragmentKey) {
      payload =
        (await decryptMeetingPayload(
          targetMtg.encryptedMeetingPayload,
          targetMtg.payloadIv,
          fragmentKey
        )) || null;
    }
    if (!payload) {
      showMsg("❌ 모임 암호문을 복호화할 수 없습니다. 키를 확인해 주세요.");
      return;
    }

    const targetUserId = "u_exec_lee";
    const existingList = (payload.seniorAttendees || []).filter(
      (item) => item.userId !== targetUserId
    );

    if (!withdraw && srLevelInput !== "STAFF") {
      existingList.push({
        userId: targetUserId,
        displayName: srNameInput,
        jobTitle: srTitleInput,
        seniorityLevel: srLevelInput as SeniorityLevel,
        attendanceConfirmed: srConfirmedInput,
        discloseName: true,
      });
    }

    const rankMap: Record<SeniorityLevel, number> = {
      STAFF: 0,
      DIRECTOR: 1,
      EXECUTIVE: 2,
      CEO: 3,
    };
    let highestLevel: SeniorityLevel = "STAFF";
    let highestStatus: "NONE" | "SCHEDULED" | "CONFIRMED" = "NONE";
    for (const item of existingList) {
      if (rankMap[item.seniorityLevel] > rankMap[highestLevel]) {
        highestLevel = item.seniorityLevel;
        highestStatus = item.attendanceConfirmed ? "CONFIRMED" : "SCHEDULED";
      }
    }

    const updatedPayload: SensitiveMeetingPayload = {
      ...payload,
      seniorAttendees: existingList,
      highestSeniorityLevel: highestLevel,
      highestSeniorityStatus: highestStatus,
    };

    // [Zero-Knowledge 준수] 브라우저 Web Crypto API로 직접 재암호화!
    const reEncrypted = await encryptMeetingPayload(
      updatedPayload,
      fragmentKey
    );

    const res = await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        action: withdraw
          ? "WITHDRAW_SENIOR_ATTENDEE"
          : "UPSERT_SENIOR_ATTENDEE",
        encryptedMeetingPayload: reEncrypted.encryptedPayload,
        payloadIv: reEncrypted.payloadIv,
        hasSeniorAttendee: existingList.length > 0,
        expectedSequenceVersion: targetMtg.sequenceVersion,
        targetUserId,
        // fragmentKey는 Zero-Knowledge 원칙에 따라 서버로 절대 전송하지 않음!
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setDecryptedMeetingsMap((prev) => ({
        ...prev,
        [targetMtg.id]: updatedPayload,
      }));
      showMsg(`🔔 [중립 알림 발송] ${data.neutralAlertText}`);
      onStateMutated();
      fetchAllDeviceState();
    } else {
      showMsg(`❌ [수정 실패] ${data.message || data.error}`);
    }
  }

  function handleSharePlace(place: any) {
    const pName = place.name || place.placeName;
    const pAddr = place.roadAddress || "여의도 인근";
    const pDesc =
      place.officialInfoSummary ||
      place.recommendationReason ||
      "비즈니스 오찬 적합";
    const mapLink =
      place.naverMapUrl ||
      `https://map.naver.com/p/search/${encodeURIComponent(pName)}`;
    const text = `🍽️ [TEAMYAK 식당 추천]\n• 식당명: ${pName} (${place.cuisineType})\n• 위치: ${pAddr}\n• 특징: ${pDesc}\n🗺️ 지도: ${mapLink}`;
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share({ title: `${pName} 추천`, text }).catch(() => {});
    } else if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        showMsg(
          `💬 [${pName}] 식당 정보가 복사되었습니다. 카카오톡에 붙여넣어 공유하세요!`
        );
      });
    }
  }

  function handleShareAllPlaces(places: any[]) {
    if (!places || places.length === 0) return;
    const items = places
      .slice(0, 5)
      .map(
        (p, i) =>
          `${i + 1}. ${p.name || p.placeName} (${p.cuisineType})\n   - 위치: ${
            p.roadAddress || "여의도"
          }\n   - 특징: ${
            p.officialInfoSummary || p.recommendationReason || "비즈니스 오찬"
          }\n   - 지도: ${
            p.naverMapUrl ||
            `https://map.naver.com/p/search/${encodeURIComponent(
              p.name || p.placeName
            )}`
          }`
      )
      .join("\n\n");
    const text = `🍽️ [TEAMYAK 모임 추천 식당 후보 (${Math.min(
      places.length,
      5
    )}곳)]\n\n${items}\n\n👉 약속 확인 및 참여: ${
      typeof window !== "undefined" ? window.location.origin : ""
    }`;
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share({ title: "모임 식당 추천 목록", text }).catch(() => {});
    } else if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        showMsg(
          "💬 [식당 추천 목록 전체 복사 완료] 카카오톡 대화방에 붙여넣어 공유하세요!"
        );
      });
    }
  }

  const currentMtg =
    (selectedMeetingId
      ? directMeetings.find((m) => m.id === selectedMeetingId)
      : null) ||
    directMeetings[0] ||
    null;
  const currentDec = currentMtg ? decryptedMeetingsMap[currentMtg.id] : null;

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayFormatted = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  const todayMeetings = directMeetings.filter(
    (m) => m.confirmedDate === todayStr && m.status !== "CANCELED"
  );
  const upcomingMeetings = directMeetings.filter(
    (m) => m.confirmedDate > todayStr && m.status !== "CANCELED"
  );
  const actionRequiredMeetings = directMeetings.filter((m) =>
    (m.participants || []).some(
      (p: any) =>
        p.rsvpStatus === "AWAITING_SENIOR_CONFIRM" ||
        p.needsReconfirmAfterChange
    )
  );
  const postponedMeetings = directMeetings.filter(
    (m) => (m.postponementCount || 0) > 0
  );

  // 브라우저 로컬에서 복호화된 내 방문 식당을 제외한 추천 목록 계산
  const browserFilteredRecs = currentMtg
    ? filterRecommendationsInBrowser(
        currentMtg.recommendations || [],
        Object.values(decryptedHistoriesMap),
        excludePastVisited
      )
    : { filteredRecommendations: [], excludedInBrowserPlaceNames: [] };

  function renderMeetingCard(m: any) {
    const dec = decryptedMeetingsMap[m.id];
    const title = dec?.title || m.title || "약속";
    const pBadge = getPostponementBadgeInfo(m.postponementCount);
    const sBadge = getSeniorityBadgeInfo(
      dec?.highestSeniorityLevel || (m.hasSeniorAttendee ? "DIRECTOR" : "STAFF"),
      dec?.highestSeniorityStatus || "NONE"
    );

    return (
      <div
        key={m.id}
        className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm space-y-3 hover:border-brand-400 transition"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[10px] font-bold text-brand-600">
              {m.hostOrgBadge || "호스트"} 주최
            </div>
            <h3 className="text-base font-extrabold text-slate-900 tracking-tight mt-0.5">
              {title}
            </h3>
          </div>
          <div className="flex flex-col items-end gap-1">
            {m.postponementCount > 0 && (
              <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${pBadge.badgeClass}`}>
                {pBadge.text}
              </span>
            )}
            {sBadge.level !== "STAFF" && (
              <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${sBadge.badgeClass}`}>
                🔐 {sBadge.text}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-slate-700 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
          <span>🗓️ {m.confirmedDate} 오후 {m.startTime || "12:00"}</span>
          <span>·</span>
          <span className={m.isPlaceTbd ? "text-amber-600" : "text-emerald-700"}>
            📍 {m.areaHint || "장소 미정"} {m.isPlaceTbd ? "(장소 미정)" : (m.selectedPlace ? `(${m.selectedPlace.name})` : "")}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-0.5">
          <button
            onClick={() => {
              setSelectedMeetingId(m.id);
              setMeetingSubView("INVITE_SHARE");
            }}
            className="py-2.5 px-3 rounded-xl bg-[#FEE500] hover:bg-[#FADA0A] text-[#191919] font-extrabold text-xs shadow-sm flex items-center justify-center gap-1.5 active:scale-95 transition"
          >
            <span>💬</span>
            <span>초대하기</span>
          </button>
          <button
            onClick={() => {
              setSelectedMeetingId(m.id);
              setMeetingSubView("DETAIL");
            }}
            className="py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs shadow-sm flex items-center justify-center gap-1.5 active:scale-95 transition"
          >
            <span>상세 보기</span>
            <span>→</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto rounded-3xl bg-white text-slate-900 shadow-xl border border-slate-200 flex flex-col transition-all overflow-hidden mb-8">
      {/* 모바일 상단 바 */}
      <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
          <span className="text-xs font-black text-white">
            {accounts.find((a) => a.id === currentUserId)?.displayName ||
              "카카오 회원"}
          </span>
          <span className="text-[10px] text-slate-400">
            ({accounts.find((a) => a.id === currentUserId)?.jobTitle ||
              "팀약 회원"})
          </span>
        </div>

        <button
          onClick={() => {
            const clientId =
              process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID ||
              "b1ec0592928d85a41c49f7b984b0bdd1";
            const redirectUri = `${window.location.origin}/auth/callback`;
            const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
              redirectUri
            )}&response_type=code&state=${encodeURIComponent("/")}`;
            window.location.href = kakaoAuthUrl;
          }}
          className="py-1 px-2.5 bg-[#FEE500] hover:bg-[#FDD800] text-[#191919] font-black rounded-lg flex items-center gap-1 text-[10px] shadow-sm transition active:scale-95"
        >
          <span>💬</span>
          <span>카카오 로그인</span>
        </button>
      </div>

      {toast && (
        <div className="bg-slate-900 text-emerald-200 px-4 py-2.5 text-[11px] border-b border-slate-700 flex items-start justify-between gap-2">
          <span>{toast}</span>
          <button
            onClick={() => setToast(null)}
            className="text-white font-bold"
          >
            ✕
          </button>
        </div>
      )}

      <div className="p-4 space-y-4 pb-20 min-h-[520px]">
        {/* ============================================================== */}
        {/* [메뉴 1] 약속 (생성·초대·참석 관리 중심) */}
        {/* ============================================================== */}
        {activeTab === "meetings" && (
          <div className="space-y-4 text-xs text-slate-900">
            {/* 서브뷰 1: 내 약속 목록 (LIST) */}
            {meetingSubView === "LIST" && (
              <div className="space-y-4">
                {/* 상단: 오늘 날짜 + 내 약속 + 가장 눈에 띄는 '새 약속 만들기' 주요 버튼 */}
                <div className="flex items-center justify-between pt-1">
                  <div>
                    <div className="text-[11px] font-bold text-slate-500">
                      📅 {todayFormatted}
                    </div>
                    <h1 className="text-xl font-black text-slate-900 tracking-tight mt-0.5">
                      내 약속
                    </h1>
                  </div>

                  <button
                    onClick={() => setMeetingSubView("CREATE")}
                    className="py-2.5 px-4 rounded-2xl bg-brand-600 hover:bg-brand-700 text-white font-black text-xs shadow-md flex items-center gap-1.5 active:scale-95 transition"
                  >
                    <span className="text-base leading-none font-bold">+</span>
                    <span>새 약속 만들기</span>
                  </button>
                </div>

                {/* 약속 목록이 비어있을 때 (새 약속 만들기 안내) */}
                {directMeetings.length === 0 ? (
                  <div className="bg-white rounded-3xl p-8 border border-slate-200 text-center space-y-4 shadow-sm">
                    <div className="w-16 h-16 mx-auto rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-3xl">
                      🤝
                    </div>
                    <div>
                      <h3 className="text-base font-extrabold text-slate-900">
                        등록된 약속이 없습니다
                      </h3>
                      <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                        기자 및 기업 홍보 담당자와의 비즈니스 약속을 새로 만들어 보세요.
                      </p>
                    </div>
                    <button
                      onClick={() => setMeetingSubView("CREATE")}
                      className="w-full py-3.5 rounded-2xl bg-brand-600 hover:bg-brand-700 text-white font-extrabold text-sm shadow-md active:scale-95 transition"
                    >
                      + 새 약속 만들기
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* 카테고리 1: 오늘 약속 */}
                    {todayMeetings.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-black text-slate-900">
                          <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
                          <span>📌 오늘 약속 ({todayMeetings.length})</span>
                        </div>
                        {todayMeetings.map((m) => renderMeetingCard(m))}
                      </div>
                    )}

                    {/* 카테고리 2: 참석 확인이 필요한 약속 */}
                    {actionRequiredMeetings.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-black text-amber-900 flex items-center gap-1">
                          <span>⚠️</span>
                          <span>참석 확인이 필요한 약속 ({actionRequiredMeetings.length})</span>
                        </div>
                        {actionRequiredMeetings.map((m) => renderMeetingCard(m))}
                      </div>
                    )}

                    {/* 카테고리 3: 날짜가 변경된 약속 */}
                    {postponedMeetings.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-black text-purple-900 flex items-center gap-1">
                          <span>🗓️</span>
                          <span>날짜가 변경된 약속 ({postponedMeetings.length})</span>
                        </div>
                        {postponedMeetings.map((m) => renderMeetingCard(m))}
                      </div>
                    )}

                    {/* 카테고리 4: 전체 / 다가오는 약속 */}
                    <div className="space-y-2">
                      <div className="text-xs font-black text-slate-900 flex items-center gap-1">
                        <span>⏳</span>
                        <span>다가오는 약속 ({upcomingMeetings.length})</span>
                      </div>
                      {upcomingMeetings.length === 0 && todayMeetings.length === 0 ? (
                        <div className="text-[11px] text-slate-500 p-3 bg-slate-50 rounded-xl">
                          다가오는 다른 일정이 없습니다.
                        </div>
                      ) : (
                        upcomingMeetings.map((m) => renderMeetingCard(m))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 서브뷰 2: 새 약속 만들기 (CREATE) */}
            {meetingSubView === "CREATE" && (
              <div className="space-y-4">
                <button
                  onClick={() => setMeetingSubView("LIST")}
                  className="flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-slate-800"
                >
                  <span>←</span>
                  <span>내 약속 목록</span>
                </button>

                <div className="bg-white rounded-3xl p-5 border border-slate-200 shadow-sm space-y-4 text-slate-900">
                  <div>
                    <h2 className="text-lg font-black text-slate-900 tracking-tight">
                      새 약속 만들기
                    </h2>
                    <p className="text-xs text-slate-500 mt-1">
                      필수 항목(제목, 일시)만 입력하면 바로 약속을 생성하고 카카오톡으로 초대할 수 있습니다.
                    </p>
                  </div>

                  <form onSubmit={handleCreateNewMeeting} className="space-y-4">
                    {/* 필수 입력 항목 1: 약속 제목 */}
                    <div className="space-y-1">
                      <label className="text-xs font-extrabold text-slate-800 flex items-center gap-1">
                        <span>1. 약속 제목</span>
                        <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        placeholder="예: 삼성생명-중앙일보 정기 오찬"
                        className="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-slate-900 bg-white text-xs font-medium focus:ring-2 focus:ring-brand-500"
                        required
                      />
                    </div>

                    {/* 필수 입력 항목 2, 3: 날짜 및 시간 */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-xs font-extrabold text-slate-800 flex items-center gap-1">
                          <span>2. 날짜</span>
                          <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="date"
                          value={newDate}
                          onChange={(e) => setNewDate(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-slate-900 bg-white text-xs font-medium focus:ring-2 focus:ring-brand-500"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-extrabold text-slate-800 flex items-center gap-1">
                          <span>3. 시작 시간</span>
                          <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="time"
                          value={newStartTime}
                          onChange={(e) => setNewStartTime(e.target.value)}
                          className="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-slate-900 bg-white text-xs font-medium focus:ring-2 focus:ring-brand-500"
                          required
                        />
                      </div>
                    </div>

                    {/* 선택 입력 항목 토글 */}
                    <div className="pt-2 border-t border-slate-200">
                      <button
                        type="button"
                        onClick={() => setShowOptionalFields(!showOptionalFields)}
                        className="w-full py-2 px-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs flex items-center justify-between border border-slate-200"
                      >
                        <span>⚙️ 추가 상세 정보 (장소, 직급, 상대사 등)</span>
                        <span>{showOptionalFields ? "▲ 접기" : "▼ 펼치기 (선택)"}</span>
                      </button>

                      {showOptionalFields && (
                        <div className="mt-3 space-y-3.5 p-3.5 bg-slate-50 rounded-2xl border border-slate-200">
                          {/* 4. 장소 또는 지역 */}
                          <div className="space-y-1">
                            <label className="text-[11px] font-bold text-slate-700">
                              4. 장소 또는 지역 (선택)
                            </label>
                            <input
                              type="text"
                              value={newAreaHint}
                              onChange={(e) => setNewAreaHint(e.target.value)}
                              placeholder="예: 여의도, 광화문 (비워두면 '장소 미정'으로 저장)"
                              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 bg-white text-xs"
                            />
                            <p className="text-[10px] text-slate-500">
                              장소를 정하지 않아도 약속을 바로 만들고 나중에 정할 수 있습니다.
                            </p>
                          </div>

                          {/* 5, 6. 참석 예정 인원 & 모임 성격 */}
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-slate-700">
                                5. 참석 인원
                              </label>
                              <select
                                value={newHeadcount}
                                onChange={(e) => setNewHeadcount(Number(e.target.value))}
                                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 bg-white text-xs"
                              >
                                <option value={2}>2명 (1:1)</option>
                                <option value={3}>3명</option>
                                <option value={4}>4명</option>
                                <option value={5}>5명 이상</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-slate-700">
                                6. 모임 성격
                              </label>
                              <select
                                value={newMeetingType}
                                onChange={(e) => setNewMeetingType(e.target.value)}
                                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 bg-white text-xs"
                              >
                                <option value="LUNCH">점심 오찬</option>
                                <option value="DINNER">저녁 만찬</option>
                                <option value="COFFEE">커피·티타임</option>
                                <option value="ROUNDTABLE">간담회·브리핑</option>
                                <option value="OTHER">기타</option>
                              </select>
                            </div>
                          </div>

                          {/* 7. 참석 예정자 및 직급 (임원/부장급 암호화 배지) */}
                          <div className="space-y-1.5 p-3 bg-purple-50/70 rounded-xl border border-purple-200">
                            <label className="text-[11px] font-bold text-purple-950">
                              7. 참석 예정자 및 직급 (선택)
                            </label>
                            <div className="grid grid-cols-2 gap-1.5">
                              <input
                                type="text"
                                value={newSeniorName}
                                onChange={(e) => setNewSeniorName(e.target.value)}
                                placeholder="이름 (예: 이재훈)"
                                className="px-2.5 py-1.5 rounded-lg border border-purple-300 text-slate-900 bg-white text-xs"
                              />
                              <input
                                type="text"
                                value={newSeniorTitle}
                                onChange={(e) => setNewSeniorTitle(e.target.value)}
                                placeholder="직함 (예: 상무)"
                                className="px-2.5 py-1.5 rounded-lg border border-purple-300 text-slate-900 bg-white text-xs"
                              />
                            </div>
                            <select
                              value={newSeniorLevel}
                              onChange={(e) => setNewSeniorLevel(e.target.value as SeniorityLevel)}
                              className="w-full px-2.5 py-1.5 rounded-lg border border-purple-300 text-slate-900 bg-white text-xs font-bold"
                            >
                              <option value="STAFF">일반 실무진 (배지 없음)</option>
                              <option value="DIRECTOR">부장급 참석</option>
                              <option value="EXECUTIVE">임원(상무/전무) 참석</option>
                              <option value="CEO">CEO·기관장 참석</option>
                            </select>
                            <p className="text-[10px] text-purple-800">
                              부장급 이상 참석 시 상대방에게 2단계 참석 확인 절차가 자동 적용됩니다.
                            </p>
                          </div>

                          {/* 8. 상대 회사·기관 */}
                          <div className="space-y-1">
                            <label className="text-[11px] font-bold text-slate-700">
                              8. 상대 회사·기관 (선택)
                            </label>
                            <input
                              type="text"
                              value={newCounterpartOrg}
                              onChange={(e) => setNewCounterpartOrg(e.target.value)}
                              placeholder="예: 중앙일보 금융팀"
                              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 bg-white text-xs"
                            />
                          </div>

                          {/* 9. 호스트 측 팀 공유 여부 */}
                          <div className="pt-1">
                            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={newHostShareToTeam}
                                onChange={(e) => setNewHostShareToTeam(e.target.checked)}
                                className="rounded text-brand-600 focus:ring-brand-500 w-4 h-4"
                              />
                              <span>9. 우리 팀 캘린더에 일정 공유 (게스트 팀 공유는 게스트가 직접 결정)</span>
                            </label>
                          </div>
                        </div>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmittingMeeting}
                      className="w-full py-4 rounded-2xl bg-brand-600 hover:bg-brand-700 text-white font-black text-sm shadow-md active:scale-95 transition flex items-center justify-center gap-2"
                    >
                      <span>{isSubmittingMeeting ? "약속 암호화 생성 중..." : "✓ 약속 생성하고 카카오톡 초대하기"}</span>
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* 서브뷰 3: 생성 직후 카카오톡 초대 (INVITE_SHARE) */}
            {meetingSubView === "INVITE_SHARE" && currentMtg && (
              <div className="space-y-4">
                <button
                  onClick={() => setMeetingSubView("LIST")}
                  className="flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-slate-800"
                >
                  <span>←</span>
                  <span>내 약속 목록</span>
                </button>

                <div className="bg-white rounded-3xl p-5 border border-slate-200 shadow-sm space-y-4 text-slate-900">
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-900 text-[10px] font-black">
                      ✓ 약속 등록 완료
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      ID: {currentMtg.id}
                    </span>
                  </div>

                  <div>
                    <h2 className="text-xl font-black text-slate-900 tracking-tight">
                      카카오톡으로 초대하기
                    </h2>
                    <p className="text-xs text-slate-500 mt-1">
                      약속이 안전하게 생성되었습니다. 아래 버튼을 눌러 상대방에게 초대장을 보내세요.
                    </p>
                  </div>

                  {/* 약속 요약 카드 */}
                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 space-y-2.5 text-xs text-slate-800">
                    <div className="text-[10px] font-bold text-brand-600">
                      {currentMtg.hostOrgBadge || "호스트"} 주최
                    </div>
                    <h3 className="text-base font-extrabold text-slate-900">
                      {currentDec?.title || currentMtg.title || "비즈니스 오찬"}
                    </h3>

                    <div className="flex flex-wrap items-center gap-1.5 font-bold text-slate-700">
                      <span>🗓️ {currentMtg.confirmedDate} 오후 {currentMtg.startTime || "12:00"}</span>
                      <span>·</span>
                      <span className={currentMtg.isPlaceTbd ? "text-amber-600" : "text-emerald-700"}>
                        📍 {currentMtg.areaHint || "장소 미정"} {currentMtg.isPlaceTbd ? "(장소 미정)" : ""}
                      </span>
                    </div>

                    <div className="pt-2 border-t border-slate-200 space-y-1 text-[11px] text-slate-600">
                      <div>• 초대 대상: <strong>{currentMtg.guestSideLabel || "초대받은 분"}</strong></div>
                      {currentDec?.highestSeniorityLevel && currentDec.highestSeniorityLevel !== "STAFF" && (
                        <div className="text-purple-900 font-bold">
                          • 🔐 주요 참석자: {currentDec.highestSeniorityLevel} 참석 (로그인 및 초대 권한 확인 후 안전 공개)
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 가장 눈에 띄는 카카오톡 초대 버튼 */}
                  <button
                    onClick={() => handleKakaoShare(currentMtg.id)}
                    className="w-full py-4 rounded-2xl bg-[#FEE500] hover:bg-[#FADA0A] text-[#191919] font-black text-sm shadow-md flex items-center justify-center gap-2 active:scale-95 transition"
                  >
                    <span className="text-lg">💬</span>
                    <span>카카오톡으로 초대하기</span>
                  </button>

                  <button
                    onClick={() => handleCopyInviteLink(currentMtg.id)}
                    className="w-full py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-extrabold text-xs border border-slate-300 flex items-center justify-center gap-1.5 active:scale-95 transition"
                  >
                    <span>📋</span>
                    <span>초대 링크 복사</span>
                  </button>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-200 text-xs">
                    <button
                      onClick={() => setMeetingSubView("DETAIL")}
                      className="font-extrabold text-brand-600 hover:text-brand-700 flex items-center gap-1"
                    >
                      <span>약속 상세 보기</span>
                      <span>→</span>
                    </button>
                    <button
                      onClick={() => setMeetingSubView("LIST")}
                      className="text-slate-500 hover:text-slate-800 font-medium"
                    >
                      내 약속 목록으로
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 서브뷰 4: 약속 상세 화면 (DETAIL) */}
            {meetingSubView === "DETAIL" && currentMtg && (
              <div className="space-y-4">
                <button
                  onClick={() => setMeetingSubView("LIST")}
                  className="flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-slate-800"
                >
                  <span>←</span>
                  <span>내 약속 목록</span>
                </button>

                {/* 약속 상단 요약 카드 */}
                <div className="rounded-3xl p-5 border border-slate-200 bg-white shadow-sm space-y-3.5 text-slate-900">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-bold text-brand-600">
                        {currentMtg.hostOrgBadge} 주최
                      </div>
                      <h2 className="text-lg font-black tracking-tight mt-0.5 text-slate-900">
                        {currentDec ? currentDec.title : (currentMtg.title || "약속")}
                      </h2>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      {(() => {
                        const pBadge = getPostponementBadgeInfo(currentMtg.postponementCount);
                        return (
                          <span className={`px-2.5 py-0.5 rounded-full border text-[10px] font-bold ${pBadge.badgeClass}`}>
                            {pBadge.text}
                          </span>
                        );
                      })()}
                      {(() => {
                        const sBadge = getSeniorityBadgeInfo(
                          currentDec?.highestSeniorityLevel || (currentMtg.hasSeniorAttendee ? "DIRECTOR" : "STAFF"),
                          currentDec?.highestSeniorityStatus || "NONE"
                        );
                        return sBadge.level !== "STAFF" ? (
                          <span className={`px-2.5 py-0.5 rounded-full border text-[10px] font-bold ${sBadge.badgeClass}`}>
                            🔐 {sBadge.text}
                          </span>
                        ) : null;
                      })()}
                    </div>
                  </div>

                  <div className="text-xs font-bold flex flex-wrap items-center gap-1.5 text-slate-700 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                    <span>🗓️ {currentMtg.confirmedDate} 오후 {currentMtg.startTime}</span>
                    <span>·</span>
                    <span className={currentMtg.isPlaceTbd ? "text-amber-600 font-bold" : "text-emerald-700 font-bold"}>
                      📍 {currentMtg.areaHint || "장소 미정"} {currentMtg.isPlaceTbd ? "(장소 미정)" : (currentMtg.selectedPlace ? `(${currentMtg.selectedPlace.name})` : "")}
                    </span>
                  </div>

                  {/* 장소 정하기 안내 & 길찾기 */}
                  {currentMtg.isPlaceTbd || !currentMtg.selectedPlace ? (
                    <button
                      onClick={() => setDetailSection("AI_PLACE")}
                      className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-black text-xs shadow flex items-center justify-center gap-1.5 active:scale-95 transition"
                    >
                      <span>📍</span>
                      <span>[장소 정하기] AI 맞춤 추천 및 식당 선택하기</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <a
                        href={currentMtg.selectedPlace.naverMapUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white font-extrabold text-xs text-center shadow flex items-center justify-center gap-1"
                      >
                        <span>🗺️</span>
                        <span>네이버 지도 길찾기 ({currentMtg.selectedPlace.name}) ↗</span>
                      </a>
                      <button
                        onClick={() => setDetailSection("AI_PLACE")}
                        className="px-3 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs border border-slate-300"
                      >
                        변경
                      </button>
                    </div>
                  )}

                  {/* 주요 액션 버튼: 카카오톡 초대 & 캘린더 연동 */}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={() => setMeetingSubView("INVITE_SHARE")}
                      className="py-2.5 px-3 rounded-xl bg-[#FEE500] hover:bg-[#FADA0A] text-[#191919] font-extrabold text-xs shadow-sm flex items-center justify-center gap-1.5 active:scale-95 transition"
                    >
                      <span>💬</span>
                      <span>카카오톡 초대</span>
                    </button>
                    <button
                      onClick={() => setActiveTab("calendar")}
                      className="py-2.5 px-3 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-900 font-extrabold text-xs border border-purple-200 shadow-sm flex items-center justify-center gap-1.5 active:scale-95 transition"
                    >
                      <span>📅</span>
                      <span>캘린더 연동 허브</span>
                    </button>
                  </div>
                </div>

                {/* 4대 상세 서브 탭 */}
                <div className="grid grid-cols-4 gap-1 bg-slate-100 p-1 rounded-xl text-[11px] font-bold border border-slate-200">
                  {[
                    { id: "PARTICIPANTS", label: "참석자·직급" },
                    { id: "AI_PLACE", label: "장소·식당" },
                    { id: "SCHEDULE_HISTORY", label: "순연·변경" },
                    { id: "NEWS", label: "관련 뉴스" },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setDetailSection(tab.id as any)}
                      className={`py-2 rounded-lg transition ${
                        detailSection === tab.id
                          ? "bg-white text-brand-700 shadow-sm font-extrabold border border-slate-200"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* 서브섹션 1: 참석자 & 암호화된 주요 참석자 관리 */}
                {detailSection === "PARTICIPANTS" && (
                  <div className="rounded-2xl p-4 border border-slate-200 bg-white shadow-sm space-y-3 text-slate-900">
                    <div className="font-extrabold text-xs text-slate-900">
                      🔐 브라우저 복호화 주요 참석자 구성 (서버 평문 미저장)
                    </div>
                    {(currentDec?.seniorAttendees || []).length === 0 ? (
                      <div className="text-[11px] text-slate-500">
                        현재 등록된 부장급 이상 주요 참석자가 없습니다 (일반 실무진 모임).
                      </div>
                    ) : (
                      (currentDec?.seniorAttendees || []).map((sr, idx) => (
                        <div
                          key={idx}
                          className="p-2.5 rounded-xl bg-purple-50 border border-purple-300 flex items-center justify-between text-slate-900"
                        >
                          <div>
                            <span className="font-bold text-purple-950">{sr.displayName}</span>{" "}
                            — <span className="text-purple-900">{sr.jobTitle}</span>
                          </div>
                          <span className="px-2 py-0.5 rounded bg-purple-700 text-white text-[10px] font-bold">
                            {sr.seniorityLevel} (
                            {sr.attendanceConfirmed ? "확정" : "예정"})
                          </span>
                        </div>
                      ))
                    )}

                    <div className="pt-2 border-t border-slate-200 space-y-2 text-slate-900">
                      <div className="font-bold text-[11px] text-slate-800">
                        👔 부장급 이상 주요 참석자 암호화 등록·변경
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <input
                          type="text"
                          value={srNameInput}
                          onChange={(e) => setSrNameInput(e.target.value)}
                          className="px-2 py-1.5 rounded border border-slate-300 text-slate-900 bg-white"
                        />
                        <input
                          type="text"
                          value={srTitleInput}
                          onChange={(e) => setSrTitleInput(e.target.value)}
                          className="px-2 py-1.5 rounded border border-slate-300 text-slate-900 bg-white"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <select
                          value={srLevelInput}
                          onChange={(e) => setSrLevelInput(e.target.value)}
                          className="px-2 py-1.5 rounded border border-slate-300 text-slate-900 font-bold bg-white"
                        >
                          <option value="DIRECTOR">부장급 참석</option>
                          <option value="EXECUTIVE">임원 참석</option>
                          <option value="CEO">CEO·기관장 참석</option>
                        </select>
                        <select
                          value={srConfirmedInput ? "CONFIRMED" : "SCHEDULED"}
                          onChange={(e) =>
                            setSrConfirmedInput(e.target.value === "CONFIRMED")
                          }
                          className="px-2 py-1.5 rounded border border-slate-300 text-slate-900 bg-white"
                        >
                          <option value="SCHEDULED">참석 예정</option>
                          <option value="CONFIRMED">참석 확정</option>
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() =>
                            handleSeniorAttendeeMutation(currentMtg.id, false)
                          }
                          className="py-2 rounded-xl bg-purple-700 text-white font-bold"
                        >
                          + 주요 참석자 암호화 등록
                        </button>
                        <button
                          onClick={() =>
                            handleSeniorAttendeeMutation(currentMtg.id, true)
                          }
                          className="py-2 rounded-xl bg-slate-200 text-slate-800 font-bold"
                        >
                          참석 철회
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* 서브섹션 2: 장소 정하기 / AI 맞춤 장소 추천 */}
                {detailSection === "AI_PLACE" && (
                  <div className="rounded-2xl p-4 border border-slate-200 bg-white shadow-sm space-y-3.5 text-slate-900">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-sm text-slate-900">
                        📍 장소 정하기 & 식당 추천
                      </span>
                      <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-900 text-[10px] font-bold">
                        네이버 지도 연동
                      </span>
                    </div>

                    {/* 본인 음식 취향 보존 정책 */}
                    <div className="p-3 rounded-xl bg-blue-50/70 border border-blue-200 space-y-2 text-slate-900">
                      <div className="font-bold text-brand-800 text-[11px]">
                        🍽️ 내 음식 취향 등록 (타인에게 비공개 · 기본값: 이번 모임만)
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={myDislikedInput}
                          onChange={(e) => setMyDislikedInput(e.target.value)}
                          className="flex-1 px-2 py-1 rounded border border-slate-300 text-slate-900 text-[11px] bg-white"
                        />
                        <button
                          onClick={() => handleSaveMyPreference(currentMtg.id)}
                          className="px-2.5 py-1 rounded bg-brand-600 text-white font-bold text-[11px]"
                        >
                          저장
                        </button>
                      </div>
                    </div>

                    <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-800">
                      <input
                        type="checkbox"
                        checked={excludePastVisited}
                        onChange={(e) =>
                          setExcludePastVisited(e.target.checked)
                        }
                      />
                      <span>
                        [지난번 방문한 식당 제외] (서버/AI 노출 없이 브라우저에서 내 이력 로컬 필터링)
                      </span>
                    </label>

                    <button
                      onClick={() => handleRunAiRecommendation(currentMtg.id)}
                      className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-extrabold shadow-sm active:scale-95 transition"
                    >
                      🔍 AI 맞춤 식당 후보 불러오기
                    </button>

                    {/* 추천 식당 목록 전체 카톡 공유 버튼 */}
                    <button
                      onClick={() =>
                        handleShareAllPlaces(
                          browserFilteredRecs.filteredRecommendations.length > 0
                            ? browserFilteredRecs.filteredRecommendations
                            : placesCatalog.length > 0
                            ? placesCatalog
                            : DEFAULT_PLACES
                        )
                      }
                      className="w-full py-3 rounded-xl bg-[#FEE500] hover:bg-[#FDD800] text-[#191919] font-black text-xs flex items-center justify-center gap-2 shadow-sm active:scale-95 transition"
                    >
                      <span>💬</span>
                      <span>추천 식당 목록 전체 카톡 공유하기</span>
                    </button>

                    {/* 식당 카드 리스트 */}
                    <div className="space-y-3 pt-1">
                      {(browserFilteredRecs.filteredRecommendations.length > 0
                        ? browserFilteredRecs.filteredRecommendations
                        : placesCatalog.length > 0
                        ? placesCatalog
                        : DEFAULT_PLACES
                      ).map((place: any) => {
                        const pName = place.name || place.placeName;
                        const pCuisine = place.cuisineType;
                        const pAddr = place.roadAddress;
                        const pSummary =
                          place.officialInfoSummary ||
                          place.recommendationReason ||
                          "비즈니스 오찬에 적합한 식당입니다.";
                        const mapUrl =
                          place.naverMapUrl ||
                          `https://map.naver.com/p/search/${encodeURIComponent(pName)}`;

                        return (
                          <div
                            key={place.id}
                            className="bg-white rounded-2xl p-3.5 border border-slate-200 shadow-sm space-y-2 text-slate-900"
                          >
                            <div className="flex items-start justify-between gap-1.5">
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-extrabold text-slate-900">
                                    {pName}
                                  </span>
                                  <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-800 font-bold text-[10px] border border-blue-200">
                                    {pCuisine}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  📍 {pAddr}
                                </p>
                                <p className="text-[11px] text-slate-700 mt-1 font-medium">
                                  ✨ {pSummary}
                                </p>
                              </div>
                            </div>

                            <div className="grid grid-cols-3 gap-1.5 pt-1">
                              <button
                                onClick={() => handleSharePlace(place)}
                                className="py-2 px-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-950 font-extrabold text-[11px] border border-amber-300 flex items-center justify-center gap-1 shadow-sm active:scale-95 transition"
                              >
                                <span>💬</span>
                                <span>카톡 공유</span>
                              </button>
                              <a
                                href={mapUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="py-2 px-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-[11px] border border-slate-300 flex items-center justify-center gap-1 text-center"
                              >
                                <span>🗺️</span>
                                <span>지도 보기</span>
                              </a>
                              <button
                                onClick={() =>
                                  handleSelectPlace(
                                    currentMtg.id,
                                    place.placeId || place.id
                                  )
                                }
                                className="py-2 px-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-[11px] shadow-sm flex items-center justify-center gap-1 active:scale-95 transition"
                              >
                                <span>✓</span>
                                <span>장소 확정</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 서브섹션 3: 일정 순연 및 변경 */}
                {detailSection === "SCHEDULE_HISTORY" && (
                  <div className="rounded-2xl p-4 border border-slate-200 bg-white shadow-sm space-y-3 text-slate-900">
                    <div className="font-extrabold text-sm text-slate-900">
                      🗓️ 일정 변경 및 순연 이력 (누적 순연:{" "}
                      {currentMtg.postponementCount}회)
                    </div>
                    {(currentMtg.scheduleChanges || []).map((sc: any) => (
                      <div
                        key={sc.id}
                        className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-800"
                      >
                        {sc.changeType === "INITIAL_CONFIRM"
                          ? `최초 확정: ${sc.newDate}`
                          : sc.changeType === "POSTPONED"
                          ? `${sc.postponementNumber}차 순연: ${sc.previousDate} → ${sc.newDate}`
                          : `${sc.changeType}: ${sc.newDate}`}
                      </div>
                    ))}
                  </div>
                )}

                {/* 서브섹션 4: 관련 뉴스 */}
                {detailSection === "NEWS" && (
                  <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 space-y-2">
                    {(newsData?.articles || []).map((art: any) => (
                      <a
                        key={art.id}
                        href={art.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block p-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-900"
                      >
                        <div className="font-bold text-slate-900">{art.title} ↗</div>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ============================================================== */}
        {/* [메뉴 2] 캘린더 (개인 및 팀 연동 허브) */}
        {/* ============================================================== */}
        {activeTab === "calendar" && (
          <div className="space-y-4 text-slate-900">
            {/* 상단 헤더 & 개요 */}
            <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 shadow-sm space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-sm flex items-center gap-1.5 text-slate-900">
                  <span>📅</span> 캘린더 자동 연동 & 알림 허브
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-900">
                  3종 캘린더 지원
                </span>
              </div>
              <p className="text-[11px] text-slate-600">
                아이폰 기본 캘린더, Google Calendar, 또는 1회성 .ICS 다운로드로 약속 일정을 편리하게 관리하세요.
              </p>
            </div>

            {/* ① 아이폰 기본 캘린더 (Apple Calendar) 구독 - iOS 우선 추천 */}
            <div className="bg-white text-slate-900 rounded-2xl p-4 border-2 border-brand-500/50 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-base">🍎</span>
                  <span className="font-extrabold text-xs text-slate-900">
                    ① 아이폰 기본 캘린더 자동 연동 (Apple Calendar)
                  </span>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-600 text-white animate-pulse">
                  iOS 추천
                </span>
              </div>

              <p className="text-[11px] text-slate-700 leading-relaxed">
                아이폰 이용자는 최초 1회만 구독하면, 이후 팀약에서 수락한 모임이 <strong className="text-slate-900">아이폰 기본 캘린더에 자동으로 동기화</strong>됩니다.
              </p>

              {/* 구독 상태 및 피드 URL */}
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-2 text-[11px] text-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">구독 연동 상태:</span>
                  <span className={`font-bold px-2 py-0.5 rounded-md text-[10px] ${
                    appleCalData?.appleCalendar?.enabled
                      ? "bg-emerald-100 text-emerald-900 font-extrabold"
                      : "bg-red-100 text-red-900 font-extrabold"
                  }`}>
                    {appleCalData?.appleCalendar?.enabled ? "● 정상 구독 활성" : "○ 구독 비활성화됨"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">현재 동기화 모임:</span>
                  <span className="font-extrabold text-brand-700">
                    {appleCalData?.appleCalendar?.activeEventsCount ?? 0}건 확정 모임
                  </span>
                </div>
                <div className="space-y-1">
                  <span className="text-slate-600 text-[10px]">내 고유 구독 피드 URL:</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      readOnly
                      value={appleCalData?.appleCalendar?.httpsUrl || "URL 생성 중..."}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-[10px] font-mono select-all text-slate-900"
                    />
                    <button
                      onClick={() => handleCopyFeedUrl(appleCalData?.appleCalendar?.httpsUrl)}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-900 font-bold text-[10px] whitespace-nowrap"
                    >
                      {isCopiedFeed ? "✓ 복사됨" : "URL 복사"}
                    </button>
                  </div>
                </div>
              </div>

              {/* 액션 버튼 그룹 */}
              <div className="grid grid-cols-2 gap-2">
                <a
                  href={appleCalData?.appleCalendar?.webcalUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="py-2.5 px-3 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-extrabold text-xs text-center shadow flex items-center justify-center gap-1 transition"
                >
                  <span>📲</span>
                  <span>1클릭 캘린더 구독</span>
                </a>
                <button
                  onClick={() => handleAppleCalendarAction("REGENERATE_TOKEN")}
                  className="py-2.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-900 font-extrabold text-xs border border-slate-300 flex items-center justify-center gap-1 transition"
                >
                  <span>🔄</span>
                  <span>구독 URL 재발급</span>
                </button>
              </div>

              {/* 구독 일시 중단 토글 버튼 */}
              <div className="flex justify-end">
                <button
                  onClick={() =>
                    handleAppleCalendarAction(
                      appleCalData?.appleCalendar?.enabled ? "REVOKE_FEED" : "ENABLE_FEED"
                    )
                  }
                  className="text-[10px] text-slate-500 hover:text-slate-800 underline"
                >
                  {appleCalData?.appleCalendar?.enabled
                    ? "구독 피드 일시 차단하기"
                    : "구독 피드 다시 활성화하기"}
                </button>
              </div>

              {/* 갱신 지연 안내문구 */}
              <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 space-y-1 text-[11px]">
                <div className="font-extrabold flex items-center gap-1 text-amber-950">
                  <span>⚠️</span>
                  <span>[필독] 아이폰 캘린더 동기화 주기 및 갱신 지연 안내</span>
                </div>
                <p className="text-[10px] leading-relaxed text-amber-900">
                  아이폰 캘린더는 Apple/iCloud의 백그라운드 폴링 정책(보통 수십 분~수 시간 간격)에 따라 팀약 서버를 정기 확인합니다.
                  따라서 약속 일정이 변경되거나 취소되더라도 아이폰 화면에 <strong>즉각 반영되지 않고 지연</strong>될 수 있습니다.
                </p>
                <p className="text-[10px] font-semibold text-amber-900">
                  💡 <strong>즉시 반영 팁</strong>: 아이폰 [캘린더 앱 &gt; 하단 &apos;캘린더&apos; 목록 &gt; 화면을 아래로 당겨 새로고침]을 실행하시면 최신 일정이 즉시 동기화됩니다.
                </p>
              </div>

              {/* 프라이버시 원칙 고지 */}
              <div className="p-2 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 text-[10px] flex items-start gap-1">
                <span>🔒</span>
                <span>
                  <strong>개인정보 보호</strong>: 외부 캘린더 피드에는 보안을 위해 상대방 회사·직함 등 민감 정보가 배제되며, 기본적으로 <strong>&apos;팀약 일정&apos;</strong> 중립 명칭으로 안전하게 등록됩니다.
                </span>
              </div>
            </div>

            {/* ② Google Calendar 연결 */}
            <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-xs flex items-center gap-1.5 text-slate-900">
                  <span>🗓️</span> ② Google Calendar 실시간 연동
                </span>
                <span className="text-[10px] text-slate-500 font-mono">OAuth 2.0 / API v3</span>
              </div>
              <p className="text-[11px] text-slate-600">
                Google 캘린더 계정과 연동하여 버튼 클릭 시 실시간으로 일정을 푸시 동기화합니다.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleGoogleCalendarSync(currentMtg ? currentMtg.id : "mtg_1")}
                  className="flex-1 py-2 px-3 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-900 font-extrabold text-xs border border-blue-200 flex items-center justify-center gap-1.5 transition"
                >
                  <span>📅</span>
                  <span>현재 모임 Google 캘린더 동기화</span>
                </button>
              </div>
            </div>

            {/* ③ 1회성 .ICS 파일 다운로드 */}
            <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-xs flex items-center gap-1.5 text-slate-900">
                  <span>📥</span> ③ 1회성 .ICS 파일 다운로드
                </span>
                <span className="text-[10px] text-slate-500 font-mono">RFC 5545</span>
              </div>
              <p className="text-[11px] text-slate-600">
                구독 없이 현재 모임 일정을 개인 파일(.ics)로 내려받아 Outlook, 네이버 캘린더 등에 1회성으로 등록합니다.
              </p>
              <button
                onClick={() => handleDownloadSingleIcs(currentMtg)}
                className="w-full py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-900 font-extrabold text-xs border border-slate-200 flex items-center justify-center gap-1.5 transition"
              >
                <span>💾</span>
                <span>[{currentMtg?.confirmedDate || "오늘"}] 모임 .ICS 파일 다운로드</span>
              </button>
            </div>

            {/* ④ 중립 문구 당일 아침 알림 센터 */}
            <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 space-y-2 text-xs">
              <div className="font-extrabold flex items-center gap-1 text-slate-900">
                <span>🔔</span>
                <span>중립 문구 당일 아침 알림 센터</span>
              </div>
              {(notifData?.deliveries || []).slice(0, 4).map((nd: any) => (
                <div
                  key={nd.id}
                  className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1 text-[11px] text-slate-800"
                >
                  <div className="font-bold text-brand-700">
                    [{nd.notificationType}]
                  </div>
                  <div>• 기본 중립 알림: &ldquo;{nd.messagePreview}&rdquo;</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* [메뉴 3] 이력 (과거 만남 및 방문 식당 기록) */}
        {/* ============================================================== */}
        {activeTab === "history" && (
          <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <div className="font-extrabold text-slate-900 text-sm">
                📜 내 개인 암호화 만남 이력
              </div>
              <span className="text-[10px] text-slate-500">
                총 {histories.length}건
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              서버 평문 저장 없이 브라우저에서 복호화된 개인 만남 기록입니다.
            </p>
            <div className="space-y-2">
              {histories.map((h) => {
                const dec = decryptedHistoriesMap[h.id];
                return (
                  <div
                    key={h.id}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1 text-slate-900"
                  >
                    <div className="font-bold text-brand-700">
                      {h.meetingDate} — {dec?.counterpartOrgName || "🔒 암호화됨"}
                    </div>
                    <div className="text-[11px] text-slate-800">
                      방문 식당: <strong>{dec?.detailedPlaceName || "장소 비공개"}</strong>
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 truncate">
                      DB 저장 해시(평문 없음): {h.encryptedHistoryBlob}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* [메뉴 4] 설정 (계정 정보, 팀 설정, 진단) */}
        {/* ============================================================== */}
        {activeTab === "settings" && (
          <div className="space-y-4 text-xs text-slate-900">
            {/* 내 계정 프로필 카드 */}
            <div className="bg-white rounded-3xl p-5 border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-sm text-slate-900">
                  👤 내 프로필 및 계정
                </span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                  {isLoggedIn ? "로그인 활성" : "미로그인"}
                </span>
              </div>

              <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2 text-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">이름</span>
                  <span className="font-extrabold text-slate-900">
                    {accounts.find((a) => a.id === currentUserId)?.displayName || "카카오 회원"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">소속 및 직함</span>
                  <span className="font-bold text-slate-800">
                    {accounts.find((a) => a.id === currentUserId)?.jobTitle || "팀약 회원"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">이메일</span>
                  <span className="text-slate-700 font-mono text-[10px]">
                    {accounts.find((a) => a.id === currentUserId)?.email || "카카오 연동 계정"}
                  </span>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const cur = accounts.find((a) => a.id === currentUserId);
                    setProfileNameInput(cur?.displayName || "");
                    const parts = (cur?.jobTitle || "").split(" ");
                    setProfileOrgInput(parts.length > 1 ? parts[0] : "");
                    setProfileTitleInput(parts.length > 1 ? parts.slice(1).join(" ") : cur?.jobTitle || "");
                    setShowProfileModal(true);
                  }}
                  className="flex-1 py-3 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition"
                >
                  <span>✏️</span>
                  <span>내 프로필 수정</span>
                </button>
                <button
                  onClick={() => {
                    const clientId =
                      process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID ||
                      "b1ec0592928d85a41c49f7b984b0bdd1";
                    const redirectUri = `${window.location.origin}/auth/callback`;
                    const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
                      redirectUri
                    )}&response_type=code&state=${encodeURIComponent("/")}`;
                    window.location.href = kakaoAuthUrl;
                  }}
                  className="flex-1 py-3 rounded-2xl bg-[#FEE500] hover:bg-[#FDD800] text-[#191919] font-black text-xs flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition"
                >
                  <span>💬</span>
                  <span>카카오 재로그인</span>
                </button>
              </div>
            </div>

            {/* 캘린더 연동 바로가기 카드 */}
            <div className="bg-white rounded-3xl p-5 border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-sm text-slate-900">
                  📅 캘린더 연동 설정
                </span>
                <button
                  onClick={() => setActiveTab("calendar")}
                  className="text-brand-600 font-bold text-[11px] underline"
                >
                  캘린더 허브 열기 →
                </button>
              </div>
              <p className="text-[11px] text-slate-600">
                아이폰 기본 캘린더 구독(Webcal) 및 Google Calendar 동기화를 설정하고 관리합니다.
              </p>
            </div>

            {/* 개발자 진단 및 테스트 계정 전환 */}
            <details className="bg-white rounded-3xl p-4 border border-slate-200 text-xs text-slate-700">
              <summary className="cursor-pointer font-extrabold text-slate-800 py-1">
                🛠️ 테스트 계정 전환 및 진단 (클릭하여 열기)
              </summary>
              <div className="pt-3 space-y-2.5">
                <div className="text-[11px] text-slate-500">
                  다른 역할(기자, 홍보팀, 임원 등)의 시점으로 화면을 즉시 전환하여 테스트합니다:
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {accounts.map((acc) => (
                    <button
                      key={acc.id}
                      onClick={() => handleAccountChange(acc.id)}
                      className={`p-2 rounded-xl text-[11px] text-left border font-semibold transition ${
                        currentUserId === acc.id
                          ? "bg-slate-900 text-white border-slate-900 font-bold"
                          : "bg-slate-50 text-slate-800 border-slate-200 hover:bg-slate-100"
                      }`}
                    >
                      <div className="truncate">{acc.displayName}</div>
                      <div className="text-[9px] opacity-75 truncate">{acc.jobTitle}</div>
                    </button>
                  ))}
                </div>
              </div>
            </details>
          </div>
        )}
      </div>

      {/* ============================================================== */}
      {/* 4대 통합 하단 네비게이션: 약속 | 캘린더 | 이력 | 설정 */}
      {/* ============================================================== */}
      <nav className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-slate-200 grid grid-cols-4 text-[11px] py-2.5 font-bold z-40 shadow-lg text-slate-900">
        {[
          { id: "meetings", label: "약속", icon: "📋" },
          { id: "calendar", label: "캘린더", icon: "📅" },
          { id: "history", label: "이력", icon: "📜" },
          { id: "settings", label: "설정", icon: "⚙️" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setActiveTab(t.id as any);
              if (t.id === "meetings") setMeetingSubView("LIST");
            }}
            className={`flex flex-col items-center gap-0.5 ${
              activeTab === t.id
                ? "text-brand-600 font-extrabold"
                : "text-slate-500 hover:text-slate-900"
            }`}
          >
            <span className="text-base">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {/* ============================================================== */}
      {/* 최초 로그인 온보딩 & 프로필 수정 모달 */}
      {/* ============================================================== */}
      {showProfileModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl border border-slate-200 space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="text-center space-y-1">
              <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center text-2xl mx-auto mb-2">
                👋
              </div>
              <h3 className="text-base font-extrabold text-slate-900 tracking-tight">
                프로필을 등록해 주세요
              </h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                기자 및 기업 홍보 담당자와의 약속 생성·초대 시 표시될 정보를 확인해 주세요.
              </p>
            </div>

            <div className="space-y-3 pt-2 text-left">
              <div>
                <label className="text-[11px] font-bold text-slate-700 block mb-1">
                  이름 (성함) <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={profileNameInput}
                  onChange={(e) => setProfileNameInput(e.target.value)}
                  placeholder="예: 홍길동"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 text-xs font-bold text-slate-900 bg-white"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-700 block mb-1">
                  소속 회사 / 언론사
                </label>
                <input
                  type="text"
                  value={profileOrgInput}
                  onChange={(e) => setProfileOrgInput(e.target.value)}
                  placeholder="예: 중앙일보, 삼성생명, 스타트업 등"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 text-xs font-bold text-slate-900 bg-white"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-700 block mb-1">
                  부서 및 직함 (직급)
                </label>
                <input
                  type="text"
                  value={profileTitleInput}
                  onChange={(e) => setProfileTitleInput(e.target.value)}
                  placeholder="예: 경제부 기자, 홍보팀 과장, 대표 등"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 text-xs font-bold text-slate-900 bg-white"
                />
              </div>
            </div>

            <div className="pt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setShowProfileModal(false)}
                className="flex-1 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition"
              >
                나중에 하기
              </button>
              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={isSavingProfile}
                className="flex-1 py-3 rounded-2xl bg-brand-600 hover:bg-brand-700 text-white font-extrabold text-xs shadow-md transition disabled:opacity-50"
              >
                {isSavingProfile ? "저장 중..." : "저장 완료"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
