// npm run voices            lists the ElevenLabs voices your key can use
// npm run voices -- raspy   filters by a search word
// Copy a voice_id into ELEVENLABS_VOICE_ID in .env.

import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const key = config.tts.elevenKey;
  if (!key) {
    console.error('Set ELEVENLABS_API_KEY in .env first.');
    process.exit(1);
  }
  const search = process.argv.slice(2).join(' ').trim();
  const voices = [];
  let token = null;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ page_size: '100' });
    if (search) params.set('search', search);
    if (token) params.set('next_page_token', token);
    const res = await fetch(`https://api.elevenlabs.io/v2/voices?${params}`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`ElevenLabs said ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(1);
    }
    const json = await res.json();
    voices.push(...(json.voices || []));
    if (!json.has_more || !json.next_page_token) break;
    token = json.next_page_token;
  }

  if (!voices.length) {
    console.log('No voices found. Add some in the ElevenLabs Voice Library or make one with Voice Design, then run this again.');
    return;
  }
  console.log(`${voices.length} voice(s) available to this key:\n`);
  for (const v of voices) {
    const labels = Object.values(v.labels || {}).filter(Boolean).join(', ');
    const current = v.voice_id === config.tts.voiceId ? '   <-- current' : '';
    console.log(`${v.name}  [${v.category || '?'}]${current}`);
    console.log(`   voice_id: ${v.voice_id}${labels ? `\n   ${labels}` : ''}`);
  }
  console.log('\nPut the one you like in .env as ELEVENLABS_VOICE_ID, then run "npm run check" to hear a sample.');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
