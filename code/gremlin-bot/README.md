# Gremlin

An AI that sits in your Discord voice call and talks back. It hears everyone, answers when someone says its name, jumps in on its own when something's funny, and can playfully roast people when you ask. Personality: friendly, upbeat and good-humored.

- **Brain:** Claude (Sonnet 5.5 for answers and its own jokes, Haiku 5.5 for quick back-and-forth), with web search for anything current; optionally Venice's models for some lines (see "Optional Venice integration")
- **Ears:** Deepgram speech-to-text
- **Voice:** ElevenLabs (pick any character voice you like)
- **Home:** a small Linux server (about $6/month), so it's always available

Setup takes about an hour the first time, mostly creating accounts. You fill in one settings file and double-click two scripts.

---

## What it costs

| Piece | Cost |
|---|---|
| Server (DigitalOcean 1 GB) | $6/month |
| Claude | roughly 25 to 40 cents per hour of calls (measured in October 2026), plus roughly 7 cents an hour for its own jokes on medium chattiness (about half a cent each time it looks for one, with Sonnet; about half that on low) |
| Venice (optional) | Model-dependent API usage; tracked separately in `/usage`. |
| Hearing | Free with Whisper on your NVIDIA graphics card (see "Free hearing with Whisper" below). Otherwise Deepgram: roughly 20 to 30 cents per hour of calls with 4 people talking ($0.0043 a minute, plus $0.0013 for boosting names), paid from the $200 free credit at first |
| Web search | Roughly 2 to 5 cents per search ($10 per 1,000 searches, plus the pages it reads). It only searches when an answer depends on current or exact facts, at most twice per answer: 20 lookups a week is about $3 to $6 a month. Capped at 100 searches a day. |
| Screen looks | About half a cent each time you ask it to look at your screen (the picture is sent with that one question) |
| Call memory | A fraction of a cent per note, so a few cents for a long night (the fast model writes them) |
| Songs | About 15 cents a minute of song with ElevenLabs Music (a 30-second song is about 8 cents), capped at `SONG_MINUTES_PER_MONTH` (10 by default). Paid ElevenLabs plans include some music minutes; the key needs access to Music. |
| Pictures | About 3.4 cents a picture with Google Gemini ("Nano Banana 2.1", 1K size), plus a fraction of a cent for its thinking. Capped at `IMAGES_PER_MONTH` (100 by default, about $3.40). Needs a Gemini API key with billing on; Google has no free tier for pictures. |
| ElevenLabs | Speech costs 0.2 credits per character on Starter (about $0.04 per 1,000 characters), so a typical line is about 20 credits and a 6-hour night about 1,500 to 6,000 credits, depending on how often people talk to it. Starter ($6/month) includes 30,000 credits a month (roughly 50 hours of typical calls) and unlocks the Voice Library. Extra credits can be added as you go. Voices with a $ icon in the Voice Library charge a creator surcharge on top, which can double the cost. These prices are for `eleven_flash_v2_5` and `eleven_v4_turbo`; `eleven_v4` costs twice as much. |

In practice (late October 2026: two and a half to five hours a night, six nights a week, Whisper doing the hearing) it came to about $1.50 a night, roughly $40 a month. Its own jokes on medium add roughly 40 to 50 cents a night (Sonnet plus the voice), about half that on low. With Deepgram instead, and the bot on a server, it's about $25 to $35 while Deepgram's free credit lasts, then about $55 to $75. Type **/usage** in Discord to see what it has actually used (only you see the answer). Set a monthly spending limit in the Anthropic Console so nothing can surprise you.

---

