# Voice chat: Cursor's "Start voice chat", rebuilt for Volt

2026-11-16. Cursor 3.29.9 was tested live in a throwaway profile over CDP (`cursor/s01`–`s20`), and its shipped code was read for the exact behaviour (`cursor-voice-chat-code-spec.md`: prompt, tools, lifecycle, every UI string).

## What Cursor does (tested)

| Step | Cursor | Screenshot |
|---|---|---|
| Empty composer | `[mic] [white waveform disc]`; tooltip "Start voice chat". Typing turns the disc into Send. | s01, s02, s03 |
| Mic hover | "Click or hold ⌃M to dictate" | s04 |
| Start | A "Voice chat" tray appears above the composer: m:ss clock, live waveform, Mute / Settings / View transcript / Hang up (red) | s05, s06 |
| Talk | Speech-to-speech (xAI Grok voice, voice "Ara"); it greets after 15 s of silence and answers in about 30 words | s07, s08 |
| Ask for work | The voice says one short line, then `send_task` writes a prompt and starts or steers the agent; on a new chat it creates the chat and moves the call into it | s09 |
| In the chat | "Voice call · Ongoing · m:ss · View transcript" card after the last message; the tray stays above the composer | s09–s11 |
| Settings | Voice (searchable, ▷ preview per voice), Speed 0.75–2x, Language (29) | s12, s13 |
| Transcript | A right-panel tab "Voice call · 10:30 PM": title, date · status · duration, "…" > Copy Transcript ID, user bubbles and voice text | s08, s11, s14 |
| Result | When the agent finishes, the voice says the result unprompted | s16 |
| Mute | The mic button flips to "Unmute" (pressed) | s15 |
| Hang up | The tray goes; the card shows "Ended · 3:20" | s17 |
| A second call in the same chat | A new card; requests steer the running agent | s18, s19 |

## Volt

- **Composer** (`agentEditor.ts`): an empty composer always shows `[mic][waveform]`. During a call the waveform stays, green and live (clicking it opens the call), and the mic is disabled: "Voice chat is using the microphone".
- **Tray** (`voltVoiceChat/browser/voiceCallTray.ts`): above the chip row and as wide as the text box (measured into `--volt-agent-input-width`). It has the failure state ("Voice chat" + why + Dismiss) and the "Voice chat with {chat}" + Return row on other chats.
- **Thread card** (`IVoltAgentWindowService.registerThreadCards`, `chrome/agentThreadCards.ts`): placed after the reply that was last when the call reached the chat.
- **"Sent by voice call"** pill on messages a call sent (`fromThread.kind: 'voice'`); it opens the transcript.
- **Transcript tab** (`voiceCallTranscript.ts`) in the chat's right panel.
- **Settings > Voice** (`voicePage.ts`): provider (Automatic / xAI / OpenAI / custom server), API keys, voice + sample, speed, language, and a switch for the button.
- **Brain** (`common/voiceCallBrain.ts`), shared by desktop, browser and phone: instructions (Volt persona, written fresh), tools `send_task` (steers a running turn, starts a new chat from an empty composer, never duplicates an errand), `search_conversations`, `peek_changes` / `peek_runs` / `peek_agents` (Volt's thread tools), `stay_silent` and `end_the_call`; `work_landed` notes with the reply's final paragraphs; and the call record.
- **Audio** (`realtimeVoiceClient.ts`): 24 kHz PCM16 over the provider's WebSocket, with barge-in truncation and echo cancellation.
- **Keys** (`platform/voltVoiceChat`): kept on the computer (`<userData>/volt-voice/keys.json`, mode 0600) or read from `XAI_API_KEY` / `OPENAI_API_KEY`. Every call gets a short-lived client secret; the key never reaches the renderer.
- **Web**: same module; keys and minting go through the agent server channel.
- **Phone** (`apps/mobile/src/chat/voice/`): `voice.*` on the agent server (`serverVoice.ts`) runs the same brain. The app runs the audio in a hidden WebView (`engineHtml.ts`, an iframe on Expo web) and has:
  - the composer's [mic][waveform] button;
  - the tray, with a settings sheet and a transcript sheet;
  - call cards anchored under the turn they followed;
  - "Sent by voice call" on messages the call sent;
  - a new chat's first task moving the call into that chat.

## Tests

- Unit tests: `voltVoiceChat/test/common/*.test.ts` and `platform/voltVoiceChat/test/node/*.test.ts` (protocol, brain, node service). The Customize, Commit Review and plugin suites also pass.
- Live: a dev instance (CDP 9971) with a mock realtime server (`.git/volt-voice-rig/mock-realtime.mjs`, same protocol as xAI) and a fake microphone. Covered: greeting, talking, `send_task` starting a chat from the new-chat composer, the real Grok agent editing `math.js`, the reply spoken back, approval needed spoken, goodbye ending the call, cards, transcript tab, settings menu and the Settings page.
- Browser workbench at `/code/` (agent server on 9965): the same flow end to end.
- Phone API: `ws-voice.mjs` drives `voice.start`, `voice.tool` and the events over `/ws`.
- Phone app on Expo web, paired to the test server through a same-origin proxy, with a fake microphone in the engine iframe:
  - a call from a chat: greeting, transcript, `send_task`, the result spoken, the transcript sheet, hang-up;
  - a call from the new-chat screen: its first task started a chat and the app moved into it.
  - The engine page was also run on its own against the mock: transcripts, tool calls, notes, and `end_the_call` hanging up after the goodbye.
  - `apps/mobile` and `apps/client-core` pass `tsc --noEmit`.
- Not tested: a real xAI or OpenAI call, because no key was available here. Add one in Settings > Voice to try it.
