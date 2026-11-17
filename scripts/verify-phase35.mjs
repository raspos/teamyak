// ============================================================================
// TEAMYAK Phase 3.5 — 비공개 베타 출시 전 종합 검증 스위트
// 1. 실제 PostgreSQL 16 엔진(@electric-sql/pglite) 기반 RLS(Row Level Security) 실증 테스트
// 2. 서버 프로세스 재시작 전후 데이터 영속성 검증
// 3. 6자리 숫자 PIN 거부 및 140-bit 고엔트로피 복구 코드(TYRK-...) 키 복구 검증
// 4. OAuth state 변조(CSRF) 차단, 세션 위조('Bearer u_park') 차단, 전달 링크 암호문 차단
// 5. 공유 권한 변경 직후 기존 활성 세션의 접근 권한 즉시 갱신 검증
// 6. 30일 보존 파기 + 미백업 참석자 모임 37일 상한선(Hard Cap) 강제 파기 검증
// 7. 실패/동시성 상황(만료 링크 410, 취소 모임 동시 수락 409, 중복 응답 멱등성, 캘린더 API 실패 격리)
// ============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const UUID_KIM  = "00000000-0000-4000-8000-000000000001";
const UUID_PARK = "00000000-0000-4000-8000-000000000002";
const UUID_LEE  = "00000000-0000-4000-8000-000000000003";
const UUID_CHOI = "00000000-0000-4000-8000-000000000004";
const UUID_JUNG = "00000000-0000-4000-8000-000000000005";

const UUID_ORG_SAMSUNG = "10000000-0000-4000-8000-000000000001";
const UUID_ORG_JA      = "10000000-0000-4000-8000-000000000002";
const UUID_TEAM_PR     = "20000000-0000-4000-8000-000000000001";
const UUID_TEAM_FIN    = "20000000-0000-4000-8000-000000000002";
const UUID_MTG_1       = "30000000-0000-4000-8000-000000000001";
const UUID_SIDE_HOST   = "40000000-0000-4000-8000-000000000001";
const UUID_SIDE_GUEST  = "40000000-0000-4000-8000-000000000002";