## Step 1: Create the Discord bot (10 min)

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it **Gremlin** (or whatever you'll call it in voice).
2. **Installation** page: set **Install Link** to **None** and save. (This lets you make the bot private in the next step.)
3. **Bot** page:
   - Click **Reset Token**, copy the token. You'll paste it into `.env` as `DISCORD_TOKEN`. Discord only shows it once.
   - Turn **Public Bot** off, so only you can add it to servers.
   - Optional: turn on **Presence Intent** if you want it to know what game everyone is playing (then set `ENABLE_PRESENCE=true` in `.env`). Gives it more to talk about.
4. Optional: upload an avatar on the **General Information** page.

You'll invite it to your server in Step 6. The bot prints its invite link when it starts.

## Step 2: Claude API key (5 min)

1. Go to <https://console.anthropic.com> and sign up. This is separate from a Claude.ai subscription.
2. Add a little credit under **Billing** ($5 lasts a long time) and set a monthly limit under **Limits**.
3. **API Keys** > **Create Key**. Copy it into `.env` as `ANTHROPIC_API_KEY`.

## Step 3: Deepgram key (3 min)

1. Sign up at <https://console.deepgram.com>. New accounts get $200 of free credit, no card needed.
2. **API Keys** > create a key, copy the secret into `.env` as `DEEPGRAM_API_KEY`.

## Step 4: ElevenLabs key and a voice (10 min)

1. Sign up at <https://elevenlabs.io>. The Starter plan is worth it here: the Free plan can't use Voice Library voices through the API and is for non-commercial use with attribution.
2. **Developers** > **API Keys** > create a key. If it asks about permissions, allow Text to Speech, Voices (read) and User (read). Copy it into `.env` as `ELEVENLABS_API_KEY`.
3. Pick the voice. This is where the comedy lives:
   - **Voice Library:** search things like "warm", "friendly", "storyteller", "narrator", "cartoon". Click **Add to my voices**.
   - **Voice Design:** describe one, like "a warm, friendly voice with an easygoing, cheerful energy".
   - Copy the voice ID (in the voice's menu) into `.env` as `ELEVENLABS_VOICE_ID`. Or run `npm run voices` later to list the IDs.
   - Skip ElevenLabs' old built-in default voices: they're being retired on December 31, 2026.

## Step 5: Fill in `.env` and test on your PC (15 min, recommended)

1. Double-click **`edit-settings.bat`**. It creates your `.env` settings file and opens it in Notepad. Paste in your keys and save. Everything else has sensible defaults.
2. Install **Node.js LTS** from <https://nodejs.org> (version 22.12 or newer).
3. Double-click **`start-windows.bat`**. It installs what it needs, then runs a pre-flight check:

   ```
   OK    Discord bot token: Gremlin (in 0 servers)
   OK    Claude claude-sonnet-5-5 (thinking: between_tools): 840 ms: "..."
   OK    ElevenLabs voice (eleven_flash_v2_5, pcm_24000): first audio in 310 ms ...
   OK    Speech-to-text (deepgram): 420 ms, heard: "Testing, testing..."
   ```

   It also saves `data/voice-test.wav`. Play it to hear the voice you picked.
4. When it starts, the window shows an **invite link**. Open it, pick your server, and authorize. (You need Manage Server permission there.)
5. In Discord: hop into a voice channel and type **/join**. Then say "Gremlin, introduce yourself."

Close the window to stop it.

## Step 6: Put it on a server so it's always on (15 min)

Discord voice needs a real server. App hosts like Railway have known problems with Discord voice, so use a plain Linux server. DigitalOcean is the easiest; any Ubuntu server works.

1. **Make an SSH key** (one time). Open PowerShell and run:

   ```powershell
   ssh-keygen -t ed25519
   ```

   Press Enter at every question. Then copy your public key:

   ```powershell
   Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
   ```

2. **Create the server** at <https://cloud.digitalocean.com>: **Create** > **Droplets**
   - Region: **San Francisco** (closest to you, so less lag)
   - Image: **Ubuntu 24.04 LTS**
   - Size: **Basic**, **Regular**, **$6/month** (1 GB)
   - Authentication: **SSH Key** > **New SSH Key** > paste > add
   - Create it and copy its **IP address**.
3. **Stop the copy on your PC** if it's running. Two copies means two Gremlins answering.
4. Double-click **`deploy\deploy-to-server.bat`**. Type `root@` followed by the IP (like `root@203.0.113.10`). The first time, type `yes` when it asks to trust the server. First setup takes 3 to 5 minutes. It tests your keys on the server (the same OK/FAIL lines as above) and ends with **Gremlin is running.** If a key fails, it asks before going live: type `n`, fix `.env`, and run it again.

That's it. It restarts itself if it crashes and when the server reboots. Each deploy builds the new version next to the old one, and if the new one won't start, it puts the old one back automatically.

- **Watch the live log:** double-click `deploy\server-logs.bat`.
- **Change anything** (`.env`, `persona.md`, `lore.md`): edit it on your PC, double-click `deploy-to-server.bat` again.

The deploy script also locks the server down: firewall with only SSH open (the bot needs no open ports), automatic security updates, and the bot runs as its own restricted account that can only write to its data folder.

---

## Free hearing with Whisper (NVIDIA graphics card)

Transcribing everyone in the call is the biggest running cost. With an NVIDIA graphics card, Whisper can do it on your PC for free, and the audio never leaves your computer.

1. Press **Run Whisper setup** on Home in the app (or double-click **setup-whisper.bat**) once. It downloads about 4 GB (a private copy of Python, the NVIDIA math library and the Whisper large-v3 model) into `%LOCALAPPDATA%\WinslowWhisper`, outside OneDrive, and tests it on your graphics card. It takes 5 to 15 minutes. If the download stops, run it again: it picks up where it left off.
2. In the app, set Settings > Hearing > Speech-to-text to `whisper` (or in `.env`, `STT_PROVIDER=whisper`).
3. Restart the bot (Restart in the app, or close the start-windows.bat window and start it again). The start-up check shows a line like `OK  Speech-to-text (Whisper large-v3 on your graphics card): 250 ms`.

While the bot runs, Whisper uses about 4.5 GB of graphics memory, or about 2.5 GB with `WHISPER_MODEL=large-v3-turbo` (nearly as accurate and over twice as fast; run the Whisper setup again after switching models, and the app offers to). It frees the memory 5 minutes after the bot stops, or right away with the button on Home. If Whisper isn't running for any reason, Deepgram takes over automatically (and costs money again) as long as there's a Deepgram key; without one, the bot can't hear until Whisper is back. Whisper needs your PC, so with it the bot runs on your PC rather than on the server. To remove it, delete the `WinslowWhisper` folder.

## Faster replies and a name detector (with Whisper)

With Whisper, two small models also run on your processor (not the graphics card), each taking a few hundredths of a second when it's asked:

- **End of turn (Smart Turn):** when someone pauses for a fifth of a second, it judges from the sound whether they're done talking. If they are, the bot answers right away instead of waiting the full `SILENCE_MS`; if they're only thinking ("um..."), it keeps waiting. It ships in `whisper/extras` and is on by default (`SMART_TURN`). If it cuts people off, turn it off in Settings > Hearing.
- **Name detector:** a small model trained on the bot's name as a sound, so it catches its name even when the words come out wrong ("Table, what time is it?"), and while the bot is talking it listens for its name every 0.3 seconds, so it stops sooner when someone says it. It needs a model for the bot's name in `whisper/extras`, named after `BOT_NAME` in lowercase (for Babel, `whisper/extras/babel.onnx`). Without one, everything works as before. `NAME_DETECTOR_THRESHOLD` (Settings > Hearing) is how sure it must be that its name was said; raise it if it reacts to words that only sound like its name. A name it catches only by sound gets a reply that can still pass if the sentence was clearly for someone else, and it doesn't listen this way to a mic that has played its voice back.

To make a name detector for a new name, open `whisper/train-name-detector.ipynb` in Google Colab (free, with a T4 graphics card), change the name in the settings cell and run everything. It takes about an hour, prints how often it heard its name and how often it mistook sound-alike words for it, and downloads `<name>.onnx`. Put that file in `whisper/extras` and restart the bot: the start-up check shows a "Name detector" line with how well it heard its name in the voice test. The notebook fixes two problems in how livekit-wakeword 0.3.0 prepares its training clips; without those fixes, Babel's first model reacted to any short word after a pause ("table", "yeah") as if it were its name, even though its own test said 99%. Its last check says whether the model is usable. Babel's name failed it even after the fixes: "Babel" differs from "able", "table", "label" and "fable" by a single sound, and the model scored those nearly as high as the name, so Babel runs without a name detector.

Also, replies are read out a sentence at a time while Claude is still writing them, so a two-sentence answer starts as soon as its first sentence is ready.

## The desktop app (start, stop and settings in one window)

On your PC you can run the bot from a small app instead of start-windows.bat and Notepad.

1. Close the start-windows.bat window if the bot is running.
2. Double-click **install-app.bat** once. It downloads the app's engine (Electron, about 160 MB) into `%LOCALAPPDATA%\WinslowApp`, outside OneDrive, checks it against its published checksum, then opens the app and puts a shortcut named after your bot on your desktop and in the Start menu. Node.js has to be installed, as for start-windows.bat.
3. From then on, open the app from that shortcut and press **Start**.

What's inside:

- **Home:** Start, Stop and Restart, whether it's online, which call it's in and who's there, and the start-up check (with "Check again" and "Start anyway" if a check fails). The latest warning or error shows here with a count, and if it stops on its own, the taskbar button flashes and Home says why. Chattiness and "Join calls by himself" (auto-join) for all your servers, applied on the spot. Hearing: whether Whisper is running, a button to run the Whisper setup, and one to free the graphics memory right away. What it has spent today and this month.
- **Settings:** your keys and the settings you'd change, grouped and explained (a few rarely needed ones, like `STT_LANGUAGE`, `STT_KEYTERMS`, `ELEVENLABS_OUTPUT_FORMAT` and `ANTHROPIC_WORKSPACE_ID`, are only in `.env`). Saved keys are never shown: press **Replace** and paste the new one. Settings apply the next time it starts, and the app offers a restart.
- **Personality:** edit `persona.md` and `lore.md`, and read or delete what it remembers about your recent calls and the jokes it kept to call back to (Call memory).
- **Usage:** today and this month by service, plus your real ElevenLabs credits and Deepgram balance.
- **Logs:** the live output, the activity log (who spoke and what it did about it, in your local time) and Whisper's log, with a filter and a copy button.

**Updates load by themselves:** when the bot's code, a setting or a personality file changes (an update, or a change you save in the app), the app restarts it to load the change once nobody is in a call with it; until then a banner on top says an update is waiting, with a "Restart now" button. Turn it off with `AUTO_UPDATE=false` (Settings > Personality and behavior), and the banner just asks you to restart. When the app's own files change, the banner asks you to close and reopen the app.

Closing the app stops the bot (it asks first), so it only runs while the app is open. Only one copy can run at a time: if start-windows.bat is already running it, Start in the app says so, and the other way around. If you rename the bot in Settings, the app renames its shortcuts to match. If you move the bot folder, run install-app.bat again so the shortcut follows. To remove the app, delete `%LOCALAPPDATA%\WinslowApp`, `%APPDATA%\Winslow` (its window settings) and the two shortcuts; start-windows.bat keeps working either way.

## Optional Venice integration

Set `VENICE_API_KEY` and choose `VENICE_FOR` to route selected voice replies through Venice. Available modes are `off` (default), `jokes`, `answers`, and `all`. Claude handles text replies and remains the default voice provider. Responses written by Venice do not use web search. Set `VENICE_MODEL` to a model supported by your account.

Provider declines are respected. Service errors can fall back to Claude so a temporary outage does not interrupt the call. Usage is tracked separately by provider.

## Using it

With auto-join on (`/autojoin on`, the switch on the app's Home, or `AUTO_JOIN=true`), it joins a voice channel by itself once two or more people have been in it for about 20 seconds, says in that channel's chat that it's listening (like `/join` does), and follows you if everyone moves to another channel. `/leave` (or disconnecting it) keeps it out until everyone has left voice. People who are deafened or opted out don't count, and it never joins the AFK channel. `/join` works either way.

Say its name anywhere in a sentence to talk to it: "Gremlin, who's winning tonight?" Say just its name ("Gremlin!", "Gremlin, you there?") and it answers with a quick "Yeah?" or "What's up?" and listens: whatever you say next is for it, no name needed. Pause mid-question ("Gremlin, best build for... a support main") and it waits for the rest and answers the whole thing. When several people ask at once, one answer covers all of them. After it answers someone (or says hi when it joins), it stays in the conversation: for about 20 seconds after it stops talking (12 on low chattiness), anyone can reply, comment or ask a follow-up without saying its name, and the back-and-forth can keep going for a few turns (two on low; as long as you like when you're the only one talking; not when chattiness is off). Reply in pieces ("I'm good... what about you?") and it answers all of it in one go. It's most ready to answer the person it was just talking with, or whoever is the only one talking. A question from them right after it talks is answered by the main model (the quick one sometimes let those go). Tell it "you don't have to respond to everything" or "nobody asked you" and for 20 minutes it stops jumping in: no jokes, and no replies without its name except a question from the person it's answering (`/chattiness` ends that early). When its name was hard to make out (often it was just noise), it listens without the "Yeah?": go on talking and it answers.

Ask it about anything current (patch notes, balance changes, tier lists, release dates, esports results, news) and it looks it up first: you'll hear "One sec" if the search takes a moment, and the source links show up in the text channel. Jokes and banter never trigger a search. A follow-up question right after it answers gets looked up too, no name needed.

Say its name while it's talking and it stops mid-sentence to listen, then answers you. Just "Gremlin!" or "Gremlin, wait" makes it stop and wait for the rest, and whatever you say next counts as talking to it, no name needed. "Gremlin, shut up" stops it without a reply.

If the person it's answering talks over it, it pauses to listen. A laugh, a quick "yeah" or a short comment ("that's so crazy") and it carries on where it stopped; anything else and it drops the rest and answers that instead. Turn this off with `TALK_OVER_PAUSE=false` (Settings > Hearing).

Ask it for a song: "Gremlin, make a song about Mike losing to a door", "sing us a birthday song for Jess". It says it's on it, writes the words and picks a sound, and once the song is ready (usually a few seconds) and nobody's talking, it says "Alright, here it is" and plays a real song with music and singing (made with ElevenLabs Music, 30 seconds unless you ask for longer, up to `SONG_MAX_SECONDS`). Talking during the song, even to it, doesn't stop it; "Gremlin, skip it", "Gremlin, stop" or `/shush` does. While it's still being made, "Gremlin, never mind the song" or a stop calls it off. A song plays as soon as it's ready: it can't be saved for later or set as a reminder. One at a time, up to `SONG_MINUTES_PER_MONTH` minutes a month (10 by default; /usage shows how many it made). Your ElevenLabs key needs access to Music: in ElevenLabs, Developers > API Keys, edit the key and turn on Music (or make a new one with it and paste it in the app under Settings > Keys). If it can't, it says why in the text chat. Turn songs off with `SONGS=false` (Settings > Personality and behavior).

Ask it for a picture: "Gremlin, draw Mike's Yasuo going zero and ten", "make us a picture of a goblin queueing for ranked". It says it's on it, and a few seconds later the picture shows up in the call's text chat (drawn by Google Gemini) and it says "It's in the chat." "Now make it at night" or "give him a hat" changes its last picture (for half an hour). It doesn't know what anyone looks like, so a picture of someone in the call is a character or a creature, and all requests follow the image provider's content policies. You can also @mention it in a text channel with a picture request. Up to `IMAGES_PER_MONTH` a month (100 by default; /usage shows how many it drew). To set it up: in [Google AI Studio](https://aistudio.google.com/apikey) click **Create API key**, then **Set up billing** for that key's project, and paste the key in the app under **Settings > Keys** (`GEMINI_API_KEY`). Its Discord role also needs **Attach Files** (Server Settings > Roles > its role); bots invited with the link it prints now ask for it. Turn pictures off with `IMAGES=false`.

It also jumps in with a joke of its own when there's a pause and the last few lines hand it something funny. It passes when nothing good comes to it, in serious or tense moments, and when all it would add is agreeing; in testing on real call moments it jumped in at about two pauses out of three. Its jokes are spaced out by chattiness: at most one every 10 minutes on low, 5 on medium and 2 on high (longer if its jokes have been falling flat). Sonnet writes them (`CLAUDE_JOKE_MODEL`, Settings > Brain): Haiku is cheaper but almost never jumps in.

A few things make it feel more like one of you, each with a switch in Settings > Personality and behavior:

- **A quick "hmm".** When a question takes it a moment, it sometimes says "Hmm." or "Ooh." right away instead of leaving dead air, then answers (at most every couple of minutes, about half the time). `THINKING_SOUNDS=false` turns it off.
- **Laughing along.** When people crack up at something one of them said, it sometimes laughs too: more likely when several of you are laughing, only at a real laugh (not a polite "ha ha") when it's one person, never at its own lines, at most every four minutes. `LAUGH_ALONG=false` turns it off.
- **Hi and bye.** Someone joining a call it's been in for a minute gets a quick hi (once every half hour each), and someone saying they're heading out ("alright guys, I'm out", "gn") after being around for five minutes gets a bye. `HELLO_GOODBYE=false` turns it off.
- **Not the same opener every time.** It's told to vary how it starts its lines, and a laugh or "Ha," to open a line right after it just laughed is left out.

Laughing along and hi and bye are off when chattiness is off.

Ask it for a reminder or a timer: "Gremlin, remind me in ten minutes to queue", "set a timer for five minutes", "tell us at nine thirty that the raid starts". It says it will, and when the time comes it says it in the call (it waits a few seconds for a pause). If it isn't in a call with that person then, it posts the reminder in the text chat it was set from and mentions them. Up to a day ahead and 20 per server; ask "what reminders do I have?", or say "cancel that" or "cancel reminder two". They're kept in `data/memory.json`, so they still go off after a restart (one that came due while it was off is said up to an hour late). Turn them off with `REMINDERS=false` (Settings > Personality and behavior).

Keep shared lists with it, for the whole server: "Gremlin, add Hades 2 to the games list", "put chips and salsa on the LAN night list", "take Deadlock off the games list", "tick off the chips", "clear the shopping list", "delete the ban list". Saying a new list's name starts it. Ask to see one ("Gremlin, post the games list", or "post all the lists") and it posts it in the call's text chat, numbered, with ticked-off items struck through; it won't read a long list out loud. The same works in text: @mention it ("@Gremlin add Silksong to games to try", "@Gremlin show me the shopping list") and it answers there and posts the list under its reply. Clearing or deleting a list needs its exact name, and one cleared or deleted by mistake can be brought back for a week ("Gremlin, bring back the shopping list"; it keeps the last five). Lists last between calls (kept in `data/memory.json`; /forgetcalls doesn't touch them). Up to 20 lists of 50 items each; when a list is full, the oldest ticked-off item makes room. Turn them off with `LISTS=false` (Settings > Personality and behavior).

You (whoever owns the bot in the Discord Developer Portal) can say "Gremlin, look at this", "Gremlin, what's on my screen?" or "can you see my screen?" and it looks at a picture of your PC's main screen with that question. Only asks that clearly mean the screen count ("did you see that goal last night?" doesn't), nobody else can do it, it only works when the bot runs from the desktop app, and the picture isn't saved. Turn it off with `SCREEN_LOOKS=false` (Settings > Personality and behavior); the app stops sending pictures as soon as that's saved.

With `CALL_MEMORY=true` (Settings > Personality and behavior > Remember calls), it keeps short notes on each call, so in a long call it still knows what happened hours ago, and next time it can bring things up ("Did you ever beat that boss?"). It keeps notes on the last 10 calls in each server, and `/join` tells everyone it's on. Read or delete them in the app under Personality > Call memory, or clear a server's with `/forgetcalls`. Someone who uses `/optout` mid-call is taken out of that call's notes. Stopping the bot waits a few seconds for the summary of the call it was in.

When hearing runs on Whisper, a clip that sounds like only its name but that Whisper isn't sure of is listened to again without the name hint (unless the name detector heard it too), so background noise doesn't wake it. `data/whisper.log` lists those clips with Whisper's confidence.

It learns from each call, a little:

- **How its jokes land.** After one of its own jokes, a laugh (a line of just laughing, or "good one, Gremlin") makes it joke a bit more often in that server; "shut up", "/shush" or talking over it for a while makes it wait longer and only try really good ones. A laugh or a "boo" about the game doesn't count. It starts adjusting after five jokes, the waits go from about 0.6 to 2 times the chattiness level's usual, and what it learned fades over a week or two. Each joke's reaction is in the log ("joke: laughed"). Turn it off with `JOKE_TUNING=false` (Settings > Personality and behavior).
- **Jokes that got a laugh.** It keeps its last dozen jokes that got a laugh, and when it's thinking about chiming in, it sees a few from earlier calls and may call back to one when something in the call sets it up (never word for word). One it used rests for a week. They're listed in the app under Personality > Call memory; Forget all there, or `/forgetcalls`, clears them. Turn it off with `JOKE_CALLBACKS=false`.
- **Words it mishears.** When it answers with a word from your games spelled differently from what it heard (it says "Malenia" after hearing "melania"), it notes that word, and once that happens twice it listens for it from then on: Whisper gets the six it learned most as hints, on sentences long enough that a hint can't be "heard" in noise, and Deepgram gets them as keyterms. Everyday English words and people's names are never learned. Turn it off with `LEARN_WORDS=false` (Settings > Hearing) if it starts hearing those words where they weren't said.

| Command | What it does |
|---|---|
| `/join` | Joins your voice channel |
| `/leave` | Leaves (it also leaves on its own a minute after everyone's gone). With auto-join on, it stays out until everyone has left voice |
| `/autojoin on/off` | Whether it joins a voice channel by itself once two or more people are in it. Remembered for the server, and wins over `AUTO_JOIN` in `.env` |
| `/chattiness off/low/medium/high` | How often it jumps in uninvited, and how long it keeps answering without its name after it talks. Remembered for the server, and wins over `CHATTINESS` in `.env` |
| `/shush` | Stops talking right now |
| `/roast @someone` | Playful roast, all in good fun |
| `/say text` | Makes it say exactly that (only for people in the call, once every 15 seconds) |
| `/remember fact` | Teaches it an inside joke ("Mike always volunteers to scout") |
| `/memories`, `/forget number` | See or remove what it remembers |
| `/optout`, `/optin` | Each person can stop it from listening to them |
| `/usage` | What it has used today and this month, and roughly what it cost, plus your real ElevenLabs credits left. Only server managers see this command, and only you see the answer |
| `/forgetcalls` | Forgets its notes on this server's calls (call memory), including the call going on now, and the jokes it kept to call back to. Only server managers see this command |

Mention it in a text channel (`@Gremlin ...`) and it replies in text.

## Making it yours

- **`persona.md`** is its personality. Rewrite it freely (`{name}` becomes whatever `BOT_NAME` is). Keep it friendly and suitable for a general audience.
- **`lore.md`** is who's who and your inside jokes. The more specific, the funnier it gets.
- **`.env`** has the knobs: name, chattiness default, voice settings, models. The app's Settings page edits the same file.

| If... | Change this in `.env` (or the same setting in the app) |
|---|---|
| it cuts people off mid-sentence | `SILENCE_MS=1000` |
| it ignores a quiet friend | `VOICE_RMS_THRESHOLD=100` |
| it ignores a quiet friend in a noisy room | `NOISE_MARGIN=1.5` (0 turns the background-noise check off) |
| an open mic's hiss or keyboard keeps it from finding a pause | `NOISE_MARGIN=3` |
| it misses its name | add the misheard spellings to `BOT_ALIASES` |
| it stops mid-line when nobody called it | remove short or common-sounding names from `BOT_ALIASES` |
| you want it faster and cheaper | `CLAUDE_MODEL=claude-haiku-5-5` |
| answers take too long | `CLAUDE_EFFORT=medium` (a bit less careful, and less eager to look things up) |
| you never want it to look things up | `WEB_SEARCH=false` |
| you want a lower cap on searches | `WEB_SEARCH_DAILY_LIMIT=30` |
| the voice is too flat or too wild | `ELEVENLABS_STABILITY` (lower is wilder) |
| you want a more expressive voice | `ELEVENLABS_MODEL=eleven_v4_turbo` and `ELEVENLABS_AUDIO_TAGS=true` (it can laugh, sigh or whisper; same price as Flash. If your account can't use it, it says so in the log and uses Flash) |
| it answers before people finish | `SMART_TURN=false`, or raise `SILENCE_MS` |
| it stops talking for words that sound like its name | `NAME_DETECTOR_THRESHOLD=0.85` |
| it struggles with game or friend names | add them to `STT_EXTRA_TERMS` |
| its "hmm"s, laughs or hi and bye get old | `THINKING_SOUNDS=false`, `LAUGH_ALONG=false`, `HELLO_GOODBYE=false` |
| it jokes too much, or not enough | `/chattiness low`, `medium` or `high` (low: a joke of its own at most every 10 minutes; medium: 5; high: 2), or `CLAUDE_JOKE_MODEL=claude-haiku-5-5` for far fewer (and cheaper) |
| songs should be shorter or rarer | `SONG_MAX_SECONDS=30`, `SONG_MINUTES_PER_MONTH=5` (0 turns them off for the month) |
| pictures should be rarer | `IMAGES_PER_MONTH=30` (0 turns them off for the month), or `IMAGES=false` |

## Troubleshooting

Turn on `LOG_TRANSCRIPTS=true` to see what it hears in the log, and `LOG_LEVEL=debug` for timings. The activity log (`data/bot.log`) always has how long each answer took to start ("first sound 1.8 s after Mike stopped talking", with where the time went), and the end of each call has the median. Check again in the app, `npm run check` or `start-windows.bat` re-tests every key.

| Problem | Likely cause |
|---|---|
| "couldn't connect to voice within 20 seconds" | The bot lacks Connect/Speak permission in that channel, or the host blocks UDP. |
| It's in the call but never answers | Check the log for "speech-to-text failed" (Deepgram key) or nothing heard (mics, `VOICE_RMS_THRESHOLD`). |
| Its lines show up as text with "(my voice isn't working: ...)" | ElevenLabs problem. The message says which: credits, voice ID, or key. Out of credits: add some in ElevenLabs or wait for the monthly reset. |
| "(I couldn't come up with a reply: ...)" | Claude problem, usually the Anthropic credit balance. Add credit in the Anthropic Console. |
| It answers questions about current stuff from memory instead of looking them up | Check the "Web search" line in the start-up check. If it says turned off for your organization, an admin can turn it on at <https://platform.claude.com/settings/capabilities>. It also stops for the day after `WEB_SEARCH_DAILY_LIMIT` searches. |
| It left the call by itself | After a network drop it tries to get back in a few times; if it can't, it posts a note. Use /join. |
| It joins calls nobody asked it into | Auto-join is on: `/autojoin off`, or the switch on the app's Home. `/leave` keeps it out until everyone has left voice. |
| Auto-join is on but it doesn't come in | It needs two people in the channel (deafened or opted-out people don't count) for about 20 seconds, and permission to connect and speak there. After `/leave` it waits until everyone has left voice; after a join that failed, ten minutes. The log says which ("auto-join"). |
| A reminder didn't go off | Ask it "what reminders do I have?". The log shows "set reminder #1 ..." when one is set and "couldn't set a reminder" when it couldn't tell the time. One for someone who wasn't in the call is posted in the text chat it was set from. |
| "(I couldn't make that song: ...)" | The reason follows. "isn't allowed to make music": in ElevenLabs, Developers > API Keys, edit the key and turn on Music (or make a new key with it and paste it in the app under Settings > Keys), then restart it. "used up": this month's `SONG_MINUTES_PER_MONTH` are gone. The log has a line for each song ("made a 30 s song in ..."). |
| A song sounds sped up, slowed down or like noise | Look for "the song came back an unexpected length" in the log and report it: ElevenLabs may have changed its audio format. |
| "(I couldn't draw that: ...)" or "(I can't post pictures here...)" | The reason follows. "needs billing turned on": in Google AI Studio, Get API key, Set up billing for the key's project. "rejected the Gemini key": paste a new key under Settings > Keys. "Attach Files": give its role that permission (Server Settings > Roles). "wouldn't draw that one": Google's rules refused that picture; ask for something else. The start-up check has a Pictures line, and the log has one for each picture ("drew a picture in ..."). |
| A banner says an update is waiting | It restarts by itself to load it once nobody is in a call with it, or press Restart now. |
| The bot froze and the window title starts with "Select" | Clicking inside the window pauses it. Press Esc. (start-windows.bat turns this off, but some setups ignore that.) |
| A pre-flight check fails but you want to play anyway | Press Start anyway in the app. start-windows.bat asks "Start anyway?": press Y. |
| Slash commands don't appear | Re-invite it with the link from the log (it needs the applications.commands scope). Discord can take a minute. |
| Two Gremlins answer | A copy is still running on your PC. |
| "Speech-to-text (Whisper ...): couldn't start" | The last lines of `data/whisper.log` (Logs > Whisper in the app) say why. Usually an old NVIDIA driver: update it, then run the Whisper setup again. Deepgram covers in the meantime if you have a key. |
| "Discord refused the Presence intent" | Turn on Presence Intent in the Developer Portal, or set `ENABLE_PRESENCE=false`. |
| It keeps hearing a game word that nobody said | A word it learned (see "It learns from each call") is a hint for Whisper. Turn off `LEARN_WORDS` (Settings > Hearing), or delete that word from `"words"` in `data/memory.json` while the bot is stopped. |
| It "thinks out loud" ("Mike's asking me to...", "the user said...") | Claude writes the words to say inside `<say>` tags and only those are spoken; any notes it writes to itself first are never heard. Replies that may turn out to be a pass are checked whole before any of it is said, and sentences that only describe what you just asked or talk about the transcript are left out (the log says "left out ... thinking out loud"; with `LOG_TRANSCRIPTS=true` it shows the words). If an answer was nothing but that, it asks Claude once more. If one still gets through, turn on `LOG_TRANSCRIPTS=true` for a session so the exact wording can be caught. |

## Privacy

- Audio is never saved. The last 15 minutes of transcript live in memory only, for context, and vanish when it leaves. (If you turn on `LOG_TRANSCRIPTS=true`, what it hears is also printed to the log.)
- Speech is sent to Deepgram to be transcribed, or stays on your PC with Whisper (the end-of-turn model and name detector run on your PC too); text goes to Anthropic (Claude) and ElevenLabs.
- `data/memory.json` also keeps, per server, how its jokes have been landing (a score and counts), its last dozen jokes that got a laugh (its own lines, to call back to; none that name someone who opted out), the words it learned to listen for (each word, how often, and when; never what was said around it), whether auto-join is on, the reminders people set (what it will say, for whom, and when) until they go off, and the shared lists (each item, who added it and when) until someone takes them off, plus the last five cleared or deleted ones for a week so they can be brought back. `data/whisper.log` only shows the words of a clip when `LOG_TRANSCRIPTS=true`.
- With `CALL_MEMORY=true`, short notes on each call (what you played and talked about, not a transcript) are written by Claude and kept in `data/memory.json`, at most 10 calls per server. `/join` says it's on. Read or delete them in the app (Personality > Call memory) or clear them with `/forgetcalls` (on a server, the app can't see the bot's notes, so use `/forgetcalls` there). It's told to leave out sensitive personal details, and `/optout` takes someone out of the call's notes too.
- When the owner asks it to look at the screen, one picture of the main screen goes to Anthropic with that question. It's never saved, and nobody else can trigger it.
- When someone asks for a song, the words and the sound Claude wrote for it go to ElevenLabs Music. The song is played in the call and not saved.
- When someone asks for a picture, the description Claude wrote for it goes to Google's Gemini API (asked not to keep it), plus its last picture when you ask to change it. The picture is posted in the text chat and kept in memory for half an hour so it can be changed, never saved to disk. Google adds an invisible SynthID watermark to every picture.
- When it looks something up, Claude writes a short search query from the question and Anthropic runs the search. The source links are posted in the text channel where /join was used.
- Text channels: if someone in the call @mentions it, its text reply can refer to the call, and anyone who can read that channel sees it (it's told not to quote the call there). When its voice fails, the lines it would have said are posted in the text channel instead.
- `data/usage.json` keeps daily and monthly totals (characters, minutes, tokens, estimated cost), never what was said.
- `data/bot.log` keeps a record of who spoke, for how long, and what the bot did about it (answered, not for it, no words recognized, chose not to reply), never the words unless `LOG_TRANSCRIPTS=true`. It starts over at 5 MB, keeping the previous one as `bot.old.log`.
- `/join` tells everyone it's listening, and so does auto-join, in the voice channel's chat. Anyone can `/optout`; their audio is then ignored before it's transcribed.
- Let your friends know it's in the call. Some places require everyone's consent to record or transcribe a conversation.
- Your keys live only in `.env`: on your PC and, on the server, readable only by the bot's service account. The desktop app edits that same file; saved keys never appear in its window, and the app itself only goes online to show your ElevenLabs credits and Deepgram balance.

## How it works

```
your mics -> Discord (encrypted) -> Gremlin decodes each person separately
          -> waits for a pause (or less, once they sound done) -> Whisper on your PC, or Deepgram (speech to text)
          -> Claude decides: was it called by name? is something funny happening?
             (and searches the web first if the question needs current facts)
          -> ElevenLabs (text to speech), a sentence at a time as Claude writes -> back into the call
```

## Files

| File | What it is |
|---|---|
| `.env` | Your keys and settings (never share it) |
| `edit-settings.bat` | Opens `.env` in Notepad |
| `persona.md`, `lore.md` | Personality and inside jokes |
| `start-windows.bat` | Run it on your PC |
| `install-app.bat`, `desktop/` | One-time setup for the desktop app, and the app itself |
| `setup-whisper.bat` | One-time setup for free hearing on your graphics card |
| `whisper/` | The local Whisper speech server and its setup |
| `whisper/extras/` | The end-of-turn model and the name detector (and their licenses in `NOTICE.txt`) |
| `whisper/train-name-detector.ipynb` | Trains a name detector for a new name in Google Colab |
| `deploy/deploy-to-server.bat` | Upload to your server and (re)start |
| `deploy/server-logs.bat` | Watch the server's live log |
| `data/` | What it remembers (`memory.json`), usage totals (`usage.json`), the activity logs (`bot.log`, `whisper.log`) and the voice test sample |
| `src/` | The code (`src/venice.js` is the optional Venice brain; `src/common-words.txt`, the everyday words it never learns as game words, is from [wordfreq](https://github.com/rspeer/wordfreq), CC BY-SA 4.0) |
| `test/` | Automated tests (`npm test`) |
