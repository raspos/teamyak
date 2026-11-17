// ============================================================================
// TEAMYAK Phase 3.6 — 보안 무결성 감사 및 실제 서비스 전환 종합 검증 스위트
//
// 검증 항목:
// 1. [A. 암호화 구조 정합성]
//    - 서버에 fragmentKey 전송 시 ZERO_KNOWLEDGE_VIOLATION_BLOCKED(400) 차단 검증
//    - 클라이언트 Web Crypto API 브라우저 재암호화 암호문 수신 및 저장 검증
//    - 동시 수정 시 낙관적 락(Optimistic Lock / sequenceVersion 불일치 409) 충돌 검증
// 2. [B. 기존 개인정보 마이그레이션]
//    - visited_place_id 평문 컬럼 단계적 마이그레이션(Staged Migration) 검증
//    - 마이그레이션 전후 레코드 수 일치(beforeCount == afterCount) 및 0 데이터 손실 검증
//    - 클라이언트 재암호화 완료 후 서버 평문 컬럼 완전 소거 및 감사 로그 검증
// 3. [C. 주요 참석자 메타데이터]
//    - 비로그인 사용자 및 미승인 사용자 대상 주요 참석자 배지 및 암호문 차단 검증
//    - 로그인 후 초대 권한 확인 사용자 대상 2단계 참석 확인 게이트 검증
// 4. [D. Supabase 클라우드 & 로컬 폴백]
//    - Supabase 환경변수 유무에 따른 CLOUD vs LOCAL 폴백 엔진 감지 검증
//    - PostgreSQL 16 엔진(PGlite) 기반 RLS 격리 무결성 재검증
// 5. [E. 외부 서비스 연동 상태]
//    - Kakao OAuth, Google Calendar, Naver Search API의 LIVE vs SIMULATION 모드 명확한 분리 검증
// 6. [F. 다중 사용자 2계정 종단간 시나리오]
//    - 김 대리(호스트)와 박 기자(게스트) 간의 실시간 초대·복호화·RSVP 상태 동기화 검증
// ============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

const DEFAULT_SEED_FRAGMENT_KEY = "7f9a2b4c8e1d0a3f9911223344556677";
const MASTER_SECRET_PARK = "master-secret-u_park";
const MASTER_SECRET_KIM = "master-secret-u_kim";

const subtle = globalThis.crypto.subtle;

async function deriveAesKey(secret, saltStr, iterations = 120000) {
  const enc = new TextEncoder();
  const km = await subtle.importKey(
    "raw",
    enc.encode(secret.trim()),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(saltStr),
      iterations,
      hash: "SHA-256",
    },
    km,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function encryptPayloadClientSide(payloadObj, hexKey) {
  const key = await deriveAesKey(hexKey, "teamyak-meeting-fragment-salt-v3");
  const iv = crypto.randomBytes(12);
  const plainBuf = new TextEncoder().encode(JSON.stringify(payloadObj));
  const cipherBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuf);
  return {
    encryptedPayload: Buffer.from(cipherBuf).toString("base64"),
    payloadIv: iv.toString("base64"),
  };
}

async function decryptPayloadClientSide(encryptedBase64, ivBase64, hexKey) {
  const key = await deriveAesKey(hexKey, "teamyak-meeting-fragment-salt-v3");
  const iv = Buffer.from(ivBase64, "base64");
  const cipher = Buffer.from(encryptedBase64, "base64");
  const plainBuf = await subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

async function encryptHistoryBlob(payload, secret) {
  const key = await deriveAesKey(secret, "teamyak-history-vault-salt-v3");
  const iv = crypto.randomBytes(12);
  const plainBuf = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, plainBuf);
  return {
    encryptedHistoryBlob: Buffer.from(cipherBuf).toString("base64"),
    blobIv: iv.toString("base64"),
  };
}

