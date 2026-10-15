import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
  DesktopUpdateReadinessSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";

export const acknowledgeUpdateReadiness = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_READINESS_CHANNEL,
  payload: DesktopUpdateReadinessSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.updates.readiness")(function* (readiness, event) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    const windows = yield* ElectronWindow.ElectronWindow;
    if (event?.senderFrame?.parent !== null || updates.acknowledgeReadiness === undefined || windows.updateInventory === undefined) return false;
    const frame = event.senderFrame;
    if (!(yield* windows.updateInventory).some((window) => window.id === event.sender.id &&
      window.generation === `${frame.processId}:${frame.routingId}`)) return false;
    return yield* updates.acknowledgeReadiness(event.sender.id, readiness);
  }),
});

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* (channel) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel);
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.install;
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("web-ui");
  }),
});
