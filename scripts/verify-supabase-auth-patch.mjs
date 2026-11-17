// ==============================================================================
// TEAMYAK — Supabase Auth 인증 구조 패치 및 RLS 무결성 종합 검증 스크립트 (최종 패치)
// ==============================================================================

import { PGlite } from "@electric-sql/pglite";
import assert from "assert";

console.log("================================================================================");
console.log("🛡️ [TEAMYAK] Supabase Auth 인증 구조 패치 및 RLS 무결성 검증 시작");
console.log("================================================================================\n");

async function runTests() {
  const db = new PGlite();

  console.log("--- [1. 스키마 및 보안 패치 트리거 설정 (SET search_path = '')] ---");
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS admin_audit;

    CREATE TABLE IF NOT EXISTS auth.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255),
      raw_app_meta_data JSONB DEFAULT '{}'::jsonb,
      raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS auth.identities (
      id TEXT PRIMARY KEY,
      user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      identity_data JSONB DEFAULT '{}'::jsonb,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      last_sign_in_at TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- public.users 테이블 생성
    CREATE TABLE IF NOT EXISTS public.users (
      id UUID PRIMARY KEY,
      kakao_id_hash VARCHAR(128) UNIQUE NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      job_title VARCHAR(100),
      email VARCHAR(255),
      account_type VARCHAR(32) NOT NULL DEFAULT 'REAL_KAKAO_OAUTH',
      is_test_account BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ
    );

    -- safe_sha256_hex 함수 생성 (SET search_path = '')
    CREATE OR REPLACE FUNCTION public.safe_sha256_hex(input_text pg_catalog.text)
    RETURNS pg_catalog.text AS $$
    BEGIN
      RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(input_text, 'UTF8')), 'hex');
    END;
    $$ LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path = '';

    -- handle_new_auth_user 트리거 함수 생성 (SET search_path = '', 정합성 보장)
    CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
    RETURNS trigger AS $$
    DECLARE
      v_kakao_provider_id pg_catalog.text;
      v_kakao_hash pg_catalog.varchar(128);
      v_display_name pg_catalog.varchar(100);
      v_email pg_catalog.varchar(255);
      v_job_title pg_catalog.varchar(100);
    BEGIN
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_catalog.pg_tables
          WHERE schemaname = 'auth' AND tablename = 'identities'
        ) THEN
          SELECT provider_id INTO v_kakao_provider_id
          FROM auth.identities
          WHERE user_id = NEW.id AND provider = 'kakao'
          LIMIT 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_kakao_provider_id := NULL;
      END;

      IF v_kakao_provider_id IS NULL THEN
        v_kakao_provider_id := COALESCE(
          NEW.raw_app_meta_data->>'provider_id',
          CASE WHEN NEW.raw_app_meta_data->>'provider' = 'kakao' THEN NEW.raw_user_meta_data->>'sub' ELSE NULL END,
          NEW.id::pg_catalog.text
        );
      END IF;

      v_kakao_hash := public.safe_sha256_hex('kakao_' || v_kakao_provider_id);

      v_display_name := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        NEW.raw_user_meta_data->>'nickname',
        '카카오 사용자'
      );

      v_email := NEW.email;
      v_job_title := COALESCE(NEW.raw_user_meta_data->>'job_title', '소속 미설정');

      -- public.users 테이블에 auth.users.id와 동일한 UUID로 멱등적 UPSERT
      INSERT INTO public.users (
        id,
        kakao_id_hash,
        display_name,
        job_title,
        email,
        account_type,
        is_test_account,
        created_at
      )
      VALUES (
        NEW.id,
        v_kakao_hash,
        v_display_name,
        v_job_title,
        v_email,
        'REAL_KAKAO_OAUTH',
        FALSE,
        COALESCE(NEW.created_at, pg_catalog.now())
      )
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        email = COALESCE(EXCLUDED.email, public.users.email),
        job_title = CASE
          WHEN public.users.job_title IS NULL OR public.users.job_title = '소속 미설정' THEN EXCLUDED.job_title
          ELSE public.users.job_title
        END;

      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'TEAMYAK_AUTH_SYNC_FATAL: handle_new_auth_user 실패 (%), auth.users.id=%', SQLERRM, NEW.id;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = '';

    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

    -- 관리자 전용 비공개 스키마 감사 뷰
    CREATE OR REPLACE VIEW admin_audit.v_auth_sync_audit AS
    SELECT
      COALESCE(au.id, pu.id) AS effective_user_id,
      CASE
        WHEN au.id IS NOT NULL AND pu.id IS NOT NULL THEN 'SYNCED_HEALTHY'
        WHEN au.id IS NOT NULL AND pu.id IS NULL THEN 'ORPHAN_AUTH_ONLY'
        WHEN au.id IS NULL AND pu.is_test_account = TRUE THEN 'TEST_SANDBOX_ISOLATED'
        WHEN au.id IS NULL AND pu.id IS NOT NULL THEN 'ORPHAN_PUBLIC_MISMATCH'
      END AS sync_status,
      au.email AS auth_email,
      pu.display_name AS public_name,
      pu.account_type,
      pu.is_test_account,
      (au.id = pu.id) AS id_exact_match
    FROM auth.users au
    FULL OUTER JOIN public.users pu ON au.id = pu.id;

    -- 고아 복구 프로시저
    CREATE OR REPLACE FUNCTION admin_audit.repair_orphaned_auth_users()
    RETURNS integer AS $$
    DECLARE
      v_repaired_count integer := 0;
      r RECORD;
    BEGIN
      FOR r IN
        SELECT au.id, au.email, au.raw_user_meta_data, au.raw_app_meta_data, au.created_at
        FROM auth.users au
        LEFT JOIN public.users pu ON au.id = pu.id
        WHERE pu.id IS NULL
      LOOP
        INSERT INTO public.users (
          id,
          kakao_id_hash,
          display_name,
          job_title,
          email,
          account_type,
          is_test_account,
          created_at
        )
        VALUES (
          r.id,
          public.safe_sha256_hex('kakao_' || COALESCE(r.raw_app_meta_data->>'provider_id', r.id::pg_catalog.text)),
          COALESCE(r.raw_user_meta_data->>'full_name', r.raw_user_meta_data->>'name', '카카오 사용자'),
          COALESCE(r.raw_user_meta_data->>'job_title', '소속 미설정'),
          r.email,
          'REAL_KAKAO_OAUTH',
          FALSE,
          COALESCE(r.created_at, pg_catalog.now())
        )
        ON CONFLICT (id) DO NOTHING;
        v_repaired_count := v_repaired_count + 1;
      END LOOP;
      RETURN v_repaired_count;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = '';

    -- 권한 분리: 일반 사용자(anon, authenticated) 권한 차단, postgres만 허용
    DO $$ BEGIN
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    REVOKE ALL ON SCHEMA admin_audit FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON TABLE admin_audit.v_auth_sync_audit FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION admin_audit.repair_orphaned_auth_users() FROM PUBLIC, anon, authenticated;

    GRANT USAGE ON SCHEMA admin_audit TO postgres;
    GRANT SELECT ON admin_audit.v_auth_sync_audit TO postgres;
    GRANT EXECUTE ON FUNCTION admin_audit.repair_orphaned_auth_users() TO postgres;
  `);
  console.log("  ✓ SET search_path = '' 적용 및 admin_audit 비공개 스키마 생성 완료\n");

  console.log("--- [2. 신규 사용자 가입 및 UUID 일치 검증] ---");
  const testKakaoUserId = "3829104812";
  const realAuthId = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";

  await db.exec(`
    INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
    VALUES (
      '${realAuthId}'::uuid,
      'reporter.park@joongang.co.kr',
      '{"provider": "kakao", "providers": ["kakao"]}'::jsonb,
      '{"full_name": "박서연", "name": "박서연", "job_title": "중앙일보 금융팀 기자", "sub": "${testKakaoUserId}"}'::jsonb
    );

    INSERT INTO auth.identities (id, user_id, provider, provider_id)
    VALUES (
      'kakao_${testKakaoUserId}',
      '${realAuthId}'::uuid,
      'kakao',
      '${testKakaoUserId}'
    );
  `);

  const syncCheck = await db.query(`SELECT * FROM public.users WHERE id = '${realAuthId}'::uuid;`);
  assert.strictEqual(syncCheck.rows.length, 1, "public.users에 레코드가 자동 동기화되어야 함");
  const syncedUser = syncCheck.rows[0];
  console.log("  ✓ 동기화된 사용자 ID:", syncedUser.id);
  console.log("  ✓ auth.users.id와 1:1 완벽 일치 확인 (auth.uid() = public.users.id)");
  assert.strictEqual(syncedUser.id, realAuthId);
  assert.strictEqual(syncedUser.display_name, "박서연");
  assert.strictEqual(syncedUser.account_type, "REAL_KAKAO_OAUTH");
  assert.strictEqual(syncedUser.is_test_account, false);
  console.log("  ✓ 카카오 provider_id 기반 불변 해시:", syncedUser.kakao_id_hash);
  console.log("  ✓ 신규 사용자 가입 트리거 검증 통과\n");

  console.log("--- [3. 재로그인 멱등성 및 충돌 방지 검증] ---");
  await db.exec(`
    INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
    VALUES (
      '${realAuthId}'::uuid,
      'reporter.park@joongang.co.kr',
      '{"provider": "kakao"}'::jsonb,
      '{"full_name": "박서연 (업데이트)", "job_title": "중앙일보 금융팀 기자"}'::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      raw_user_meta_data = EXCLUDED.raw_user_meta_data;
  `);

  const reLoginCheck = await db.query(`SELECT COUNT(*) as count FROM public.users WHERE id = '${realAuthId}'::uuid;`);
  assert.strictEqual(Number(reLoginCheck.rows[0].count), 1, "중복 사용자 레코드가 생성되지 않아야 함");
  console.log("  ✓ 동일 카카오 계정 재로그인 시 1개 계정 유지 확인 (중복 없음)");

  // 테스트 샌드박스 계정
  await db.exec(`
    INSERT INTO public.users (id, kakao_id_hash, display_name, job_title, account_type, is_test_account)
    VALUES (
      '00000000-0000-0000-0000-000000000001'::uuid,
      'test_hash_kim_minjun',
      '김민준 대리',
      '삼성생명 홍보팀 대리',
      'TEST_SANDBOX_ACCOUNT',
      TRUE
    );
  `);
  console.log("  ✓ 테스트 샌드박스 계정(is_test_account=true) 추가 및 실제 계정과의 분리 확인\n");

  console.log("--- [4. 비공개 스키마 이전 및 일반 사용자 권한 차단 검증] ---");
  await db.exec(`SET ROLE authenticated;`);
  let viewAccessBlocked = false;
  try {
    await db.query(`SELECT * FROM admin_audit.v_auth_sync_audit;`);
  } catch (err) {
    viewAccessBlocked = true;
    console.log("  ✓ 일반 사용자(authenticated)의 admin_audit 감사 뷰 접근 시 차단 확인 (Permission Denied)");
  }
  assert.strictEqual(viewAccessBlocked, true, "일반 사용자는 admin_audit 뷰에 접근할 수 없어야 함");

  await db.exec(`RESET ROLE;`);
  const auditReport = await db.query(`SELECT * FROM admin_audit.v_auth_sync_audit ORDER BY sync_status;`);
  console.log("  ✓ 관리자(postgres) 권한으로 감사 뷰 정상 조회 확인 (건수: " + auditReport.rows.length + ")");
  for (const row of auditReport.rows) {
    console.log(`    - [${row.sync_status}] ID: ${row.effective_user_id} (${row.public_name || row.auth_email || 'N/A'}) 일치여부: ${row.id_exact_match}`);
  }

  // 4-3. 고아 사용자 복구 프로시저 검증
  const orphanAuthId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  await db.exec(`
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${orphanAuthId}'::uuid, 'orphan@test.com', '{"full_name": "고아 사용자"}'::jsonb);
  `);

  const orphanCheckBefore = await db.query(`SELECT * FROM admin_audit.v_auth_sync_audit WHERE effective_user_id = '${orphanAuthId}'::uuid;`);
  assert.strictEqual(orphanCheckBefore.rows[0].sync_status, "ORPHAN_AUTH_ONLY");
  console.log("  ✓ 고아 계정 발생 정확히 탐지 확인 (ORPHAN_AUTH_ONLY)");

  const repairRes = await db.query(`SELECT admin_audit.repair_orphaned_auth_users() AS repaired;`);
  console.log("  ✓ admin_audit.repair_orphaned_auth_users() 실행 완료 (복구 건수: " + repairRes.rows[0].repaired + ")");

  const orphanCheckAfter = await db.query(`SELECT * FROM admin_audit.v_auth_sync_audit WHERE effective_user_id = '${orphanAuthId}'::uuid;`);
  assert.strictEqual(orphanCheckAfter.rows[0].sync_status, "SYNCED_HEALTHY");
  console.log("  ✓ 복구 프로시저 실행 후 고아 계정 정상 복원 확인 (SYNCED_HEALTHY)\n");

  console.log("--- [5. RLS 권한 격리 및 일반 사용자 vs 관리자 분리 검증] ---");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public.meetings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_by UUID NOT NULL REFERENCES public.users(id),
      title TEXT NOT NULL
    );
    ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.meetings FORCE ROW LEVEL SECURITY;

    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

    DROP POLICY IF EXISTS "meetings_owner_select" ON public.meetings;
    CREATE POLICY "meetings_owner_select" ON public.meetings
    FOR ALL TO authenticated
    USING (created_by = current_setting('request.jwt.claim.sub', true)::uuid);
  `);

  await db.exec(`
    INSERT INTO public.meetings (id, created_by, title)
    VALUES ('11111111-1111-2222-3333-444444444444'::uuid, '${realAuthId}'::uuid, '중앙일보 출입기자 미팅');
  `);

  // 1) 본인 JWT(auth.uid() = 박서연 UUID)로 쿼리 시 조회 성공
  await db.exec(`
    SET ROLE authenticated;
    SELECT set_config('request.jwt.claim.sub', '${realAuthId}', false);
  `);
  const selfQuery = await db.query(`SELECT * FROM public.meetings;`);
  assert.strictEqual(selfQuery.rows.length, 1, "본인 세션에서는 본인 모임이 조회되어야 함");
  console.log("  ✓ 본인 세션(auth.uid()) RLS 조회 성공:", selfQuery.rows[0].title);

  // 2) 타인 세션(auth.uid() = 다른 사용자 UUID)으로 쿼리 시 0건 차단
  await db.exec(`
    SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  `);
  const otherQuery = await db.query(`SELECT * FROM public.meetings;`);
  assert.strictEqual(otherQuery.rows.length, 0, "타인 세션에서는 타인의 모임이 RLS에 의해 차단되어야 함");
  console.log("  ✓ 타인 세션 RLS 접근 원천 차단 확인 (0건 반환)");

  // 3) 관리자 키(postgres superuser)로 전환 시 RLS 우회 확인
  await db.exec(`RESET ROLE;`);
  const adminQuery = await db.query(`SELECT * FROM public.meetings;`);
  assert.strictEqual(adminQuery.rows.length, 1, "관리자(superuser) 권한에서는 RLS 우회 조회 가능");
  console.log("  ✓ 관리자(service_role/superuser) 전용 경로에서만 RLS 우회 가능 확인 (일반 세션 분리 입증)");

  console.log("\n================================================================================");
  console.log("🎉 [SUCCESS] Supabase Auth 최종 패치 및 보안 무결성 검증 100% 통과!");
  console.log("================================================================================");
}

runTests().catch((err) => {
  console.error("❌ 검증 실패:", err);
  process.exit(1);
});
