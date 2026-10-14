# Voice input

Transcription edits a composer draft. Mobile transcribes locally on supported iOS
devices; sending remains a separate action there. The Weasel web/desktop recorder
uses the selected environment's authenticated HTTP API. Stop inserts text; its
explicit Send action uses normal message submission and retains audio until the
server accepts the message. Navigation cancels transcription delivery but does
not cancel an already submitted agent turn. Its admission receipt must settle
against the original draft, so returning to a pending recording cannot submit
it twice. The host owns provider authentication; browser clients never receive
transcription credentials. Account transcription and explicit API transcription
are separate modes, with no automatic billing fallback.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
