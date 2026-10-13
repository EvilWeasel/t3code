# Weasel transcription host configuration

Configure the server belonging to the selected environment. The desktop's
local backend inherits its launch environment; configuring a laptop does not
configure a remote server.

The default `T3CODE_TRANSCRIPTION_PROVIDER=codex-account` uses a configured
Codex instance and its existing ChatGPT login. Set
`T3CODE_TRANSCRIPTION_CODEX_INSTANCE_ID` when transcription should use one
specific instance. A missing login or rejected account request fails explicitly
and never changes billing mode automatically.

For explicit API transcription, set `T3CODE_TRANSCRIPTION_PROVIDER=openai-api`
and inject `T3CODE_TRANSCRIPTION_API_KEY` from the existing private store into
the server process. `T3CODE_TRANSCRIPTION_MODEL` defaults to `gpt-transcribe`.
Keep this dedicated key separate from `OPENAI_API_KEY`, which can change how
Codex authenticates ordinary coding work. Do not commit credentials or put them
in launcher arguments. With Proton Pass CLI, use a private `pass://` reference
in the dedicated environment variable and retain `pass-cli run` output masking.

The API adapter has passed a production-function test using a synthetic German
WAV. The account adapter's protocol and mock tests do not establish backend
acceptance: the initial Node requests received a Cloudflare challenge. Do not
copy browser cookies, desktop integrity state, or another application's identity
to work around this. GPT Live must remain subscription-backed and does not use
this API fallback.
