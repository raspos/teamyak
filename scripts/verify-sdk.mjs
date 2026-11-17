/**
 * TEAMYAK — Cross-Platform Client SDK (@teamyak/client) 동작 검증
 */

import { TeamyakClient } from "../src/lib/sdk/teamyak-client.ts";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

async function run() {
  console.log("================================================================================");
  console.log("🚀 TEAMYAK Cross-Platform SDK (@teamyak/client) 검증 시작");
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log("================================================================================\n");

  const client = new TeamyakClient({ baseUrl: BASE_URL });

  // 1. 로그인 테스트
  console.log("[1] SDK 인증 (Login & Bearer Token 주입) 검증...");
  const loginRes = await client.loginWithTestAccount("u_kim");
  assert(Boolean(loginRes.sessionToken), "세션 토큰 정상 수령 확인");
  assert(client.getToken() === loginRes.sessionToken, "클라이언트 내부 Bearer Token 동기화 확인");

  const me = await client.getMe();
  assert(me.user?.id === "u_kim", `인증 확인 (u_kim): ${me.user?.displayName}`);
  console.log("  ✓ SDK 인증 모듈 검증 통과\n");

  // 2. 모임 목록 조회
  console.log("[2] SDK 모임 목록 조회 검증...");
  const meetingsData = await client.getMeetings();
  assert(Array.isArray(meetingsData.directMeetings), "모임 목록 배열(directMeetings) 반환 확인");
  assert(meetingsData.directMeetings.length > 0, `모임 개수 확인: ${meetingsData.directMeetings.length}건`);
  console.log("  ✓ SDK 모임 조회 검증 통과\n");

  // 3. Apple Calendar 연동 조회
  console.log("[3] SDK Apple Calendar Webcal 연동 검증...");
  const appleCal = await client.getAppleCalendar();
  assert(appleCal.ok === true, "Apple Calendar API 응답 확인");
  assert(appleCal.appleCalendar.webcalUrl.startsWith("webcal://"), "Webcal 프로토콜 확인");
  console.log("  ✓ SDK Apple Calendar 모듈 검증 통과\n");

  // 4. 클라이언트 암호화/복호화 엔진 검증
  console.log("[4] SDK 내장 제로 지식 암호화 (AES-GCM / PBKDF2) 엔진 검증...");
  const fragmentKey = TeamyakClient.crypto.generateFragmentKey();
  assert(fragmentKey.length === 32, `고엔트로피 단편 키 생성 확인: ${fragmentKey}`);

  const testPayload = {
    title: "크로스 플랫폼 SDK 연동 오찬",
    counterpartOrgName: "중앙일보",
    detailedPlaceName: "화동옥 룸 3호",
    detailedPlaceAddress: "서울 영등포구 여의도동",
    highestSeniorityLevel: "DIRECTOR",
  };

  const encrypted = await TeamyakClient.crypto.encryptMeetingPayload(testPayload, fragmentKey);
  assert(Boolean(encrypted.encryptedPayload) && Boolean(encrypted.payloadIv), "AES-GCM 암호화 성공");

  const decrypted = await TeamyakClient.crypto.decryptMeetingPayload(
    encrypted.encryptedPayload,
    encrypted.payloadIv,
    fragmentKey
  );
  assert(decrypted.title === testPayload.title, "클라이언트 복호화 성공 및 무결성 확인");
  assert(decrypted.detailedPlaceName === testPayload.detailedPlaceName, "상세 장소 복호화 일치 확인");
  console.log("  ✓ SDK 클라이언트 암호화 엔진 검증 통과\n");

  // 5. 뉴스 및 알림 조회
  console.log("[5] SDK 뉴스 검색 & 중립 알림 센터 검증...");
  const news = await client.getNews("삼성생명");
  assert(Array.isArray(news.articles), "뉴스 검색 결과 배열(articles) 반환 확인");

  const notifs = await client.getNotifications();
  assert(Array.isArray(notifs.deliveries), "중립 알림 목록 반환 확인");
  console.log("  ✓ SDK 부가 서비스 모듈 검증 통과\n");

  console.log("================================================================================");
  console.log("🎉 [SUCCESS] TEAMYAK Cross-Platform SDK (@teamyak/client) 100% 정상 작동!");
  console.log("================================================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR in SDK verification:", err);
  process.exit(1);
});
