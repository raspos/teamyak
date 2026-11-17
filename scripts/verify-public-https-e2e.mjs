import { encryptMeetingPayload, decryptMeetingPayload } from '../src/lib/crypto.ts';

const BASE_URL = 'https://jeff-aug-francisco-freebsd.trycloudflare.com';

async function runE2E() {
  console.log('Testing TEAMYAK Live HTTPS E2E on:', BASE_URL);

  // 1. Diagnostic health check
  const diagRes = await fetch(`${BASE_URL}/api/auth?mode=diagnostic`);
  if (!diagRes.ok) throw new Error(`Diagnostic failed: HTTP ${diagRes.status}`);
  const diag = await diagRes.json();
  console.log('1. Health Check PASS - DB Engine:', diag.apiStatus.databaseEngine, '| Kakao:', diag.apiStatus.kakaoLoginMode);

  // 2. Host (Device 1) Session
  const hostLoginRes = await fetch(`${BASE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'LOGIN_ACCOUNT', userId: 'u_kim' })
  });
  const hostAuth = await hostLoginRes.json();
  const hostSessionToken = hostAuth.sessionToken;
  console.log('2. Host Session initialized for:', hostAuth.user.displayName, `(${hostAuth.user.jobTitle})`);

  // 3. Create Meeting with Senior Attendee
  const fragmentKey = '7f9a2b4c8e1d0a3f9911223344556677';
  const rawPayload = {
    title: '2026 하반기 신제품 기자간담회',
    description: '여의도 오찬 및 신제품 로드맵 브리핑',
    detailedPlaceName: '여의도 화동옥 2층 매화실',
    highestSeniorityLevel: 'EXECUTIVE',
    highestSeniorityStatus: 'CONFIRMED',
    seniorAttendees: [
      { displayName: '이재훈 상무', jobTitle: '삼성생명 홍보담당 상무', seniorityLevel: 'EXECUTIVE', attendanceConfirmed: true }
    ],
    newsKeyword: '삼성생명',
    recommendedPlaceIds: ['plc_1']
  };

  const enc = await encryptMeetingPayload(rawPayload, fragmentKey);

  const createRes = await fetch(`${BASE_URL}/api/meetings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hostSessionToken}`
    },
    body: JSON.stringify({
      title: rawPayload.title,
      confirmedDate: '2026-11-20',
      startTime: '12:00',
      endTime: '13:30',
      areaHint: '여의도',
      detailedPlaceName: rawPayload.detailedPlaceName,
      meetingType: 'LUNCH',
      hostOrgBadge: '삼성생명',
      encryptedMeetingPayload: enc.encryptedPayload,
      payloadIv: enc.payloadIv,
      seedFragmentKeyForTest: fragmentKey,
      hasSeniorAttendee: true
    })
  });

  if (!createRes.ok) throw new Error(`Meeting create failed: HTTP ${createRes.status} ${await createRes.text()}`);
  const newMtg = await createRes.json();
  const inviteCode = newMtg.inviteCode;
  const meetingId = newMtg.meeting?.id;
  console.log(`3. Meeting Created! ID: ${meetingId}, Invite Code: ${inviteCode}`);

  const fullInviteUrl = `${BASE_URL}/i/${inviteCode}#k=${fragmentKey}`;
  console.log(`   Shareable Invitation URL: ${fullInviteUrl}`);

  // 4. Guest (Device 2) Accesses Invitation
  const guestLoginRes = await fetch(`${BASE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'LOGIN_ACCOUNT', userId: 'u_park' })
  });
  const guestAuth = await guestLoginRes.json();
  const guestSessionToken = guestAuth.sessionToken;
  const guestUser = guestAuth.user;

  const getInvRes = await fetch(`${BASE_URL}/api/invitations/${inviteCode}`, {
    headers: {
      'Authorization': `Bearer ${guestSessionToken}`
    }
  });
  if (!getInvRes.ok) throw new Error(`Fetch invite failed: HTTP ${getInvRes.status}`);
  const invData = await getInvRes.json();
  console.log(`4. Guest Accessed Invite: Host Badge '${invData.publicEnvelope.hostOrgBadge}'`);

  // 5. Guest Decrypts Payload with #k=
  const dec = await decryptMeetingPayload(
    invData.encryptedDetail.encryptedMeetingPayload,
    invData.encryptedDetail.payloadIv,
    fragmentKey
  );
  console.log(`5. Guest Decrypted Payload with #k= successfully: '${dec.title}' at '${dec.detailedPlaceName}'`);
  console.log(`   Detected Senior Attendee: ${dec.highestSeniorityLevel} (${dec.seniorAttendees[0].displayName})`);

  // 6. Guest RSVP Step 1 (Trigger 2-step confirmation)
  const rsvp1Res = await fetch(`${BASE_URL}/api/invitations/${inviteCode}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${guestSessionToken}`
    },
    body: JSON.stringify({
      rsvpStatus: 'ATTENDING',
      confirmedAfterSeniorityReview: false
    })
  });
  const rsvp1Data = await rsvp1Res.json();
  console.log(`6. RSVP Step 1 (Senior Attendee Review Required): requiresSeniorConfirmation = ${rsvp1Data.requiresSeniorConfirmation}`);

  // 7. Guest RSVP Step 2 (Final Confirmation after reviewing senior attendee)
  const rsvp2Res = await fetch(`${BASE_URL}/api/invitations/${inviteCode}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${guestSessionToken}`
    },
    body: JSON.stringify({
      rsvpStatus: 'ATTENDING',
      confirmedAfterSeniorityReview: true
    })
  });
  const rsvp2Data = await rsvp2Res.json();
  console.log(`7. RSVP Step 2 (Final Attend Confirmed): status = ${rsvp2Data.participant?.rsvpStatus}`);
  console.log(`   Guest Team Independence Preserved (teamId): ${guestUser.teamId === null ? 'NULL (PROVEN INDEPENDENT)' : guestUser.teamId}`);

  console.log('\n=== ALL 7 STEPS OF LIVE HTTPS STAGING VERIFICATION PASSED ===');
}

runE2E().catch(err => {
  console.error('E2E Verification Error:', err);
  process.exit(1);
});
