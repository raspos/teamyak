// ============================================================================
// TEAMYAK Phase 3.5 Final — 하이브리드 클라이언트 암호화 & 브라우저 로컬 필터링 엔진
//
// [보안 보완 내역]
// 1. 개인 방문 장소 암호화: personal_meeting_histories 테이블의 평문 visited_place_id를 제거하고
//    encrypted_history_blob(SensitiveHistoryPayload.visitedPlaceId) 내부에만 암호화 저장.
// 2. [지난번 방문한 식당 제외] 브라우저 로컬 처리(filterRecommendationsInBrowser):
//    서버나 외부 AI API에 사용자의 과거 방문 식당 목록을 절대 전송하지 않고,
//    브라우저에서 복호화한 본인 이력으로 후보 목록을 로컬 필터링함.
// 3. 주요 참석자 직급·직함 암호화: 서버 평문 컬럼 대신 SensitiveMeetingPayload 내부에
//    직급 등급(highestSeniorityLevel)과 주요 참석자 명단을 #k= 키로 AES-256-GCM 암호화 저장.
// ============================================================================

export type SeniorityLevel = "STAFF" | "DIRECTOR" | "EXECUTIVE" | "CEO";

export interface EncryptedSeniorAttendeeItem {
  userId: string;
  displayName: string;
  jobTitle: string;
  seniorityLevel: SeniorityLevel;
  attendanceConfirmed: boolean;
  discloseName: boolean;
}

export interface SensitiveMeetingPayload {
  title: string;
  counterpartOrgName: string;
  detailedPlaceName: string;
  detailedPlaceAddress: string;
  naverMapUrl?: string;
  externalBookingUrl?: string;
  description?: string;
  // [보안 보완 4] 주요 참석자 직급 등급·상태·명단을 클라이언트 암호화 페이로드 내부로 편입
  highestSeniorityLevel?: SeniorityLevel;
  highestSeniorityStatus?: "NONE" | "SCHEDULED" | "CONFIRMED";
  seniorAttendees?: EncryptedSeniorAttendeeItem[];
}

export interface SensitiveHistoryPayload {
  title: string;
  counterpartOrgName: string;
  counterpartAliases: string[];
  // [보안 보완 3] 방문 장소 ID와 식당명을 평문 컬럼 대신 암호화 블롭 내부에만 저장
  visitedPlaceId?: string | null;
  detailedPlaceName: string;
  privateMemo: string;
}

export interface PreLoginInviteVault {
  inviteCode: string;
  rsvpIntent: "ATTENDING" | "TENTATIVE" | "DECLINED";
  fragmentKey: string;
  oauthStateNonce: string;
  savedAt: number;
  networkDropRecoveryAvailable?: boolean;
}

