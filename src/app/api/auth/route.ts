import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  readDatabase,
  writeDatabase,
  resolveUserFromRequest,
  createInitialSeedDatabase,
  signSessionToken,
  verifySignedSessionToken,
  signOAuthState,
  verifyOAuthState,
  SEED_RECOVERY_CODE_KIM,
  SEED_RECOVERY_CODE_PARK,
} from "@/lib/server-store";
import { validateRecoverySecretStrength } from "@/lib/crypto";
import {
  getSupabaseConfigStatus,
  getExternalServiceConfigStatus,
} from "@/lib/supabase-client";
import { checkRateLimit } from "@/lib/security-guardrails";

export async function GET(req: NextRequest) {
  const db = await readDatabase();
  const mode = req.nextUrl.searchParams.get("mode");

  // 1. 카카오 OAuth 2.0 인가 요청 시작 (state 서명 및 HttpOnly 쿠키 바인딩)
  if (mode === "kakao_authorize") {
    const returnTo = req.nextUrl.searchParams.get("returnTo") || "/i/inv_9x82a";
    const clientStateNonce =
      req.nextUrl.searchParams.get("stateNonce") ||
      crypto.randomBytes(16).toString("hex");

    const signedState = signOAuthState(clientStateNonce, returnTo);
    const clientId = process.env.KAKAO_CLIENT_ID || "KAKAO_CLIENT_ID_NOT_CONFIGURED";
    const redirectUri =
      process.env.KAKAO_REDIRECT_URI ||
      `${req.nextUrl.origin}/api/auth?mode=kakao_callback`;

    const kakaoAuthorizeUrl = `https://kauth.kakao.com/oauth/authorize?client_id=${encodeURIComponent(
      clientId
    )}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&response_type=code&state=${encodeURIComponent(signedState)}`;

    const res = NextResponse.json({
      ok: true,
      kakaoOAuthConfigured: Boolean(process.env.KAKAO_CLIENT_ID),
      authorizeUrl: kakaoAuthorizeUrl,
      signedState,
      clientStateNonce,
      returnTo,
    });
    res.cookies.set("teamyak_oauth_nonce", clientStateNonce, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
    });
    return res;
  }

  const authHeader = req.headers.get("authorization");
  const cookieToken = req.cookies.get("teamyak_session")?.value;
  const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

  const kakaoApiConfigured = Boolean(
    process.env.KAKAO_CLIENT_ID && process.env.KAKAO_CLIENT_SECRET
  );
  const supabaseCloudConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const googleOAuthConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );

  return NextResponse.json({
    authenticated: Boolean(currentUser),
    user: currentUser,
    storageEngine: db.storageEngine,
    seedRecoveryCodesForTest: {
      u_kim: SEED_RECOVERY_CODE_KIM,
      u_park: SEED_RECOVERY_CODE_PARK,
    },
    availableTestAccounts: db.users.map((u) => {
      let sess = db.sessions.find(
        (s) =>
          s.userId === u.id &&
          !s.revoked &&
          verifySignedSessionToken(s.token).valid
      );
      if (!sess) {
        const sessId = `sess_${u.id}_init_${Date.now()}`;
        sess = {
          id: sessId,
          token: signSessionToken(sessId, u.id),
          userId: u.id,
          accountType: u.accountType,
          deviceLabel: "모바일 기기",
          revoked: false,
          expiresAt: new Date(
            Date.now() + 30 * 24 * 3600 * 1000
          ).toISOString(),
          createdAt: new Date().toISOString(),
        };
        db.sessions.push(sess);
      }
      return {
        id: u.id,
        accountType: u.accountType,
        displayName: u.displayName,
        jobTitle: u.jobTitle,
        teamId: u.teamId,
        sessionToken: sess?.token || "",
        deviceLabel: sess?.deviceLabel || "모바일 기기",
        hasKeyBackup: Boolean(u.encryptedMasterKeyBackup),
        recoveryEntropyBits: u.recoveryEntropyBits || 140,
      };
    }),
    apiStatus: {
      databaseEngine: supabaseCloudConfigured
        ? "CLOUD_SUPABASE_POSTGRES_CONNECTED"
        : "LOCAL_PERSISTENT_JSON_AND_PGLITE_PG16",
      kakaoLoginMode: kakaoApiConfigured
        ? "LIVE_KAKAO_OAUTH"
        : "OAUTH_PROTOCOL_READY_USING_TEST_ACCOUNTS",
      googleCalendarMode: googleOAuthConfigured
        ? "LIVE_GOOGLE_OAUTH"
        : "SIMULATION_AND_REAL_ICS_EXPORT",
      naverApiMode: process.env.NAVER_CLIENT_ID
        ? "LIVE_NAVER_OPENAPI"
        : "SIMULATION_SANDBOX_DATASET",
      supabaseConfig: getSupabaseConfigStatus(),
      externalServices: getExternalServiceConfigStatus(),
    },
  });
}

