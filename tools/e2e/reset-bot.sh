#!/bin/sh
# Puts the fake bot folder back to its starting state before an end-to-end run.
set -e
cd "$(dirname "$0")/bot"
mkdir -p data node_modules/discord.js ../shots
printf '{}' > node_modules/discord.js/package.json
cat > .env <<'ENV'
# Gremlin settings.
DISCORD_TOKEN=OLD-SECRET-DISCORD
ANTHROPIC_API_KEY=OLD-SECRET-ANTHROPIC
DEEPGRAM_API_KEY=
ELEVENLABS_API_KEY=OLD-SECRET-ELEVEN
ELEVENLABS_VOICE_ID=0lp4RIz96WD1RUtvEu3Q
BOT_NAME=Winslow
BOT_ALIASES=
# How often it jumps in
CHATTINESS=low
WEB_SEARCH=true
CLAUDE_EFFORT=high
STT_PROVIDER=whisper
WHISPER_MODEL=large-v3-turbo
WHISPER_PORT=8199
CUSTOM_UNKNOWN=keep me
ENV
printf '# Personality\n\nYou are a cheerful voice companion.\n' > persona.md
printf '[]' > data/received.json
printf '{}' > node_modules/.package-lock.json
cat > data/memory.json <<'JSON'
{
  "guilds": {
    "230425884790620160": {
      "facts": [],
      "optouts": [],
      "chattiness": "medium",
      "calls": [
        { "id": "c1", "at": "2026-10-23T03:10:00.000Z", "minutes": 95, "server": "The Pressure Chamber", "channel": "Gaming", "people": ["Daniel", "Weevil"], "summary": "Played Zomboid until 2am. Weevil planned a rematch." },
        { "id": "c2", "at": "2026-10-24T02:00:00.000Z", "minutes": 40, "server": "The Pressure Chamber", "channel": "Gaming", "people": ["Daniel", "Mike"], "summary": "Talked about the new patch and who carries." }
      ]
    }
  }
}
JSON
mkdir -p whisper
cat > whisper/setup-whisper.ps1 <<'PS'
# Fake Whisper setup for the app's end-to-end test: talks, then takes its time.
Write-Host 'Setting up Whisper (fake).'
Write-Host 'Downloading the model...'
Start-Sleep -Seconds 120
Write-Host 'Done.'
PS
# The usage numbers are for "today" in the bot's time zone, whatever day the test runs.
node -e "
const fs = require('fs');
const f = 'data/usage.json';
const todayData = { ttsChars:6053, ttsRequests:42, ttsDollars:0.24212, sttSeconds:688.96, sttRequests:261, sttDollars:0, claudeRequests:100, claudeInput:150794, claudeOutput:2909, claudeCacheRead:221061, claudeCacheWrite:44233, claudeSearches:3, claudeDollars:0.28 };
const monthData = { ...todayData, ttsDollars:1.767476, claudeDollars:2.044 };
const d = { version:1, days:{ seed:todayData }, months:{ seed:monthData } };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const [day] = Object.keys(d.days);
if (day !== today) d.days = { [today]: d.days[day] };
d.months = { [today.slice(0, 7)]: Object.values(d.months)[0] };
fs.writeFileSync(f, JSON.stringify(d));
"
