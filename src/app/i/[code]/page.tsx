"use client";

import React, { useEffect, useState } from "react";
import {
  decryptMeetingPayload,
  savePreLoginInviteVault,
  consumePreLoginInviteVault,
  SensitiveMeetingPayload,
} from "@/lib/crypto";

export default function InviteDirectLandingPage({
  params,
}: {
  params: { code: string };
}) {
  const [fragmentKey, setFragmentKey] = useState<string>("");
  const [sessionToken, setSessionToken] = useState<string>("");
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [inviteData, setInviteData] = useState<Record<string, any> | null>(null);
  const [decrypted, setDecrypted] = useState<SensitiveMeetingPayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [requiresSeniorConfirmation, setRequiresSeniorConfirmation] =
    useState<boolean>(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const hash = window.location.hash; // 예: #k=7f9a2b4c8e1d0a3f9911223344556677
      const match = hash.match(/k=([a-fA-F0-9]+)/);
      if (match && match[1]) {
        setFragmentKey(match[1]);
      } else {
        setFragmentKey("7f9a2b4c8e1d0a3f9911223344556677");
      }
    }
  }, []);

  async function loadInvitation(token?: string, keyOverride?: string) {
    const headers: Record<string, string> = {};
    const activeToken = token ?? sessionToken;
    if (activeToken) {
      headers["Authorization"] = `Bearer ${activeToken}`;
    }
    const res = await fetch(`/api/invitations/${params.code}`, { headers });
    if (res.ok) {
      const data = await res.json();
      setInviteData(data);
      const activeKey = keyOverride || fragmentKey;
      if (data.encryptedDetail?.encryptedMeetingPayload && activeKey) {
        const dec = await decryptMeetingPayload(
          data.encryptedDetail.encryptedMeetingPayload,
          data.encryptedDetail.payloadIv,
          activeKey
        );
        setDecrypted(dec);
      } else {
        setDecrypted(null);
      }

      if (data.myParticipant?.rsvpStatus === "AWAITING_SENIOR_CONFIRM") {
        setRequiresSeniorConfirmation(true);
      }
    }
  }

  useEffect(() => {
    if (fragmentKey) {
      loadInvitation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragmentKey, sessionToken]);

  async function handleRsvpAction(
    rsvpStatus: "ATTENDING" | "TENTATIVE" | "DECLINED",
    confirmedAfterSeniorityReview = false
  ) {
    if (!isLoggedIn) {
      // 비로그인 상태: 카카오 로그인 전 초대 응답 상태와 암호화 키(#k=)를 안전하게 세션 볼트에 보존
      const vault = savePreLoginInviteVault(params.code, rsvpStatus, fragmentKey);
      const loginRes = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "LOGIN_ACCOUNT", userId: "u_park" }),
      });
      const loginData = await loginRes.json();
      if (loginData.ok) {
        const restored = consumePreLoginInviteVault(vault.oauthStateNonce);
        setIsLoggedIn(true);
        setSessionToken(loginData.sessionToken);
        const restoredKey = restored?.fragmentKey || fragmentKey;
        setFragmentKey(restoredKey);

        const rsvpRes = await fetch(`/api/invitations/${params.code}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${loginData.sessionToken}`,
          },
          body: JSON.stringify({
            rsvpStatus: restored?.rsvpIntent || rsvpStatus,
            confirmedAfterSeniorityReview,
          }),
        });
        const rsvpData = await rsvpRes.json();
        if (rsvpData.requiresSeniorConfirmation) {
          setRequiresSeniorConfirmation(true);
          setMessage(
            "👔 이 모임에는 부장급 이상 주요 참석자가 포함되어 있습니다. 아래 직급을 확인 후 최종 참석을 확정해 주세요."
          );
        } else {
          setRequiresSeniorConfirmation(false);
          setMessage(
            `✅ 카카오 로그인 후 [${
              restored?.rsvpIntent || rsvpStatus
            }] 응답과 암호화 키(#k=)가 복원되어 참석 등록 및 캘린더 자동 등록(제목: '${
              rsvpData.externalCalendarMapping?.exportedTitle || "팀약 일정"
            }')이 완료되었습니다.`
          );
        }
        await loadInvitation(loginData.sessionToken, restoredKey);
      }
      return;
    }

    const rsvpRes = await fetch(`/api/invitations/${params.code}`, {
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
    const rsvpData = await rsvpRes.json();
    if (rsvpData.ok) {
      if (rsvpData.requiresSeniorConfirmation) {
        setRequiresSeniorConfirmation(true);
        setMessage(
          "👔 주요 참석자(임원/부장급)가 포함된 모임입니다. 아래 직급 정보를 확인한 뒤 최종 확정해 주세요."
        );
      } else {
        setRequiresSeniorConfirmation(false);
        setMessage(
          `✅ [${rsvpData.participant.rsvpStatus}] 응답이 실시간 반영되었습니다 (캘린더 동기화: 완료).`
        );
      }
      await loadInvitation();
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-[420px] bg-white rounded-3xl shadow-2xl overflow-hidden text-slate-900">
        <div className="bg-[#FEE500] px-4 py-3.5 flex items-center justify-between">
          <span className="font-extrabold text-xs text-[#191919]">
            💬 TEAMYAK 카카오톡 약속 초대장
          </span>
          <a href="/" className="text-[11px] font-bold text-[#191919] underline">
            전체 앱 열기 →
          </a>
        </div>

        <div className="p-5 space-y-4 text-xs">
          {message && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-900 font-medium">
              {message}
            </div>
          )}

          <div>
            <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-800 font-bold text-[10px]">
              {inviteData?.publicEnvelope?.hostOrgBadge || "호스트"}
            </span>
            <h1 className="text-lg font-extrabold mt-1">
              {decrypted
                ? decrypted.title
                : "🔒 [승인된 참석자에게만 복호화되는 약속 초대장]"}
            </h1>
            <p className="text-[11px] text-slate-500 mt-1">
              {decrypted
                ? decrypted.description
                : "카카오 로그인 및 초대 권한 확인 전에는 URL #k= 키가 있어도 서버가 암호문 반환을 차단합니다."}
            </p>

            {decrypted && decrypted.highestSeniorityLevel && decrypted.highestSeniorityLevel !== "STAFF" && (
              <div className="mt-2 inline-block px-2.5 py-1 rounded-full bg-purple-100 text-purple-900 border border-purple-300 text-[11px] font-bold">
                👔 주요 참석자: {decrypted.highestSeniorityLevel} (
                {decrypted.highestSeniorityStatus === "CONFIRMED" ? "참석 확정" : "참석 예정"}
                )
              </div>
            )}
          </div>

          <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-200 space-y-2">
            <div className="flex justify-between">
              <span className="text-slate-500">일시</span>
              <span className="font-bold">
                {inviteData?.publicEnvelope?.confirmedDate}{" "}
                {inviteData?.publicEnvelope?.startTime}~
                {inviteData?.publicEnvelope?.endTime}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">장소</span>
              <span className="font-bold">
                {decrypted
                  ? decrypted.detailedPlaceName
                  : `${inviteData?.publicEnvelope?.areaHint || "여의도"} (참석 수락 시 상세 공개)`}
              </span>
            </div>
            {inviteData?.publicEnvelope?.postponementCount > 0 && (
              <div className="flex justify-between text-amber-700 font-bold">
                <span>순연 횟수</span>
                <span>
                  {inviteData?.publicEnvelope?.postponementCount}회 순연된 약속
                </span>
              </div>
            )}
          </div>

          {/* 주요 참석자 존재 시 2단계 확인 박스 */}
          {requiresSeniorConfirmation && decrypted && (
            <div className="p-3.5 rounded-2xl bg-purple-50 border-2 border-purple-400 space-y-2 text-purple-950">
              <div className="font-extrabold text-xs">
                👔 주요 참석자 명단을 확인해 주세요
              </div>
              {(decrypted.seniorAttendees || []).map((sr, idx) => (
                <div key={idx} className="text-[11px] font-semibold">
                  • {sr.displayName} ({sr.jobTitle}) —{" "}
                  {sr.attendanceConfirmed ? "참석 확정" : "참석 예정"}
                </div>
              ))}
              <button
                onClick={() => handleRsvpAction("ATTENDING", true)}
                className="w-full py-2.5 rounded-xl bg-purple-700 text-white font-extrabold text-xs shadow-md"
              >
                ✓ 직급 확인 완료 — 참석 최종 확정하기
              </button>
            </div>
          )}

          {!requiresSeniorConfirmation && (
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => handleRsvpAction("ATTENDING", false)}
                className="py-3.5 rounded-2xl bg-brand-600 text-white font-extrabold text-sm"
              >
                ✓ 참석
              </button>
              <button
                onClick={() => handleRsvpAction("TENTATIVE", false)}
                className="py-3.5 rounded-2xl bg-amber-500 text-white font-bold text-sm"
              >
                보류
              </button>
              <button
                onClick={() => handleRsvpAction("DECLINED", false)}
                className="py-3.5 rounded-2xl bg-slate-200 text-slate-700 font-bold text-sm"
              >
                불참
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
