"use client";

import React, { useEffect, useState } from "react";
import { consumePreLoginInviteVault, peekPreLoginInviteVault } from "@/lib/crypto";

function maskToken(str?: string | null): string {
  if (!str) return "[EMPTY]";
  if (str.length <= 8) return "***";
  return `${str.slice(0, 4)}***${str.slice(-4)}`;
}

export default function AuthCallbackPage() {
  const [status, setStatus] = useState<string>("카카오 로그인 인가 처리 중...");
  const [error, setError] = useState<{ title: string; message: string; code?: string } | null>(null);
  const [keyRecoveryFailed, setKeyRecoveryFailed] = useState<boolean>(false);
  const [targetInviteCode, setTargetInviteCode] = useState<string | null>(null);
  const [redirectTarget, setRedirectTarget] = useState<string>("/");

  useEffect(() => {
    async function processCallback() {
      try {
        if (typeof window === "undefined") return;

        const url = new URL(window.location.href);
        const searchParams = url.searchParams;
        const hash = window.location.hash.substring(1);
        const hashParams = new URLSearchParams(hash);

        // 1. URL 파라미터 에러 확인 (사용자 취소, 카카오 인가 실패 등)
        const urlError = searchParams.get("error") || hashParams.get("error");
        const urlErrorDesc = searchParams.get("error_description") || hashParams.get("error_description");
        if (urlError) {
          setError({
            title: "카카오 로그인 실패 또는 취소",
            message: urlErrorDesc || "카카오 인가 과정에서 오류가 발생했거나 사용자가 로그인을 취소했습니다.",
            code: urlError,
          });
          return;
        }

        // 2. 토큰 및 인가 코드 추출 (로그 노출 방지: 절대 콘솔에 원문 로깅 금지)
        let accessToken = hashParams.get("access_token") || searchParams.get("access_token");
        let refreshToken = hashParams.get("refresh_token") || searchParams.get("refresh_token");
        const authCode = searchParams.get("code");
        const returnToParam = searchParams.get("returnTo") || searchParams.get("state");

        // 3. 인가 코드 교환 (직통 카카오 로그인 토큰 교환 & 세션 발급)
        if (authCode && !accessToken) {
          setStatus("카카오 계정 인가 코드 교환 및 로그인 처리 중...");
          try {
            const redirectUri = `${window.location.origin}/auth/callback`;
            const exchangeRes = await fetch("/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "DIRECT_KAKAO_TOKEN_EXCHANGE",
                code: authCode,
                redirectUri,
                deviceLabel: navigator?.userAgent?.includes("Mobile")
                  ? "모바일 카카오 브라우저"
                  : "데스크톱 브라우저",
              }),
            });

            if (exchangeRes.ok) {
              const exchangeData = await exchangeRes.json();
              if (exchangeData.sessionToken) {
                localStorage.setItem("teamyak_session_token", exchangeData.sessionToken);
                // 기등록된 사용자 프로필이 있으면 브라우저 스토리지에 복원
                if (exchangeData.user) {
                  const u = exchangeData.user;
                  if (u.displayName && !u.displayName.startsWith("카카오 회원") && u.teamId) {
                    const p = {
                      displayName: u.displayName,
                      jobTitle: u.jobTitle || "",
                      orgName: u.teamId || "",
                    };
                    localStorage.setItem("teamyak_custom_profile", JSON.stringify(p));
                    localStorage.setItem("teamyak_profile_onboarding_done", "true");
                  }
                }
                setStatus("카카오 실계정 로그인 성공! 이동 중...");
              }
            } else {
              const errBody = await exchangeRes.json().catch(() => ({}));
              // Supabase PKCE Fallback
              const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
              const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
              let supabaseSucceeded = false;
              if (supabaseUrl && anonKey) {
                const tokenRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    apikey: anonKey,
                  },
                  body: JSON.stringify({ auth_code: authCode }),
                });
                if (tokenRes.ok) {
                  const tokenData = await tokenRes.json();
                  accessToken = tokenData.access_token;
                  refreshToken = tokenData.refresh_token;
                  supabaseSucceeded = true;
                }
              }

              if (!supabaseSucceeded) {
                setError({
                  title: "카카오 로그인 세션 발급 실패",
                  message:
                    errBody?.details ||
                    errBody?.message ||
                    errBody?.error ||
                    "카카오 토큰 교환 중 오류가 발생했습니다. 카카오 앱 설정을 확인해 주세요.",
                  code: errBody?.error || "EXCHANGE_FAILED",
                });
                return;
              }
            }
          } catch (e: any) {
            console.error("Token exchange failed:", e);
            setError({
              title: "카카오 인증 통신 오류",
              message: e?.message || "서버와 통신 중 오류가 발생했습니다.",
            });
            return;
          }
        }

        // 4. 발급된 세션 저장 (브라우저 스토리지)
        if (accessToken) {
          localStorage.setItem("teamyak_supabase_access_token", accessToken);
          if (refreshToken) {
            localStorage.setItem("teamyak_supabase_refresh_token", refreshToken);
          }
        }

        // 5. 백엔드 프로필 동기화 (Supabase accessToken이 있을 때만 수행)
        if (accessToken) {
          setStatus("사용자 프로필 및 초대 권한 동기화 중...");
          try {
            const syncRes = await fetch("/api/auth", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                action: "SUPABASE_SESSION_SYNC",
                accessToken,
                deviceLabel: navigator?.userAgent?.includes("Mobile")
                  ? "모바일 카카오 브라우저"
                  : "데스크톱 브라우저",
              }),
            });
            const syncData = await syncRes.json();
            if (syncData.sessionToken) {
              localStorage.setItem("teamyak_session_token", syncData.sessionToken);
              if (syncData.user) {
                const u = syncData.user;
                if (u.displayName && !u.displayName.startsWith("카카오 회원") && u.teamId) {
                  const p = {
                    displayName: u.displayName,
                    jobTitle: u.jobTitle || "",
                    orgName: u.teamId || "",
                  };
                  localStorage.setItem("teamyak_custom_profile", JSON.stringify(p));
                  localStorage.setItem("teamyak_profile_onboarding_done", "true");
                }
              }
            }
          } catch {
            // 백엔드 동기화 실패 시에도 클라이언트 복귀 계속 진행
          }
        }

        // 6. 사전 로그인 볼트 확인 및 #k= 암호화 키 복원
        const vault = peekPreLoginInviteVault();
        const consumed = consumePreLoginInviteVault();

        let targetUrl = "/";
        let hasRestoredKey = false;

        if (consumed && consumed.inviteCode && consumed.fragmentKey) {
          // 정상적으로 암호화 키 복원 완료
          targetUrl = `/i/${consumed.inviteCode}#k=${consumed.fragmentKey}`;
          hasRestoredKey = true;
          setStatus("초대장 및 암호화 키(#k=) 복원 완료! 이동 중...");
        } else if (returnToParam) {
          targetUrl = decodeURIComponent(returnToParam);
          if (consumed?.fragmentKey && !targetUrl.includes("#k=")) {
            targetUrl = `${targetUrl}#k=${consumed.fragmentKey}`;
            hasRestoredKey = true;
          }
          // 만약 returnTo가 /i/로 시작하는데 #k= 키가 전혀 복원되지 않은 경우
          if (targetUrl.startsWith("/i/") && !targetUrl.includes("#k=") && !hasRestoredKey) {
            const codeMatch = targetUrl.match(/\/i\/([^/?#]+)/);
            if (codeMatch && codeMatch[1]) {
              setTargetInviteCode(codeMatch[1]);
            }
            setKeyRecoveryFailed(true);
            return;
          }
          setStatus("원래 페이지로 이동 중...");
        } else {
          setStatus("로그인 완료! 메인 화면으로 이동합니다.");
        }

        setRedirectTarget(targetUrl);
        setTimeout(() => {
          window.location.href = targetUrl;
        }, 300);
      } catch (err: any) {
        setError({
          title: "콜백 처리 오류",
          message: err?.message || "인증 처리 도중 예기치 못한 오류가 발생했습니다.",
        });
      }
    }

    processCallback();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-[380px] bg-white rounded-3xl p-6 text-center space-y-4 shadow-2xl">
        <div className="w-14 h-14 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto text-2xl">
          💬
        </div>
        <h2 className="text-base font-extrabold text-slate-900">
          TEAMYAK 카카오 인증
        </h2>

        {/* 1. 오류 발생 시 */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-2xl text-left space-y-2">
            <div className="text-xs font-bold text-red-900 flex items-center gap-1.5">
              <span>⚠️</span> {error.title}
            </div>
            <p className="text-[11px] text-red-700 leading-relaxed">
              {error.message}
            </p>
            {error.code && (
              <span className="inline-block px-2 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-mono">
                {error.code}
              </span>
            )}
            <div className="pt-2 flex gap-2">
              <a
                href="/"
                className="flex-1 py-2 text-center bg-slate-900 text-white rounded-xl text-xs font-bold"
              >
                메인으로 돌아가기
              </a>
            </div>
          </div>
        )}

        {/* 2. 브라우저 전환 등으로 암호화 키(#k=) 복원 불가능 시 안전한 재초대 안내 */}
        {!error && keyRecoveryFailed && (
          <div className="p-4 bg-amber-50 border border-amber-300 rounded-2xl text-left space-y-2.5">
            <div className="font-extrabold text-amber-900 text-xs flex items-center gap-1.5">
              <span>🔒</span> 암호화 초대 키 복구 안내
            </div>
            <p className="text-[11px] text-amber-800 leading-relaxed">
              카카오 로그인 중 브라우저 전환(카카오톡 인앱 브라우저 등)으로 인해 초대장의 종단간 암호화 키(#k=)가 소실되었습니다.
            </p>
            <p className="text-[11px] text-amber-800 leading-relaxed">
              모임 상세 정보와 참석자 명단은 오직 초대 링크의 암호키로만 복호화됩니다. 보안을 위해 <strong>호스트에게 카카오톡 초대장을 다시 공유해 달라고 요청</strong>하신 후, 같은 브라우저에서 링크를 다시 열어주세요.
            </p>
            <div className="pt-2 space-y-2">
              {targetInviteCode && (
                <a
                  href={`/i/${targetInviteCode}`}
                  className="block w-full py-2.5 text-center bg-amber-600 text-white rounded-xl text-xs font-extrabold shadow-sm"
                >
                  기존 초대장 화면 확인하기
                </a>
              )}
              <a
                href="/"
                className="block w-full py-2 text-center bg-slate-100 text-slate-700 rounded-xl text-xs font-bold"
              >
                메인으로 이동
              </a>
            </div>
          </div>
        )}

        {/* 3. 정상 처리 진행 중 */}
        {!error && !keyRecoveryFailed && (
          <div className="space-y-4">
            <div className="flex items-center justify-center space-x-2 text-xs text-slate-600 font-medium">
              <span className="w-3 h-3 rounded-full border-2 border-brand-600 border-t-transparent animate-spin inline-block" />
              <span>{status}</span>
            </div>
            <p className="text-[11px] text-slate-400">
              세션 및 암호화 키를 안전하게 연결하고 있습니다.
            </p>
            <div className="pt-2">
              <a
                href={redirectTarget}
                className="inline-block w-full py-3 bg-[#FEE500] hover:bg-[#FDD800] text-[#191919] font-black rounded-xl text-xs shadow-sm transition cursor-pointer"
              >
                화면이 멈춘 경우 여기를 터치하세요 →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
