# Voice input in Weasel Nightly

Record a message from the chat composer. **Stop** transcribes it into editable
prompt text. **Send** transcribes it and sends the prompt directly, including any
text already in your draft. A failed transcription or send keeps the recording
for playback and retry. Retrying a failed send uses the editable prompt without
inserting the same transcript twice.

Recordings stay with their original draft when you open Settings or switch
threads. Leaving during recording stops capture and keeps the audio for review;
it does not send a message. Return to that draft to listen, insert text, or send.
A successful insertion, accepted send, or **Discard recording** removes the saved
audio. Browser storage must remain available to keep audio across an app reload.

Transcription runs on the environment selected for that composer. A remote
environment uses its own configured transcription provider and login. Changing
the thread or environment cancels the current operation and ignores late
results, preserving reviewed audio on the original draft. Recordings are limited to 25 MiB.

Open **Settings → Integrations → Voice transcription** to see the selected
environment's provider status, choose a Codex account, or explicitly configure
OpenAI API transcription. The default uses the enabled Codex instance, including
the built-in instance on a fresh profile. Existing sign-in is reused; no API key
is needed for account mode. A provider can still reject transcription even while
coding works; the failed recording remains available to retry.

OpenAI API mode uses API billing. Keys entered here go only to the environment's
private secret store and are never returned in settings. Leave the key blank to
retain it; **Remove saved key** removes the saved override. A key supplied by the
host's private launch environment remains managed by that host.

This feature records messages. Continuous GPT Live conversation and spoken
work results are a separate integration still in development.
