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
    const target = `${supabaseUrl}/auth/v1/authorize?provider=kakao&scopes=profile_nickname&redirect_to=${encodeURIComponent(
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
  } catch (e) {
    console.error('Fetch error:', e.message);
  }
}

testAuthorize();