const PRE_LOGIN_VAULT_KEY = "teamyak_prelogin_invite_vault_v36";
const BASE32_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof window === "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof window === "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getCryptoSubtle(): SubtleCrypto {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  if (typeof window !== "undefined" && window.crypto?.subtle) {
    return window.crypto.subtle;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("crypto");
  return nodeCrypto.webcrypto.subtle;
}

function getRandomBytes(length: number): Uint8Array {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto.getRandomValues(new Uint8Array(length));
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("crypto");
  return new Uint8Array(nodeCrypto.randomBytes(length));
}

export function generateFragmentKey(): string {
  const bytes = getRandomBytes(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateHighEntropyRecoveryCode(): string {
  const randomBytes = getRandomBytes(28);
  const groups: string[] = ["TYRK"];
  for (let g = 0; g < 7; g++) {
    let block = "";
    for (let i = 0; i < 4; i++) {
      const idx = randomBytes[g * 4 + i] % 32;
      block += BASE32_ALPHABET[idx];
    }
    groups.push(block);
  }
  return groups.join("-");
}

export function validateRecoverySecretStrength(secret: string): {
  valid: boolean;
  estimatedEntropyBits: number;
  reason?: string;
} {
  const trimmed = (secret || "").trim();

  if (/^\d+$/.test(trimmed)) {
    const bits = Math.round(trimmed.length * Math.log2(10));
    return {
      valid: false,
      estimatedEntropyBits: bits,
      reason: `REJECT_WEAK_NUMERIC_PIN: 숫자 PIN(${trimmed.length}자리, 약 ${bits}비트 엔트로피)은 오프라인 무차별 대입 공격(Brute-force)에 의해 수 분 내에 해독될 수 있어 사용할 수 없습니다. 무작위 복구 코드(TYRK-...) 또는 16자 이상의 강력한 복구 암호를 사용하세요.`,
    };
  }

  const normalizedCode = trimmed.toUpperCase().replace(/\s+/g, "");
  if (/^TYRK(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){7}$/.test(normalizedCode)) {
    return { valid: true, estimatedEntropyBits: 140 };
  }

  if (trimmed.length < 16) {
    return {
      valid: false,
      estimatedEntropyBits: trimmed.length * 4,
      reason:
        "REJECT_SHORT_PASSPHRASE: 복구 암호는 최소 16자 이상이거나 시스템이 발급한 28자리 무작위 복구 코드(TYRK-...)여야 합니다.",
    };
  }

  let poolSize = 0;
  if (/[a-z]/.test(trimmed)) poolSize += 26;
  if (/[A-Z]/.test(trimmed)) poolSize += 26;
  if (/[0-9]/.test(trimmed)) poolSize += 10;
  if (/[^a-zA-Z0-9]/.test(trimmed)) poolSize += 32;
  if (/[가-힣]/.test(trimmed)) poolSize += 100;

  const estimatedEntropyBits = Math.round(
    trimmed.length * Math.log2(Math.max(poolSize, 26))
  );
  if (estimatedEntropyBits < 72) {
    return {
      valid: false,
      estimatedEntropyBits,
      reason: `REJECT_LOW_ENTROPY: 추정 엔트로피(${estimatedEntropyBits}비트)가 최소 보안 기준(72비트) 미만입니다.`,
    };
  }

  return { valid: true, estimatedEntropyBits };
}

async function deriveAesKeyFromSecret(
  secret: string,
  saltStr: string,
  iterations = 120000
): Promise<CryptoKey> {
  const subtle = getCryptoSubtle();
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey(
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
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function encryptMeetingPayload(
  payload: SensitiveMeetingPayload,
  fragmentKey: string
): Promise<{ encryptedPayload: string; payloadIv: string }> {
  const subtle = getCryptoSubtle();
  const key = await deriveAesKeyFromSecret(
    fragmentKey,
    "teamyak-meeting-fragment-salt-v3"
  );
  const iv = getRandomBytes(12);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoded
  );
  return {
    encryptedPayload: bytesToBase64(new Uint8Array(cipherBuf)),
    payloadIv: bytesToBase64(iv),
  };
}

export async function decryptMeetingPayload(
  encryptedPayload: string,
  payloadIv: string,
  fragmentKey: string
): Promise<SensitiveMeetingPayload | null> {
  try {
    const subtle = getCryptoSubtle();
    const key = await deriveAesKeyFromSecret(
      fragmentKey,
      "teamyak-meeting-fragment-salt-v3"
    );
    const iv = base64ToBytes(payloadIv);
    const cipherBytes = base64ToBytes(encryptedPayload);
    const plainBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipherBytes as BufferSource
    );
    const jsonStr = new TextDecoder().decode(plainBuf);
    return JSON.parse(jsonStr) as SensitiveMeetingPayload;
  } catch {
    return null;
  }
}

export async function encryptHistoryBlob(
  payload: SensitiveHistoryPayload,
  userMasterSecret: string
): Promise<{ encryptedBlob: string; blobIv: string }> {
  const subtle = getCryptoSubtle();
  const key = await deriveAesKeyFromSecret(
    userMasterSecret,
    "teamyak-history-vault-salt-v3"
  );
  const iv = getRandomBytes(12);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoded
  );
  return {
    encryptedBlob: bytesToBase64(new Uint8Array(cipherBuf)),
    blobIv: bytesToBase64(iv),
  };
}

export async function decryptHistoryBlob(
  encryptedBlob: string,
  blobIv: string,
  userMasterSecret: string
): Promise<SensitiveHistoryPayload | null> {
  try {
    const subtle = getCryptoSubtle();
    const key = await deriveAesKeyFromSecret(
      userMasterSecret,
      "teamyak-history-vault-salt-v3"
    );
    const iv = base64ToBytes(blobIv);
    const cipherBytes = base64ToBytes(encryptedBlob);
    const plainBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipherBytes as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(plainBuf)) as SensitiveHistoryPayload;
  } catch {
    return null;
  }
}

/**
 * [보안 보완 3] 브라우저 로컬에서 복호화된 개인 이력을 바탕으로 '지난번 방문한 식당 제외' 처리
 * - 개인의 과거 방문 장소 목록을 서버나 외부 AI API에 절대 전송하지 않는다!
 */
export function filterRecommendationsInBrowser<
  T extends { placeId: string; placeName: string }
>(
  candidates: T[],
  decryptedMyHistories: SensitiveHistoryPayload[],
  excludePreviouslyVisited: boolean
): {
  filteredRecommendations: T[];
  excludedInBrowserPlaceNames: string[];
} {
  if (!excludePreviouslyVisited) {
    return {
      filteredRecommendations: candidates.slice(0, 5),
      excludedInBrowserPlaceNames: [],
    };
  }

  const visitedIds = new Set<string>();
  const visitedNames = new Set<string>();
  for (const h of decryptedMyHistories) {
    if (h.visitedPlaceId) visitedIds.add(h.visitedPlaceId);
    if (h.detailedPlaceName) visitedNames.add(h.detailedPlaceName.trim());
  }

  const excludedInBrowserPlaceNames: string[] = [];
  const filtered = candidates.filter((item) => {
    const matched =
      visitedIds.has(item.placeId) || visitedNames.has(item.placeName.trim());
    if (matched) {
      excludedInBrowserPlaceNames.push(item.placeName);
      return false;
    }
    return true;
  });

  return {
    filteredRecommendations: filtered.slice(0, 5),
    excludedInBrowserPlaceNames,
  };
}

export async function createRecoveryKeyBackup(
  userMasterSecret: string,
  recoverySecret: string
): Promise<{
  encryptedMasterKeyBackup: string;
  masterKeyIv: string;
  keySalt: string;
  estimatedEntropyBits: number;
}> {
  const check = validateRecoverySecretStrength(recoverySecret);
  if (!check.valid) {
    throw new Error(check.reason || "WEAK_RECOVERY_SECRET_REJECTED");
  }

  const subtle = getCryptoSubtle();
  const saltBytes = getRandomBytes(16);
  const keySalt = bytesToBase64(saltBytes);
  const wrappingKey = await deriveAesKeyFromSecret(
    recoverySecret.trim(),
    `recovery-v35::${keySalt}`,
    310000
  );
  const iv = getRandomBytes(12);
  const encodedSecret = new TextEncoder().encode(userMasterSecret);
  const wrappedBuf = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    wrappingKey,
    encodedSecret
  );
  return {
    encryptedMasterKeyBackup: bytesToBase64(new Uint8Array(wrappedBuf)),
    masterKeyIv: bytesToBase64(iv),
    keySalt,
    estimatedEntropyBits: check.estimatedEntropyBits,
  };
}

