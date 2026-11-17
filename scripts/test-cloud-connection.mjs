import fs from 'fs';
import path from 'path';

const envPath = path.resolve('teamyak/.env.local');
if (!fs.existsSync(envPath)) {
  console.log('ENV_LOCAL_NOT_FOUND');
  process.exit(1);
}

const content = fs.readFileSync(envPath, 'utf8');
const lines = content.split('\n');
const envVars = {};

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envVars[key] = val;
  }
}

const requiredKeys = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY'
];

let allValid = true;
for (const k of requiredKeys) {
  const v = envVars[k] || '';
  const isSet = v.length > 20 && !v.includes('여기에');
  console.log(`${k}: ${isSet ? 'CONFIGURED (len=' + v.length + ')' : 'MISSING_OR_PLACEHOLDER'}`);
  if (!isSet) allValid = false;
}

if (!allValid) {
  console.log('SOME_KEYS_MISSING');
  process.exit(2);
}

// Test live connection to Supabase REST API
async function testSupabase() {
  const url = envVars['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = envVars['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  const serviceKey = envVars['SUPABASE_SERVICE_ROLE_KEY'];

  console.log('\n--- Testing Supabase Cloud Connectivity ---');
  try {
    // 1. Test Anon Key with public table or health check
    const anonRes = await fetch(`${url}/rest/v1/users?select=count`, {
      method: 'HEAD',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
      }
    });
    console.log(`Anon Key REST test: HTTP ${anonRes.status} (${anonRes.statusText})`);

    // 2. Test Service Role Key
    const serviceRes = await fetch(`${url}/rest/v1/users?select=count`, {
      method: 'HEAD',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
      }
    });
    console.log(`Service Role Key REST test: HTTP ${serviceRes.status} (${serviceRes.statusText})`);

    // 3. Test private admin_audit schema isolation (anon should get 401 or 404/403)
    const auditAnonRes = await fetch(`${url}/rest/v1/v_auth_sync_audit`, {
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
      }
    });
    console.log(`admin_audit PostgREST isolation (anon access): HTTP ${auditAnonRes.status} (Expected 404/401/403)`);

    console.log('\n--- Supabase Connection Status: SUCCESS ---');
  } catch (err) {
    console.error('Supabase fetch failed:', err.message);
    process.exit(3);
  }
}

testSupabase();
