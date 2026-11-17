# TEAMYAK 개발자 자격증명 및 클라우드 서비스 연동 가이드

> **대상**: TEAMYAK 개발팀 및 인프라 운영자  
> **목적**: Supabase, Kakao, Google, Naver 실제 API 자격증명 발급 및 배포 환경 설정 절차

---

## 1. Supabase Cloud PostgreSQL 설정 절차

1. **프로젝트 생성**:
   - [Supabase Console](https://supabase.com/dashboard)에 로그인하여 새 프로젝트(`teamyak-production` 또는 `teamyak-staging`)를 생성합니다.
   - Region: `ap-northeast-2 (Seoul)`을 선택합니다.
2. **데이터베이스 스키마 및 RLS 적용**:
   - Supabase 대시보드 좌측 메뉴의 **SQL Editor**로 이동합니다.
   - 프로젝트 내 `supabase/schema_and_rls.sql` 파일의 전체 내용을 붙여넣고 **Run**을 실행합니다.
   - 16개 핵심 테이블, RLS 정책, 2단계 마이그레이션 구문이 일괄 생성됩니다.
3. **API Keys 확인 및 환경변수 등록**:
   - 대시보드 **Project Settings -> API**로 이동합니다.
   - `Project URL`: `NEXT_PUBLIC_SUPABASE_URL`로 복사
   - `Project API Keys -> anon / public`: `NEXT_PUBLIC_SUPABASE_ANON_KEY`로 복사 (일반 사용자 세션 및 RLS 전용)
   - `Project API Keys -> service_role / secret`: `SUPABASE_SERVICE_ROLE_KEY`로 복사 (보존 정책 자동 파기 배치 전용)

---

## 2. Kakao Developers (카카오 로그인 & 공유) 설정 절차

1. **애플리케이션 등록**:
   - [Kakao Developers](https://developers.kakao.com) 콘솔에 로그인 후 **내 애플리케이션 -> 애플리케이션 추가하기**를 클릭합니다.
   - 앱 이름: `팀약 (TEAMYAK)`
2. **플랫폼 Web 사이트 도메인 등록**:
   - **앱 설정 -> 플랫폼 -> Web**에 서비스 도메인을 등록합니다.
   - 예: `https://teamyak.kr`, `https://staging.teamyak.kr`, `http://localhost:3000`
3. **카카오 로그인 활성화 & Redirect URI 등록**:
   - **제품 설정 -> 카카오 로그인 -> 활성화 설정**을 `ON`으로 변경합니다.
   - **Redirect URI 등록**:
     - 운영: `https://teamyak.kr/api/auth?mode=kakao_callback`
     - 스테이징: `https://staging.teamyak.kr/api/auth?mode=kakao_callback`
     - 로컬: `http://localhost:3000/api/auth?mode=kakao_callback`
4. **보안 코드 (Client Secret) 발급**:
   - **제품 설정 -> 카카오 로그인 -> 보안**에서 Client Secret을 생성하고 활성화(`ON`)합니다.
5. **환경변수 매핑**:
   - REST API 키 -> `KAKAO_CLIENT_ID`
   - Client Secret 코드 -> `KAKAO_CLIENT_SECRET`
   - JavaScript 키 -> `NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY` (카카오톡 인앱 공유용)

---

## 3. Google Cloud Console (Google Calendar API) 설정 절차

1. **프로젝트 생성 및 API 활성화**:
   - [Google Cloud Console](https://console.cloud.google.com)에서 새 프로젝트 `TEAMYAK`을 생성합니다.
   - **API 및 서비스 -> 라이브러리**에서 `Google Calendar API`를 검색하여 **사용**을 클릭합니다.
2. **OAuth 동의 화면 구성**:
   - 사용자 유형: `외부(External)`
   - 앱 이름: `팀약 (TEAMYAK)`
   - 범위(Scope): `https://www.googleapis.com/auth/calendar.events` (일정 생성 및 관리)
3. **OAuth 2.0 클라이언트 ID 생성**:
   - **사용자 인증 정보 -> 사용자 인증 정보 만들기 -> OAuth 클라이언트 ID**
   - 애플리케이션 유형: `웹 애플리케이션`
   - 승인된 리디렉션 URI:
     - 운영: `https://teamyak.kr/api/calendar/google?mode=callback`
     - 스테이징: `https://staging.teamyak.kr/api/calendar/google?mode=callback`
     - 로컬: `http://localhost:3000/api/calendar/google?mode=callback`
4. **환경변수 매핑**:
   - 클라이언트 ID -> `GOOGLE_CLIENT_ID`
   - 클라이언트 보안 비밀 -> `GOOGLE_CLIENT_SECRET`

---

## 4. Naver Developers (네이버 검색 API) 설정 절차

1. **애플리케이션 등록**:
   - [네이버 개발자센터](https://developers.naver.com) 콘솔에서 **Application -> 애플리케이션 등록**을 클릭합니다.
   - 애플리케이션 이름: `TEAMYAK`
2. **사용 API 선택**:
   - `검색` API 선택 (뉴스 검색 및 지역 검색)
3. **환경변수 매핑**:
   - Client ID -> `NAVER_CLIENT_ID`
   - Client Secret -> `NAVER_CLIENT_SECRET`
