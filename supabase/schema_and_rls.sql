-- ============================================================================
-- TEAMYAK (팀약) — PostgreSQL / Supabase Schema & Row Level Security (RLS)
-- 원칙: "약속은 연결하지만, 관계는 소유하지 않는다."
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. ENUM Types
CREATE TYPE org_type AS ENUM ('ENTERPRISE', 'MEDIA', 'INSTITUTION', 'ASSOCIATION', 'OTHER');
CREATE TYPE team_verification_status AS ENUM ('UNVERIFIED', 'DOMAIN_VERIFIED', 'OFFICIAL_APPROVED');
CREATE TYPE membership_role AS ENUM ('ADMIN', 'MEMBER');
CREATE TYPE membership_status AS ENUM ('ACTIVE', 'INVITED', 'LEFT');
CREATE TYPE place_category AS ENUM ('RESTAURANT', 'CAFE', 'HOTEL', 'MEETING_ROOM', 'OFFICE', 'OTHER');
CREATE TYPE meeting_status AS ENUM ('SCHEDULING', 'RECRUITING', 'CONFIRMED', 'COMPLETED', 'CANCELED');
CREATE TYPE meeting_side_type AS ENUM ('HOST', 'GUEST');
CREATE TYPE visibility_scope AS ENUM ('PRIVATE_PARTICIPANTS_ONLY', 'TEAM_SHARED');
CREATE TYPE side_role AS ENUM ('REPRESENTATIVE', 'PARTICIPANT');
CREATE TYPE rsvp_status_type AS ENUM ('ATTENDING', 'TENTATIVE', 'DECLINED', 'PENDING_APPROVAL');
CREATE TYPE attendance_check_type AS ENUM ('UNCONFIRMED', 'VERIFIED_ATTENDED', 'NO_SHOW');
CREATE TYPE calendar_provider AS ENUM ('INTERNAL', 'GOOGLE', 'ICS_FEED');

-- 2. Core 15 Entities

-- (1) User
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kakao_id VARCHAR(128) UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  job_title VARCHAR(100),
  email VARCHAR(255),
  encryption_public_key TEXT,
  encrypted_master_key_backup TEXT,
  key_salt VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- (2) Organization (기관 별칭 체계 포함: 예 한국은행·한은·BOK)
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name VARCHAR(150) NOT NULL UNIQUE,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  org_type org_type NOT NULL DEFAULT 'ENTERPRISE',
  verified_domains TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_organizations_aliases ON organizations USING GIN (aliases);

-- (3) Team (사칭 방지용 인증 체계 포함)
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name VARCHAR(120) NOT NULL,
  verification_status team_verification_status NOT NULL DEFAULT 'UNVERIFIED',
  verified_domain VARCHAR(255),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- (4) TeamMembership (다중 팀 소속 및 이직/탈퇴 분리)
CREATE TABLE team_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role membership_role NOT NULL DEFAULT 'MEMBER',
  status membership_status NOT NULL DEFAULT 'ACTIVE',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  UNIQUE (team_id, user_id)
);

-- (5) Place (네이버 지역 검색 및 외부 예약 연결)
CREATE TABLE places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  naver_place_id VARCHAR(128),
  name VARCHAR(200) NOT NULL,
  category place_category NOT NULL DEFAULT 'RESTAURANT',
  road_address VARCHAR(300),
  jibun_address VARCHAR(300),
  area_summary VARCHAR(100) NOT NULL, -- 비로그인 초대장용 지역명 (예: 여의도)
  latitude NUMERIC(10, 7),
  longitude NUMERIC(10, 7),
  naver_map_url TEXT,
  external_booking_url TEXT,
  official_info_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (6) Meeting (모임 원본)
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  status meeting_status NOT NULL DEFAULT 'RECRUITING',
  confirmed_date DATE,
  candidate_dates JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_time TIME,
  end_time TIME,
  is_time_tbd BOOLEAN NOT NULL DEFAULT FALSE,
  place_id UUID REFERENCES places(id) ON DELETE SET NULL,
  place_tbd_hint VARCHAR(150),
  description TEXT,
  max_participants INT,
  rsvp_deadline TIMESTAMPTZ,
  sequence_version INT NOT NULL DEFAULT 1,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (7) MeetingSide (호스트 측과 게스트 측 분리)
CREATE TABLE meeting_sides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  side_type meeting_side_type NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  representative_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  side_label VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, side_type)
);

