import { createLiveVoiceEnvironmentAtoms } from "@t3tools/client-runtime/state/live-voice";

import { connectionAtomRuntime } from "../connection/runtime";

export const liveVoiceEnvironment = createLiveVoiceEnvironmentAtoms(connectionAtomRuntime);
