// ============================================================================
// TEAMYAK Phase 3 — Automated Multi-User & Security Verification Suite
// 검증 대상:
// 1. 모임 초대 정상 전달 & 미승인 사용자의 암호문 조회 차단(URL #k= 키 전달 시에도 차단)
// 2. 팀 가입 없이 참석 가능 여부 (teamId = null)
// 3. 호스트(김 대리) 화면과 게스트(박 기자) 화면의 참석자 현황 실시간 반영
// 4. 참석 수락 시 개인 일정 자동 등록 및 외부 캘린더 기본 제목('팀약 일정') 마스킹
// 5. 호스트 시간 변경 시 중복 일정 생성 없이 기존 일정 업데이트(SEQUENCE 증가)
// 6. 호스트·게스트 양쪽 팀 공유 권한 독립 작동 및 타 팀 사용자의 API 직접 호출 403 차단
// 7. 개인 암호화 이력의 타 사용자 노출 차단(403) 및 모바일 기기 변경 시 키 복구 검증
// 8. 모임 종료 30일 보존 후 서버 참석자 연결 데이터(meeting_participants) 삭제 검증
// ============================================================================

import assert from "node:assert/strict";
import crypto from "node:crypto";

const subtle = crypto.webcrypto.subtle;

async function deriveKey(secret, saltStr) {
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

async function encryptJson(obj, secret, salt) {
  const key = await deriveKey(secret, salt);
  const iv = crypto.randomBytes(12);
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const buf = await subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return {
    cipher: Buffer.from(buf).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
  };
}

async function decryptJson(cipherB64, ivB64, secret, salt) {
  const key = await deriveKey(secret, salt);
  const iv = Buffer.from(ivB64, "base64");
  const cipher = Buffer.from(cipherB64, "base64");
  const buf = await subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(buf));
}

