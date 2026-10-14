import { LiveVoiceError, liveVoicePublicErrorMessage } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { unwrapLiveVoiceCommand } from "./LiveVoiceCommands";

it.each(["managed_account_required", "planner_restriction_failed", "stale_lease"] as const)(
  "preserves actionable %s failures from the command boundary",
  (code) => {
    expect(() =>
      unwrapLiveVoiceCommand(AsyncResult.failure(Cause.fail(new LiveVoiceError({ code })))),
    ).toThrow(liveVoicePublicErrorMessage(code));
  },
);

it.each([Cause.fail(new Error("private provider token")), Cause.die("private defect token")])(
  "does not expose arbitrary command failures or defects",
  (cause) => {
    expect(() => unwrapLiveVoiceCommand(AsyncResult.failure(cause))).toThrow(
      "Live voice request failed.",
    );
  },
);