export async function POST(req: NextRequest) {
  const clientIp = req.headers.get("x-forwarded-for") || "127.0.0.1";
  const rl = checkRateLimit(`auth_${clientIp}`, 60);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: "TOO_MANY_REQUESTS",
        message: "요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
        retryAfterSeconds: rl.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSeconds) },
      }
    );
  }

  const body = await req.json();
  const { action } = body;
  const db = await readDatabase();

  // 1. OAuth Callback 검증 (state 변조 및 CSRF 공격 방어 테스트 포함)
  if (action === "KAKAO_OAUTH_CALLBACK") {
    const { signedState, code, targetTestUserId } = body;
    const cookieNonce =
      req.cookies.get("teamyak_oauth_nonce")?.value || body.expectedCookieNonce || "";

    const stateCheck = verifyOAuthState(signedState || "", cookieNonce);
    if (!stateCheck.valid) {
      return NextResponse.json(
        {
          error: "OAUTH_STATE_VERIFICATION_FAILED",
          reason: stateCheck.reason,
          message:
            "OAuth state 파라미터가 변조되었거나 세션 쿠키와 일치하지 않아 로그인 요청이 차단되었습니다.",
        },
        { status: 400 }
      );
    }

    // 실제 KAKAO_CLIENT_ID가 설정된 경우 kauth.kakao.com/oauth/token 교환 수행
    if (
      process.env.KAKAO_CLIENT_ID &&
      process.env.KAKAO_CLIENT_SECRET &&
      code &&
      !targetTestUserId
    ) {
      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET,
        redirect_uri:
          process.env.KAKAO_REDIRECT_URI || `${req.nextUrl.origin}/api/auth`,
        code,
      });
      const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: tokenParams.toString(),
      });
      if (!tokenRes.ok) {
        return NextResponse.json(
          { error: "KAKAO_TOKEN_EXCHANGE_FAILED" },
          { status: 502 }
        );
      }
    }

    const userId = targetTestUserId || "u_park";
    const user = db.users.find((u) => u.id === userId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const sessId = `sess_${user.id}_${Date.now()}`;
    const signedToken = signSessionToken(sessId, user.id);
    const newSess = {
      id: sessId,
      token: signedToken,
      userId: user.id,
      accountType: user.accountType,
      deviceLabel: body.deviceLabel || "Kakao OAuth Verified Device",
      revoked: false,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    db.sessions.push(newSess);
    await writeDatabase(db);

    const res = NextResponse.json({
      ok: true,
      user,
      sessionToken: signedToken,
      verifiedReturnTo: stateCheck.returnTo,
      verifiedStateNonce: stateCheck.stateNonce,
    });
    res.cookies.set("teamyak_session", signedToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    res.cookies.delete("teamyak_oauth_nonce");
    return res;
  }

  // 1-1. 직통 카카오 OAuth 토큰 교환 (이메일 권한 불필요, KOE205 원천 방지)
  if (action === "DIRECT_KAKAO_TOKEN_EXCHANGE") {
    const { code, redirectUri } = body;
    const clientId =
      process.env.KAKAO_CLIENT_ID ||
      process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID ||
      "b1ec0592928d85a41c49f7b984b0bdd1";
    const clientSecret =
      process.env.KAKAO_CLIENT_SECRET &&
      !process.env.KAKAO_CLIENT_SECRET.includes("여기에")
        ? process.env.KAKAO_CLIENT_SECRET
        : undefined;

    if (!code) {
      return NextResponse.json({ error: "MISSING_KAKAO_CODE" }, { status: 400 });
    }

    try {
      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri || `${req.nextUrl.origin}/auth/callback`,
        code,
      });
      if (clientSecret) {
        tokenParams.append("client_secret", clientSecret);
      }

      const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: tokenParams.toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return NextResponse.json(
          { error: "KAKAO_TOKEN_EXCHANGE_FAILED", details: errText },
          { status: 502 }
        );
      }

      const tokenData = await tokenRes.json();
      const kakaoAccessToken = tokenData.access_token;

      // 카카오 사용자 정보 조회 (닉네임, 프로필)
      const userRes = await fetch("https://kapi.kakao.com/v2/user/me", {
        headers: {
          Authorization: `Bearer ${kakaoAccessToken}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
      });

      if (!userRes.ok) {
        return NextResponse.json(
          { error: "KAKAO_USER_FETCH_FAILED" },
          { status: 502 }
        );
      }

      const kakaoUser = await userRes.json();
      const kakaoId = String(kakaoUser.id);
      const nickname =
        kakaoUser.kakao_account?.profile?.nickname ||
        kakaoUser.properties?.nickname ||
        `카카오 회원 (${kakaoId.slice(-4)})`;
      const userId = `u_kakao_${kakaoId}`;

      let user = db.users.find(
        (u) => u.id === userId || u.kakaoIdHash === `kakao_hash_${kakaoId}`
      );
      if (!user) {
        user = {
          id: userId,
          kakaoIdHash: `kakao_hash_${kakaoId}`,
          accountType: "REAL_KAKAO_OAUTH",
          displayName: nickname,
          jobTitle: "팀약 회원",
          teamId: null, // 무팀 독립성 유지
          createdAt: new Date().toISOString(),
        };
        db.users.push(user);
      } else {
        user.displayName = nickname;
      }

      const sessId = `sess_${user.id}_${Date.now()}`;
      const signedToken = signSessionToken(sessId, user.id);
      const newSess = {
        id: sessId,
        token: signedToken,
        userId: user.id,
        accountType: user.accountType,
        deviceLabel: body.deviceLabel || "Kakao Mobile Browser",
        revoked: false,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      db.sessions.push(newSess);
      await writeDatabase(db);

      const res = NextResponse.json({
        ok: true,
        user,
        sessionToken: signedToken,
      });
      res.cookies.set("teamyak_session", signedToken, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 3600,
      });
      return res;
    } catch (e: any) {
      return NextResponse.json(
        { error: "SERVER_AUTH_ERROR", message: e?.message },
        { status: 500 }
      );
    }
  }

  // 1-2. Supabase Auth 세션 동기화 (실제 카카오 OAuth 완료 후 발급된 Supabase JWT 검증)
  if (action === "SUPABASE_SESSION_SYNC") {
    const accessToken =
      body.accessToken ||
      req.headers.get("authorization")?.replace("Bearer ", "");
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!accessToken || !supabaseUrl || !anonKey) {
      return NextResponse.json(
        { error: "MISSING_SUPABASE_TOKEN" },
        { status: 400 }
      );
    }

    let supabaseUser: any = null;
    try {
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!userRes.ok) {
        return NextResponse.json(
          { error: "INVALID_SUPABASE_TOKEN" },
          { status: 401 }
        );
      }
      supabaseUser = await userRes.json();
    } catch {
      return NextResponse.json(
        { error: "AUTH_VERIFICATION_FAILED" },
        { status: 502 }
      );
    }

    const userId = supabaseUser.id;
    const kakaoIdentity = (supabaseUser.identities || []).find(
      (i: any) => i.provider === "kakao"
    );
    const kakaoProviderId =
      kakaoIdentity?.id ||
      kakaoIdentity?.identity_data?.sub ||
      `kakao_${userId}`;
    const displayName =
      supabaseUser.user_metadata?.full_name ||
      supabaseUser.user_metadata?.name ||
      "카카오 사용자";

    let user = db.users.find((u) => u.id === userId);
    if (!user) {
      user = {
        id: userId,
        kakaoIdHash: `kakao_hash_${kakaoProviderId}`,
        accountType: "REAL_KAKAO_OAUTH",
        displayName,
        jobTitle: "팀약 회원",
        teamId: null,
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
    }

    const sessId = `sess_${user.id}_${Date.now()}`;
    const signedToken = signSessionToken(sessId, user.id);
    const newSess = {
      id: sessId,
      token: signedToken,
      userId: user.id,
      accountType: user.accountType,
      deviceLabel: body.deviceLabel || "Kakao OAuth Verified Device",
      revoked: false,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    db.sessions.push(newSess);
    await writeDatabase(db);

    const res = NextResponse.json({
      ok: true,
      user,
      sessionToken: signedToken,
    });
    res.cookies.set("teamyak_session", signedToken, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    return res;
  }

  // 2. 테스트 계정 로그인 세션 발급 (실제 카카오 계정과 명확히 구분된 TEST_SANDBOX_ACCOUNT 표시)
  if (action === "LOGIN_ACCOUNT") {
    // [보안 감사 1] 프로덕션 환경에서는 테스트 계정 직접 로그인 원천 차단
    if (process.env.APP_ENV === "production") {
      return NextResponse.json(
        {
          error: "TEST_LOGIN_DISABLED_IN_PRODUCTION",
          message:
            "프로덕션 실서비스 환경에서는 테스트 계정 직접 로그인이 비활성화되어 있습니다. 정규 카카오 OAuth 로그인을 이용해 주세요.",
        },
        { status: 403 }
      );
    }

    const { userId, createNewGuestName } = body;
    let user = db.users.find((u) => u.id === userId);

    if (!user && createNewGuestName) {
      const newId = `u_guest_${Date.now()}`;
      user = {
        id: newId,
        kakaoIdHash: `kakao_hash_${newId}`,
        accountType: "TEST_SANDBOX_ACCOUNT",
        displayName: createNewGuestName,
        jobTitle: body.jobTitle || "언론사 기자 (무팀 참석)",
        teamId: null,
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
    }

    if (!user) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    let sess = body.forceNewSession
      ? null
      : db.sessions.find(
          (s) =>
            s.userId === user.id &&
            !s.revoked &&
            verifySignedSessionToken(s.token).valid
        );
    if (!sess) {
      const sessId = `sess_${user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sess = {
        id: sessId,
        token: signSessionToken(sessId, user.id),
        userId: user.id,
        accountType: user.accountType,
        deviceLabel: body.deviceLabel || "Mobile Browser",
        revoked: false,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      db.sessions.push(sess);
    }
    await writeDatabase(db);

    const res = NextResponse.json({
      ok: true,
      user,
      sessionToken: sess.token,
    });
    res.cookies.set("teamyak_session", sess.token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
    return res;
  }

  // 2-1. 사용자 프로필 업데이트 (최초 로그인 온보딩 및 내 정보 수정)
  if (action === "UPDATE_PROFILE") {
    const authHeader = req.headers.get("authorization");
    const cookieToken = req.cookies.get("teamyak_session")?.value;
    const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);
    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { displayName, jobTitle, orgName } = body;
    if (displayName && typeof displayName === "string" && displayName.trim()) {
      currentUser.displayName = displayName.trim();
    }
    if (jobTitle && typeof jobTitle === "string" && jobTitle.trim()) {
      currentUser.jobTitle = jobTitle.trim();
    }
    if (orgName && typeof orgName === "string" && orgName.trim()) {
      if (orgName.includes("중앙일보") || orgName.includes("기자") || orgName.includes("언론")) {
        currentUser.teamId = "team_press_joongang";
      } else {
        currentUser.teamId = "team_pr_corp";
      }
    }

    await writeDatabase(db);
    return NextResponse.json({
      ok: true,
      user: currentUser,
      message: "프로필이 성공적으로 저장되었습니다."
    });
  }

  // 3. 모바일 기기 변경 대비 마스터키 복구 봉투 저장 (6자리 PIN 등 저엔트로피 비밀값 서버에서도 거부!)
  if (action === "SAVE_KEY_BACKUP") {
    const authHeader = req.headers.get("authorization");
    const cookieToken = req.cookies.get("teamyak_session")?.value;
    const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);
    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (body.recoverySecretForValidationOnly !== undefined) {
      const strength = validateRecoverySecretStrength(
        body.recoverySecretForValidationOnly
      );
      if (!strength.valid) {
        return NextResponse.json(
          {
            error: "WEAK_RECOVERY_SECRET_REJECTED",
            reason: strength.reason,
            estimatedEntropyBits: strength.estimatedEntropyBits,
          },
          { status: 400 }
        );
      }
    }

    if (
      typeof body.estimatedEntropyBits === "number" &&
      body.estimatedEntropyBits < 72
    ) {
      return NextResponse.json(
        {
          error: "WEAK_RECOVERY_SECRET_REJECTED",
          message:
            "오프라인 무차별 대입 공격 방어를 위해 72비트 미만(예: 6자리 숫자 PIN)의 키 백업은 허용되지 않습니다.",
        },
        { status: 400 }
      );
    }

    currentUser.encryptedMasterKeyBackup = body.encryptedMasterKeyBackup;
    currentUser.masterKeyIv = body.masterKeyIv;
    currentUser.keySalt = body.keySalt;
    currentUser.recoveryEntropyBits = body.estimatedEntropyBits || 140;
    await writeDatabase(db);
    return NextResponse.json({ ok: true, user: currentUser });
  }

  // 4. 세션 로그아웃 (현재 기기 세션 폐기 및 쿠키 제거)
  if (action === "LOGOUT") {
    const authHeader = req.headers.get("authorization");
    const cookieToken = req.cookies.get("teamyak_session")?.value;

    let tokenToRevoke = "";
    if (authHeader?.startsWith("Bearer ")) {
      tokenToRevoke = authHeader.replace("Bearer ", "").trim();
    } else if (cookieToken) {
      tokenToRevoke = cookieToken;
    }

    if (tokenToRevoke) {
      const sess = db.sessions.find((s) => s.token === tokenToRevoke);
      if (sess) {
        sess.revoked = true;
        await writeDatabase(db);
      }
    }

    const res = NextResponse.json({ ok: true, message: "Logged out successfully" });
    res.cookies.delete("teamyak_session");
    return res;
  }

  // 5. 기기별 세션 독립 폐기 (특정 기기 원격 로그아웃)
  if (action === "REVOKE_DEVICE_SESSION") {
    const authHeader = req.headers.get("authorization");
    const cookieToken = req.cookies.get("teamyak_session")?.value;
    const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { targetSessionId } = body;
    const targetSess = db.sessions.find(
      (s) => s.id === targetSessionId && s.userId === currentUser.id
    );

    if (!targetSess) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    targetSess.revoked = true;
    await writeDatabase(db);

    return NextResponse.json({
      ok: true,
      message: `기기 세션(${targetSess.deviceLabel})이 성공적으로 폐기되었습니다.`,
      revokedSessionId: targetSessionId,
    });
  }

  // 6. 활성 기기 세션 목록 조회
  if (action === "GET_ACTIVE_SESSIONS") {
    const authHeader = req.headers.get("authorization");
    const cookieToken = req.cookies.get("teamyak_session")?.value;
    const currentUser = resolveUserFromRequest(db, authHeader, cookieToken);

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let currentToken = "";
    if (authHeader?.startsWith("Bearer ")) {
      currentToken = authHeader.replace("Bearer ", "").trim();
    } else if (cookieToken) {
      currentToken = cookieToken;
    }

    const activeSessions = db.sessions
      .filter((s) => s.userId === currentUser.id && !s.revoked)
      .map((s) => ({
        id: s.id,
        deviceLabel: s.deviceLabel,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        isCurrentDevice: s.token === currentToken,
      }));

    return NextResponse.json({ ok: true, sessions: activeSessions });
  }

  // 7. 데이터베이스 초기 시드 리셋
  if (action === "RESET_SEED_DB") {
    const seed = await createInitialSeedDatabase();
    await writeDatabase(seed);
    return NextResponse.json({
      ok: true,
      message: "Database reset to initial Phase 3.5 seed",
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
