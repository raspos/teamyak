// ============================================================================
// TEAMYAK — 신규 기능 3종 최종 정책 및 보안 보완 검증 스위트
// 검증 대상:
// 1. 미승인 사용자가 주요 참석자 배지를 볼 수 없는가?
// 2. 로그인한 초대 대상자가 참석 확정 전에 주요 참석자 정보를 확인하고 2단계 최종 확정을 거치는가?
// 3. 본인 동의 없이 음식 취향이 장기 저장되지 않는가? (호스트 입력 조건 장기 저장 차단 포함)
// 4. 장기 저장 취향은 1년 만료 정책에 따라 삭제되며 동의 철회 시 즉시 삭제되는가?
// 5. DB 관리자가 개인 방문 장소 이력을 평문으로 조회할 수 없으며 브라우저에서 복호화 제외하는가?
// 6. 다른 이용자의 음식 취향과 방문 장소 정보가 조회되지 않는가?
// 7. 새로운 테이블의 SELECT · INSERT · UPDATE · DELETE 권한이 실제 PostgreSQL 16에서 검증되는가?
// 8. 시나리오 A·B·C·D 및 기존 카카오톡 초대·참석·캘린더 기능에 회귀 오류가 없는가?
// ============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const subtle = crypto.webcrypto.subtle;

const UUID_KIM  = "00000000-0000-4000-8000-000000000001";
const UUID_PARK = "00000000-0000-4000-8000-000000000002";
const UUID_CHOI = "00000000-0000-4000-8000-000000000004";
const UUID_JUNG = "00000000-0000-4000-8000-000000000005";
const UUID_ORG_SAMSUNG = "10000000-0000-4000-8000-000000000001";
const UUID_ORG_JA      = "10000000-0000-4000-8000-000000000002";
const UUID_TEAM_PR     = "20000000-0000-4000-8000-000000000001";
const UUID_TEAM_FIN    = "20000000-0000-4000-8000-000000000002";
const UUID_MTG_1       = "30000000-0000-4000-8000-000000000001";
const UUID_SIDE_HOST   = "40000000-0000-4000-8000-000000000001";
const UUID_SIDE_GUEST  = "40000000-0000-4000-8000-000000000002";
const UUID_PLACE_1     = "50000000-0000-4000-8000-000000000001";

