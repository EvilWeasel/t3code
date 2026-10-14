/** Coordinates microphone use between Live voice and recorded dictation in one renderer. */
let currentOwner: symbol | null = null;

export function acquireMicrophoneOwnership(): (() => void) | null {
  if (currentOwner !== null) return null;

  const owner = Symbol("microphone-owner");
  currentOwner = owner;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    if (currentOwner === owner) currentOwner = null;
  };
}
