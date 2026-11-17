// ============================================================================
// TEAMYAK Phase 3.7 — 보안 가드레일 (Rate Limiting / Log Masking / CSRF / PII 보호)
// ============================================================================

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitBucket>();

/**
 * 1. API 요청 제한 (Rate Limiting)
 * 기본 분당 60회 초과 시 429 Too Many Requests 반환
 */
export function checkRateLimit(
  identifier: string,
  limitPerMinute = 60
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = rateLimitStore.get(identifier);

  if (!bucket || now > bucket.resetAt) {
    rateLimitStore.set(identifier, {
      count: 1,
      resetAt: now + 60 * 1000,
    });
    return {
      allowed: true,
      remaining: limitPerMinute - 1,
      retryAfterSeconds: 60,
    };
  }

  bucket.count += 1;
  if (bucket.count > limitPerMinute) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, retryAfter),
    };
  }

  return {
    allowed: true,
    remaining: limitPerMinute - bucket.count,
    retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/**
 * 2. 개인정보 로그 마스킹 (PII Log Masking)
 * 이름, 이메일, 세션 토큰, 복구 코드 등 민감 정보를 마스킹하여 로그에 유출되지 않도록 함
 */
export function maskPii(text: string): string {
  if (!text) return "";
  let masked = text;

  // 이름 마스킹 (예: 김민준 -> 김*준, 박서연 -> 박*연)
  masked = masked.replace(/([가-힣])([가-힣])([가-힣])/g, "$1*$3");

  // 세션 토큰 마스킹 (예: sess_123456... -> sess_123456***)
  masked = masked.replace(/(sess_[a-zA-Z0-9_-]{8})[a-zA-Z0-9._-]+/g, "$1***");

  // 복구 코드 마스킹 (예: TYRK-8F92-K4M7... -> TYRK-8F92-****-****)
  masked = masked.replace(/(TYRK-[A-Z0-9]{4}-)[A-Z0-9-]+/g, "$1****-****-****");

  // 이메일 마스킹 (예: seoyeon.park@joongang.co.kr -> se***@joongang.co.kr)
  masked = masked.replace(
    /([a-zA-Z0-9._%+-]{2})[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    "$1***$2"
  );

  return masked;
}

/**
 * 3. URL 암호화 키(#k=) 외부 유출 방지 헬퍼
 * Referer 헤더 및 외부 링크 전달 시 해시 파편(#)을 완벽히 제거
 */
export function sanitizeUrlForExternalSharing(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = ""; // URL fragment(#k=...) 완전 제거!
    return url.toString();
  } catch {
    return rawUrl.split("#")[0];
  }
}

/**
 * 4. 보안 로거
 */
export function secureLog(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const timestamp = new Date().toISOString();
  const safeMessage = maskPii(message);
  if (level === "ERROR") {
    console.error(`[${timestamp}] [SECURITY_LOG] [${level}] ${safeMessage}`);
  } else if (level === "WARN") {
    console.warn(`[${timestamp}] [SECURITY_LOG] [${level}] ${safeMessage}`);
  } else {
    console.log(`[${timestamp}] [SECURITY_LOG] [${level}] ${safeMessage}`);
  }
}
