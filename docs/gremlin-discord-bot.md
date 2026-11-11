# Babel architecture

Babel is a conversational Discord voice companion with a configurable personality.

## Conversation pipeline

Discord audio is decoded and transcribed by Whisper, Deepgram or ElevenLabs. The conversation controller detects requests, waits for sentence completion, selects a configured AI provider and streams short replies to text-to-speech. Optional jokes and follow-ups respect call activity and chattiness settings.

## Features

- Claude responses with optional web search and source links.
- Optional Venice provider routing for selected voice replies.
- ElevenLabs speech and requested music generation.
- Gemini image generation and edits to recent images.
- Shared lists, reminders, saved facts and optional call summaries.
- Desktop controls, usage reporting, auto-join and server deployment.

## Boundaries

Provider declines are respected. Service failures may use the configured availability fallback. Transcripts are shared only with participants in the call, and users can opt out. Credentials and runtime data belong in local configuration and ignored data directories. Spending and concurrency limits apply before generation.

Implementation and installation details are documented in `code/gremlin-bot/README.md`.
