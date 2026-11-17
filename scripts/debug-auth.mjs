const BASE_URL = 'http://localhost:3000';

async function test() {
  const loginRes = await fetch(`${BASE_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'LOGIN_ACCOUNT', userId: 'u_kim' })
  });
  const data = await loginRes.json();
  console.log('Login token:', data.sessionToken);

  const getMeetingsRes = await fetch(`${BASE_URL}/api/meetings`, {
    headers: {
      'Authorization': `Bearer ${data.sessionToken}`
    }
  });
  console.log('GET /api/meetings status:', getMeetingsRes.status);
  const meetingsData = await getMeetingsRes.json();
  console.log('GET /api/meetings body:', meetingsData);
}

test();