export async function recoverMasterKeyFromBackup(
  encryptedMasterKeyBackup: string,
  masterKeyIv: string,
  keySalt: string,
  recoverySecret: string
): Promise<string | null> {
  try {
    const subtle = getCryptoSubtle();
    const wrappingKey = await deriveAesKeyFromSecret(
      recoverySecret.trim(),
      `recovery-v35::${keySalt}`,
      310000
    );
    const iv = base64ToBytes(masterKeyIv);
    const cipherBytes = base64ToBytes(encryptedMasterKeyBackup);
    const plainBuf = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      wrappingKey,
      cipherBytes as BufferSource
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    return null;
  }
}

export function savePreLoginInviteVault(
  inviteCode: string,
  rsvpIntent: "ATTENDING" | "TENTATIVE" | "DECLINED",
  fragmentKey: string,
  customStateNonce?: string
): PreLoginInviteVault {
  const nonceBytes = getRandomBytes(16);
  const oauthStateNonce =
    customStateNonce ||
    Array.from(nonceBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const vault: PreLoginInviteVault = {
    inviteCode,
    rsvpIntent,
    fragmentKey,
    oauthStateNonce,
    savedAt: Date.now(),
    networkDropRecoveryAvailable: true,
  };
  if (typeof window !== "undefined") {
    const serialized = JSON.stringify(vault);
    try {
      window.sessionStorage?.setItem(PRE_LOGIN_VAULT_KEY, serialized);
      window.localStorage?.setItem(PRE_LOGIN_VAULT_KEY, serialized);
    } catch {}
  }
  return vault;
}

export function peekPreLoginInviteVault(): PreLoginInviteVault | null {
  if (typeof window === "undefined") return null;
  const raw =
    window.sessionStorage?.getItem(PRE_LOGIN_VAULT_KEY) ||
    window.localStorage?.getItem(PRE_LOGIN_VAULT_KEY);
  if (!raw) return null;
  try {
    const vault = JSON.parse(raw) as PreLoginInviteVault;
    if (Date.now() - vault.savedAt > 30 * 60 * 1000) {
      clearPreLoginInviteVault();
      return null;
    }
    return vault;
  } catch {
    return null;
  }
}

export function clearPreLoginInviteVault(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.removeItem(PRE_LOGIN_VAULT_KEY);
    window.localStorage?.removeItem(PRE_LOGIN_VAULT_KEY);
  } catch {}
}

export function consumePreLoginInviteVault(
  expectedStateNonce?: string
): PreLoginInviteVault | null {
  const vault = peekPreLoginInviteVault();
  if (!vault) return null;
  if (expectedStateNonce && vault.oauthStateNonce !== expectedStateNonce) {
    return null;
  }
  clearPreLoginInviteVault();
  return vault;
}