-- (8) MeetingVisibility (양측 독립적 팀 공유 설정)
CREATE TABLE meeting_visibilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_side_id UUID NOT NULL UNIQUE REFERENCES meeting_sides(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  share_scope visibility_scope NOT NULL DEFAULT 'PRIVATE_PARTICIPANTS_ONLY',
  share_participant_names_to_team BOOLEAN NOT NULL DEFAULT FALSE,
  decided_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (9) MeetingParticipant (참석자 및 응답·실제 참석 분리)
CREATE TABLE meeting_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  meeting_side_id UUID NOT NULL REFERENCES meeting_sides(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_side side_role NOT NULL DEFAULT 'PARTICIPANT',
  rsvp_status rsvp_status_type NOT NULL DEFAULT 'ATTENDING',
  attendance_check attendance_check_type NOT NULL DEFAULT 'UNCONFIRMED',
  is_forwarded_guest BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by_user_id UUID REFERENCES users(id),
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, user_id)
);

-- (10) MeetingInvitation (카카오톡 초대 링크 토큰 - 개인정보 미포함)
CREATE TABLE meeting_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  meeting_side_id UUID NOT NULL REFERENCES meeting_sides(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  intended_target_hint VARCHAR(150),
  require_host_approval_on_forward BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (11) MeetingHistory (개인 소유 미팅 이력 + 클라이언트 측 암호화 메모)
CREATE TABLE meeting_histories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_id UUID REFERENCES meetings(id) ON DELETE SET NULL,
  counterpart_organization_id UUID NOT NULL REFERENCES organizations(id),
  meeting_date DATE NOT NULL,
  meeting_title_snapshot VARCHAR(200) NOT NULL,
  attendance_verified BOOLEAN NOT NULL DEFAULT FALSE,
  encrypted_private_memo TEXT, -- AES-256-GCM Ciphertext (클라이언트 측 암호화)
  memo_iv VARCHAR(64),
  shared_to_team_id UUID REFERENCES teams(id) ON DELETE SET NULL, -- 명시적 팀 공유 승인 시에만 설정
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (12) OrganizationContact (기관별 접촉 기록 요약 - 타인 비공개 이력 기반 추론 금지)
CREATE TABLE organization_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  owner_team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  target_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  last_met_date DATE NOT NULL,
  encrypted_contact_note TEXT,
  note_iv VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_contact_owner CHECK (
    (owner_user_id IS NOT NULL AND owner_team_id IS NULL) OR
    (owner_user_id IS NULL AND owner_team_id IS NOT NULL)
  )
);

-- (13) CalendarConnection (외부 캘린더 연동 및 쓰기 동의)
CREATE TABLE calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider calendar_provider NOT NULL,
  write_consent BOOLEAN NOT NULL DEFAULT FALSE,
  encrypted_oauth_refresh_token TEXT,
  external_event_mappings JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

-- (14) NotificationPreference (당일 오전 8시 기본 알림 설정)
CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  morning_briefing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  morning_briefing_time TIME NOT NULL DEFAULT '08:00:00',
  notify_on_schedule_change BOOLEAN NOT NULL DEFAULT TRUE,
  prefer_external_calendar_alarm BOOLEAN NOT NULL DEFAULT TRUE,
  web_push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (15) NewsKeyword (우리 회사 & 만나는 회사 뉴스 키워드)
CREATE TABLE news_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  keyword VARCHAR(100) NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 3. Row Level Security (RLS) Policies
-- ============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_sides ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_visibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_histories ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- [RLS 1] 모임(Meeting) 조회: 본인 생성, 본인 참석, 또는 본인 활성 소속 팀의 해당 Side가 TEAM_SHARED인 경우에만 허용
CREATE POLICY "meetings_select_policy" ON meetings
FOR SELECT USING (
  created_by = auth.uid()
  OR EXISTS (
    SELECT 1 FROM meeting_participants mp
    WHERE mp.meeting_id = meetings.id AND mp.user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM meeting_sides ms
    JOIN meeting_visibilities mv ON mv.meeting_side_id = ms.id
    JOIN team_memberships tm ON tm.team_id = mv.team_id
    WHERE ms.meeting_id = meetings.id
      AND mv.share_scope = 'TEAM_SHARED'
      AND tm.user_id = auth.uid()
      AND tm.status = 'ACTIVE'
  )
);

