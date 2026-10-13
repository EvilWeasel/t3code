# Voice input in Weasel Nightly

Record a message from the chat composer, stop, and listen before transcribing.
You can discard the recording or retry transcription. The transcript becomes
editable draft text; sending it remains a separate action.

Transcription runs on the environment selected for that composer. A remote
environment uses its own configured transcription provider and login. Changing
the thread or environment cancels the current operation and discards late
results. Recordings are limited to 25 MiB.

ChatGPT account transcription is the default host mode. The account-backed
endpoint is an internal desktop protocol and may reject an independent client.
The first fork's Node transport has encountered a Cloudflare challenge, so
subscription transcription is not yet confirmed in practice. An administrator
can explicitly enable API transcription instead; that uses API billing rather
than the ChatGPT subscription. See [host configuration](../operations/weasel-voice.md).

This feature records messages. Continuous GPT Live conversation and spoken
work results are a separate integration still in development.
