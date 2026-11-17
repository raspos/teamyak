import fs from 'node:fs';

const env = fs.readFileSync('teamyak/.env.local', 'utf8');
const idMatch = env.match(/NAVER_CLIENT_ID="?([^"\r\n]+)"?/);
const secretMatch = env.match(/NAVER_CLIENT_SECRET="?([^"\r\n]+)"?/);
const id = idMatch ? idMatch[1] : '';
const secret = secretMatch ? secretMatch[1] : '';

async function testEndpoints() {
  const tests = [
    {
      name: 'NCP Geocoding',
      url: 'https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode?query=' + encodeURIComponent('분당구 불정로 6'),
      headers: { 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret }
    },
    {
      name: 'NCP Reverse Geocoding',
      url: 'https://naveropenapi.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=127.1058342,37.359708&output=json',
      headers: { 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret }
    },
    {
      name: 'Naver Developers Search (Local)',
      url: 'https://openapi.naver.com/v1/search/local.json?query=' + encodeURIComponent('여의도 맛집'),
      headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret }
    },
  ];

  for (const t of tests) {
    try {
      const res = await fetch(t.url, { headers: t.headers });
      const text = await res.text();
      console.log(`[${t.name}] Status: ${res.status} | Body: ${text.substring(0, 150)}`);
    } catch (e) {
      console.log(`[${t.name}] Error: ${e.message}`);
    }
  }
}

testEndpoints();