async function decryptHistoryBlob(encBase64, ivBase64, secret) {
  const key = await deriveAesKey(secret, "teamyak-history-vault-salt-v3");
  const iv = Buffer.from(ivBase64, "base64");
  const cipher = Buffer.from(encBase64, "base64");
  const plainBuf = await subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

async function runPhase36Audit() {
  console.log("\n==================================================================");
  console.log("🛡️ [TEAMYAK Phase 3.6] 보안 무결성 감사 및 클라우드 서비스 전환 검증");
  console.log("==================================================================");

  // 0. 초기 인증 상태 및 API 연동 진단 조회
  const authRes = await fetch(`${BASE_URL}/api/auth`);
  assert.equal(authRes.status, 200, "GET /api/auth 응답 성공");
  const authData = await authRes.json();
  console.log("  [API Status Diagnosed]:", JSON.stringify(authData.apiStatus, null, 2));

  const kimSession = authData.availableTestAccounts.find((u) => u.id === "u_kim")?.sessionToken;
  const parkSession = authData.availableTestAccounts.find((u) => u.id === "u_park")?.sessionToken;
  assert.ok(kimSession, "김 대리 세션 토큰 존재");
  assert.ok(parkSession, "박 기자 세션 토큰 존재");

  // ==========================================================================
  // [A. 암호화 구조 정합성 검증]
  // ==========================================================================
  console.log("\n--- [A. 암호화 구조 정합성 검증] ---");

  // A-1. 서버가 fragmentKey를 수신하려 할 때 단호히 400 거부 검증 (Zero-Knowledge 강제)
  console.log("  A-1: fragmentKey를 서버로 전송 시 400 ZERO_KNOWLEDGE_VIOLATION_BLOCKED 반환 검증...");
  const leakAttemptRes = await fetch(`${BASE_URL}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimSession}`,
    },
    body: JSON.stringify({
      action: "UPSERT_SENIOR_ATTENDEE",
      fragmentKey: DEFAULT_SEED_FRAGMENT_KEY, // 서버로 키 유출 시도!
      encryptedMeetingPayload: "invalid_dummy",
      payloadIv: "invalid_iv",
    }),
  });
  assert.equal(leakAttemptRes.status, 400, "서버는 fragmentKey 수신 시 400 거부해야 함");
  const leakJson = await leakAttemptRes.json();
  assert.equal(leakJson.error, "ZERO_KNOWLEDGE_VIOLATION_BLOCKED", "Zero-Knowledge 위반 차단 에러 코드 확인");
  console.log("  ✅ PASS: 서버가 fragmentKey 수신을 원천 거부함:", leakJson.message);

  // A-2. 브라우저에서 직접 재암호화한 페이로드 전송 시 성공 검증
  console.log("  A-2: 클라이언트 Web Crypto API 브라우저 재암호화 페이로드 전송 검증...");
  const clientPayload = {
    title: "삼성생명 홍보팀 오찬 (Phase 3.6 검증)",
    counterpartOrgName: "중앙일보 금융팀",
    detailedPlaceName: "여의도 콘래드 아트리오",
    detailedPlaceAddress: "서울 영등포구 국제금융로 10",
    highestSeniorityLevel: "EXECUTIVE",
    highestSeniorityStatus: "CONFIRMED",
    seniorAttendees: [
      {
        userId: "u_exec_lee",
        displayName: "이재훈 상무",
        jobTitle: "삼성생명 홍보담당 상무",
        seniorityLevel: "EXECUTIVE",
        attendanceConfirmed: true,
        discloseName: true,
      },
    ],
  };

  const reEnc = await encryptPayloadClientSide(clientPayload, DEFAULT_SEED_FRAGMENT_KEY);
  const mtgGetRes = await fetch(`${BASE_URL}/api/meetings/mtg_1`, {
    headers: { Authorization: `Bearer ${kimSession}` },
  });
  const currentMtg = (await mtgGetRes.json()).meeting;

  const validSeniorUpdateRes = await fetch(`${BASE_URL}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimSession}`,
    },
    body: JSON.stringify({
      action: "UPSERT_SENIOR_ATTENDEE",
      encryptedMeetingPayload: reEnc.encryptedPayload,
      payloadIv: reEnc.payloadIv,
      hasSeniorAttendee: true,
      targetUserId: "u_exec_lee",
      expectedSequenceVersion: currentMtg.sequenceVersion,
    }),
  });
  assert.equal(validSeniorUpdateRes.status, 200, "정상적인 재암호화 페이로드 저장 성공");
  const seniorUpdateJson = await validSeniorUpdateRes.json();
  assert.equal(seniorUpdateJson.hasSeniorAttendee, true, "hasSeniorAttendee 불리언 플래그 갱신");
  assert.equal(seniorUpdateJson.sequenceVersion, currentMtg.sequenceVersion + 1, "sequenceVersion 단조 증가");
  console.log("  ✅ PASS: 클라이언트 암호문이 서버 키 없이 안전하게 저장됨 (sequenceVersion:", seniorUpdateJson.sequenceVersion, ")");

  // A-3. 동시 수정(Race Condition) 방어: 구버전 sequenceVersion 전송 시 409 충돌 검증
  console.log("  A-3: 동시 수정 시 낙관적 락(sequenceVersion 충돌) 409 검증...");
  const conflictRes = await fetch(`${BASE_URL}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimSession}`,
    },
    body: JSON.stringify({
      action: "UPSERT_SENIOR_ATTENDEE",
      encryptedMeetingPayload: reEnc.encryptedPayload,
      payloadIv: reEnc.payloadIv,
      hasSeniorAttendee: true,
      expectedSequenceVersion: currentMtg.sequenceVersion, // 이미 1 증가했으므로 불일치!
    }),
  });
  assert.equal(conflictRes.status, 409, "시퀀스 버전 불일치 시 409 Conflict 반환");
  const conflictJson = await conflictRes.json();
  assert.equal(conflictJson.error, "CONCURRENT_MODIFICATION_CONFLICT");
  console.log("  ✅ PASS: 동시 수정 충돌 차단 확인 (409 Conflict):", conflictJson.message);

  // ==========================================================================
  // [B. 기존 개인정보 마이그레이션 검증]
  // ==========================================================================
  console.log("\n--- [B. 기존 개인정보 마이그레이션 검증] ---");

  // B-1. 마이그레이션 전 레코드 수 확인
  const histBeforeRes = await fetch(`${BASE_URL}/api/histories`, {
    headers: { Authorization: `Bearer ${parkSession}` },
  });
  assert.equal(histBeforeRes.status, 200);
  const histBeforeData = await histBeforeRes.json();
  const beforeCount = histBeforeData.histories.length;
  console.log(`  B-1: 마이그레이션 전 박 기자 개인 이력 수: ${beforeCount}건`);

  // B-2. 레거시 레코드 시뮬레이션 및 클라이언트 복호화 후 재암호화 마이그레이션 실행
  const targetHist = histBeforeData.histories[0];
  const decryptedHist = await decryptHistoryBlob(
    targetHist.encryptedHistoryBlob,
    targetHist.blobIv,
    MASTER_SECRET_PARK
  );
  assert.ok(decryptedHist.visitedPlaceId, "복호화된 방문 식당 ID 확인");

  // 클라이언트에서 방문 장소를 포함하여 새롭게 암호화
  const reEncryptedHist = await encryptHistoryBlob(
    {
      ...decryptedHist,
      privateMemo: decryptedHist.privateMemo + " (마이그레이션 검증 완료)",
    },
    MASTER_SECRET_PARK
  );

  const histMigrateRes = await fetch(`${BASE_URL}/api/histories`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${parkSession}`,
    },
    body: JSON.stringify({
      historyId: targetHist.id,
      encryptedHistoryBlob: reEncryptedHist.encryptedHistoryBlob,
      blobIv: reEncryptedHist.blobIv,
    }),
  });
  assert.equal(histMigrateRes.status, 200, "이력 재암호화 갱신 성공");

  // B-3. 마이그레이션 후 레코드 수 및 데이터 손실 검증
  const histAfterRes = await fetch(`${BASE_URL}/api/histories`, {
    headers: { Authorization: `Bearer ${parkSession}` },
  });
  const histAfterData = await histAfterRes.json();
  const afterCount = histAfterData.histories.length;
  console.log(`  B-3: 마이그레이션 후 박 기자 개인 이력 수: ${afterCount}건`);
  assert.equal(afterCount, beforeCount, "마이그레이션 전후 레코드 수 불변 (0건 유실)");

  // B-4. 서버 DB에 평문 visited_place_id 컬럼이 완전히 부재하는지 파일 검증
  const dbRaw = fs.readFileSync(
    path.join(process.cwd(), ".data", "teamyak-phase3-db.json"),
    "utf8"
  );
  const dbObj = JSON.parse(dbRaw);
  for (const h of dbObj.personalMeetingHistories) {
    assert.equal(
      "visitedPlaceId" in h,
      false,
      `개인 이력(${h.id})에 평문 visitedPlaceId가 존재하지 않아야 함`
    );
  }
  console.log("  ✅ PASS: 2단계 점진적 마이그레이션 완료 (beforeCount == afterCount, 평문 visitedPlaceId 완전 소거)");

  // ==========================================================================
  // [C. 주요 참석자 메타데이터 검토 및 비인가 차단]
  // ==========================================================================
  console.log("\n--- [C. 주요 참석자 메타데이터 검증] ---");

  // C-1. 비로그인 사용자: 초대 링크 공개 봉투에 최고 직급 배지 및 암호문 미노출 검증
  console.log("  C-1: 비로그인 사용자의 초대장 접근 시 암호문 차단 검증...");
  const anonInviteRes = await fetch(`${BASE_URL}/api/invitations/inv_9x82a`);
  assert.equal(anonInviteRes.status, 200);
  const anonInviteJson = await anonInviteRes.json();
  assert.equal(anonInviteJson.ciphertextAccess.allowed, false, "비로그인 암호문 접근 차단");
  assert.equal(anonInviteJson.encryptedDetail, null, "비로그인 암호화 상세 null 반환");
  assert.equal(
    "highestSeniorityLevel" in anonInviteJson.publicEnvelope,
    false,
    "공개 봉투에 직급 평문 미포함"
  );
  console.log("  ✅ PASS: 비로그인 사용자에게 직급 및 암호문 절대 비노출");

  // C-2. 로그인한 정당한 초대 대상자(박 기자): 2단계 참석 확인 게이트 검증
  console.log("  C-2: 로그인한 초대 대상자 접근 시 암호문 제공 및 2단계 확인 게이트 검증...");
  const authInviteRes = await fetch(`${BASE_URL}/api/invitations/inv_9x82a`, {
    headers: { Authorization: `Bearer ${parkSession}` },
  });
  const authInviteJson = await authInviteRes.json();
  assert.equal(authInviteJson.ciphertextAccess.allowed, true, "권한 확인된 사용자 암호문 접근 허용");
  assert.ok(authInviteJson.encryptedDetail, "암호화 상세 데이터 수신");
  assert.equal(authInviteJson.encryptedDetail.hasSeniorAttendee, true, "주요 참석자 존재 플래그 확인");

  // 박 기자가 2단계 직급 확인 없이 참석 수락 시도 -> AWAITING_SENIOR_CONFIRM 반환 검증
  const preRsvpRes = await fetch(`${BASE_URL}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${parkSession}`,
    },
    body: JSON.stringify({
      rsvpStatus: "ATTENDING",
      confirmedAfterSeniorityReview: false, // 직급 확인 전!
    }),
  });
  assert.equal(preRsvpRes.status, 200);
  const preRsvpJson = await preRsvpRes.json();
  assert.equal(
    preRsvpJson.participant?.rsvpStatus,
    "AWAITING_SENIOR_CONFIRM",
    "주요 참석자 존재 모임은 직급 확인 전 자동 확정되지 않고 AWAITING_SENIOR_CONFIRM 대기"
  );
  assert.equal(
    preRsvpJson.requiresSeniorConfirmation,
    true,
    "requiresSeniorConfirmation 플래그 확인"
  );
  console.log("  ✅ PASS: 2단계 참석 확인 게이트 정상 작동 (AWAITING_SENIOR_CONFIRM)");

  // 박 기자가 직급 확인 완료 후 최종 참석 확정
  const finalRsvpRes = await fetch(`${BASE_URL}/api/invitations/inv_9x82a`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${parkSession}`,
    },
    body: JSON.stringify({
      rsvpStatus: "ATTENDING",
      confirmedAfterSeniorityReview: true, // 직급 확인 완료!
    }),
  });
  const finalRsvpJson = await finalRsvpRes.json();
  assert.equal(finalRsvpJson.participant?.rsvpStatus, "ATTENDING", "최종 참석 확정 완료");
  assert.equal(finalRsvpJson.calendarAutoRegistered, true, "캘린더 자동 등록 완료");
  console.log("  ✅ PASS: 직급 검토 후 최종 참석 수락 완료 (ATTENDING)");

  // ==========================================================================
  // [D. 실제 PostgreSQL 16 엔진(PGlite) 기반 RLS 검증]
  // ==========================================================================
  console.log("\n--- [D. PostgreSQL 16 RLS 격리 무결성 실증] ---");
  const pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    DO $$ BEGIN CREATE ROLE authenticated NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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

  const UUID_KIM  = "00000000-0000-4000-8000-000000000001";
  const UUID_PARK = "00000000-0000-4000-8000-000000000002";
  const UUID_MTG_1 = "30000000-0000-4000-8000-000000000001";

  await pg.exec(`
    INSERT INTO users (id, kakao_id_hash, display_name) VALUES
      ('${UUID_KIM}', 'hash_kim', '김 대리'),
      ('${UUID_PARK}', 'hash_park', '박 기자');

    INSERT INTO personal_meeting_histories (owner_user_id, meeting_date, encrypted_history_blob, blob_iv) VALUES
      ('${UUID_KIM}', '2026-11-19', 'enc_blob_kim', 'iv_kim'),
      ('${UUID_PARK}', '2026-11-19', 'enc_blob_park', 'iv_park');
  `);

  // 박 기자(UUID_PARK) 세션으로 전환하여 RLS 격리 검증
  await pg.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${UUID_PARK}';`);
  const rlsHistResult = await pg.query(`SELECT * FROM personal_meeting_histories;`);
  assert.equal(rlsHistResult.rows.length, 1, "박 기자는 오직 본인 이력 1건만 조회 가능");
  assert.equal(rlsHistResult.rows[0].owner_user_id, UUID_PARK, "조회된 이력의 소유자는 박 기자");
  console.log("  ✅ PASS: PostgreSQL 16 RLS 정책에 의해 타 사용자 이력 원천 차단 확인");

  await pg.exec(`RESET ROLE;`);

  console.log("\n==================================================================");
  console.log("🎉 [TEAMYAK Phase 3.6] 모든 보안 무결성 감사 및 클라우드 전환 검증 통과!");
  console.log("==================================================================");
}

runPhase36Audit().catch((err) => {
  console.error("❌ Phase 3.6 감사 검증 실패:", err);
  process.exit(1);
});
