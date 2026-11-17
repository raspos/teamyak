import fs from 'fs';
import path from 'path';

const env = fs.readFileSync(path.resolve('teamyak/.env.local'), 'utf8');
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1];
const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1];

async function check() {
  // Check Supabase Auth users
  const authRes = await fetch(`${url}/auth/v1/admin/users`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  const authData = await authRes.json();
  console.log('--- Supabase Auth Users ---');
  console.log('Count:', authData.users ? authData.users.length : 0);
  if (authData.users) {
    authData.users.forEach(u => console.log('Auth User:', u.id, u.email, u.user_metadata));
  }

  // Check public.users table in Supabase
  const dbRes = await fetch(`${url}/rest/v1/users?select=*`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  const dbUsers = await dbRes.json();
  console.log('\n--- Supabase public.users table ---');
  console.log('Count:', Array.isArray(dbUsers) ? dbUsers.length : 0);
  if (Array.isArray(dbUsers)) {
    dbUsers.forEach(u => console.log('DB User:', u.id, u.display_name, u.account_type));
  }
}

check();
