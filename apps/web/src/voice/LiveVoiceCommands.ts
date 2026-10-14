import { LiveVoiceError } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isLiveVoiceError = Schema.is(LiveVoiceError);

/** Preserve only the public voice category; defects and provider text stay private. */
export function unwrapLiveVoiceCommand<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Success") return result.value;
  const error = Cause.findErrorOption(result.cause);
  if (Option.isSome(error) && isLiveVoiceError(error.value)) {
    throw new LiveVoiceError({ code: error.value.code });
  }
  throw new Error("Live voice request failed.");
}
