import fs from 'fs';
import path from 'path';

const envContent = fs.readFileSync(path.resolve('teamyak/.env.local'), 'utf8');
const urlMatch = envContent.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/);
const anonMatch = envContent.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY="([^"]+)"/);

const supabaseUrl = urlMatch ? urlMatch[1] : '';
const anonKey = anonMatch ? anonMatch[1] : '';

console.log('Testing Supabase authorize endpoint for Kakao...');
console.log('Supabase URL:', supabaseUrl);

async function testAuthorize() {
  try {
    const target = `${supabaseUrl}/auth/v1/authorize?provider=kakao&redirect_to=${encodeURIComponent(
      'https://jeff-aug-francisco-freebsd.trycloudflare.com/auth/callback'
    )}`;
    const res = await fetch(target, {
      method: 'GET',
      headers: {
        'apikey': anonKey
      },
      redirect: 'manual'
    });
    console.log('HTTP Status:', res.status);
    const location = res.headers.get('location');
    console.log('Redirect Location:', location);

    if (location && location.includes('kauth.kakao.com')) {
      console.log('SUCCESS: Supabase Auth is correctly configured and redirects to Kakao OAuth!');
    } else if (res.status === 400 || res.status === 422) {
      const body = await res.text();
      console.log('Response body:', body);
      console.log('Notice: Kakao provider might not be enabled yet in Supabase Console -> Authentication -> Providers.');
    } else {
      console.log('Unexpected response:', res.status, location);
    }
  } catch (e) {
    console.error('Fetch error:', e.message);
  }
}

testAuthorize();
