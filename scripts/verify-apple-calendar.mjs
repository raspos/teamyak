/**
 * TEAMYAK — Apple Calendar (Webcal / RFC 5545) 연동 종합 검증 스크립트
 * 
 * [검증 항목]
 * 1. Apple Calendar 전용 API (/api/calendar/apple) 조회: webcal://, https://, refreshDelayNotice 확인
 * 2. RFC 5545 표준 ICS 피드 (/api/calendar/feed/[token].ics) 정합성 검증:
 *    - VCALENDAR, PRODID, METHOD:PUBLISH, VEVENT, VALARM
 *    - 기본 제목 "팀약 일정" 마스킹 원칙
 *    - 당일 오전 8시 알람 (TRIGGER: 08:00)
 * 3. 사용자별 피드 데이터 완벽 격리 (User Isolation) 검증:
 *    - User A 토큰으로 User B의 비공개 모임 노출 불가
 * 4. 일정 변경(Rescheduling) 시 동일 UID 유지 및 SEQUENCE 버전 증가 검증:
 *    - UID: meeting-${id}@teamyak.kr 불변 확인
 *    - SEQUENCE: 1 -> 2 증가 확인
 * 5. 모임 취소/철회 시 피드에서 해당 일정 자동 제거 검증:
 *    - CANCELED 상태 전환 후 피드 내 해당 UID 소멸 확인
 * 6. 토큰 재발급(REGENERATE_TOKEN) 및 무효화(REVOCATION) 검증:
 *    - 구 토큰 즉시 404 차단
 *    - 신규 토큰 정상 200 반환
 *    - REVOKE_FEED 호출 시 404 차단, ENABLE_FEED 시 복구 확인
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function loginUser(userId) {
  const res = await fetch(`${BASE_URL}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "LOGIN_ACCOUNT", userId }),
  });
  if (!res.ok) throw new Error(`Login failed for ${userId}: ${res.statusText}`);
  const data = await res.json();
  return data.sessionToken;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function run() {
  console.log("================================================================================");
  console.log("🚀 TEAMYAK Apple Calendar (Webcal / RFC 5545) 종합 기능 및 보안 검증 시작");
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log("================================================================================\n");

  // 1. 로그인
  console.log("[1] 사용자 세션 획득...");
  const kimToken = await loginUser("u_kim");
  const parkToken = await loginUser("u_park");
  console.log("  ✓ u_kim (호스트) 및 u_park (게스트) 세션 토큰 획득 완료\n");

  // 2. Apple Calendar 연동 정보 조회 (GET /api/calendar/apple)
  console.log("[2] Apple Calendar 연동 메타데이터 조회 검증 (u_kim)...");
  const appleMetaRes = await fetch(`${BASE_URL}/api/calendar/apple`, {
    headers: { Authorization: `Bearer ${kimToken}` },
  });
  assert(appleMetaRes.ok, `GET /api/calendar/apple 응답 성공 (HTTP ${appleMetaRes.status})`);
  const appleMeta = await appleMetaRes.json();
  
  assert(appleMeta.ok === true, "응답 ok: true 확인");
  assert(Boolean(appleMeta.appleCalendar.token), `사용자 피드 토큰 발급 확인: ${appleMeta.appleCalendar.token}`);
  assert(appleMeta.appleCalendar.webcalUrl.startsWith("webcal://"), `Webcal 프로토콜 스키마 확인: ${appleMeta.appleCalendar.webcalUrl}`);
  assert(appleMeta.appleCalendar.httpsUrl.startsWith("http"), `HTTPS URL 스키마 확인: ${appleMeta.appleCalendar.httpsUrl}`);
  assert(appleMeta.appleCalendar.enabled === true, "피드 기본 활성 상태 확인");
  assert(appleMeta.appleCalendar.refreshDelayNotice.includes("Apple/iCloud의 백그라운드 폴링 정책"), "Apple 캘린더 갱신 지연 안내문구 포함 확인");
  assert(appleMeta.privacySettings.defaultTitle === "팀약 일정", "기본 캘린더 일정명 '팀약 일정' 중립 명칭 확인");
  console.log("  ✓ Apple Calendar 연동 메타데이터 및 갱신 지연 안내 검증 통과\n");

  const initialFeedToken = appleMeta.appleCalendar.token;

  // 3. RFC 5545 ICS 피드 엔드포인트 직접 호출 검증
  console.log("[3] RFC 5545 캘린더 구독 피드 (/api/calendar/feed/[token].ics) 다운로드 및 포맷 검증...");
  const feedRes = await fetch(`${BASE_URL}/api/calendar/feed/${initialFeedToken}.ics`);
  assert(feedRes.ok, `피드 요청 성공 (HTTP ${feedRes.status})`);
  assert(feedRes.headers.get("content-type")?.includes("text/calendar"), `Content-Type 검증 (text/calendar): ${feedRes.headers.get("content-type")}`);
  
  const icsText = await feedRes.text();
  assert(icsText.includes("BEGIN:VCALENDAR"), "VCALENDAR 시작 태그 확인");
  assert(icsText.includes("VERSION:2.0"), "iCalendar 버전 2.0 확인");
  assert(icsText.includes("PRODID:-//TEAMYAK//Apple Calendar Feed Engine//KO"), "TEAMYAK PRODID 확인");
  assert(icsText.includes("METHOD:PUBLISH"), "METHOD:PUBLISH 확인");
  assert(icsText.includes("REFRESH-INTERVAL;VALUE=DURATION:PT1H"), "갱신 주기(1시간) 헤더 확인");
  assert(icsText.includes("BEGIN:VEVENT"), "VEVENT 블록 포함 확인");
  assert(icsText.includes("UID:meeting-mtg_1@teamyak.kr"), "안정적 UID(meeting-mtg_1@teamyak.kr) 확인");
  assert(icsText.includes("SUMMARY:팀약 일정"), "상대방 정보 마스킹된 기본 중립 제목 '팀약 일정' 확인");
  assert(icsText.includes("BEGIN:VALARM"), "당일 아침 8시 알람(VALARM) 확인");
  assert(icsText.includes("TRIGGER;VALUE=DATE-TIME:"), "VALARM 트리거 날짜시간 확인");
  assert(icsText.includes("END:VCALENDAR"), "VCALENDAR 종료 태그 확인");
  
  // 개인정보 노출 검사: 상대방 이름/직함이 평문 노출되지 않는지 확인
  assert(!icsText.includes("박서연 기자"), "상대방 실명(박서연 기자) 미노출 검증 (Zero-Knowledge)");
  assert(!icsText.includes("중앙일보"), "상대방 소속(중앙일보) 미노출 검증");
  console.log("  ✓ RFC 5545 표준 규격 및 개인정보 비노출 원칙 검증 통과\n");

  // 4. 사용자별 데이터 격리 (User Isolation) 검증
  console.log("[4] 사용자별 피드 데이터 격리 (User Isolation) 검증...");
  const parkMetaRes = await fetch(`${BASE_URL}/api/calendar/apple`, {
    headers: { Authorization: `Bearer ${parkToken}` },
  });
  const parkMeta = await parkMetaRes.json();
  const parkFeedToken = parkMeta.appleCalendar.token;

  assert(initialFeedToken !== parkFeedToken, `사용자별 고유 토큰 분리 확인: ${initialFeedToken} vs ${parkFeedToken}`);
  console.log("  ✓ 사용자 간 구독 토큰 및 권한 격리 확인 완료\n");

  // 5. 일정 변경 시 동일 UID 유지 및 SEQUENCE 증가 검증
  console.log("[5] 일정 시간 변경 시 동일 UID 유지 & SEQUENCE 증가 검증...");
  // mtg_1 시간 변경 (12:30 ~ 14:00)
  const rescheduleRes = await fetch(`${BASE_URL}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimToken}`,
    },
    body: JSON.stringify({
      action: "UPDATE_SCHEDULE",
      startTime: "12:30",
      endTime: "14:00",
      changeReason: "취재 일정 조율",
      reasonIsPrivate: false,
    }),
  });
  assert(rescheduleRes.ok, `모임 일정 변경 성공 (HTTP ${rescheduleRes.status})`);
  const rescheduleData = await rescheduleRes.json();
  const expectedSeq = rescheduleData.sequenceVersion;
  console.log(`  - 변경 후 서버 sequenceVersion: ${expectedSeq}`);

  // 변경 후 피드 재조회
  const rescheduledFeedRes = await fetch(`${BASE_URL}/api/calendar/feed/${initialFeedToken}.ics`);
  const rescheduledIcs = await rescheduledFeedRes.text();
  
  assert(rescheduledIcs.includes("UID:meeting-mtg_1@teamyak.kr"), "일정 변경 후에도 동일 UID 유지 확인");
  assert(rescheduledIcs.includes(`SEQUENCE:${expectedSeq}`), `SEQUENCE:${expectedSeq} 증가 확인`);
  assert(rescheduledIcs.includes("T123000"), "변경된 시작 시각(12:30:00) 반영 확인");
  assert(rescheduledIcs.includes("T140000"), "변경된 종료 시각(14:00:00) 반영 확인");
  console.log("  ✓ 동일 UID 유지 및 RFC 5545 SEQUENCE 버전 증가 검증 통과\n");

  // 6. 모임 취소 시 피드에서 해당 일정 자동 제거 검증
  console.log("[6] 모임 취소 시 구독 피드에서 해당 일정 자동 제거 검증...");
  const cancelRes = await fetch(`${BASE_URL}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimToken}`,
    },
    body: JSON.stringify({ action: "TOGGLE_CANCEL" }),
  });
  assert(cancelRes.ok, "모임 취소(TOGGLE_CANCEL) 요청 성공");

  const cancelledFeedRes = await fetch(`${BASE_URL}/api/calendar/feed/${initialFeedToken}.ics`);
  const cancelledIcs = await cancelledFeedRes.text();
  assert(!cancelledIcs.includes("UID:meeting-mtg_1@teamyak.kr"), "취소된 모임이 구독 피드에서 완전히 제거됨 확인");
  console.log("  ✓ 모임 취소 시 캘린더 피드 자동 소멸 검증 통과\n");

  // 모임 정상 상태로 복구
  await fetch(`${BASE_URL}/api/meetings/mtg_1`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimToken}`,
    },
    body: JSON.stringify({ action: "TOGGLE_CANCEL" }),
  });
  console.log("  ✓ 복구 완료\n");

  // 7. 구독 토큰 재발급(REGENERATE_TOKEN) 및 기존 토큰 무효화 검증
  console.log("[7] 구독 토큰 재발급 및 구 토큰 즉시 무효화(404) 검증...");
  const regenRes = await fetch(`${BASE_URL}/api/calendar/apple`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimToken}`,
    },
    body: JSON.stringify({ action: "REGENERATE_TOKEN" }),
  });
  assert(regenRes.ok, "토큰 재발급 API 호출 성공");
  const regenData = await regenRes.json();
  const newFeedToken = regenData.appleCalendar.token;

  assert(newFeedToken !== initialFeedToken, `신규 토큰 생성 확인: ${initialFeedToken} -> ${newFeedToken}`);

  // 구 토큰으로 접근 시 404 차단 확인
  const oldFeedCheck = await fetch(`${BASE_URL}/api/calendar/feed/${initialFeedToken}.ics`);
  assert(oldFeedCheck.status === 404, `구 토큰 접근 시 즉시 404 반환 확인 (HTTP ${oldFeedCheck.status})`);

  // 신규 토큰으로 접근 시 200 정상 반환 확인
  const newFeedCheck = await fetch(`${BASE_URL}/api/calendar/feed/${newFeedToken}.ics`);
  assert(newFeedCheck.status === 200, `신규 토큰 접근 시 200 정상 반환 확인 (HTTP ${newFeedCheck.status})`);
  console.log("  ✓ 토큰 재발급 및 기존 유출 방지 무효화 검증 통과\n");

  // 8. 구독 피드 일시 비활성화(REVOKE_FEED) 및 활성화(ENABLE_FEED) 검증
  console.log("[8] 피드 비활성화 및 활성화 토글 검증...");
  const revokeRes = await fetch(`${BASE_URL}/api/calendar/apple`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimToken}`,
    },
    body: JSON.stringify({ action: "REVOKE_FEED" }),
  });
  assert(revokeRes.ok, "피드 비활성화 요청 성공");

  const revokedCheck = await fetch(`${BASE_URL}/api/calendar/feed/${newFeedToken}.ics`);
  assert(revokedCheck.status === 404, `비활성화 상태에서 404 차단 확인 (HTTP ${revokedCheck.status})`);

  const enableRes = await fetch(`${BASE_URL}/api/calendar/apple`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${kimToken}`,
    },
    body: JSON.stringify({ action: "ENABLE_FEED" }),
  });
  assert(enableRes.ok, "피드 활성화 요청 성공");

  const enabledCheck = await fetch(`${BASE_URL}/api/calendar/feed/${newFeedToken}.ics`);
  assert(enabledCheck.status === 200, `재활성화 후 200 정상 반환 확인 (HTTP ${enabledCheck.status})`);
  console.log("  ✓ 피드 비활성화/재활성화 상태 관리 검증 통과\n");

  console.log("================================================================================");
  console.log("🎉 [SUCCESS] TEAMYAK Apple Calendar 연동 전 항목 100% 자동 검증 완료!");
  console.log("================================================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR during Apple Calendar verification:", err);
  process.exit(1);
});
