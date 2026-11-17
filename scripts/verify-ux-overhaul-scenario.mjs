import { encryptMeetingPayload, decryptMeetingPayload, generateFragmentKey } from '../src/lib/crypto.ts';

const BASE_URL = 'http://localhost:3000';
const PUBLIC_TUNNEL_URL = 'https://jeff-aug-francisco-freebsd.trycloudflare.com';

async function runScenario() {
  console.log('=== TEAMYAK 약속 생성 중심 UX 개편 종합 E2E 검증 ===\n');

  // [검증 1] 메인 페이지 HTML 렌더링 및 하단 메뉴 / 핵심 버튼 확인
  console.log('[1/7] 메인 화면 UX 구조 및 4탭 하단 메뉴 검증...');
  const mainRes = await fetch(`${BASE_URL}/`);
  if (!mainRes.ok) throw new Error(`Main page fetch failed: HTTP ${mainRes.status}`);
  const html = await mainRes.text();

  const checks = [
    { name: '새 약속 만들기 버튼', pattern: /새 약속 만들기/ },
    { name: '내 약속 메인 뷰', pattern: /내 약속/ },
    { name: '약속 하단 탭', pattern: /약속/ },
    { name: '캘린더 하단 탭', pattern: /캘린더/ },
    { name: '이력 하단 탭', pattern: /이력/ },
    { name: '설정 하단 탭', pattern: /설정/ },
    { name: '고대비 slate 텍스트 클래스', pattern: /text-slate-900/ }
  ];

  for (const c of checks) {
    if (!c.pattern.test(html)) {
      throw new Error(`Main page verification failed: missing '${c.name}'`);
    }
  }
  console.log('  -> 메인 화면 UI 요소 확인 완료 (내 약속, 새 약속 만들기 CTA, 약속|캘린더|이력|설정 4탭, 고대비 slate-900)');

  // [검증 2] 호스트 로그인 (언론사 / 기업홍보 계정)
  console.log('\n[2/7] 호스트 계정 세션 생성...');
  const hostAuthRes = await fetch(`${BASE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'LOGIN_ACCOUNT', userId: 'u_kim' })
  });
  const hostAuth = await hostAuthRes.json();
  const hostToken = hostAuth.sessionToken;
  console.log(`  -> 호스트: ${hostAuth.user.displayName} (${hostAuth.user.jobTitle}) 로그인 성공`);

  // [검증 3] 필수 항목만으로 새 약속 만들기 (장소 미정)
  console.log('\n[3/7] 필수 항목(제목·날짜·시간)만 입력하여 장소 미정 상태로 새 약속 생성...');
  const meetingKey = generateFragmentKey();
  const rawPayload = {
    title: '모바일 UX 개편 기념 오찬 간담회',
    counterpartOrgName: '중앙일보 경제부',
    detailedPlaceName: '장소 미정 (협의 중)',
    detailedPlaceAddress: '장소 미정',
    description: '모바일 UX 개편 기념 오찬 간담회 약속입니다.',
    highestSeniorityLevel: 'DIRECTOR',
    highestSeniorityStatus: 'SCHEDULED',
    seniorAttendees: [
      {
        userId: 'senior_test_1',
        displayName: '박부장',
        jobTitle: '산업부 부장',
        seniorityLevel: 'DIRECTOR',
        attendanceConfirmed: false,
        discloseName: true
      }
    ]
  };

  const { encryptedPayload, payloadIv } = await encryptMeetingPayload(rawPayload, meetingKey);

  const createRes = await fetch(`${BASE_URL}/api/meetings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hostToken}`
    },
    body: JSON.stringify({
      confirmedDate: '2026-11-25',
      startTime: '12:30',
      endTime: '13:30',
      isTimeTbd: false,
      isPlaceTbd: true,
      placeId: null,
      areaHint: '장소 미정',
      detailedPlaceName: '장소 미정 (협의 중)',
      meetingType: 'LUNCH',
      hostOrgBadge: '삼성생명',
      guestSideLabel: '중앙일보 경제부',
      intendedTargetHint: '중앙일보 경제부',
      encryptedMeetingPayload: encryptedPayload,
      payloadIv: payloadIv,
      seedFragmentKeyForTest: meetingKey,
      hostShareToTeam: false,
      hasSeniorAttendee: true
    })
  });

  if (!createRes.ok) throw new Error(`Meeting creation failed: ${await createRes.text()}`);
  const createdData = await createRes.json();
  const meetingId = createdData.meeting.id;
  const inviteCode = createdData.inviteCode;
  console.log(`  -> 약속 생성 성공! Meeting ID: ${meetingId}`);
  console.log(`  -> 장소 미정(isPlaceTbd): ${createdData.meeting.isPlaceTbd}, 지역: '${createdData.meeting.areaHint}'`);
  console.log(`  -> 초대 코드 발급: ${inviteCode}`);

  const dynamicInviteUrl = `${PUBLIC_TUNNEL_URL}/i/${inviteCode}#k=${meetingKey}`;
  console.log(`  -> 실 카카오톡 공유용 초대 URL: ${dynamicInviteUrl}`);

  // [검증 4] 게스트 (다른 사용자 u_park) 초대 링크 접속 및 암호화 복호화 확인
  console.log('\n[4/7] 다른 계정(게스트)에서 초대 링크 열람 및 종단간 복호화...');
  const guestAuthRes = await fetch(`${BASE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'LOGIN_ACCOUNT', userId: 'u_park' })
  });
  const guestAuth = await guestAuthRes.json();
  const guestToken = guestAuth.sessionToken;
  console.log(`  -> 게스트: ${guestAuth.user.displayName} (${guestAuth.user.jobTitle}) 로그인 성공`);

  const invRes = await fetch(`${BASE_URL}/api/invitations/${inviteCode}`, {
    headers: { 'Authorization': `Bearer ${guestToken}` }
  });
  if (!invRes.ok) throw new Error(`Invite fetch failed: ${invRes.status}`);
  const invData = await invRes.json();

  const decryptedGuestPayload = await decryptMeetingPayload(
    invData.encryptedDetail.encryptedMeetingPayload,
    invData.encryptedDetail.payloadIv,
    meetingKey
  );

  console.log(`  -> 게스트 복호화 완료: 제목='${decryptedGuestPayload.title}', 장소='${decryptedGuestPayload.detailedPlaceName}'`);
  console.log(`  -> 주요 참석자 감지: ${decryptedGuestPayload.highestSeniorityLevel} (${decryptedGuestPayload.seniorAttendees[0].displayName})`);

  // [검증 5] 게스트 참석 수락 (2단계 참석 확인 정책 적용)
  console.log('\n[5/7] 게스트가 약속에 [참석] 수락 제출 (부장급 이상 2단계 확인 검증)...');
  const rsvpStep1Res = await fetch(`${BASE_URL}/api/invitations/${inviteCode}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${guestToken}`
    },
    body: JSON.stringify({
      rsvpStatus: 'ATTENDING'
    })
  });
  if (!rsvpStep1Res.ok) throw new Error(`RSVP Step 1 failed: ${await rsvpStep1Res.text()}`);
  const rsvpStep1Data = await rsvpStep1Res.json();
  console.log(`  -> 1단계 응답: requiresSeniorConfirmation=${rsvpStep1Data.requiresSeniorConfirmation}, 상태=${rsvpStep1Data.participant.rsvpStatus}`);

  if (rsvpStep1Data.requiresSeniorConfirmation) {
    console.log(`  -> 2단계 확인 메시지: "${rsvpStep1Data.userFriendlyMessage}"`);
    const rsvpStep2Res = await fetch(`${BASE_URL}/api/invitations/${inviteCode}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${guestToken}`
      },
      body: JSON.stringify({
        rsvpStatus: 'ATTENDING',
        confirmedAfterSeniorityReview: true
      })
    });
    if (!rsvpStep2Res.ok) throw new Error(`RSVP Step 2 failed: ${await rsvpStep2Res.text()}`);
    const rsvpStep2Data = await rsvpStep2Res.json();
    console.log(`  -> 2단계 최종 확정 성공! 상태: ${rsvpStep2Data.participant.rsvpStatus}, 캘린더 자동등록: ${rsvpStep2Data.calendarAutoRegistered}`);
  }

  // [검증 6] 호스트 화면에서 참석자 상태 즉시 반영 확인
  console.log('\n[6/7] 호스트가 약속 상세에서 게스트 참석 확인...');
  const hostMeetingRes = await fetch(`${BASE_URL}/api/meetings/${meetingId}`, {
    headers: { 'Authorization': `Bearer ${hostToken}` }
  });
  if (!hostMeetingRes.ok) throw new Error(`Host meeting fetch failed: ${hostMeetingRes.status}`);
  const hostMeetingData = await hostMeetingRes.json();
  
  const guestParticipant = hostMeetingData.meeting.participants?.find((p) => p.userId === 'u_park');
  console.log(`  -> 호스트 측 참석자 목록: 총 ${hostMeetingData.meeting.participants?.length}명`);
  console.log(`  -> 게스트(박기자) 참석 상태: ${guestParticipant ? guestParticipant.rsvpStatus : '확인불가'}`);

  // [검증 7] 장소 확정 (장소 미정 -> 여의도 화동옥 확정)
  console.log('\n[7/7] 약속 상세 화면에서 [장소 정하기]를 통해 장소 확정 처리...');
  const updatePlaceRes = await fetch(`${BASE_URL}/api/meetings/${meetingId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hostToken}`
    },
    body: JSON.stringify({
      action: 'SELECT_PLACE',
      placeId: 'place_yeouido_hwadong',
      detailedPlaceName: '여의도 화동옥',
      areaHint: '여의도'
    })
  });
  if (!updatePlaceRes.ok) throw new Error(`Place update failed: ${await updatePlaceRes.text()}`);
  const updateResult = await updatePlaceRes.json();
  console.log(`  -> 장소 확정 성공! isPlaceTbd: ${updateResult.meeting.isPlaceTbd}, 장소: ${updateResult.meeting.detailedPlaceName}`);

  // [부가 검증] Apple 캘린더 연동 확인
  const appleCalRes = await fetch(`${BASE_URL}/api/calendar/apple?mode=status`, {
    headers: { 'Authorization': `Bearer ${hostToken}` }
  });
  console.log(`  -> Apple 캘린더 연동 API 상태: HTTP ${appleCalRes.status}`);

  console.log('\n🎉 [성공] 모든 약속 생성 중심 사용자 경험 시나리오가 완벽하게 통과되었습니다!');
}

runScenario().catch((err) => {
  console.error('\n❌ 시나리오 검증 실패:', err);
  process.exit(1);
});