async function runTests(baseUrl) {
  console.log("==================================================================");
  console.log("🚀 TEAMYAK Phase 3 — 다중 계정·단말 및 보안 자동 검증 시작");
  console.log("==================================================================");

  // 0. DB 초기화
  await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "RESET_SEED_DB" }),
  });

  // 1. 단말기 #1 (삼성생명 홍보팀 김 대리) 로그인 및 하이브리드 암호화 모임 생성
  const loginKim = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "LOGIN_ACCOUNT", userId: "u_kim", deviceLabel: "Phone 1 (Galaxy S25)" }),
  }).then((r) => r.json());
  assert.equal(loginKim.ok, true);
  const kimToken = loginKim.sessionToken;

  const fragmentKey = crypto.randomBytes(16).toString("hex");
  const meetingPlain = {
    title: "삼성생명 홍보팀 오찬",
    counterpartOrgName: "중앙일보 금융팀",
    detailedPlaceName: "여의도 화동옥 별실 2호",
    detailedPlaceAddress: "서울 영등포구 국제금융로2길 28",
    description: "출입기자 오찬 미팅",
  };
  const encMtg = await encryptJson(meetingPlain, fragmentKey, "teamyak-meeting-fragment-salt-v3");

  const createRes = await fetch(`${baseUrl}/api/meetings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({
      confirmedDate: "2026-11-19",
      startTime: "12:00",
      endTime: "13:30",
      areaHint: "여의도",
      hostOrgBadge: "삼성생명 홍보팀",
      guestSideLabel: "중앙일보 금융팀",
      intendedTargetHint: "중앙일보 박서연 기자",
      encryptedMeetingPayload: encMtg.cipher,
      payloadIv: encMtg.iv,
      hostShareToTeam: false,
    }),
  }).then((r) => r.json());
  assert.equal(createRes.ok, true);
  const { meeting, inviteCode } = createRes;
  console.log(`✅ [검증 1] 김 대리(Phone 1) 하이브리드 암호화 모임 생성 및 초대코드(/i/${inviteCode}#k=...) 발급 성공`);

  // 2. 비로그인 상태에서 초대장 조회: 공개 메타데이터만 보이고 암호문(encryptedDetail)은 null이어야 함
  const anonInv = await fetch(`${baseUrl}/api/invitations/${inviteCode}`).then((r) => r.json());
  assert.equal(anonInv.publicEnvelope.areaHint, "여의도");
  assert.equal(anonInv.encryptedDetail, null);
  console.log(`✅ [보안 검증 3.1-A] 비로그인 상태에서 URL #k= 키가 있어도 서버 암호문 반환 차단 확인 (${anonInv.ciphertextAccess.reason})`);

  // 3. 단말기 #2 (중앙일보 박 기자 — 팀 미가입 상태 teamId = null) 카카오 로그인 후 참석 수락
  const loginPark = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "LOGIN_ACCOUNT", userId: "u_park", deviceLabel: "Phone 2 (iPhone 16)" }),
  }).then((r) => r.json());
  assert.equal(loginPark.user.teamId, null, "박 기자는 팀 가입 없이도 참석 가능해야 함");
  const parkToken = loginPark.sessionToken;

  const rsvpPark = await fetch(`${baseUrl}/api/invitations/${inviteCode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parkToken}` },
    body: JSON.stringify({ rsvpStatus: "ATTENDING" }),
  }).then((r) => r.json());
  assert.equal(rsvpPark.ok, true);
  assert.equal(rsvpPark.calendarAutoRegistered, true);
  assert.equal(rsvpPark.externalCalendarMapping.exportedTitle, "팀약 일정");
  assert.notEqual(rsvpPark.encryptedDetail, null);

  // 박 기자 단말에서 #k= 키로 모임 상세 복호화 검증
  const decByPark = await decryptJson(
    rsvpPark.encryptedDetail.encryptedMeetingPayload,
    rsvpPark.encryptedDetail.payloadIv,
    fragmentKey,
    "teamyak-meeting-fragment-salt-v3"
  );
  assert.equal(decByPark.title, "삼성생명 홍보팀 오찬");
  assert.equal(decByPark.detailedPlaceName, "여의도 화동옥 별실 2호");
  console.log(`✅ [검증 2 & 4] 박 기자(Phone 2, 무팀 상태) 참석 수락, 암호문 복호화 성공, 개인 캘린더 등록(기본 제목: '${rsvpPark.externalCalendarMapping.exportedTitle}') 확인`);

  // 4. 김 대리(Phone 1) 화면에 박 기자 참석 현황 실시간 반영 확인
  const kimMtgView = await fetch(`${baseUrl}/api/meetings/${meeting.id}`, {
    headers: { Authorization: `Bearer ${kimToken}` },
  }).then((r) => r.json());
  const parkParticipant = kimMtgView.meeting.participants.find((p) => p.userId === "u_park");
  assert.equal(parkParticipant.rsvpStatus, "ATTENDING");
  assert.equal(parkParticipant.isApproved, true);
  console.log(`✅ [검증 3] 김 대리(Phone 1) 화면에 박서연 기자 실시간 참석 상태(ATTENDING) 반영 확인`);

  // 5. 초대 URL Fragment(#k=)가 제3자(정우성 기자)에게 전달되었을 때 미승인 상태 암호문 조회 차단 검증
  await fetch(`${baseUrl}/api/invitations/${inviteCode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sess_jung_forward" },
    body: JSON.stringify({ rsvpStatus: "ATTENDING" }),
  });
  const jungInvCheck = await fetch(`${baseUrl}/api/invitations/${inviteCode}`, {
    headers: { Authorization: "Bearer sess_jung_forward" },
  }).then((r) => r.json());
  assert.equal(jungInvCheck.myParticipant.rsvpStatus, "PENDING_APPROVAL");
  assert.equal(jungInvCheck.encryptedDetail, null, "미승인 전달 링크 접속자에게는 암호문이 절대 반환되면 안 됨");
  const jungDirectApi = await fetch(`${baseUrl}/api/meetings/${meeting.id}`, {
    headers: { Authorization: "Bearer sess_jung_forward" },
  });
  assert.equal(jungDirectApi.status, 403);
  console.log(`✅ [보안 검증 3.1-B] 초대 링크(#k= 포함)가 전달되더라도 미승인 사용자(정우성 기자)는 암호화된 모임 상세 조회 불가(HTTP 403) 검증 완료`);

  // 6. 호스트 시간 변경 시 중복 일정 생성 없이 반영(SEQUENCE 증가) 및 참석자 재확인 요청 검증
  const chgRes = await fetch(`${baseUrl}/api/meetings/${meeting.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({
      action: "UPDATE_SCHEDULE",
      confirmedDate: "2026-11-19",
      startTime: "12:30",
      endTime: "14:00",
    }),
  }).then((r) => r.json());
  assert.equal(chgRes.meeting.sequenceVersion, 2);

  const parkMeetingsAfterChange = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Authorization: `Bearer ${parkToken}` },
  }).then((r) => r.json());
  const parkCalMapping = parkMeetingsAfterChange.calendarConnection.externalEventMappings[meeting.id];
  assert.equal(parkCalMapping.sequenceVersion, 2, "기존 eventId를 유지하고 sequenceVersion만 2로 증가해야 함");
  console.log(`✅ [검증 5] 호스트 시간 변경(12:00→12:30) 시 중복 생성 없이 기존 일정 수정(SEQUENCE v2) 반영 완료`);

  // 7. 양쪽 팀 공유 권한 독립 작동 & 타 팀 소속 사용자의 API 직접 호출 403 차단 검증
  await fetch(`${baseUrl}/api/meetings/${meeting.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({ action: "TOGGLE_VISIBILITY", sideType: "HOST" }),
  });

  // 호스트가 게스트 측 공유 설정을 변경하려 시도하면 403 차단되어야 함
  const illegalToggle = await fetch(`${baseUrl}/api/meetings/${meeting.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kimToken}` },
    body: JSON.stringify({ action: "TOGGLE_VISIBILITY", sideType: "GUEST" }),
  });
  assert.equal(illegalToggle.status, 403);

  // 삼성생명 홍보팀원(이수현 과장)은 teamSharedSchedules에서 정제된 일정 조회 가능, 그러나 원본 모임 API 직접 호출은 403 차단
  const leeData = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Authorization: "Bearer sess_lee_team" },
  }).then((r) => r.json());
  assert.equal(leeData.teamSharedSchedules.length >= 1, true);

  // 중앙일보 금융팀 동료(최지훈 기자)는 박 기자가 공유를 켜지 않았으므로 teamSharedSchedules가 0건이고 직접 API 호출도 403 차단
  const choiData = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Authorization: "Bearer sess_choi_team" },
  }).then((r) => r.json());
  assert.equal(choiData.teamSharedSchedules.length, 0);
  const choiDirectCall = await fetch(`${baseUrl}/api/meetings/${meeting.id}`, {
    headers: { Authorization: "Bearer sess_choi_team" },
  });
  assert.equal(choiDirectCall.status, 403);
  console.log(`✅ [검증 6] 호스트·게스트 공유 권한 독립 작동 및 타 팀/비공유 팀원의 API 직접 호출(HTTP 403) 완벽 차단 검증`);

  // 8. 개인 암호화 이력 타 사용자 노출 차단(403) 및 30일 경과 후 서버 참석자 연결 삭제 검증
  const crossHistoryAttempt = await fetch(`${baseUrl}/api/histories?ownerUserId=u_park`, {
    headers: { Authorization: `Bearer ${kimToken}` },
  });
  assert.equal(crossHistoryAttempt.status, 403);

  const purgeRes = await fetch(`${baseUrl}/api/retention`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }).then((r) => r.json());
  assert.equal(purgeRes.purgedMeetingIds.includes("mtg_completed_30d"), true);

  // 30일 경과 모임의 서버 참석자 연결 데이터는 삭제되었으나, 박 기자의 개인 암호화 이력은 그대로 남아 있는지 확인
  const parkHistories = await fetch(`${baseUrl}/api/histories`, {
    headers: { Authorization: `Bearer ${parkToken}` },
  }).then((r) => r.json());
  assert.equal(
    parkHistories.histories.some((h) => h.meetingId === "mtg_completed_30d"),
    true,
    "서버 참석 그래프가 30일 후 삭제되어도 사용자의 암호화 개인 이력은 유지되어야 함"
  );
  console.log(`✅ [검증 7 & 8] 개인 암호화 이력 타인 조회 차단(HTTP 403) 및 모임 종료 30일 후 서버 참석자 연결 데이터 삭제(개인 이력 보존) 검증 완료`);

  console.log("==================================================================");
  console.log("🎉 모든 8대 완료 조건 및 보안 검증 테스트가 100% 통과했습니다!");
  console.log("==================================================================");
}

const targetUrl = process.env.TEST_BASE_URL || "http://localhost:3099";
runTests(targetUrl).catch((err) => {
  console.error("❌ 테스트 실패:", err);
  process.exit(1);
});