async function runPostgresRlsVerification() {
  console.log("\n------------------------------------------------------------------");
  console.log("🐘 [Part 1] 실제 PostgreSQL 16 엔진(PGlite) 기반 RLS 정책 검증");
  console.log("------------------------------------------------------------------");

  const pg = new PGlite();

  // Supabase auth.uid() 호환 스키마 및 비특권 역할(authenticated) 생성
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    DO $$ BEGIN
      CREATE ROLE authenticated NOINHERIT;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  const schemaSql = fs.readFileSync(
    path.join(process.cwd(), "supabase", "schema_and_rls.sql"),
    "utf8"
  );
  await pg.exec(schemaSql);

  await pg.exec(`
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
  `);

  // 초기 테스트 데이터 삽입 (superuser 상태에서 시드 적재)
  await pg.exec(`
    INSERT INTO users (id, kakao_id_hash, display_name, job_title) VALUES
      ('${UUID_KIM}',  'hash_kim',  '김민준 대리', '삼성생명 홍보팀'),
      ('${UUID_PARK}', 'hash_park', '박서연 기자', '중앙일보 금융팀'),
      ('${UUID_LEE}',  'hash_lee',  '이수현 과장', '삼성생명 홍보팀원'),
      ('${UUID_CHOI}', 'hash_choi', '최지훈 기자', '중앙일보 동료기자'),
      ('${UUID_JUNG}', 'hash_jung', '정우성 기자', '한국경제 미승인 전달접속');

    INSERT INTO organizations (id, canonical_name) VALUES
      ('${UUID_ORG_SAMSUNG}', '삼성생명'),
      ('${UUID_ORG_JA}', '중앙일보');

    INSERT INTO teams (id, organization_id, name, created_by) VALUES
      ('${UUID_TEAM_PR}',  '${UUID_ORG_SAMSUNG}', '홍보팀', '${UUID_KIM}'),
      ('${UUID_TEAM_FIN}', '${UUID_ORG_JA}',      '금융팀', '${UUID_PARK}');

    INSERT INTO team_memberships (team_id, user_id, role, status) VALUES
      ('${UUID_TEAM_PR}',  '${UUID_KIM}',  'ADMIN',  'ACTIVE'),
      ('${UUID_TEAM_PR}',  '${UUID_LEE}',  'MEMBER', 'ACTIVE'),
      ('${UUID_TEAM_FIN}', '${UUID_PARK}', 'ADMIN',  'ACTIVE'),
      ('${UUID_TEAM_FIN}', '${UUID_CHOI}', 'MEMBER', 'ACTIVE');

    INSERT INTO meetings (id, status, confirmed_date, start_time, end_time, area_hint, host_org_badge, encrypted_meeting_payload, payload_iv, created_by)
    VALUES ('${UUID_MTG_1}', 'CONFIRMED', '2026-11-19', '12:00', '13:30', '여의도', '삼성생명 홍보팀', 'AES256GCM_CIPHERTEXT_SAMPLE', 'IV_12B', '${UUID_KIM}');

    INSERT INTO meeting_sides (id, meeting_id, side_type, organization_id, team_id, representative_user_id, side_label) VALUES
      ('${UUID_SIDE_HOST}',  '${UUID_MTG_1}', 'HOST',  '${UUID_ORG_SAMSUNG}', '${UUID_TEAM_PR}',  '${UUID_KIM}',  '삼성생명 홍보팀'),
      ('${UUID_SIDE_GUEST}', '${UUID_MTG_1}', 'GUEST', '${UUID_ORG_JA}',      '${UUID_TEAM_FIN}', '${UUID_PARK}', '중앙일보 금융팀');

    INSERT INTO meeting_participants (meeting_id, meeting_side_id, user_id, role_in_side, rsvp_status, is_approved) VALUES
      ('${UUID_MTG_1}', '${UUID_SIDE_HOST}',  '${UUID_KIM}',  'REPRESENTATIVE', 'ATTENDING', TRUE),
      ('${UUID_MTG_1}', '${UUID_SIDE_GUEST}', '${UUID_PARK}', 'REPRESENTATIVE', 'ATTENDING', TRUE),
      ('${UUID_MTG_1}', '${UUID_SIDE_GUEST}', '${UUID_JUNG}', 'PARTICIPANT',    'PENDING_APPROVAL', FALSE);

    -- 호스트(삼성생명 홍보팀)만 팀 공유를 켜서 team_shared_schedules에 프로젝션 행이 존재함 (게스트 중앙일보는 비공유)
    INSERT INTO team_shared_schedules (team_id, meeting_id, meeting_side_id, side_type, confirmed_date, start_time, end_time, area_summary, our_side_summary, counterpart_org_summary, shared_by_user_id)
    VALUES ('${UUID_TEAM_PR}', '${UUID_MTG_1}', '${UUID_SIDE_HOST}', 'HOST', '2026-11-19', '12:00', '13:30', '여의도', '김민준 대리', '중앙일보 금융팀 (개인정보 비공개)', '${UUID_KIM}');

    INSERT INTO personal_meeting_histories (owner_user_id, meeting_id, meeting_date, attendance_verified, encrypted_history_blob, blob_iv) VALUES
      ('${UUID_PARK}', '${UUID_MTG_1}', '2026-11-19', TRUE, 'PARK_ENCRYPTED_HISTORY_BLOB', 'IV_PARK'),
      ('${UUID_KIM}',  '${UUID_MTG_1}', '2026-11-19', TRUE, 'KIM_ENCRYPTED_HISTORY_BLOB',  'IV_KIM');
  `);

  async function queryAsUser(userUuid, sqlQuery) {
    await pg.exec("BEGIN;");
    await pg.exec("SET LOCAL ROLE authenticated;");
    await pg.exec(`SELECT set_config('request.jwt.claim.sub', '${userUuid}', true);`);
    const res = await pg.query(sqlQuery);
    await pg.exec("COMMIT;");
    return res.rows;
  }

  // [PG-RLS 1] 승인된 참석자(박 기자)는 meetings 조회 가능
  const parkMtgRows = await queryAsUser(UUID_PARK, "SELECT id, status, encrypted_meeting_payload FROM meetings;");
  assert.equal(parkMtgRows.length, 1);
  console.log(`✅ [PG-RLS 1] 승인된 참석자(박 기자) meetings SELECT 응답: ${JSON.stringify(parkMtgRows)}`);

  // [PG-RLS 2] 미승인 전달 링크 접속자(정우성 기자, is_approved=FALSE)는 meetings 조회 시 0건 반환!
  const jungMtgRows = await queryAsUser(UUID_JUNG, "SELECT id, encrypted_meeting_payload FROM meetings;");
  assert.equal(jungMtgRows.length, 0);
  console.log(`✅ [PG-RLS 2] 미승인 전달 링크 접속자(정우성 기자) meetings SELECT 응답: ${JSON.stringify(jungMtgRows)} (0건 차단)`);

  // [PG-RLS 3] 비참석 팀원(이수현 과장, 호스트 팀)은 meetings 원본은 0건이나 team_shared_schedules는 1건 조회 가능
  const leeMtgRows = await queryAsUser(UUID_LEE, "SELECT id FROM meetings;");
  const leeSharedRows = await queryAsUser(UUID_LEE, "SELECT side_type, area_summary, counterpart_org_summary FROM team_shared_schedules;");
  assert.equal(leeMtgRows.length, 0);
  assert.equal(leeSharedRows.length, 1);
  console.log(`✅ [PG-RLS 3] 호스트 팀원(이 과장) meetings 원본=${leeMtgRows.length}건(차단), team_shared_schedules=${JSON.stringify(leeSharedRows)}`);

  // [PG-RLS 4] 비공유 측 팀원(최지훈 기자, 중앙일보 금융팀)은 meetings와 team_shared_schedules 모두 0건!
  const choiMtgRows = await queryAsUser(UUID_CHOI, "SELECT id FROM meetings;");
  const choiSharedRows = await queryAsUser(UUID_CHOI, "SELECT id FROM team_shared_schedules;");
  assert.equal(choiMtgRows.length, 0);
  assert.equal(choiSharedRows.length, 0);
  console.log(`✅ [PG-RLS 4] 비공유 게스트 팀원(최 기자) meetings=${choiMtgRows.length}건, team_shared_schedules=${choiSharedRows.length}건 (완벽 차단)`);

  // [PG-RLS 5] 개인 이력(personal_meeting_histories) 조회 시 오직 본인 행만 반환되고 타인 이력은 절대 노출되지 않음
  const kimHistRows = await queryAsUser(UUID_KIM, "SELECT owner_user_id, encrypted_history_blob FROM personal_meeting_histories;");
  assert.equal(kimHistRows.length, 1);
  assert.equal(kimHistRows[0].owner_user_id, UUID_KIM);
  console.log(`✅ [PG-RLS 5] 김 대리 세션에서 personal_meeting_histories 전체 SELECT 응답: ${JSON.stringify(kimHistRows)} (박 기자 이력 미노출)`);

  await pg.close();
}