-- [RLS 2] 양측 독립 공유 설정(MeetingVisibility) 수정: 오직 해당 Side의 대표(Representative)만 자신의 소속 팀 공유 여부 변경 가능
CREATE POLICY "meeting_visibilities_update_by_side_rep" ON meeting_visibilities
FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM meeting_sides ms
    WHERE ms.id = meeting_visibilities.meeting_side_id
      AND ms.representative_user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM meeting_sides ms
    WHERE ms.id = meeting_visibilities.meeting_side_id
      AND ms.representative_user_id = auth.uid()
  )
);

-- [RLS 3] 개인 미팅 이력(MeetingHistory): 오직 소유자(owner_user_id)만 모든 권한 보유
CREATE POLICY "meeting_histories_owner_all" ON meeting_histories
FOR ALL USING (owner_user_id = auth.uid())
WITH CHECK (owner_user_id = auth.uid());

-- 팀에 명시적 공개 승인된 이력만 해당 팀의 활성 팀원이 조회 가능 (단, 암호화 메모는 클라이언트 키가 없어 복호화 불가)
CREATE POLICY "meeting_histories_team_shared_select" ON meeting_histories
FOR SELECT USING (
  shared_to_team_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM team_memberships tm
    WHERE tm.team_id = meeting_histories.shared_to_team_id
      AND tm.user_id = auth.uid()
      AND tm.status = 'ACTIVE'
  )
);

-- [RLS 4] 기관별 접촉 요약(OrganizationContact): 본인 소유이거나 활성 소속 팀에 공개 승인된 요약만 조회
CREATE POLICY "organization_contacts_select" ON organization_contacts
FOR SELECT USING (
  owner_user_id = auth.uid()
  OR (
    owner_team_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM team_memberships tm
      WHERE tm.team_id = organization_contacts.owner_team_id
        AND tm.user_id = auth.uid()
        AND tm.status = 'ACTIVE'
    )
  )
);


-- ============================================================================
-- 4. Supabase Auth (auth.users) <-> TEAMYAK (public.users) 사용자 식별 연동 및 정합성 보장
-- ============================================================================
-- [보안 강화 1] SECURITY DEFINER 함수에 SET search_path = '' 적용 및 모든 참조 객체 스키마 명시
-- [보안 강화 2] 신규 가입 시 public.users 동기화 무조건 은폐(Silent Fail) 금지 및 정합성 보장
-- [보안 강화 3] 복구 프로시저(admin_audit.repair_orphaned_auth_users) 제공
-- [보안 강화 4] 민감 정보 노출 방지를 위해 감사 뷰를 admin_audit 비공개 스키마로 이전
--              (anon, authenticated 접근 전면 차단, service_role/postgres만 허용)

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS account_type VARCHAR(32) NOT NULL DEFAULT 'REAL_KAKAO_OAUTH';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_test_account BOOLEAN NOT NULL DEFAULT FALSE;

-- 해시 생성 헬퍼 함수 (search_path = '' 적용 및 core sha256 내장 함수 활용)
CREATE OR REPLACE FUNCTION public.safe_sha256_hex(input_text pg_catalog.text)
RETURNS pg_catalog.text AS $$
BEGIN
  RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(input_text, 'UTF8')), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = '';

