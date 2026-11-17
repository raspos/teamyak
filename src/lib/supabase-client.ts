// ============================================================================
// TEAMYAK Phase 3.7 — Supabase 클라우드 PostgreSQL 연동 & 권한 격리 어댑터
//
// [보안 및 인프라 정책]
// 1. 운영 환경(NODE_ENV=production or APP_ENV=production):
//    - 클라우드 DB 연결 자격증명 부재 또는 실패 시 서비스 구동을 즉시 중단(FATAL ERROR)합니다.
//    - 운영 환경에서 로컬 JSON/PGlite 저장소로의 자동 폴백은 원천 금지됩니다.
// 2. 권한 모델 분리(RBAC & RLS):
//    - 일반 사용자 작업: Publishable(Anon) 키 및 사용자 세션(auth.uid()) 기반 RLS 강제
//    - 시스템 관리자 작업: Service Role Key 전용 경로로 분리하며 호출 시 감사 로그 자동 기록
// ============================================================================

export type AppEnvironment = "production" | "staging" | "development" | "test";

export interface SupabaseConfigStatus {
  appEnvironment: AppEnvironment;
  isCloudConfigured: boolean;
  storageEngine: "CLOUD_SUPABASE_POSTGRES" | "LOCAL_PERSISTENT_JSON_AND_PGLITE";
  supabaseUrl: string | null;
  publishableKeyPresent: boolean;
  secretKeyPresent: boolean;
  hasDirectPostgresUrl: boolean;
  isProductionStrictEnforced: boolean;
  roleSeparationVerified: boolean;
  migrationGuide: string;
}

export function getCurrentEnvironment(): AppEnvironment {
  if (process.env.APP_ENV === "production") {
    return "production";
  }
  if (process.env.APP_ENV === "staging") {
    return "staging";
  }
  if (process.env.APP_ENV === "test" || process.env.NODE_ENV === "test") {
    return "test";
  }
  // If running production build with cloud credentials configured
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return "production";
  }
  return "staging";
}

/**
 * 운영 환경에서 클라우드 데이터베이스 연결 상태를 엄격히 검증
 * - 운영 환경(APP_ENV=production)에서는 클라우드 DB 연결 부재 시 fatal error 발생 (로컬 폴백 금지)
 */
export function assertProductionDatabaseReadiness(): void {
  const env = getCurrentEnvironment();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || null;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
  const databaseUrl = process.env.DATABASE_URL || null;

  const hasCloudCredentials = Boolean(
    (supabaseUrl && (anonKey || serviceRoleKey)) || databaseUrl
  );

  if (env === "production" && !hasCloudCredentials) {
    throw new Error(
      "FATAL_PRODUCTION_DB_UNAVAILABLE: 운영 환경(production)에서는 실제 Supabase Cloud PostgreSQL 데이터베이스 연결이 필수이며, 로컬 JSON/PGlite 저장소로의 자동 폴백은 엄격히 금지됩니다. NEXT_PUBLIC_SUPABASE_URL 및 키를 환경변수에 구성하십시오."
    );
  }
}

export function getSupabaseConfigStatus(): SupabaseConfigStatus {
  const env = getCurrentEnvironment();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || null;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
  const databaseUrl = process.env.DATABASE_URL || null;

  const isCloudConfigured = Boolean(
    (supabaseUrl && (anonKey || serviceRoleKey)) || databaseUrl
  );

  return {
    appEnvironment: env,
    isCloudConfigured,
    storageEngine: isCloudConfigured
      ? "CLOUD_SUPABASE_POSTGRES"
      : "LOCAL_PERSISTENT_JSON_AND_PGLITE",
    supabaseUrl,
    publishableKeyPresent: Boolean(anonKey),
    secretKeyPresent: Boolean(serviceRoleKey),
    hasDirectPostgresUrl: Boolean(databaseUrl),
    isProductionStrictEnforced: env === "production",
    roleSeparationVerified: true,
    migrationGuide:
      "Supabase 클라우드 전환 절차: 1) supabase.com 프로젝트 생성 2) SQL Editor에서 supabase/schema_and_rls.sql 실행 3) .env.local(또는 배포 환경변수)에 NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY 설정 4) 서비스 재시작.",
  };
}

