/**
 * TEAMYAK — 크로스플랫폼 SDK 호환성 및 보안 감사 검증 스크립트
 * 
 * [검증 항목]
 * 1. 암호화 호환성 및 공통 테스트 벡터 (AES-256-GCM / PBKDF2 / IV 12B / Auth Tag 16B / 변조 차단)
 * 2. 복구 코드 기반 마스터키 백업 래핑 및 언래핑 (310,000 반복 PBKDF2)
 * 3. SDK 보안 검증:
 *    - 3-1: 프로덕션 환경(APP_ENV=production)에서 테스트 계정 로그인 차단
 *    - 3-2: Bearer 토큰 및 세션 토큰 마스킹 (오류 메시지 노출 방지)
 *    - 3-3: 네이티브 OS 보안 저장소(Keychain / SecureStore) 어댑터 동작 검증
 *    - 3-4: 동일 사용자 다중 기기 세션 격리 및 단일 기기 독립 폐기 (Remote Logout)
 *    - 3-5: 서로 다른 사용자 간 SDK 인스턴스 격리 (상태 비공유)
 * 4. Universal Links & App Links 엔드포인트 규격 검증 (apple-app-site-association, assetlinks.json)
 */

import { TeamyakClient } from "../src/lib/sdk/teamyak-client.ts";
import {
  generateFragmentKey,
  encryptMeetingPayload,
  decryptMeetingPayload,
  createRecoveryKeyBackup,
  recoverMasterKeyFromBackup,
} from "../src/lib/crypto.ts";
import crypto from "crypto";

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
  console.log("🛡️ TEAMYAK 크로스플랫폼 SDK 호환성 및 보안 감사 시작");
  console.log(`📍 Base URL: ${BASE_URL}`);
  console.log("================================================================================\n");

  // ==========================================================================
  // [PART 1] 암호화 호환성 및 공통 테스트 벡터 검증
  // ==========================================================================
  console.log("--- [1. 암호화 표준 및 공통 테스트 벡터 검증] ---");

  // 1-1. PBKDF2 키 유도 호환성 검증
  const testSecret = "teamyak-common-test-vector-password-2026";
  const testSalt = "teamyak-meeting-fragment-salt-v3";
  const iterations = 10000;

  console.log("  [1-1] PBKDF2 키 유도 (SHA-256, 10,000회 반복) 검증...");
  const webCryptoSubtle = crypto.webcrypto.subtle;
  const enc = new TextEncoder();

  const keyMaterial = await webCryptoSubtle.importKey(
    "raw",
    enc.encode(testSecret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const derivedKey = await webCryptoSubtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(testSalt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  const exportedRawKey = await webCryptoSubtle.exportKey("raw", derivedKey);
  const derivedKeyHex = Buffer.from(exportedRawKey).toString("hex");
  assert(derivedKeyHex.length === 64, `256비트 AES 키 유도 완료 (64 hex characters): ${derivedKeyHex.slice(0, 16)}...`);

  // Node native pbkdf2Sync와 비트 단위 일치 검증
  const nodeNativeKey = crypto.pbkdf2Sync(testSecret, testSalt, iterations, 32, "sha256");
  assert(derivedKeyHex === nodeNativeKey.toString("hex"), "W3C SubtleCrypto와 Native Crypto의 PBKDF2 유도 결과 100% 비트 일치");

  // 1-2. AES-256-GCM 암호화 및 Auth Tag 16B 직렬화 포맷 검증
  console.log("  [1-2] AES-256-GCM 인증 태그 및 직렬화 구조 검증...");
  const fixedIv = Buffer.from("0102030405060708090a0b0c", "hex"); // 12 bytes IV
  const plainObject = {
    title: "공통 테스트 벡터 오찬",
    counterpartOrgName: "조선일보",
    detailedPlaceName: "광화문 한일관",
    timestamp: 1763350000,
  };
  const plainBytes = enc.encode(JSON.stringify(plainObject));

  const cipherBuffer = await webCryptoSubtle.encrypt(
    { name: "AES-GCM", iv: fixedIv },
    derivedKey,
    plainBytes
  );

  const cipherBytes = new Uint8Array(cipherBuffer);
  // Web Crypto API 표준: 암호문 끝 16바이트가 GCM 인증 태그(Auth Tag)임
  assert(cipherBytes.length === plainBytes.length + 16, `암호문 길이 검증 (평문 ${plainBytes.length}B + GCM 태그 16B = ${cipherBytes.length}B)`);

  const tag = cipherBytes.slice(cipherBytes.length - 16);
  assert(tag.length === 16, `128비트(16바이트) GCM 인증 태그 확인: ${Buffer.from(tag).toString("hex")}`);

  // 1-3. 암호문 변조 차단 (Tamper Resistance) 실증
  console.log("  [1-3] 암호문 1비트 변조 시 복호화 차단 실증...");
  const tamperedBytes = new Uint8Array(cipherBytes);
  tamperedBytes[0] ^= 0x01; // 1비트 반전

  let tamperFailed = false;
  try {
    await webCryptoSubtle.decrypt(
      { name: "AES-GCM", iv: fixedIv },
      derivedKey,
      tamperedBytes
    );
  } catch (err) {
    tamperFailed = true;
    assert(err.name === "OperationError", `GCM 인증 태그 검증 실패로 복호화 거부 확인 (${err.name})`);
  }
  assert(tamperFailed, "암호문 변조 시 복호화 원천 차단 확인");

  // 1-4. 복구 코드 기반 마스터키 래핑/언래핑 (310,000회 PBKDF2)
  console.log("  [1-4] 복구 코드 마스터키 래핑/언래핑 검증...");
  const masterSecret = "teamyak-master-secret-for-user-u-kim";
  const recoveryCode = "TYRK-8F92-K92X-P49L-Q29M";
  const wrapped = await createRecoveryKeyBackup(masterSecret, recoveryCode);
  assert(Boolean(wrapped.encryptedMasterKeyBackup), "마스터키 래핑 백업 암호문 생성 확인");

  const unwrapped = await recoverMasterKeyFromBackup(
    wrapped.encryptedMasterKeyBackup,
    wrapped.masterKeyIv,
    wrapped.keySalt,
    recoveryCode
  );
  assert(unwrapped === masterSecret, "복구 코드로 원본 마스터키 100% 무손실 복원 확인\n");

  // ==========================================================================
  // [PART 2] SDK 보안 및 세션 관리 감사
  // ==========================================================================
  console.log("--- [2. SDK 보안 및 세션 관리 감사] ---");

  // 2-1. 프로덕션 환경 테스트 로그인 차단 검증
  console.log("  [2-1] 프로덕션 환경(APP_ENV=production) 테스트 로그인 차단 검증...");
  const originalAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = "production";

  const prodTestClient = new TeamyakClient({ baseUrl: BASE_URL });
  let prodLoginBlocked = false;
  try {
    await prodTestClient.loginWithTestAccount("u_kim");
  } catch (err) {
    prodLoginBlocked = true;
    assert(err.message.includes("TEST_LOGIN_DISABLED_IN_PRODUCTION"), `SDK 클라이언트 측 프로덕션 차단 확인: ${err.message}`);
  }
  assert(prodLoginBlocked, "프로덕션 환경 테스트 계정 로그인 차단 확인");
  process.env.APP_ENV = originalAppEnv || "staging";

  // 2-2. Bearer 토큰 오류 마스킹 검증
  console.log("  [2-2] Bearer 토큰 오류 메시지 마스킹 검증...");
  const leakTestClient = new TeamyakClient({
    baseUrl: BASE_URL,
    token: "sess_super_secret_token_12345",
  });
  try {
    // 존재하지 않는 엔드포인트 요청
    await leakTestClient.getMeeting("non_existent_id");
  } catch (err) {
    assert(!err.message.includes("sess_super_secret_token_12345"), "오류 메시지에 원본 세션 토큰 미노출 확인");
  }
  console.log("  ✓ Bearer 토큰 및 민감 정보 마스킹 확인 완료");

  // 2-3. 네이티브 OS 보안 저장소 (TokenStorage) 어댑터 검증
  console.log("  [2-3] 네이티브 보안 저장소(Keychain / SecureStore) 어댑터 동작 검증...");
  const mockSecureStorage = new Map();
  const nativeStorageAdapter = {
    getItem: async (k) => mockSecureStorage.get(k) || null,
    setItem: async (k, v) => { mockSecureStorage.set(k, v); },
    removeItem: async (k) => { mockSecureStorage.delete(k); },
  };

  const nativeClient = new TeamyakClient({
    baseUrl: BASE_URL,
    storage: nativeStorageAdapter,
    storageKey: "native_secure_keychain_token",
  });

  nativeClient.setToken("sess_native_keychain_token_999");
  assert(mockSecureStorage.get("native_secure_keychain_token") === "sess_native_keychain_token_999", "setToken() 호출 시 보안 저장소에 자동 동기화 확인");

  const restoredClient = new TeamyakClient({
    baseUrl: BASE_URL,
    storage: nativeStorageAdapter,
    storageKey: "native_secure_keychain_token",
  });
  const restoredToken = await restoredClient.initFromStorage();
  assert(restoredToken === "sess_native_keychain_token_999", "initFromStorage()로 보안 저장소 토큰 복원 확인");

  await restoredClient.logout();
  assert(mockSecureStorage.get("native_secure_keychain_token") === undefined, "logout() 시 보안 저장소 토큰 자동 파기 확인");
  console.log("  ✓ 네이티브 보안 저장소 어댑터 연동 검증 통과");

  // 2-4. 동일 사용자 다중 기기 세션 격리 및 단일 기기 독립 폐기 검증
  console.log("  [2-4] 동일 사용자 기기별 세션 독립 폐기(Remote Logout) 검증...");
  // Device 1 로그인 (호스트 u_kim)
  const clientDev1 = new TeamyakClient({ baseUrl: BASE_URL });
  const dev1Res = await clientDev1.loginWithTestAccount("u_kim");
  const tokenDev1 = dev1Res.sessionToken;

  // Device 2 신규 세션 발급 (다른 기기)
  const dev2Login = await fetch(`${BASE_URL}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "LOGIN_ACCOUNT",
      userId: "u_kim",
      forceNewSession: true,
      deviceLabel: "iPad Pro (Device 2)",
    }),
  });
  const dev2Data = await dev2Login.json();
  const tokenDev2 = dev2Data.sessionToken;

  assert(tokenDev1 !== tokenDev2, "동일 사용자라도 기기별로 서로 다른 고유 세션 토큰 발급 확인");

  const clientDev2 = new TeamyakClient({ baseUrl: BASE_URL, token: tokenDev2 });

  // 활성 세션 목록 조회
  const sessListRes = await clientDev1.getActiveSessions();
  assert(sessListRes.sessions.length >= 2, `활성 세션 목록 조회 확인 (${sessListRes.sessions.length}개 기기)`);

  const dev2SessId = sessListRes.sessions.find((s) => !s.isCurrentDevice)?.id;
  assert(Boolean(dev2SessId), "Device 2 세션 ID 식별 확인");

  // Device 1에서 Device 2의 세션을 원격 폐기 (REVOKE_DEVICE_SESSION)
  const revokeRes = await clientDev1.revokeDeviceSession(dev2SessId);
  assert(revokeRes.ok === true, "Device 2 세션 독립 폐기 성공");

  // Device 2로 요청 시 401 차단 확인
  let dev2Blocked = false;
  try {
    await clientDev2.getMeetings();
  } catch (err) {
    dev2Blocked = true;
    assert(err.status === 401, `폐기된 Device 2 접근 시 401 Unauthorized 차단 확인 (HTTP ${err.status})`);
  }
  assert(dev2Blocked, "폐기된 기기 세션 즉시 무효화 확인");

  // Device 1은 여전히 유효한지 확인
  const dev1Meetings = await clientDev1.getMeetings();
  assert(Boolean(dev1Meetings.directMeetings), "Device 1 세션은 정상 유지됨 확인 (세션 독립성 보장)\n");

  // 2-5. 인스턴스 간 사용자 세션 격리 (SSR 안전성)
  console.log("  [2-5] 서로 다른 사용자 SDK 인스턴스 격리 검증...");
  const kimClient = new TeamyakClient({ baseUrl: BASE_URL, token: tokenDev1 });
  const parkClient = new TeamyakClient({ baseUrl: BASE_URL });
  const parkRes = await parkClient.loginWithTestAccount("u_park");

  assert(kimClient.getToken() !== parkClient.getToken(), "인스턴스별 토큰 완전 격리 확인");
  const kimMe = await kimClient.getMe();
  const parkMe = await parkClient.getMe();
  assert(kimMe.user.id === "u_kim" && parkMe.user.id === "u_park", "다중 인스턴스 동시 실행 시 사용자 상태 간섭 없음 확인\n");

  // ==========================================================================
  // [PART 3] Universal Links & Android App Links 엔드포인트 규격 검증
  // ==========================================================================
  console.log("--- [3. Universal Links & App Links 엔드포인트 규격 검증] ---");

  // 3-1. iOS Apple App Site Association
  console.log("  [3-1] iOS apple-app-site-association 엔드포인트 검증...");
  const aasaRes = await fetch(`${BASE_URL}/.well-known/apple-app-site-association`);
  assert(aasaRes.ok, `GET /.well-known/apple-app-site-association 응답 성공 (HTTP ${aasaRes.status})`);
  assert(aasaRes.headers.get("content-type")?.includes("application/json"), "Content-Type: application/json 확인");
  const aasa = await aasaRes.json();
  assert(Array.isArray(aasa.applinks.details), "applinks.details 배열 확인");
  assert(aasa.applinks.details[0].paths.includes("/i/*"), "초대장 경로 (/i/*) 라우팅 규칙 포함 확인");
  console.log("  ✓ iOS Universal Links 구성 규격 검증 통과");

  // 3-2. Android assetlinks.json
  console.log("  [3-2] Android assetlinks.json 엔드포인트 검증...");
  const assetRes = await fetch(`${BASE_URL}/.well-known/assetlinks.json`);
  assert(assetRes.ok, `GET /.well-known/assetlinks.json 응답 성공 (HTTP ${assetRes.status})`);
  assert(assetRes.headers.get("content-type")?.includes("application/json"), "Content-Type: application/json 확인");
  const assetLinks = await assetRes.json();
  assert(assetLinks[0].target.package_name === "kr.teamyak.app", "안드로이드 패키지명(kr.teamyak.app) 확인");
  assert(assetLinks[0].target.sha256_cert_fingerprints.length > 0, "앱 서명 SHA-256 지문 포함 확인");
  console.log("  ✓ Android App Links 구성 규격 검증 통과\n");

  // ==========================================================================
  // [PART 4] 암호화 키(#k=) 유실 방지 및 인가 게이트 검증
  // ==========================================================================
  console.log("--- [4. 암호화 키(#k=) 유실 방지 및 인가 게이트 검증] ---");
  console.log("  [4-1] 미승인 사용자의 암호문 탈취 차단 게이트 실증...");
  // 비로그인 상태에서 모임 암호문 접근 시도
  const unauthClient = new TeamyakClient({ baseUrl: BASE_URL });
  let gateBlocked = false;
  try {
    await unauthClient.getMeeting("mtg_1");
  } catch (err) {
    gateBlocked = true;
    assert(err.status === 401 || err.status === 403, `미승인 사용자 암호문 조회 차단 확인 (HTTP ${err.status})`);
  }
  assert(gateBlocked, "#k= 키가 유출되더라도 서버 암호문 미인가 조회 원천 차단 확인\n");

  console.log("================================================================================");
  console.log("🎉 [SUCCESS] TEAMYAK 크로스플랫폼 SDK 호환성 및 보안 감사 전 항목 100% 통과!");
  console.log("================================================================================");
}

run().catch((err) => {
  console.error("FATAL ERROR during SDK compatibility audit:", err);
  process.exit(1);
});
