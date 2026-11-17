# TEAMYAK (팀약) — 모바일 웹 실제 서비스 연결 및 스테이징 구축 가이드

> **문서 버전**: v1.1 (Supabase Auth 카카오 통합 및 실연동 검증 반영)  
> **대상 독자**: TEAMYAK 관리자 및 개발 운영자  
> **목적**: 외부 클라우드 계정(Supabase, Kakao Developers)을 실제 연결하고, 모바일 웹 스테이징 서비스를 배포하여 2대의 실기기(스마트폰)에서 종단간 검증을 완료하기 위한 단계별 매뉴얼입니다.

---

## 0. 핵심 아키텍처 및 보안 원칙

1. **Supabase Auth 카카오 통합 (`auth.users` ↔ `public.users` 1:1 동기화)**:
   - 카카오 로그인은 Supabase Auth의 Kakao OAuth Provider를 공식 인증으로 사용합니다.
   - 가입 시 Supabase가 발급한 실제 사용자 UUID(`auth.users.id`)가 PostgreSQL 보안 트리거(`public.handle_new_auth_user()`)를 통해 `public.users.id`로 1:1 자동 복제·동기화됩니다.
   - 따라서 일반 사용자가 Supabase JWT를 통해 쿼리할 때 PostgreSQL 엔진의 `auth.uid()`가 본인 사용자 레코드와 100% 일치하며 RLS 정책이 정확하게 적용됩니다.
2. **관리자 권한(`service_role` 키) 최소화**:
   - `SUPABASE_SERVICE_ROLE_KEY`는 시스템 초기화 및 데이터 보존 파기 배치 작업(30일/37일 만료 처리) 전용으로만 서버 내부에서 제한적으로 사용됩니다.
   - 일반 사용자의 모든 데이터 접근(모임 조회, 참석 수락, 미팅 이력 등)은 본인의 JWT와 RLS를 통해서만 처리되며, 브라우저에는 오직 `NEXT_PUBLIC_SUPABASE_ANON_KEY`만 노출됩니다.
3. **URL Fragment (`#k=...`) 암호화 키 무손실 유지**:
   - 브라우저 표준상 URL의 `#k=...` 해시 프래그먼트는 외부 인증 서버(Kakao/Supabase)로 전송되지 않습니다.
   - TEAMYAK은 카카오 로그인 전 `savePreLoginInviteVault`를 통해 브라우저 `sessionStorage`에 초대장 코드와 암호화 키를 안전하게 보관한 뒤, 로그인 완료 후 `/auth/callback` 페이지에서 이를 원본 URL로 100% 복구합니다.
4. **실제 연결 검증 원칙**:
   - 환경변수가 등록되어 있다는 사실만으로 "연결 완료"로 간주하지 않습니다. 실제 데이터베이스에 쿼리를 실행해 RLS가 작동하고 실제 카카오 계정 인증이 완료되었을 때만 LIVE 상태로 인정합니다.

---

## 1. Supabase 프로젝트 생성