-- 함수 권한 최소화
REVOKE ALL ON FUNCTION public.safe_sha256_hex(pg_catalog.text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.safe_sha256_hex(pg_catalog.text) TO postgres, service_role, anon, authenticated;

-- 신규 사용자 동기화 트리거 함수 (SET search_path = '', 정합성 보장)
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger AS $$
DECLARE
  v_kakao_provider_id pg_catalog.text;
  v_kakao_hash pg_catalog.varchar(128);
  v_display_name pg_catalog.varchar(100);
  v_email pg_catalog.varchar(255);
  v_job_title pg_catalog.varchar(100);
BEGIN
  -- 1. 카카오 공급자 ID 조회:
  --    클라이언트 조작 가능한 raw_user_meta_data 대신
  --    auth.identities 또는 서버 통제 raw_app_meta_data를 우선 조회
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

  -- identities에 아직 기록 전인 경우 서버 생성 app_metadata 확인, 최후 fallback은 NEW.id
  IF v_kakao_provider_id IS NULL THEN
    v_kakao_provider_id := COALESCE(
      NEW.raw_app_meta_data->>'provider_id',
      CASE WHEN NEW.raw_app_meta_data->>'provider' = 'kakao' THEN NEW.raw_user_meta_data->>'sub' ELSE NULL END,
      NEW.id::pg_catalog.text
    );
  END IF;

  -- 불변 공급자 ID 기반 해시 생성
  v_kakao_hash := public.safe_sha256_hex('kakao_' || v_kakao_provider_id);

  -- 표시 이름 추출
  v_display_name := COALESCE(
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'name',
    NEW.raw_user_meta_data->>'nickname',
    '카카오 사용자'
  );

  v_email := NEW.email;
  v_job_title := COALESCE(NEW.raw_user_meta_data->>'job_title', '소속 미설정');

  -- 2. public.users 테이블에 auth.users.id와 동일한 UUID로 멱등적 UPSERT
  -- 정합성 보장: public.users 삽입/갱신이 성공해야 정상 커밋됨
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
  -- 오류 은폐 방지: 정합성 유지를 위해 예외 원인을 기록하고 트랜잭션 실패로 전파
  RAISE EXCEPTION 'TEAMYAK_AUTH_SYNC_FATAL: handle_new_auth_user 실패 (%), auth.users.id=%', SQLERRM, NEW.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

-- 함수 실행 권한 최소화 (anon, authenticated, PUBLIC 전면 배제)
REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_auth_user() TO postgres, service_role;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.handle_new_auth_user() TO supabase_auth_admin;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Supabase 환경의 auth.users에 트리거 등록
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'auth') AND
     EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'auth' AND tablename = 'users') THEN
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
  END IF;
END $$;

-- auth.identities 추가 시 카카오 provider_id 업데이트 트리거 (실제 클라우드 호환성 고려 안전 래핑)
CREATE OR REPLACE FUNCTION public.handle_auth_identity_sync()
RETURNS trigger AS $$
BEGIN
  IF NEW.provider = 'kakao' AND NEW.provider_id IS NOT NULL THEN
    UPDATE public.users
    SET kakao_id_hash = public.safe_sha256_hex('kakao_' || NEW.provider_id)
    WHERE id = NEW.user_id AND is_test_account = FALSE;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

REVOKE ALL ON FUNCTION public.handle_auth_identity_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_auth_identity_sync() TO postgres, service_role;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.handle_auth_identity_sync() TO supabase_auth_admin;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'auth') AND
     EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'auth' AND tablename = 'identities') THEN
    BEGIN
      DROP TRIGGER IF EXISTS on_auth_identity_synced ON auth.identities;
      CREATE TRIGGER on_auth_identity_synced
        AFTER INSERT OR UPDATE ON auth.identities
        FOR EACH ROW EXECUTE FUNCTION public.handle_auth_identity_sync();
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Supabase 클라우드 auth.identities 트리거 권한 제한으로 건너뜀 (handle_new_auth_user로 안전 대체 동작함)';
    END;
  END IF;
END $$;

-- ============================================================================
-- 5. 관리자 전용 비공개 스키마 및 양방향 감사 뷰 (민감 정보 완전 격리)
-- ============================================================================
-- 기존 public 뷰 삭제 (PostgREST 자동 노출 원천 차단)
DROP VIEW IF EXISTS public.v_auth_sync_audit;

-- 관리자 전용 비공개 스키마 생성
CREATE SCHEMA IF NOT EXISTS admin_audit;

-- 비공개 감사 뷰 생성 (FULL OUTER JOIN으로 양방향 고아 계정 탐지)
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
  (au.id = pu.id) AS id_exact_match,
  au.created_at AS auth_created_at,
  pu.created_at AS public_created_at
FROM auth.users au
FULL OUTER JOIN public.users pu ON au.id = pu.id;

-- 일반 사용자(anon, authenticated, PUBLIC) 접근 완전 차단
REVOKE ALL ON SCHEMA admin_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE admin_audit.v_auth_sync_audit FROM PUBLIC, anon, authenticated;

-- 시스템 관리자(service_role, postgres)만 조회 허용
GRANT USAGE ON SCHEMA admin_audit TO service_role, postgres;
GRANT SELECT ON admin_audit.v_auth_sync_audit TO service_role, postgres;

-- 고아 사용자 발생 시 수동/자동 복구 프로시저 (관리자 전용)
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

REVOKE ALL ON FUNCTION admin_audit.repair_orphaned_auth_users() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_audit.repair_orphaned_auth_users() TO service_role, postgres;
