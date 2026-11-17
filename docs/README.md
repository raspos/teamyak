# TEAMYAK (팀약) — Phase 1·2 제품 기획 및 운영자 데이터 가시성·보안 설계 안내

본 디렉터리(`teamyak/docs`)와 상위 프로젝트는 다음 산출물을 포함합니다.

1. **모바일 웹 UX 고도화 프로토타입**: [index.html](file:///c:/Users/kimwo/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/teamyak/index.html)
   - 브라우저에서 즉시 실행 가능한 모바일 퍼스트(320px / 390px / 768px / PC 반응형) 프로토타입
   - 카카오톡 인앱 브라우저 UX 모드, 초대장 우선 노출 및 조건부 카카오 로그인 연결(무팀 참석 지원)
   - 호스트 대표(김민준 대리) · 게스트 대표(박서연 기자) · 비참석 팀원(이수현 과장, 최지훈 기자) · 전달 링크 접속자(정우성 기자) · 운영자 3대 역할 감사 뷰 실시간 전환
   - 실제 Web Crypto API (`PBKDF2` + `AES-256-GCM`) 클라이언트 암호화 및 RFC 5545 표준 `.ics` 파일(`UID` 고정 + `SEQUENCE` 버전 증가 + 당일 08:00 `VALARM`) 생성·다운로드
2. **PostgreSQL / Supabase 물리적 분리 스키마 및 RLS 정책**: [schema_and_rls.sql](file:///c:/Users/kimwo/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/teamyak/supabase/schema_and_rls.sql)
   - `personal_meeting_histories` (100% 본인 독점 테이블)와 `team_shared_schedules` (팀 공유 승인 시에만 정제된 요약 행이 복제되는 프로젝션 테이블)의 물리적 분리
3. **TypeScript 도메인 타입 및 암호화/ICS 모듈**:
   - [domain.ts](file:///c:/Users/kimwo/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/teamyak/src/types/domain.ts)
   - [crypto.ts](file:///c:/Users/kimwo/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/teamyak/src/lib/crypto.ts)
   - [ics.ts](file:///c:/Users/kimwo/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/teamyak/src/lib/ics.ts)