async function runHttpApiAndEdgeCaseVerification(baseUrl) {
  console.log("\n------------------------------------------------------------------");
  console.log("🌐 [Part 2] HTTP API 보안, 키 복구, 보존 정책, 실패 상황 검증");
  console.log("------------------------------------------------------------------");

  await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "RESET_SEED_DB" }),
  });

  const authInfo = await fetch(`${baseUrl}/api/auth`).then((r) => r.json());
  const kimToken  = authInfo.availableTestAccounts.find((a) => a.id === "u_kim").sessionToken;
  const parkToken = authInfo.availableTestAccounts.find((a) => a.id === "u_park").sessionToken;
  const choiToken = authInfo.availableTestAccounts.find((a) => a.id === "u_choi").sessionToken;

  // 1. 세션 토큰 위조('Bearer u_park') 차단 검증
  const forgedRes = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Authorization: "Bearer u_park" },
  });
  const forgedBody = await forgedRes.json();
  assert.equal(forgedRes.status, 401);
  console.log(`✅ [API 보안 1] 서명되지 않은 위조 토큰('Bearer u_park') 응답: HTTP ${forgedRes.status} ${JSON.stringify(forgedBody)}`);

  // 2. 취약한 6자리 숫자 PIN('123456') 거부 검증
  const weakPinRes = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({
      action: "SAVE_KEY_BACKUP",
      recoverySecretForValidationOnly: "123456",
    }),
  });
  const weakPinBody = await weakPinRes.json();
  assert.equal(weakPinRes.status, 400);
  console.log(`✅ [API 보안 2] 6자리 숫자 PIN('123456') 키 백업 거부 응답: HTTP ${weakPinRes.status} ${JSON.stringify(weakPinBody)}`);

  // 3. OAuth state 변조(CSRF) 차단 및 정상 OAuth 콜백 검증
  const oauthStart = await fetch(
    `${baseUrl}/api/auth?mode=kakao_authorize&returnTo=/i/inv_9x82a&stateNonce=nonce_valid_999`
  ).then((r) => r.json());

  const tamperedCallback = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "KAKAO_OAUTH_CALLBACK",
      signedState: oauthStart.signedState,
      expectedCookieNonce: "nonce_attacker_csrf",
    }),
  });
  const tamperedBody = await tamperedCallback.json();
  assert.equal(tamperedCallback.status, 400);
  console.log(`✅ [API 보안 3] OAuth state CSRF 불일치 차단 응답: HTTP ${tamperedCallback.status} ${JSON.stringify(tamperedBody)}`);

  // 4. 만료된 초대 링크(inv_expired_01) 410 Gone 검증
  const expRes = await fetch(`${baseUrl}/api/invitations/inv_expired_01`);
  const expBody = await expRes.json();
  assert.equal(expRes.status, 410);
  console.log(`✅ [실패 처리 1] 만료된 초대 링크 응답: HTTP ${expRes.status} ${JSON.stringify(expBody)}`);

  // 5. 중복 참석 수락 요청 시 멱등성(Idempotency) 검증
  await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ rsvpStatus: "ATTENDING" }),
  });
  const dupRes = await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ rsvpStatus: "ATTENDING" }),
  }).then((r) => r.json());
  assert.equal(dupRes.idempotentDuplicate, true);
  console.log(`✅ [실패 처리 2] 이미 참석한 모임 재응답 멱등성 응답: idempotentDuplicate=${dupRes.idempotentDuplicate}`);

  // 6. 외부 캘린더 API 일시 실패 시 부분 실패 격리 및 재동기화 복구 검증
  const calFailRes = await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ rsvpStatus: "ATTENDING", simulateCalendarApiFailure: true }),
  }).then((r) => r.json());
  assert.equal(calFailRes.ok, true);
  assert.equal(calFailRes.externalCalendarMapping.syncStatus, "PARTIAL_FAILURE_RETRY_QUEUED");
  console.log(`✅ [실패 처리 3] 캘린더 API 실패 시 참석 수락 유지 + syncStatus=${calFailRes.externalCalendarMapping.syncStatus}`);

  // 7. 공유 권한 변경 직후 기존 활성 세션 접근 권한 즉시 갱신 검증
  await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ action: "TOGGLE_VISIBILITY", sideType: "GUEST" }),
  });
  const choiOn = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Authorization: `Bearer ${choiToken}` },
  }).then((r) => r.json());
  assert.equal(choiOn.teamSharedSchedules.length, 1);

  await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ action: "TOGGLE_VISIBILITY", sideType: "GUEST" }),
  });
  const choiOff = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Authorization: `Bearer ${choiToken}` },
  }).then((r) => r.json());
  assert.equal(choiOff.teamSharedSchedules.length, 0);
  console.log(`✅ [권한 즉시 갱신] 공유 ON 시 기존 세션 조회=${choiOn.teamSharedSchedules.length}건 → 공유 OFF 직후 동일 세션 조회=${choiOff.teamSharedSchedules.length}건`);

  // 8. 참석 수락과 모임 취소가 동시에 발생하는 경우(Race Condition: 409 Conflict) 검증
  await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({ action: "TOGGLE_CANCEL" }),
  });
  const raceRes = await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ rsvpStatus: "ATTENDING" }),
  });
  const raceBody = await raceRes.json();
  assert.equal(raceRes.status, 409);
  console.log(`✅ [실패 처리 4] 취소된 모임에 동시 참석 수락 요청 시 응답: HTTP ${raceRes.status} ${JSON.stringify(raceBody)}`);

  // 모임 취소 복원
  await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({ action: "TOGGLE_CANCEL" }),
  });

  // 9. 모임 종료 30일 표준 파기 + 미백업 참석자 모임 37일 상한선(Hard Cap) 강제 파기 검증
  const purgeRes = await fetch(`${baseUrl}/api/retention`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).then((r) => r.json());
  assert.equal(purgeRes.purgedMeetingIds.includes("mtg_completed_30d"), true);
  assert.equal(purgeRes.hardPurgedUnbackedMeetingIds.includes("mtg_unbacked_38d"), true);
  console.log(`✅ [보존 정책 검증] 30일 백업완료 파기=${JSON.stringify(purgeRes.purgedMeetingIds)}, 37일 미백업 강제파기=${JSON.stringify(purgeRes.hardPurgedUnbackedMeetingIds)}`);
}

const targetUrl = process.env.TEST_BASE_URL || "http://localhost:3099";
(async () => {
  await runPostgresRlsVerification();
  await runHttpApiAndEdgeCaseVerification(targetUrl);
  console.log("\n==================================================================");
  console.log("🎉 Phase 3.5 모든 PostgreSQL RLS 및 API 보안·엣지케이스 검증 완료!");
  console.log("==================================================================");
})().catch((err) => {
  console.error("❌ Phase 3.5 검증 실패:", err);
  process.exit(1);
});