1. [Supabase 공식 홈페이지(supabase.com)](https://supabase.com)에 접속하여 로그인합니다.
2. 대시보드 우측 상단의 **`+ New project`** 버튼을 클릭합니다.
3. 생성 폼에 아래 정보를 입력합니다:
   - **Organization**: 본인의 조직 선택
   - **Name**: `teamyak-staging` (운영 환경일 경우 `teamyak-production`)
   - **Database Password**: 영문 대소문자, 숫자, 특수기호가 포함된 강력한 비밀번호를 입력하고 안전하게 메모합니다.
   - **Region**: 한국 사용자 최저 지연시간을 위해 반드시 **`Northeast (Seoul) [ap-northeast-2]`**를 선택합니다.
   - **Pricing Plan**: Free 또는 Pro 플랜 선택
4. **`Create new project`** 버튼을 클릭하고 데이터베이스 프로비저닝이 완료될 때까지 약 1~2분 대기합니다.

---

## 2. 데이터베이스 스키마 및 마이그레이션 적용

1. Supabase 프로젝트 대시보드 좌측 사이드바에서 **`SQL Editor`** (터미널 아이콘 `>_`) 메뉴를 클릭합니다.
2. 상단의 **`+ New query`** 버튼을 클릭하여 빈 쿼리 편집기를 엽니다.
3. TEAMYAK 프로젝트 폴더 내 **`supabase/schema_and_rls.sql`** 파일의 전체 내용을 복사하여 편집기에 붙여넣습니다.
4. 편집기 우측 하단의 초록색 **`Run`** 버튼을 누르거나 `Ctrl + Enter`를 누릅니다.
5. 쿼리 결과 창에 `Success. No rows returned` 메시지가 출력되는지 확인합니다.
6. 좌측 메뉴의 **`Table Editor`**를 클릭하여 아래 테이블 및 트리거가 생성되었는지 확인합니다:
   - `users` (사용자 프로필, `account_type`, `is_test_account`, 마스터키 백업)
   - `organizations` 및 `teams` (기업 및 부서 정보)
   - `meetings` 및 `meeting_participants` (모임 및 참석자)
   - `meeting_preferences` (음식 취향 및 프라이버시 제약)
   - `place_recommendations` (AI 맞춤 장소 및 조건 검증 상태)
   - `meeting_schedule_changes` (순연 횟수 및 변경 이력)
   - `personal_meeting_histories` (개인별 암호화 미팅 이력)
   - `calendar_connections` (캘린더 연동 및 Apple Webcal 피드 토큰)

---

## 3. 일반 사용자 데이터 접근 권한 및 RLS 검증

1. 좌측 메뉴 **`Table Editor`**에서 `meetings`, `meeting_participants`, `personal_meeting_histories` 테이블을 각각 클릭합니다.
2. 테이블명 우측에 **`RLS` (초록색 방패 아이콘)**가 켜져 있는지 확인합니다.
3. 좌측 하단 톱니바퀴 아이콘인 **`Project Settings`** 클릭 후 **`API`** 탭을 선택합니다.
4. 다음 키 값들을 복사하여 준비합니다:
   - **Project URL**: `https://<your-project-id>.supabase.co`  
     → 환경변수: `NEXT_PUBLIC_SUPABASE_URL`
   - **Project API keys** 섹션:
     - `anon` `public`: 일반 사용자 브라우저 요청용 (RLS 정책 자동 적용)  
       → 환경변수: `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     - `service_role` `secret`: 서버 관리자 전용 (RLS 우회 권한, 절대 프론트엔드 노출 금지)  
       → 환경변수: `SUPABASE_SERVICE_ROLE_KEY`
5. 좌측 메뉴 **`Database`** 탭의 **`Connection String`** 섹션에서 **URI** 탭을 선택합니다:
   - `postgresql://postgres:[YOUR-PASSWORD]@db.<your-project-id>.supabase.co:5432/postgres`  
     → 환경변수: `DATABASE_URL` ([YOUR-PASSWORD] 부분에 1단계에서 설정한 DB 비밀번호 입력)

---

## 4. Kakao Developers 앱 생성

1. [카카오 개발자 콘솔(developers.kakao.com)](https://developers.kakao.com)에 접속하여 카카오 계정으로 로그인합니다.
2. 상단 네비게이션에서 **`내 애플리케이션`**을 클릭합니다.
3. **`애플리케이션 추가하기`** 버튼을 누릅니다.
4. 팝업 창에 입력:
   - **앱 이름**: `팀약 (TEAMYAK)`
   - **사업자명**: 본인 이름 또는 회사명
   - 운영원칙 동의 체크 후 **`저장`** 클릭
5. 생성된 앱의 **`요약 정보`** 화면에서 **`앱 키`** 섹션을 확인합니다:
   - **`REST API 키`** 복사 (이 값이 Supabase 및 환경변수 `KAKAO_CLIENT_ID`가 됨).
   - **`JavaScript 키`** 복사 (선택 사항, `NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY`).

---

## 5. 카카오 로그인 및 Supabase Auth 콜백 설정

> [!IMPORTANT]
> **콜백 URL 차이점 안내**:
> - **Supabase Auth 카카오 콜백**: `https://<your-project-id>.supabase.co/auth/v1/callback`  
>   카카오 개발자 콘솔의 Redirect URI에는 **반드시 이 Supabase Auth 콜백 URL을 등록**해야 합니다. 이를 통해 Supabase가 카카오 인가를 대행하고 정식 JWT(`auth.users.id`)를 발행합니다.
> - **자체 개발/테스트 콜백**: `https://<staging-domain>/api/auth?mode=kakao_callback`  
>   이 주소는 과거 자체 HMAC 세션 테스트 전용 엔드포인트이며, 실서비스 RLS 연동을 위해서는 위의 Supabase Auth 콜백을 사용합니다.

### 5-1. Kakao Developers 콘솔 설정
1. 카카오 콘솔 좌측 메뉴에서 **`제품 설정 -> 카카오 로그인`**을 클릭합니다.
2. **`활성화 설정`** 토글 버튼을 눌러 상태를 **`ON`**으로 변경합니다.
3. 페이지 하단의 **`Redirect URI`** 섹션에서 **`Redirect URI 등록`** 버튼을 클릭합니다.
4. 다음 주소를 등록합니다:
   - **`https://<your-project-id>.supabase.co/auth/v1/callback`** (필수)
   - *(로컬 테스트 병행 시)*: `http://localhost:3000/api/auth?mode=kakao_callback`
5. 좌측 메뉴에서 **`제품 설정 -> 카카오 로그인 -> 보안`**을 클릭합니다:
   - **`Client Secret`** 항목에서 **`코드 생성`** 버튼을 눌러 비밀키를 발급받습니다.  
     → 환경변수: `KAKAO_CLIENT_SECRET`
   - **`활성화 상태`**를 **`사용함`**으로 설정합니다.
6. 좌측 메뉴에서 **`제품 설정 -> 카카오 로그인 -> 동의항목`**을 클릭합니다:
   - **닉네임**: `필수 동의`
   - **카카오계정(이메일)**: `선택 동의`

### 5-2. Supabase 콘솔에서 Kakao Provider 활성화
1. Supabase 대시보드 좌측 메뉴에서 **`Authentication -> Providers`**를 클릭합니다.
2. 목록에서 **`Kakao`**를 찾아 펼칩니다.
3. **`Enable Kakao`** 토글을 켭니다.
4. 값을 입력합니다:
   - **Kakao client ID**: 카카오의 `REST API 키` 입력
   - **Kakao client secret**: 카카오 보안 메뉴에서 발급한 `Client Secret 코드` 입력
5. **`Save`**를 클릭하여 저장합니다.

---

## 6. 스테이징 도메인 연결 (Vercel 배포 기준)

1. [Vercel(vercel.com)](https://vercel.com)에 로그인 후 **`Add New... -> Project`**를 클릭합니다.
2. TEAMYAK Git 저장소를 선택하고 **`Import`**를 클릭합니다.
3. 프로젝트 설정:
   - **Project Name**: `teamyak-staging`
   - **Framework Preset**: `Next.js`
   - **Root Directory**: `./teamyak` (프로젝트 루트가 teamyak 하위인 경우)
4. 배포 후 자동 할당되는 도메인을 확인합니다:
   - 예: `https://teamyak-staging.vercel.app`  
     → 환경변수 `BASE_URL` 및 `NEXT_PUBLIC_APP_URL`의 값으로 사용

---

## 7. 환경변수 등록

Vercel 대시보드의 **`Project Settings -> Environment Variables`** (또는 로컬의 `.env.local`)에 아래 변수들을 정확히 입력합니다:

| 환경변수명 | 값 예시 / 설명 | 비고 |
| :--- | :--- | :---: |
| `NODE_ENV` | `production` | 공통 |
| `APP_ENV` | `staging` | 공통 |
| `BASE_URL` | `https://teamyak-staging.vercel.app` | 스테이징 도메인 |
| `NEXT_PUBLIC_APP_URL` | `https://teamyak-staging.vercel.app` | 스테이징 도메인 |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<your-project-id>.supabase.co` | Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGciOi...` (Supabase Anon Key) | 브라우저 공개 가능 |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi...` (Supabase Service Role Key) | **서버 전용 (비밀)** |
| `DATABASE_URL` | `postgresql://postgres:[PW]@db.<your-project-id>.supabase.co:5432/postgres` | **서버 전용 (비밀)** |
| `SESSION_HMAC_SECRET` | 64자리 무작위 16진수 문자열 | **서버 전용 (비밀)** |
| `KAKAO_CLIENT_ID` | 카카오 REST API 키 | **비밀** |
| `KAKAO_CLIENT_SECRET` | 카카오 Client Secret 코드 | **비밀** |
| `KAKAO_REDIRECT_URI` | `https://<your-project-id>.supabase.co/auth/v1/callback` | Supabase Auth 콜백 |

> **SESSION_HMAC_SECRET 생성 방법**:  
> 로컬 터미널에서 다음 명령어를 실행하여 출력된 문자열을 복사합니다:  
> `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## 8. 실제 로그인 및 RLS 일치 검증

1. **진단 엔드포인트를 통한 사전 점검**:  
   브라우저에서 `https://<staging-domain>/api/auth?mode=diagnostic` 접속.  
   - `"storageEngine": "CLOUD_SUPABASE_POSTGRES"`
   - `"kakao": { "isConfigured": true, "mode": "LIVE_KAKAO_OAUTH" }`  
   위 상태가 확인되면 클라우드 환경이 준비된 것입니다.
2. **실제 카카오 로그인 및 사용자 식별 확인**:
   - 메인 화면에서 `카카오 1초 로그인` 클릭.
   - 카카오 공식 인증창 → 동의 → Supabase Auth → `/auth/callback` → 메인 화면 리디렉션 흐름 진행.
3. **RLS 및 auth.uid() 정합성 검증**:
   - Supabase 콘솔의 **`SQL Editor`**에서 아래 쿼리를 실행하여 `auth.users`와 `public.users`의 UUID가 일치하는지 확인합니다:
     ```sql
     SELECT 
       au.id AS auth_user_id,
       pu.id AS public_user_id,
       pu.display_name,
       pu.account_type,
       (au.id = pu.id) AS id_matches_auth_uid
     FROM auth.users au
     JOIN public.users pu ON au.id = pu.id
     ORDER BY au.created_at DESC
     LIMIT 5;
     ```
   - `id_matches_auth_uid`가 **`true`**로 출력되면 Supabase Auth와 TEAMYAK의 사용자 식별이 100% 일치하며 일반 사용자 권한으로 RLS가 정상 동작하는 것입니다.

---

## 9. 실제 모임 생성 및 참석 수락 (2인 E2E 검증)

두 대의 스마트폰(또는 서로 다른 브라우저 세션)에서 다음 흐름을 테스트합니다:

### [사용자 A — 기업 홍보팀 담당자 (기기 1)]
1. 카카오 로그인 후 모임 일시, 장소(`여의도 화동옥`)를 입력합니다.
2. `주요 참석자`에 부장급 이상 임원(`이재훈 상무`)을 등록합니다.
3. **`모임 생성하기`** 버튼을 누릅니다.
4. 생성된 카카오톡 초대장 링크를 복사하여 사용자 B에게 카카오톡으로 전송합니다.  
   *(초대 링크 형식: `https://<staging-domain>/i/inv_...#k=...`)*

### [사용자 B — 언론사 출입 기자 (기기 2)]
1. 스마트폰에서 전송받은 초대 링크를 탭합니다.
2. **비로그인 상태 확인**: 모임 기본 개요와 함께 "주요 참석자 포함 모임" 배지가 표시되나, 상세 직급/이름은 블라인드 처리되어 있음을 확인합니다.
3. 하단 **`참석`** 버튼을 누르고 **카카오 로그인**을 진행합니다.
4. **URL fragment (#k=) 복원 확인**: 카카오 로그인을 거쳐 복귀한 후에도 URL에 `#k=...` 암호키가 유실되지 않고 유지되는지 확인합니다.
5. **👔 주요 참석자 사전 확인 2단계 창**이 나타납니다:
   - `• 이재훈 (상무) — 참석 예정` 명단 확인
6. **`✓ 직급 확인 완료 — 참석 최종 확정하기`** 버튼을 클릭합니다.
7. 화면에 `[ATTENDING] 참석 등록 완료` 메시지가 표시되는지 확인합니다.
8. **독립 참여 확인**: 사용자 B의 계정 소속이 기업 홍보팀으로 강제 편입되지 않고 언론사/개인 계정 상태(`teamId: null`)로 안전하게 유지되는지 확인합니다.

---

## 10. Apple Calendar 실제 아이폰 연결 (Webcal 구독)

1. 사용자 B의 **아이폰 Safari 브라우저**에서 참석 완료 화면 하단의 **`아이폰 기본 캘린더 (Apple Calendar) 1초 구독`** 버튼을 탭합니다.
2. iOS 시스템 팝업 노출: *“'팀약 일정' 캘린더를 구독하시겠습니까?”*
3. **`구독`** → **`추가`**를 차례로 누릅니다.
4. 아이폰 홈 화면의 기본 **`캘린더`** 앱을 실행하여 모임 일시에 **`팀약 일정`**이 등록되었는지 확인합니다.
5. **일정 변경 동기화 테스트**:
   - 기기 1(사용자 A)에서 모임 시간을 30분 뒤로 순연 변경합니다.
   - 기기 2의 아이폰 캘린더에서 해당 일정이 동일 UID를 유지한 채 변경된 시간으로 자동 갱신되는지 확인합니다.

---

## 11. 체크리스트 요약

- [ ] Supabase Seoul 리전 프로젝트 생성 완료
- [ ] `schema_and_rls.sql` 전체 스키마 및 `handle_new_auth_user()` 트리거 실행 완료
- [ ] Kakao Developers 애플리케이션 생성 및 REST API 키 / Client Secret 발급
- [ ] 카카오 Redirect URI에 `https://<your-project-id>.supabase.co/auth/v1/callback` 등록
- [ ] Supabase Dashboard -> Authentication -> Providers -> Kakao 활성화 완료
- [ ] Vercel 스테이징 환경변수 등록 완료 (service_role 키는 절대 브라우저 노출 금지)
- [ ] `/api/auth?mode=diagnostic`에서 실제 클라우드 연결 상태 확인
- [ ] 카카오 로그인 후 `auth.users.id` = `public.users.id` 및 RLS 작동 확인
- [ ] 카카오 로그인 리디렉션 전후 초대장 URL `#k=` 암호키 100% 무손실 복구 확인
- [ ] 실기기 2대 E2E 검증 (모임 생성 → 초대 → 부장급 확인 → 독립 참석 수락)
- [ ] 아이폰 기본 캘린더 Webcal 1초 구독 및 일정 순연 자동 동기화 확인