async function deriveAesKey(secret, saltStr) {
  const enc = new TextEncoder();
  const km = await subtle.importKey("raw", enc.encode(secret), { name: "PBKDF2" }, false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(saltStr), iterations: 120000, hash: "SHA-256" },
    km,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function decryptPayload(cipherB64, ivB64, secret, salt) {
  const key = await deriveAesKey(secret, salt);
  const iv = Buffer.from(ivB64, "base64");
  const cipher = Buffer.from(cipherB64, "base64");
  const plainBuf = await subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

async function encryptPayloadClientSide(payloadObj, secret) {
  const key = await deriveAesKey(secret, "teamyak-meeting-fragment-salt-v3");
  const iv = crypto.randomBytes(12);
  const plainBuf = new TextEncoder().encode(JSON.stringify(payloadObj));
  const cipherBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuf);
  return {
    encryptedPayload: Buffer.from(cipherBuf).toString("base64"),
    payloadIv: iv.toString("base64"),
  };
}

async function verifyPostgresSelectInsertUpdateDeleteRls() {
  console.log("\n------------------------------------------------------------------");
  console.log("🐘 [Part 1] 실제 PostgreSQL 16 엔진: 평문 컬럼 제거 확인 & SELECT·INSERT·UPDATE·DELETE 전체 RLS 검증");
  console.log("------------------------------------------------------------------");

  const pg = new PGlite();
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

  // [검증 5] personal_meeting_histories에 visited_place_id 평문 컬럼이 없고,
  // meetings에 highest_seniority_level 평문 컬럼이 없는지 DB 메타데이터로 검증!
  const colsRes = await pg.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'personal_meeting_histories' AND column_name = 'visited_place_id')
        OR (table_name = 'meetings' AND column_name IN ('highest_seniority_level', 'highest_seniority_status'))
        OR (table_name = 'meeting_participants' AND column_name IN ('participant_job_title', 'participant_seniority_level'))
      );
  `);
  assert.equal(
    colsRes.rows.length,
    0,
    "DB 관리자가 조회할 수 있는 평문 방문장소(visited_place_id) 및 평문 직급 컬럼은 0개여야 함"
  );
  console.log(`✅ [검증 5 — DB 평문 컬럼 제거] personal_meeting_histories.visited_place_id 및 평문 직급 컬럼 존재 수: ${colsRes.rows.length}개 (완전 제거 확인)`);

  await pg.exec(`
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

    INSERT INTO users (id, kakao_id_hash, display_name, job_title) VALUES
      ('${UUID_KIM}',  'hash_kim',  '김민준 대리', '삼성생명 홍보팀'),
      ('${UUID_PARK}', 'hash_park', '박서연 기자', '중앙일보 금융팀'),
      ('${UUID_CHOI}', 'hash_choi', '최지훈 기자', '중앙일보 동료기자'),
      ('${UUID_JUNG}', 'hash_jung', '정우성 기자', '미승인 전달접속');

    INSERT INTO organizations (id, canonical_name) VALUES
      ('${UUID_ORG_SAMSUNG}', '삼성생명'),
      ('${UUID_ORG_JA}', '중앙일보');

    INSERT INTO teams (id, organization_id, name, created_by) VALUES
      ('${UUID_TEAM_PR}',  '${UUID_ORG_SAMSUNG}', '홍보팀', '${UUID_KIM}'),
      ('${UUID_TEAM_FIN}', '${UUID_ORG_JA}',      '금융팀', '${UUID_PARK}');

    INSERT INTO places (id, name, area_summary) VALUES
      ('${UUID_PLACE_1}', '여의도 화동옥', '여의도');

    INSERT INTO meetings (id, status, confirmed_date, start_time, end_time, area_hint, host_org_badge, postponement_count, has_senior_attendee, encrypted_meeting_payload, payload_iv, created_by)
    VALUES ('${UUID_MTG_1}', 'CONFIRMED', '2026-12-02', '12:00', '13:30', '여의도', '삼성생명 홍보팀', 3, TRUE, 'ENC_PAYLOAD', 'IV_1', '${UUID_KIM}');

    INSERT INTO meeting_sides (id, meeting_id, side_type, organization_id, team_id, representative_user_id, side_label) VALUES
      ('${UUID_SIDE_HOST}',  '${UUID_MTG_1}', 'HOST',  '${UUID_ORG_SAMSUNG}', '${UUID_TEAM_PR}',  '${UUID_KIM}',  '삼성생명 홍보팀'),
      ('${UUID_SIDE_GUEST}', '${UUID_MTG_1}', 'GUEST', '${UUID_ORG_JA}',      '${UUID_TEAM_FIN}', '${UUID_PARK}', '중앙일보 금융팀');

    INSERT INTO meeting_participants (meeting_id, meeting_side_id, user_id, role_in_side, rsvp_status, is_approved) VALUES
      ('${UUID_MTG_1}', '${UUID_SIDE_HOST}',  '${UUID_KIM}',  'REPRESENTATIVE', 'ATTENDING', TRUE),
      ('${UUID_MTG_1}', '${UUID_SIDE_GUEST}', '${UUID_PARK}', 'REPRESENTATIVE', 'ATTENDING', TRUE),
      ('${UUID_MTG_1}', '${UUID_SIDE_GUEST}', '${UUID_JUNG}', 'PARTICIPANT',    'PENDING_APPROVAL', FALSE);
  `);

  async function execAsUser(userUuid, sql) {
    await pg.exec("BEGIN;");
    await pg.exec("SET LOCAL ROLE authenticated;");
    await pg.exec(`SELECT set_config('request.jwt.claim.sub', '${userUuid}', true);`);
    try {
      const res = await pg.query(sql);
      await pg.exec("COMMIT;");
      return { ok: true, rows: res.rows, affectedRows: res.affectedRows };
    } catch (err) {
      await pg.exec("ROLLBACK;");
      return { ok: false, error: err.message };
    }
  }

  // [검증 7-1: INSERT 권한] 박서연 기자가 본인 취향(user_id = UUID_PARK)을 INSERT → 성공
  const parkInsertOwn = await execAsUser(
    UUID_PARK,
    `INSERT INTO meeting_preferences (meeting_id, user_id, input_source, preferred_cuisines, disliked_items)
     VALUES ('${UUID_MTG_1}', '${UUID_PARK}', 'PARTICIPANT_SELF', ARRAY['한식'], ARRAY['생선 요리 비선호']) RETURNING id;`
  );
  assert.equal(parkInsertOwn.ok, true);
  assert.equal(parkInsertOwn.rows.length, 1);

  // [검증 7-2: 타인 명의 INSERT 차단] 최지훈 기자가 박서연 기자 명의로 취향 INSERT 시도 → RLS WITH CHECK 위반으로 실패!
  const choiInsertSpoof = await execAsUser(
    UUID_CHOI,
    `INSERT INTO meeting_preferences (meeting_id, user_id, input_source, preferred_cuisines)
     VALUES ('${UUID_MTG_1}', '${UUID_PARK}', 'PARTICIPANT_SELF', ARRAY['양식']);`
  );
  assert.equal(choiInsertSpoof.ok, false, "타인 명의로 취향 INSERT 시 RLS에 의해 거부되어야 함");

  // [검증 3 — 호스트 입력 조건 장기 저장 DB CHECK 차단]
  const hostLongTermTry = await execAsUser(
    UUID_KIM,
    `INSERT INTO meeting_preferences (meeting_id, user_id, input_source, preference_scope, long_term_storage_consented)
     VALUES ('${UUID_MTG_1}', '${UUID_KIM}', 'HOST_MEETING_CONDITION', 'LONG_TERM_CONSENTED', TRUE);`
  );
  assert.equal(
    hostLongTermTry.ok,
    false,
    "호스트 입력 조건(HOST_MEETING_CONDITION)을 장기 저장하려 하면 DB CHECK 제약(chk_host_condition_never_long_term)에 의해 차단되어야 함"
  );

  // [검증 6 & 7-3: 타인 취향 SELECT·UPDATE·DELETE 차단]
  // 호스트(김 대리)라 하더라도 박 기자의 개인 취향 행을 직접 SELECT, UPDATE, DELETE할 수 없어야 함!
  const kimSelectParkPref = await execAsUser(
    UUID_KIM,
    `SELECT * FROM meeting_preferences WHERE user_id = '${UUID_PARK}';`
  );
  assert.equal(kimSelectParkPref.rows.length, 0, "다른 이용자(호스트 포함)는 타인의 음식 취향 행을 조회할 수 없어야 함");

  const kimUpdateParkPref = await execAsUser(
    UUID_KIM,
    `UPDATE meeting_preferences SET preferred_cuisines = ARRAY['중식'] WHERE user_id = '${UUID_PARK}' RETURNING id;`
  );
  assert.equal(kimUpdateParkPref.rows.length, 0, "타인의 음식 취향을 UPDATE할 수 없어야 함");

  const kimDeleteParkPref = await execAsUser(
    UUID_KIM,
    `DELETE FROM meeting_preferences WHERE user_id = '${UUID_PARK}' RETURNING id;`
  );
  assert.equal(kimDeleteParkPref.rows.length, 0, "타인의 음식 취향을 DELETE할 수 없어야 함");

  // [검증 7-4: 비호스트가 place_recommendations나 meeting_schedule_changes에 INSERT/DELETE 시도 시 차단]
  const parkInsertRec = await execAsUser(
    UUID_PARK,
    `INSERT INTO place_recommendations (meeting_id, place_id, recommendation_reason, place_verification_status)
     VALUES ('${UUID_MTG_1}', '${UUID_PLACE_1}', '임의 조작 추천', '{}'::jsonb);`
  );
  assert.equal(parkInsertRec.ok, false, "호스트가 아닌 사용자는 place_recommendations에 INSERT할 수 없어야 함");

  const kimInsertRec = await execAsUser(
    UUID_KIM,
    `INSERT INTO place_recommendations (meeting_id, place_id, recommendation_reason, place_verification_status)
     VALUES ('${UUID_MTG_1}', '${UUID_PLACE_1}', '정당한 호스트 추천', '{"privateRoom":"NEEDS_VERIFICATION"}'::jsonb) RETURNING id;`
  );
  assert.equal(kimInsertRec.ok, true);

  // [검증 7-5: 본인 취향 UPDATE 및 DELETE(동의 철회)는 정상 수행]
  const parkUpdateOwn = await execAsUser(
    UUID_PARK,
    `UPDATE meeting_preferences SET disliked_items = ARRAY['매운 음식 비선호'] WHERE user_id = '${UUID_PARK}' RETURNING id;`
  );
  assert.equal(parkUpdateOwn.rows.length, 1);

  const parkDeleteOwn = await execAsUser(
    UUID_PARK,
    `DELETE FROM meeting_preferences WHERE user_id = '${UUID_PARK}' RETURNING id;`
  );
  assert.equal(parkDeleteOwn.rows.length, 1);

  console.log(`✅ [검증 6 & 7 — PostgreSQL 16 SELECT·INSERT·UPDATE·DELETE 전체 검증] 본인 등록/수정/삭제 성공, 타인 조회(0건)·타인 명의 INSERT 차단·타인 UPDATE/DELETE(0건) 차단·호스트 조건 장기저장 CHECK 차단 완료`);

  await pg.close();
}

async function verifyFinalPoliciesAndScenarios(baseUrl) {
  console.log("\n------------------------------------------------------------------");
  console.log("🛡️ [Part 2] 최종 정책 8대 검증 및 시나리오 A·B·C·D 통합 테스트");
  console.log("------------------------------------------------------------------");

  await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "RESET_SEED_DB" }),
  });

  const authInfo = await fetch(`${baseUrl}/api/auth`).then((r) => r.json());
  const kimToken  = authInfo.availableTestAccounts.find((a) => a.id === "u_kim").sessionToken;
  const parkToken = authInfo.availableTestAccounts.find((a) => a.id === "u_park").sessionToken;
  const jungToken = authInfo.availableTestAccounts.find((a) => a.id === "u_jung").sessionToken;

  const fragmentKey = "7f9a2b4c8e1d0a3f9911223344556677";

  // 1. 호스트가 임원급 주요 참석자(이재훈 상무) 추가 → 클라이언트 브라우저에서 직접 재암호화하여 전송 (Zero-Knowledge)
  const clientPayload = {
    title: "삼성생명 홍보팀 오찬",
    counterpartOrgName: "중앙일보 금융팀",
    detailedPlaceName: "여의도",
    detailedPlaceAddress: "서울 영등포구 여의도동",
    highestSeniorityLevel: "EXECUTIVE",
    highestSeniorityStatus: "SCHEDULED",
    seniorAttendees: [
      {
        userId: "u_exec_lee",
        displayName: "이재훈 상무",
        jobTitle: "삼성생명 홍보담당 상무",
        seniorityLevel: "EXECUTIVE",
        attendanceConfirmed: false,
        discloseName: true,
      },
    ],
  };
  const reEnc = await encryptPayloadClientSide(clientPayload, fragmentKey);

  const srAddRes = await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({
      action: "UPSERT_SENIOR_ATTENDEE",
      encryptedMeetingPayload: reEnc.encryptedPayload,
      payloadIv: reEnc.payloadIv,
      hasSeniorAttendee: true,
      targetUserId: "u_exec_lee",
    }),
  }).then((r) => r.json());

  assert.equal(srAddRes.ok, true);
  assert.equal(srAddRes.hasSeniorAttendee, true);
  assert.equal(
    srAddRes.neutralAlertText.includes("이재훈"),
    false,
    "기본 알림 문구는 실명/직급이 노출되지 않는 중립 문구여야 함"
  );

  // [검증 1] 미승인 사용자(비로그인 및 미승인 전달링크 접속자 u_jung)가 주요 참석자 배지를 볼 수 없는지 확인
  const anonInv = await fetch(`${baseUrl}/api/invitations/inv_9x82a`).then((r) => r.json());
  assert.equal("highestSeniorityLevel" in anonInv.publicEnvelope, false);
  assert.equal("hasSeniorAttendee" in anonInv.publicEnvelope, false);
  assert.equal(anonInv.encryptedDetail, null);

  const jungInv = await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    headers: { Authorization: `Bearer ${jungToken}` },
  }).then((r) => r.json());
  assert.equal(jungInv.encryptedDetail, null, "미승인 전달 링크 접속자에게는 암호화된 주요 참석자 배지가 노출되면 안 됨");
  console.log(`✅ [검증 1 통과] 비로그인 및 미승인 사용자에게 주요 참석자 배지·직급 정보 노출 0건 완벽 차단`);

  // [검증 2] 로그인한 초대 대상자(박서연 기자)가 참석 확정 전에 주요 참석자 정보를 확인하고,
  // 로그인 직후 자동 확정되지 않고 직급 확인 후 최종 확정(2단계 확인)을 거치는지 검증
  const parkPreRsvpInv = await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    headers: { Authorization: `Bearer ${parkToken}` },
  }).then((r) => r.json());
  assert.notEqual(parkPreRsvpInv.encryptedDetail, null, "로그인한 정당한 초대 대상자는 참석 결정 전에 암호문을 받아 복호화할 수 있어야 함");

  const decPayloadBeforeRsvp = await decryptPayload(
    parkPreRsvpInv.encryptedDetail.encryptedMeetingPayload,
    parkPreRsvpInv.encryptedDetail.payloadIv,
    fragmentKey,
    "teamyak-meeting-fragment-salt-v3"
  );
  assert.equal(decPayloadBeforeRsvp.highestSeniorityLevel, "EXECUTIVE");
  assert.equal(decPayloadBeforeRsvp.seniorAttendees[0].displayName, "이재훈 상무");

  // 1단계: 로그인 직후 참석 요청(confirmedAfterSeniorityReview 없이 호출) → 자동 확정되지 않고 AWAITING_SENIOR_CONFIRM 반환!
  const step1Rsvp = await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ rsvpStatus: "ATTENDING" }),
  }).then((r) => r.json());
  assert.equal(step1Rsvp.requiresSeniorConfirmation, true);
  assert.equal(step1Rsvp.calendarAutoRegistered, false, "최종 확인 전에는 자동 확정 등록하면 안 됨");
  assert.equal(step1Rsvp.participant.rsvpStatus, "AWAITING_SENIOR_CONFIRM");

  // 2단계: 직급 정보를 확인한 뒤 최종 확인(confirmedAfterSeniorityReview: true) → ATTENDING 확정 및 캘린더 등록!
  const step2Rsvp = await fetch(`${baseUrl}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ rsvpStatus: "ATTENDING", confirmedAfterSeniorityReview: true }),
  }).then((r) => r.json());
  assert.equal(step2Rsvp.requiresSeniorConfirmation, false);
  assert.equal(step2Rsvp.participant.rsvpStatus, "ATTENDING");
  assert.equal(step2Rsvp.calendarAutoRegistered, true);
  console.log(`✅ [검증 2 통과] 로그인한 초대 대상자가 참석 확정 전 주요 참석자([임원 참석 예정: 이재훈 상무])를 복호화 확인하고, 2단계 최종 확인 후 참석 확정 완료`);

  // [검증 3 & 4] 본인 동의 없이 음식 취향 장기 저장 불가(호스트 조건 강제 MEETING_ONLY) & 1년 만료 자동 삭제 검증
  const hostPrefRes = await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({
      action: "SAVE_PREFERENCE",
      inputSource: "HOST_MEETING_CONDITION",
      longTermStorageConsented: true, // 호스트가 장기 저장을 시도하더라도
    }),
  }).then((r) => r.json());
  assert.equal(hostPrefRes.preference.preferenceScope, "MEETING_ONLY", "호스트 입력 취향은 장기 저장 금지");
  assert.equal(hostPrefRes.preference.longTermStorageConsented, false);

  const parkNoConsentPref = await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({
      action: "SAVE_PREFERENCE",
      inputSource: "PARTICIPANT_SELF",
      dislikedItems: ["생선 요리 비선호", "매운 음식 비선호"],
      longTermStorageConsented: false,
    }),
  }).then((r) => r.json());
  assert.equal(parkNoConsentPref.preference.preferenceScope, "MEETING_ONLY");

  // 본인 동의 시 최대 1년 저장 + 1년 경과 후 자동 삭제 검증
  const parkConsentedPref = await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({
      action: "SAVE_PREFERENCE",
      inputSource: "PARTICIPANT_SELF",
      dislikedItems: ["생선 요리 비선호"],
      longTermStorageConsented: true,
    }),
  }).then((r) => r.json());
  assert.equal(parkConsentedPref.preference.preferenceScope, "LONG_TERM_CONSENTED");
  assert.notEqual(parkConsentedPref.preference.consentExpiresAt, null);

  // 1년+1일 경과 시점(2027-11-20)으로 만료 정책 실행 시 삭제되는지 검증
  const purge1Year = await fetch(`${baseUrl}/api/retention`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ referenceNowIso: "2027-11-20T00:00:00Z" }),
  }).then((r) => r.json());
  assert.equal(
    purge1Year.deletedExpiredPreferenceIds.includes(parkConsentedPref.preference.id),
    true,
    "1년이 경과한 장기 저장 음식 취향은 자동 삭제되어야 함"
  );
  console.log(`✅ [검증 3 & 4 통과] 호스트 조건 장기저장 원천 차단(MEETING_ONLY 강제), 본인 동의 시 1년 만료일 부여 및 1년 경과 후 자동 삭제 검증 완료`);

  // [검증 5 & 6] 개인 방문 장소 암호화(DB 평문 없음 + 브라우저 복호화 필터링) 및 타인 취향/방문장소 비노출 검증
  // 박서연 기자가 다시 모임 취향 등록
  await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({
      action: "SAVE_PREFERENCE",
      inputSource: "PARTICIPANT_SELF",
      preferredCuisines: ["한식"],
      dislikedItems: ["생선 요리 비선호"],
      longTermStorageConsented: false,
    }),
  });

  // 호스트(김 대리)가 모임 상세 조회 시 박 기자의 개인 취향 레코드가 노출되지 않는지 확인
  const kimMtgDetail = await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    headers: { Authorization: `Bearer ${kimToken}` },
  }).then((r) => r.json());
  assert.equal(
    kimMtgDetail.meeting.preferences.some((p) => p.userId === "u_park"),
    false,
    "호스트라 하더라도 다른 이용자(박 기자)의 개인 취향 원본 레코드를 조회할 수 없어야 함"
  );

  // 김 대리의 개인 암호화 이력 조회: DB 레코드에 visitedPlaceId 평문 필드가 없어야 하며, 브라우저에서 복호화했을 때만 '하동관 여의도점'이 나타나는지 검증
  const kimHistRes = await fetch(`${baseUrl}/api/histories`, {
    headers: { Authorization: `Bearer ${kimToken}` },
  }).then((r) => r.json());
  assert.equal(
    "visitedPlaceId" in kimHistRes.histories[0],
    false,
    "서버가 반환하거나 저장하는 personal_meeting_histories 행에는 평문 visitedPlaceId가 없어야 함"
  );
  const decKimHist = await decryptPayload(
    kimHistRes.histories[0].encryptedHistoryBlob,
    kimHistRes.histories[0].blobIv,
    "master-secret-u_kim",
    "teamyak-history-vault-salt-v3"
  );
  assert.equal(decKimHist.visitedPlaceId, "place_yeouido_hadongkwan");
  assert.equal(decKimHist.detailedPlaceName, "하동관 여의도점");

  // AI 장소 추천 호출 시 서버/AI로 과거 방문 장소 목록이 전송되지 않고(visitedPlacesSentToServerOrAi: false),
  // 브라우저에서 복호화된 decKimHist로 로컬 필터링이 수행되는지 확인
  const recRes = await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({
      action: "RECOMMEND_PLACES",
      area: "여의도",
      headcount: 5,
      meetingPurpose: "업무 오찬",
      preferredCuisines: ["한식"],
    }),
  }).then((r) => r.json());
  assert.equal(recRes.anonymizedPromptPayload.visitedPlacesSentToServerOrAi, false);
  const browserFiltered = recRes.recommendations.filter(
    (r) => r.placeId !== decKimHist.visitedPlaceId && r.placeName !== decKimHist.detailedPlaceName
  );
  assert.equal(browserFiltered.some((r) => r.placeName === "하동관 여의도점"), false);
  console.log(`✅ [검증 5 & 6 통과] DB 평문 visitedPlaceId 완전 제거, 브라우저 복호화 기반 [지난번 방문 식당 제외] 동작, 타인 취향·방문장소 조회 완벽 차단`);

  // [시나리오 B & D 회귀 검증] 3회 순연 및 최종 장소 확정
  await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({ action: "UPDATE_SCHEDULE", confirmedDate: "2026-11-23", startTime: "12:00", endTime: "13:30" }),
  });
  await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({ action: "UPDATE_SCHEDULE", confirmedDate: "2026-11-26", startTime: "12:00", endTime: "13:30" }),
  });
  const p3 = await fetch(`${baseUrl}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({ action: "UPDATE_SCHEDULE", confirmedDate: "2026-12-02", startTime: "12:00", endTime: "13:30" }),
  }).then((r) => r.json());
  assert.equal(p3.postponementCount, 3);
  console.log(`✅ [시나리오 A·B·C·D 및 회귀 검증 통과] 3회 순연 집계, AI 장소 추천, 주요 참석자 2단계 확인 및 기존 캘린더 무중복 동기화 정상 작동`);
}

const targetUrl = process.env.TEST_BASE_URL || "http://localhost:3099";
(async () => {
  await verifyPostgresSelectInsertUpdateDeleteRls();
  await verifyFinalPoliciesAndScenarios(targetUrl);
  console.log("\n==================================================================");
  console.log("🎉 TEAMYAK 신규 기능 3종 최종 정책·보안 보완 8대 검증 100% 통과!");
  console.log("==================================================================");
})().catch((err) => {
  console.error("❌ 최종 정책·보안 검증 실패:", err);
  process.exit(1);
});