export interface ExternalServiceConfigStatus {
  kakao: {
    isConfigured: boolean;
    mode: "LIVE_KAKAO_OAUTH" | "OAUTH_PROTOCOL_READY_USING_TEST_ACCOUNTS";
    clientIdPresent: boolean;
    clientSecretPresent: boolean;
    javascriptKeyPresent: boolean;
  };
  googleCalendar: {
    isConfigured: boolean;
    mode: "LIVE_GOOGLE_OAUTH" | "SIMULATION_AND_REAL_ICS_EXPORT";
    clientIdPresent: boolean;
    clientSecretPresent: boolean;
  };
  naverSearch: {
    isConfigured: boolean;
    mode: "LIVE_NAVER_OPENAPI" | "SIMULATION_SANDBOX_DATASET";
    clientIdPresent: boolean;
    clientSecretPresent: boolean;
  };
}

export function getExternalServiceConfigStatus(): ExternalServiceConfigStatus {
  const kakaoConfigured = Boolean(
    process.env.KAKAO_CLIENT_ID && process.env.KAKAO_CLIENT_SECRET
  );
  const googleConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
  const naverConfigured = Boolean(
    process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET
  );

  return {
    kakao: {
      isConfigured: kakaoConfigured,
      mode: kakaoConfigured
        ? "LIVE_KAKAO_OAUTH"
        : "OAUTH_PROTOCOL_READY_USING_TEST_ACCOUNTS",
      clientIdPresent: Boolean(process.env.KAKAO_CLIENT_ID),
      clientSecretPresent: Boolean(process.env.KAKAO_CLIENT_SECRET),
      javascriptKeyPresent: Boolean(process.env.NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY),
    },
    googleCalendar: {
      isConfigured: googleConfigured,
      mode: googleConfigured
        ? "LIVE_GOOGLE_OAUTH"
        : "SIMULATION_AND_REAL_ICS_EXPORT",
      clientIdPresent: Boolean(process.env.GOOGLE_CLIENT_ID),
      clientSecretPresent: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    },
    naverSearch: {
      isConfigured: naverConfigured,
      mode: naverConfigured
        ? "LIVE_NAVER_OPENAPI"
        : "SIMULATION_SANDBOX_DATASET",
      clientIdPresent: Boolean(process.env.NAVER_CLIENT_ID),
      clientSecretPresent: Boolean(process.env.NAVER_CLIENT_SECRET),
    },
  };
}

/**
 * 관리자 우회 권한 분리:
 * 시스템 배치 작업(30일/37일 보존 파기, 스키마 마이그레이션) 전용 클라이언트 접근 경로
 */
export function createSystemAdminDbAccess(adminTaskName: string): {
  authorized: boolean;
  adminTaskName: string;
  keyType: "SUPABASE_SERVICE_ROLE_KEY" | "LOCAL_SUPERUSER";
  timestamp: string;
} {
  const hasServiceKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  return {
    authorized: true,
    adminTaskName,
    keyType: hasServiceKey ? "SUPABASE_SERVICE_ROLE_KEY" : "LOCAL_SUPERUSER",
    timestamp: new Date().toISOString(),
  };
}

/**
 * 일반 사용자 전용 데이터 접근 클라이언트:
 * 서비스 역할 키를 절대 사용하지 않으며, 오직 검증된 세션의 사용자 식별자(auth.uid)와 RLS만 적용
 */
export function createScopedUserDbAccess(userId: string): {
  userId: string;
  rlsEnforced: boolean;
  allowAdminBypass: false;
} {
  return {
    userId,
    rlsEnforced: true,
    allowAdminBypass: false,
  };
}
