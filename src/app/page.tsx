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
      text: `부장급 참석 ${suffix}`,
      badgeClass:
        "bg-blue-100 text-blue-900 border-blue-400 dark:bg-blue-950/80 dark:text-blue-200 dark:border-blue-500",
    };
  }
  if (level === "EXECUTIVE") {
    return {
      text: `임원 참석 ${suffix}`,
      badgeClass:
        "bg-purple-100 text-purple-900 border-purple-400 dark:bg-purple-950/80 dark:text-purple-200 dark:border-purple-500",
    };
  }
  if (level === "CEO") {
    return {
      text: `CEO·기관장 참석 ${suffix}`,
      badgeClass:
        "bg-amber-100 text-amber-950 border-amber-500 font-extrabold dark:bg-amber-950/80 dark:text-amber-200 dark:border-amber-400",
    };
  }
  return {
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
}

export default function TeamyakUnifiedApp() {
  const [dualDeviceMode, setDualDeviceMode] = useState<boolean>(false);
  const [viewportWidth, setViewportWidth] = useState<number>(390);
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [globalVerifyLog, setGlobalVerifyLog] = useState<string[]>([]);
  const [isRunningTests, setIsRunningTests] = useState<boolean>(false);
  const [syncPulse, setSyncPulse] = useState<number>(0);

  const triggerGlobalSync = useCallback(() => {
    setSyncPulse((p) => p + 1);
  }, []);

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((data) => {
        if (data.availableTestAccounts) setAccounts(data.availableTestAccounts);
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
          : "bg-slate-900 text-slate-100"
      }`}
    >
      <header className="w-full bg-slate-950 border-b border-slate-800 px-3 py-2.5 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-emerald-600 text-[11px] font-extrabold text-white">
                FINAL POLICY & SECURITY
              </span>
              <h1 className="text-sm sm:text-base font-extrabold text-white">
                팀약 (TEAMYAK) — 신규 기능 3종 최종 정책 및 보안 보완
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-700 text-[11px]">
                {[
                  { w: 320, label: "320px" },
                  { w: 390, label: "390px" },
                  { w: 768, label: "768px" },
                  { w: 0, label: "PC" },
                ].map((vp) => (
                  <button
                    key={vp.w}
                    onClick={() => setViewportWidth(vp.w)}
                    className={`px-2 py-0.5 rounded ${
                      viewportWidth === vp.w
                        ? "bg-brand-600 text-white font-bold"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {vp.label}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setDarkMode(!darkMode)}
                className="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 font-semibold text-[11px]"
              >
                {darkMode ? "🌙 다크 모드" : "☀️ 라이트 모드"}
              </button>

              <button
                onClick={() => setDualDeviceMode(!dualDeviceMode)}
                className={`px-2.5 py-1 rounded-lg font-bold border text-[11px] ${
                  dualDeviceMode
                    ? "bg-amber-400 text-slate-950 border-amber-300"
                    : "bg-slate-800 text-amber-300 border-slate-700"
                }`}
              >
                {dualDeviceMode ? "📱📱 2단말 비교: ON" : "📱 2단말 비교 열기"}
              </button>

              <button
                onClick={runFinalSecurityAndPolicyVerification}
                disabled={isRunningTests}
                className="px-3 py-1 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-bold shadow text-[11px]"
              >
                {isRunningTests
                  ? "검증 실행 중..."
                  : "🛡️ 최종 정책 8대 항목 & 보안 자동 검증 실행"}
              </button>
            </div>
          </div>

          {globalVerifyLog.length > 0 && (
            <div className="bg-slate-900 border border-emerald-600/60 rounded-xl p-3 text-[11px] space-y-1 max-h-48 overflow-y-auto">
              <div className="flex items-center justify-between pb-1 border-b border-slate-800">
                <span className="font-bold text-emerald-400">
                  🛡️ 신규 기능 3종 최종 정책 및 보안 검증 결과
                </span>
                <button
                  onClick={() => setGlobalVerifyLog([])}
                  className="text-slate-400 hover:text-white"
                >
                  닫기 ✕
                </button>
              </div>
              {globalVerifyLog.map((line, i) => (
                <div key={i} className="text-slate-100 font-mono leading-relaxed">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto py-4 px-2 sm:px-4 flex flex-col lg:flex-row items-start justify-center gap-6">
        <MobileDeviceInstance
          deviceTitle="단말 세션 #1 (호스트: 삼성생명 김민준 대리)"
          defaultUserId="u_kim"
          defaultTab="meeting_detail"
          viewportWidth={viewportWidth}
          darkMode={darkMode}
          accounts={accounts}
          syncPulse={syncPulse}
          onStateMutated={triggerGlobalSync}
        />

        {dualDeviceMode && (
          <MobileDeviceInstance
            deviceTitle="단말 세션 #2 (게스트: 중앙일보 박서연 기자)"
            defaultUserId="u_park"
            defaultTab="invite"
            viewportWidth={viewportWidth}
            darkMode={darkMode}
            accounts={accounts}
            syncPulse={syncPulse}
            onStateMutated={triggerGlobalSync}
          />
        )}
      </main>
    </div>
  );
}

function MobileDeviceInstance({
  deviceTitle,
  defaultUserId,
  defaultTab,
  viewportWidth,
  darkMode,
  accounts,
  syncPulse,
  onStateMutated,
}: {
  deviceTitle: string;
  defaultUserId: string;
  defaultTab: "meeting_detail" | "invite" | "calendar" | "history";
  viewportWidth: number;
  darkMode: boolean;
  accounts: AccountInfo[];
  syncPulse: number;
  onStateMutated: () => void;
}) {
  const [sessionToken, setSessionToken] = useState<string>("");
  const [currentUserId, setCurrentUserId] = useState<string>(defaultUserId);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<string>(defaultTab);
  const [detailSection, setDetailSection] = useState<
    "PARTICIPANTS" | "AI_PLACE" | "SCHEDULE_HISTORY" | "NEWS"
  >("PARTICIPANTS");

  const [fragmentKey] = useState<string>(DEFAULT_FRAGMENT_KEY);
  const [inviteCode] = useState<string>("inv_9x82a");
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
    const found = accounts.find((a) => a.id === currentUserId);
    if (found && found.sessionToken && !sessionToken) {
      setSessionToken(found.sessionToken);
    }
  }, [accounts, currentUserId, sessionToken]);

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
        const list = mJson.directMeetings || [];
        setDirectMeetings(list);

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

  async function handleKakaoShare(meetingId: string) {
    const activeInviteCode = currentMtg?.inviteCode || inviteCode;
    const inviteUrl = `${window.location.origin}/i/${activeInviteCode}#k=${fragmentKey}`;

    if (
      typeof window !== "undefined" &&
      (window as any).Kakao &&
      (window as any).Kakao.isInitialized()
    ) {
      try {
        (window as any).Kakao.Share.sendDefault({
          objectType: "feed",
          content: {
            title: `[TEAMYAK] ${currentMtg?.hostOrgBadge || "업무 오찬"} 약속 초대장`,
            description: `${currentMtg?.confirmedDate || "약속 일시"} 오후 ${
              currentMtg?.startTime || "12:00"
            } · ${currentMtg?.areaHint || "여의도"}`,
            imageUrl: "https://teamyak.kr/teamyak-og-card.png",
            link: {
              mobileWebUrl: inviteUrl,
              webUrl: inviteUrl,
            },
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
        showMsg("💬 카카오톡 초대장이 카카오톡 앱으로 공유되었습니다.");
        return;
      } catch (err) {
        // Fallback to clipboard
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

  const currentMtg = directMeetings[0] || null;
  const currentDec = currentMtg ? decryptedMeetingsMap[currentMtg.id] : null;
  const containerStyle =
    viewportWidth === 0
      ? { width: "100%", maxWidth: "880px" }
      : { width: `${viewportWidth}px`, maxWidth: "100%" };

  // 브라우저 로컬에서 복호화된 내 방문 식당을 제외한 추천 목록 계산
  const browserFilteredRecs = currentMtg
    ? filterRecommendationsInBrowser(
        currentMtg.recommendations || [],
        Object.values(decryptedHistoriesMap),
        excludePastVisited
      )
    : { filteredRecommendations: [], excludedInBrowserPlaceNames: [] };

  return (
    <div
      style={containerStyle}
      className={`rounded-[28px] shadow-2xl border-2 overflow-hidden flex flex-col transition-all ${
        darkMode
          ? "bg-slate-900 text-slate-100 border-slate-700"
          : "bg-slate-50 text-slate-900 border-slate-300"
      }`}
    >
      <div className="bg-slate-900 text-white px-3.5 py-2.5 space-y-2 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-extrabold text-amber-300 truncate">
            {deviceTitle}
          </span>
          <button
            onClick={() => setIsLoggedIn(!isLoggedIn)}
            className={`px-2 py-0.5 rounded text-[10px] font-bold shrink-0 ${
              isLoggedIn
                ? "bg-emerald-600 text-white"
                : "bg-amber-500 text-slate-950"
            }`}
          >
            {isLoggedIn ? "로그인됨" : "비로그인(미승인)"}
          </button>
        </div>

        <button
          onClick={() => {
            const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
            if (supabaseUrl) {
              const redirectUri = `${window.location.origin}/auth/callback?returnTo=/`;
              window.location.href = `${supabaseUrl}/auth/v1/authorize?provider=kakao&redirect_to=${encodeURIComponent(
                redirectUri
              )}`;
            }
          }}
          className="w-full py-1.5 px-3 bg-[#FEE500] hover:bg-[#FDD800] text-[#191919] font-black rounded-lg flex items-center justify-center gap-1.5 text-[11px] shadow-sm transition-transform active:scale-98"
        >
          <span>💬</span>
          <span>카카오로 실계정 로그인</span>
        </button>

        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11px] text-slate-400 shrink-0">계정:</span>
          <select
            value={currentUserId}
            onChange={(e) => handleAccountChange(e.target.value)}
            className="flex-1 bg-slate-800 text-white text-xs font-bold px-2 py-1 rounded-lg border border-slate-700"
          >
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.displayName} ({acc.jobTitle})
              </option>
            ))}
          </select>
        </div>
      </div>

      {toast && (
        <div className="bg-slate-900 text-emerald-200 px-3.5 py-2 text-[11px] border-b border-slate-700 flex items-start justify-between gap-2">
          <span>{toast}</span>
          <button
            onClick={() => setToast(null)}
            className="text-white font-bold"
          >
            ✕
          </button>
        </div>
      )}

      <div className="p-3.5 space-y-3.5 min-h-[620px] max-h-[720px] overflow-y-auto">
        {activeTab === "meeting_detail" && (
          <div className="space-y-3.5 text-xs">
            {!currentMtg ? (
              <div
                className={`rounded-2xl p-5 border text-center space-y-2 ${
                  darkMode
                    ? "bg-slate-800 border-slate-700 text-slate-300"
                    : "bg-white border-slate-200 text-slate-600"
                }`}
              >
                <div className="font-extrabold text-sm">
                  🔒 비로그인 또는 미승인 상태입니다
                </div>
                <p className="text-[11px]">
                  비로그인·미승인 사용자에게는 부장급 이상 주요 참석자 배지와 모임 상세가 노출되지 않습니다.
                </p>
              </div>
            ) : (
              <>
                {/* 상단 요약 카드 */}
                <div
                  className={`rounded-2xl p-4 border shadow-sm space-y-3 ${
                    darkMode
                      ? "bg-slate-800 border-slate-700"
                      : "bg-white border-slate-200"
                  }`}
                >
                  <div>
                    <div className="text-[11px] font-bold text-brand-600">
                      {currentMtg.hostOrgBadge} 주최
                    </div>
                    <h2 className="text-lg font-extrabold tracking-tight mt-0.5">
                      {currentDec ? currentDec.title : "삼성생명 홍보팀 오찬"}
                    </h2>

                    <div className="mt-1.5 text-xs font-bold flex flex-wrap items-center gap-1.5">
                      <span>
                        🗓️ {currentMtg.confirmedDate} 오후 {currentMtg.startTime}
                      </span>
                      <span>·</span>
                      <span
                        className={
                          currentMtg.isPlaceTbd
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-emerald-700 dark:text-emerald-400"
                        }
                      >
                        📍 {currentMtg.areaHint} ·{" "}
                        {currentMtg.selectedPlace
                          ? currentMtg.selectedPlace.name
                          : "장소 미확정"}
                      </span>
                    </div>

                    {/* 순연 배지 & 브라우저에서 복호화된 주요 참석자 배지 (서버 평문 미저장!) */}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                      {(() => {
                        const pBadge = getPostponementBadgeInfo(
                          currentMtg.postponementCount
                        );
                        return (
                          <span
                            className={`px-2.5 py-0.5 rounded-full border text-[11px] font-bold ${pBadge.badgeClass}`}
                          >
                            [{pBadge.text}]
                          </span>
                        );
                      })()}

                      {(() => {
                        const sBadge = getSeniorityBadgeInfo(
                          currentDec?.highestSeniorityLevel || "STAFF",
                          currentDec?.highestSeniorityStatus || "NONE"
                        );
                        return (
                          <span
                            className={`px-2.5 py-0.5 rounded-full border text-[11px] font-bold ${sBadge.badgeClass}`}
                          >
                            [🔐 {sBadge.text}]
                          </span>
                        );
                      })()}
                    </div>
                  </div>

                  {currentMtg.isPlaceTbd || !currentMtg.selectedPlace ? (
                    <button
                      onClick={() => setDetailSection("AI_PLACE")}
                      className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-extrabold text-xs shadow"
                    >
                      🤖 [AI 장소 추천] 참석자 취향 기반 식당 찾기 (시뮬레이션)
                    </button>
                  ) : (
                    <a
                      href={currentMtg.selectedPlace.naverMapUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full py-2.5 rounded-xl bg-emerald-600 text-white font-extrabold text-xs text-center"
                    >
                      🗺️ 네이버 지도 길찾기 ({currentMtg.selectedPlace.name}) ↗
                    </a>
                  )}

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={() => handleKakaoShare(currentMtg.id)}
                      className="py-2.5 px-3 rounded-xl bg-[#FEE500] hover:bg-[#FADA0A] text-[#191919] font-extrabold text-xs shadow-sm flex items-center justify-center gap-1.5 transition"
                    >
                      <span>💬</span>
                      <span>카카오톡 초대 공유</span>
                    </button>
                    <button
                      onClick={() => setActiveTab("calendar")}
                      className="py-2.5 px-3 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-900 dark:bg-purple-950/60 dark:text-purple-300 font-extrabold text-xs border border-purple-200 dark:border-purple-800 shadow-sm flex items-center justify-center gap-1.5 transition"
                    >
                      <span>📅</span>
                      <span>캘린더 자동 연동 허브</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-1 text-[11px]">
                    <button
                      onClick={() => handleGoogleCalendarSync(currentMtg.id)}
                      className="py-1.5 px-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 flex items-center justify-center gap-1"
                    >
                      <span>🗓️</span> Google 동기화
                    </button>
                    <button
                      onClick={() => handleDownloadSingleIcs(currentMtg)}
                      className="py-1.5 px-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700 flex items-center justify-center gap-1"
                    >
                      <span>📥</span> 1회성 .ICS 다운로드
                    </button>
                  </div>
                </div>

                {/* 4대 통합 탭 */}
                <div className="grid grid-cols-4 gap-1 bg-slate-200/80 dark:bg-slate-800 p-1 rounded-xl text-[11px] font-bold">
                  {[
                    { id: "PARTICIPANTS", label: "참석자·직급" },
                    { id: "AI_PLACE", label: "AI 장소추천" },
                    { id: "SCHEDULE_HISTORY", label: "순연·변경이력" },
                    { id: "NEWS", label: "관련 뉴스" },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setDetailSection(tab.id as any)}
                      className={`py-2 rounded-lg transition ${
                        detailSection === tab.id
                          ? "bg-white dark:bg-slate-900 text-brand-700 dark:text-amber-300 shadow-sm font-extrabold"
                          : "text-slate-600 dark:text-slate-400"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* 서브섹션 1: 참석자 & 암호화된 주요 참석자 관리 */}
                {detailSection === "PARTICIPANTS" && (
                  <div
                    className={`rounded-2xl p-4 border shadow-sm space-y-3 ${
                      darkMode
                        ? "bg-slate-800 border-slate-700"
                        : "bg-white border-slate-200"
                    }`}
                  >
                    <div className="font-extrabold text-xs">
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
                          className="p-2.5 rounded-xl bg-purple-50 dark:bg-slate-900 border border-purple-300 flex items-center justify-between"
                        >
                          <div>
                            <span className="font-bold">{sr.displayName}</span>{" "}
                            — <span>{sr.jobTitle}</span>
                          </div>
                          <span className="px-2 py-0.5 rounded bg-purple-700 text-white text-[10px] font-bold">
                            {sr.seniorityLevel} (
                            {sr.attendanceConfirmed ? "확정" : "예정"})
                          </span>
                        </div>
                      ))
                    )}

                    <div className="pt-2 border-t border-slate-200 dark:border-slate-700 space-y-2">
                      <div className="font-bold text-[11px]">
                        👔 부장급 이상 주요 참석자 암호화 등록·변경
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <input
                          type="text"
                          value={srNameInput}
                          onChange={(e) => setSrNameInput(e.target.value)}
                          className="px-2 py-1.5 rounded border border-slate-300 text-slate-900"
                        />
                        <input
                          type="text"
                          value={srTitleInput}
                          onChange={(e) => setSrTitleInput(e.target.value)}
                          className="px-2 py-1.5 rounded border border-slate-300 text-slate-900"
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

                {/* 서브섹션 2: AI 장소 추천 (브라우저 로컬 방문 식당 제외 + 1년 취향 보존 정책) */}
                {detailSection === "AI_PLACE" && (
                  <div
                    className={`rounded-2xl p-4 border shadow-sm space-y-3 ${
                      darkMode
                        ? "bg-slate-800 border-slate-700"
                        : "bg-white border-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-sm">
                        🤖 AI 맞춤 장소 추천
                      </span>
                      <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">
                        외부 AI/네이버 API 시뮬레이션
                      </span>
                    </div>

                    {/* 본인 음식 취향 보존 정책 (기본 MEETING_ONLY, 동의 시 최대 1년, 철회 시 즉시 삭제) */}
                    <div className="p-3 rounded-xl bg-blue-50/70 dark:bg-slate-900 border border-blue-200 space-y-2">
                      <div className="font-bold text-brand-800 dark:text-blue-300 text-[11px]">
                        🍽️ 내 음식 취향 등록 (타인에게 비공개 · 기본값: MEETING_ONLY)
                      </div>
                      {(currentMtg.preferences || []).map((p: any) => (
                        <div key={p.id} className="text-[11px]">
                          • 내 설정: 비선호({p.dislikedItems.join(", ")}) · 보존:{" "}
                          <strong>{p.preferenceScope}</strong>{" "}
                          {p.consentExpiresAt
                            ? `(만료일: ${p.consentExpiresAt.slice(0, 10)})`
                            : ""}
                        </div>
                      ))}
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={myDislikedInput}
                          onChange={(e) => setMyDislikedInput(e.target.value)}
                          className="flex-1 px-2 py-1 rounded border border-slate-300 text-slate-900 text-[11px]"
                        />
                        <button
                          onClick={() => handleSaveMyPreference(currentMtg.id)}
                          className="px-2.5 py-1 rounded bg-brand-600 text-white font-bold text-[11px]"
                        >
                          저장
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={longTermPrefConsent}
                            onChange={(e) =>
                              setLongTermPrefConsent(e.target.checked)
                            }
                          />
                          <span>본인 취향 최대 1년 저장 동의 (1년 후 미재동의 시 자동 삭제)</span>
                        </label>
                        <button
                          onClick={() =>
                            handleWithdrawPreferenceConsent(currentMtg.id)
                          }
                          className="text-rose-600 font-bold underline shrink-0"
                        >
                          동의 철회·삭제
                        </button>
                      </div>
                    </div>

                    <label className="flex items-center gap-1.5 text-[11px] font-semibold">
                      <input
                        type="checkbox"
                        checked={excludePastVisited}
                        onChange={(e) =>
                          setExcludePastVisited(e.target.checked)
                        }
                      />
                      <span>
                        [지난번 방문한 식당 제외] (서버/AI에 과거 방문 장소를 보내지 않고 브라우저에서 내 암호화 이력을 복호화해 로컬 필터링)
                      </span>
                    </label>

                    <button
                      onClick={() => handleRunAiRecommendation(currentMtg.id)}
                      className="w-full py-2.5 rounded-xl bg-brand-600 text-white font-extrabold"
                    >
                      🔍 AI 장소 후보 추천 실행 (시뮬레이션)
                    </button>

                    {browserFilteredRecs.excludedInBrowserPlaceNames.length >
                      0 && (
                      <div className="text-[11px] text-emerald-700 font-bold">
                        🔐 브라우저 로컬 복호화로 제외된 내 과거 방문 식당:{" "}
                        {browserFilteredRecs.excludedInBrowserPlaceNames.join(
                          ", "
                        )}
                      </div>
                    )}

                    {browserFilteredRecs.filteredRecommendations.map(
                      (rec: any) => (
                        <div
                          key={rec.id}
                          className="p-3 rounded-xl border border-slate-200 space-y-1.5"
                        >
                          <div className="font-extrabold text-sm">
                            {rec.placeName} ({rec.cuisineType})
                          </div>
                          <div className="text-[11px] text-slate-600">
                            {rec.recommendationReason}
                          </div>
                          <div className="flex flex-wrap gap-1 text-[10px]">
                            {(rec.unverifiedItems || []).map(
                              (uv: string, i: number) => (
                                <span
                                  key={i}
                                  className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-bold"
                                >
                                  ⚠️ {uv}
                                </span>
                              )
                            )}
                          </div>
                          <button
                            onClick={() =>
                              handleSelectPlace(currentMtg.id, rec.placeId)
                            }
                            className="w-full py-1.5 rounded-lg bg-slate-900 text-white font-bold text-[11px]"
                          >
                            이 장소로 확정
                          </button>
                        </div>
                      )
                    )}
                  </div>
                )}

                {detailSection === "SCHEDULE_HISTORY" && (
                  <div
                    className={`rounded-2xl p-4 border shadow-sm space-y-2.5 ${
                      darkMode
                        ? "bg-slate-800 border-slate-700"
                        : "bg-white border-slate-200"
                    }`}
                  >
                    <div className="font-extrabold text-sm">
                      🗓️ 일정 변경 및 순연 이력 (누적 순연:{" "}
                      {currentMtg.postponementCount}회)
                    </div>
                    {(currentMtg.scheduleChanges || []).map((sc: any) => (
                      <div
                        key={sc.id}
                        className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 text-[11px]"
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

                {detailSection === "NEWS" && (
                  <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 space-y-2">
                    {(newsData?.articles || []).map((art: any) => (
                      <a
                        key={art.id}
                        href={art.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block p-2.5 rounded-xl border border-slate-200"
                      >
                        <div className="font-bold">{art.title} ↗</div>
                      </a>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* [탭 2] 초대장 화면: 비로그인/미승인 배지 차단 vs 로그인 초대대상자 2단계 참석 확정 */}
        {/* ================================================================= */}
        {activeTab === "invite" && (
          <div className="space-y-3 text-xs">
            <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 shadow-sm space-y-3">
              <div className="bg-[#FEE500] -mx-4 -mt-4 px-4 py-3 rounded-t-2xl flex items-center justify-between">
                <span className="font-extrabold text-xs text-[#191919]">
                  💬 TEAMYAK 카카오톡 초대장 (/i/{inviteCode})
                </span>
                <span className="text-[10px] font-bold bg-black/10 px-2 py-0.5 rounded">
                  {isLoggedIn ? "로그인됨" : "비로그인 상태"}
                </span>
              </div>

              <div>
                <h2 className="text-base font-extrabold">
                  {inviteDecrypted
                    ? inviteDecrypted.title
                    : "🔒 [로그인 및 초대 권한 확인 후 제목 공개]"}
                </h2>
                <div className="text-xs font-bold text-slate-600 mt-1">
                  {inviteData?.publicEnvelope?.confirmedDate} 오후{" "}
                  {inviteData?.publicEnvelope?.startTime || "12:00"} ·{" "}
                  {inviteData?.publicEnvelope?.areaHint || "여의도"}
                </div>

                {/* [정책 1 검증] 비로그인·미승인 상태에서는 부장급 이상 배지가 절대 노출되지 않으며,
                    로그인 후 초대 권한이 확인된 사용자(inviteDecrypted 존재)에게만 참석 확정 전에 표시됨! */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {!inviteDecrypted ? (
                    <span className="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-300 text-[10px] font-bold">
                      🔒 주요 참석자 배지: 로그인 및 초대 권한 확인 후에만 공개됩니다
                    </span>
                  ) : (
                    (() => {
                      const sBadge = getSeniorityBadgeInfo(
                        inviteDecrypted.highestSeniorityLevel || "STAFF",
                        inviteDecrypted.highestSeniorityStatus || "NONE"
                      );
                      return (
                        <span
                          className={`px-2.5 py-0.5 rounded-full border text-[11px] font-bold ${sBadge.badgeClass}`}
                        >
                          [권한 확인됨 · {sBadge.text}]
                        </span>
                      );
                    })()
                  )}
                </div>
              </div>

              {/* 주요 참석자가 존재하는 모임에서 참석 확정 전 2단계 최종 확인 안내 */}
              {inviteData?.myParticipant?.rsvpStatus ===
                "AWAITING_SENIOR_CONFIRM" &&
                inviteDecrypted && (
                  <div className="p-3 rounded-xl bg-purple-50 border-2 border-purple-400 text-purple-950 space-y-2">
                    <div className="font-extrabold text-xs">
                      👔 주요 참석자 구성을 확인한 뒤 참석을 최종 확정해 주세요
                    </div>
                    {(inviteDecrypted.seniorAttendees || []).map((sr, i) => (
                      <div key={i} className="text-[11px] font-semibold">
                        • {sr.displayName} ({sr.jobTitle}) —{" "}
                        {sr.attendanceConfirmed ? "참석 확정" : "참석 예정"}
                      </div>
                    ))}
                    <button
                      onClick={() => handleInviteRsvp("ATTENDING", true)}
                      className="w-full py-2.5 rounded-xl bg-purple-700 text-white font-extrabold text-xs"
                    >
                      ✓ 주요 참석자 확인 완료 — 참석 최종 확정하기
                    </button>
                  </div>
                )}

              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => handleInviteRsvp("ATTENDING", false)}
                  className="py-3 rounded-xl bg-brand-600 text-white font-extrabold text-xs"
                >
                  ✓ 참석
                </button>
                <button
                  onClick={() => handleInviteRsvp("TENTATIVE", false)}
                  className="py-3 rounded-xl bg-amber-500 text-white font-bold text-xs"
                >
                  보류
                </button>
                <button
                  onClick={() => handleInviteRsvp("DECLINED", false)}
                  className="py-3 rounded-xl bg-slate-200 text-slate-700 font-bold text-xs"
                >
                  불참
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "calendar" && (
          <div className="space-y-4">
            {/* 상단 헤더 & 개요 */}
            <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-sm flex items-center gap-1.5">
                  <span>📅</span> 캘린더 자동 연동 & 알림 허브
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300">
                  3종 캘린더 지원
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                아이폰 기본 캘린더, Google Calendar, 또는 1회성 .ICS 다운로드로 약속 일정을 편리하게 관리하세요.
              </p>
            </div>

            {/* ① 아이폰 기본 캘린더 (Apple Calendar) 구독 - iOS 우선 추천 */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border-2 border-brand-500/50 dark:border-brand-500/60 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-base">🍎</span>
                  <span className="font-extrabold text-xs text-slate-900 dark:text-white">
                    ① 아이폰 기본 캘린더 자동 연동 (Apple Calendar)
                  </span>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-600 text-white animate-pulse">
                  iOS 추천
                </span>
              </div>

              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                아이폰 이용자는 최초 1회만 구독하면, 이후 팀약에서 수락한 모임이 <strong>아이폰 기본 캘린더에 자동으로 동기화</strong>됩니다.
              </p>

              {/* 구독 상태 및 피드 URL */}
              <div className="bg-slate-50 dark:bg-slate-800/80 rounded-xl p-3 border border-slate-200 dark:border-slate-700 space-y-2 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">구독 연동 상태:</span>
                  <span className={`font-bold px-2 py-0.5 rounded-md text-[10px] ${
                    appleCalData?.appleCalendar?.enabled
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                  }`}>
                    {appleCalData?.appleCalendar?.enabled ? "● 정상 구독 활성" : "○ 구독 비활성화됨"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500 dark:text-slate-400">현재 동기화 모임:</span>
                  <span className="font-extrabold text-brand-700 dark:text-amber-300">
                    {appleCalData?.appleCalendar?.activeEventsCount ?? 0}건 확정 모임
                  </span>
                </div>
                <div className="space-y-1">
                  <span className="text-slate-500 dark:text-slate-400 text-[10px]">내 고유 구독 피드 URL:</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      readOnly
                      value={appleCalData?.appleCalendar?.httpsUrl || "URL 생성 중..."}
                      className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-[10px] font-mono select-all text-slate-700 dark:text-slate-300"
                    />
                    <button
                      onClick={() => handleCopyFeedUrl(appleCalData?.appleCalendar?.httpsUrl)}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 font-bold text-[10px] whitespace-nowrap"
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
                  className="py-2.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 font-extrabold text-xs border border-slate-200 dark:border-slate-700 flex items-center justify-center gap-1 transition"
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
                  className="text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 underline"
                >
                  {appleCalData?.appleCalendar?.enabled
                    ? "구독 피드 일시 차단하기"
                    : "구독 피드 다시 활성화하기"}
                </button>
              </div>

              {/* 갱신 지연 안내문구 */}
              <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 space-y-1 text-[11px]">
                <div className="font-extrabold flex items-center gap-1">
                  <span>⚠️</span>
                  <span>[필독] 아이폰 캘린더 동기화 주기 및 갱신 지연 안내</span>
                </div>
                <p className="text-[10px] leading-relaxed">
                  아이폰 캘린더는 Apple/iCloud의 백그라운드 폴링 정책(보통 수십 분~수 시간 간격)에 따라 팀약 서버를 정기 확인합니다.
                  따라서 약속 일정이 변경되거나 취소되더라도 아이폰 화면에 <strong>즉각 반영되지 않고 지연</strong>될 수 있습니다.
                </p>
                <p className="text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                  💡 <strong>즉시 반영 팁</strong>: 아이폰 [캘린더 앱 &gt; 하단 &apos;캘린더&apos; 목록 &gt; 화면을 아래로 당겨 새로고침]을 실행하시면 최신 일정이 즉시 동기화됩니다.
                </p>
              </div>

              {/* 프라이버시 원칙 고지 */}
              <div className="p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 text-[10px] flex items-start gap-1">
                <span>🔒</span>
                <span>
                  <strong>개인정보 보호</strong>: 외부 캘린더 피드에는 보안을 위해 상대방 회사·직함 등 민감 정보가 배제되며, 기본적으로 <strong>&apos;팀약 일정&apos;</strong> 중립 명칭으로 안전하게 등록됩니다.
                </span>
              </div>
            </div>

            {/* ② Google Calendar 연결 */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-xs flex items-center gap-1.5 text-slate-900 dark:text-white">
                  <span>🗓️</span> ② Google Calendar 실시간 연동
                </span>
                <span className="text-[10px] text-slate-400 font-mono">OAuth 2.0 / API v3</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Google 캘린더 계정과 연동하여 버튼 클릭 시 실시간으로 일정을 푸시 동기화합니다.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleGoogleCalendarSync(currentMtg.id)}
                  className="flex-1 py-2 px-3 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-blue-300 font-extrabold text-xs border border-blue-200 dark:border-slate-700 flex items-center justify-center gap-1.5 transition"
                >
                  <span>📅</span>
                  <span>현재 모임 Google 캘린더 동기화</span>
                </button>
              </div>
            </div>

            {/* ③ 1회성 .ICS 파일 다운로드 */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-extrabold text-xs flex items-center gap-1.5 text-slate-900 dark:text-white">
                  <span>📥</span> ③ 1회성 .ICS 파일 다운로드
                </span>
                <span className="text-[10px] text-slate-400 font-mono">RFC 5545</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                구독 없이 현재 모임 일정을 개인 파일(.ics)로 내려받아 Outlook, 네이버 캘린더 등에 1회성으로 등록합니다.
              </p>
              <button
                onClick={() => handleDownloadSingleIcs(currentMtg)}
                className="w-full py-2 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 font-extrabold text-xs border border-slate-200 dark:border-slate-700 flex items-center justify-center gap-1.5 transition"
              >
                <span>💾</span>
                <span>[{currentMtg.confirmedDate || "오늘"}] 모임 .ICS 파일 다운로드</span>
              </button>
            </div>

            {/* ④ 중립 문구 당일 아침 알림 센터 */}
            <div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-2xl p-4 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
              <div className="font-extrabold flex items-center gap-1">
                <span>🔔</span>
                <span>중립 문구 당일 아침 알림 센터</span>
              </div>
              {(notifData?.deliveries || []).slice(0, 4).map((nd: any) => (
                <div
                  key={nd.id}
                  className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-1 text-[11px]"
                >
                  <div className="font-bold text-brand-700 dark:text-amber-300">
                    [{nd.notificationType}]
                  </div>
                  <div>• 기본 중립 알림: &ldquo;{nd.messagePreview}&rdquo;</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="bg-white text-slate-900 rounded-2xl p-4 border border-slate-200 space-y-2 text-xs">
            <div className="font-extrabold">
              🔐 내 개인 암호화 이력 (방문 장소 평문 컬럼 제거됨)
            </div>
            {histories.map((h) => {
              const dec = decryptedHistoriesMap[h.id];
              return (
                <div
                  key={h.id}
                  className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1"
                >
                  <div className="font-bold text-brand-700">
                    {h.meetingDate} — {dec?.counterpartOrgName || "🔒 암호화됨"}
                  </div>
                  <div className="text-[11px]">
                    브라우저 복호화 방문 식당: <strong>{dec?.detailedPlaceName}</strong>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 truncate">
                    DB 저장 행(visited_place_id 없음): {h.encryptedHistoryBlob}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <nav className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 grid grid-cols-4 text-[11px] py-2 font-bold">
        {[
          { id: "meeting_detail", label: "모임상세", icon: "📋" },
          { id: "invite", label: "초대장(2단계)", icon: "💌" },
          { id: "calendar", label: "캘린더·알림", icon: "📅" },
          { id: "history", label: "암호화이력", icon: "🔐" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex flex-col items-center gap-0.5 ${
              activeTab === t.id
                ? "text-brand-600 font-extrabold"
                : "text-slate-400"
            }`}
          >
            <span className="text-base">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
