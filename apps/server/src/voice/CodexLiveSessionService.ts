import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  LiveVoiceError,
  MessageId,
  ProviderSessionId,
  type LiveVoiceEvent,
  type LiveVoicePrepareInput,
  type LiveVoiceSession,
  type LiveVoiceStartInput,
  type LiveVoiceStopInput,
  type LiveVoiceSubscribeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CodexLiveEventHub from "./CodexLiveEventHub.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";

type LeaseRow = {
  lease_id: string;
  generation: number;
  environment_id: string;
  thread_id: string;
  provider_instance_id: string;
  model_selection_json: string;
  runtime_policy_json: string;
  provider_session_id: string | null;
  planner_native_thread_id: string | null;
  principal_session_id: string;
  principal_subject: string;
  client_request_id: string;
  start_client_request_id: string | null;
  stop_client_request_id: string | null;
  status: LiveVoiceSession["status"];
  native_started: number;
  native_sdp_received: number;
};

const leaseKey = (leaseId: string, generation: number) => `${leaseId}:${generation}`;
const sessionFromRow = (row: LeaseRow): LiveVoiceSession => ({
  leaseId: row.lease_id,
  generation: row.generation,
  environmentId: row.environment_id as LiveVoiceSession["environmentId"],
  threadId: row.thread_id as LiveVoiceSession["threadId"],
  providerInstanceId: row.provider_instance_id as LiveVoiceSession["providerInstanceId"],
  providerSessionId: row.provider_session_id as LiveVoiceSession["providerSessionId"],
  plannerNativeThreadId: row.planner_native_thread_id,
  status: row.status,
});

const liveError = (code: LiveVoiceError["code"]) => new LiveVoiceError({ code });

export class CodexLiveSessionService extends Context.Service<
  CodexLiveSessionService,
  {
    readonly prepare: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoicePrepareInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly start: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceStartInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly stop: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceStopInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly status: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceSubscribeInput,
    ) => Effect.Effect<LiveVoiceSession, LiveVoiceError>;
    readonly subscribe: (
      session: EnvironmentAuth.AuthenticatedSession,
      input: LiveVoiceSubscribeInput,
    ) => Stream.Stream<LiveVoiceEvent, LiveVoiceError>;
  }
>()("t3/voice/CodexLiveSessionService") {}

export const layer: Layer.Layer<
  CodexLiveSessionService,
  never,
  | SqlClient.SqlClient
  | SessionStore.SessionStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | RuntimePolicy.RuntimePolicyV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ThreadManagementService.ThreadManagementService
  | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  CodexLiveSessionService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const authSessions = yield* SessionStore.SessionStore;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const runtimePolicies = yield* RuntimePolicy.RuntimePolicyV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const eventHub = yield* CodexLiveEventHub.CodexLiveEventHub;
    const leaseLocks = yield* KeyedLock.make<string>();
    const active = new Map<
      string,
      {
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly plannerNativeThreadId: string;
      }
    >();

    const getLease = (leaseId: string, generation: number) =>
      sql<LeaseRow>`
        SELECT * FROM codex_live_voice_leases WHERE lease_id = ${leaseId} AND generation = ${generation}
      `.pipe(Effect.map((rows) => rows[0]));

    const getOwnedLease = Effect.fn("CodexLiveSessionService.getOwnedLease")(function* (
      principalSessionId: string,
      leaseId: string,
      generation: number,
    ) {
      const row = yield* getLease(leaseId, generation);
      if (row === undefined || row.principal_session_id !== principalSessionId) {
        return yield* liveError("session_not_found");
      }
      return row;
    });

    const ensurePrincipal = Effect.fn("CodexLiveSessionService.ensurePrincipal")(function* (
      session: EnvironmentAuth.AuthenticatedSession,
    ) {
      if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
        return yield* liveError("session_not_found");
      }
      const activeSessions = yield* authSessions
        .listActive()
        .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
      const principal = activeSessions.find(
        (candidate) => candidate.sessionId === session.sessionId,
      );
      if (
        principal === undefined ||
        principal.subject !== session.subject ||
        !principal.scopes.includes(AuthOrchestrationOperateScope)
      ) {
        return yield* liveError("session_not_found");
      }
    });

    const updateStatus = (
      row: LeaseRow,
      status: LiveVoiceSession["status"],
      additionalSql?: (now: string) => Effect.Effect<unknown>,
    ) =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const next = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE codex_live_voice_leases SET status = ${status}, updated_at = ${now}
              WHERE lease_id = ${row.lease_id} AND generation = ${row.generation}
            `;
            if (additionalSql !== undefined) yield* additionalSql(now);
            return yield* getLease(row.lease_id, row.generation);
          }),
        );
        if (next === undefined) return yield* liveError("session_not_found");
        const session = sessionFromRow(next);
        yield* eventHub.publish({ type: "status", session });
        return { row: next, session };
      });

    const markUnknown = (leaseId: string, generation: number) =>
      Effect.gen(function* () {
        const row = yield* getLease(leaseId, generation);
        if (row !== undefined) yield* updateStatus(row, "unknown");
      });

    const prepare: CodexLiveSessionService["Service"]["prepare"] = (session, input) =>
      leaseLocks.withLock(
        `request:${session.sessionId}:${input.clientRequestId}`,
        Effect.gen(function* () {
          yield* ensurePrincipal(session);
          const environmentId = yield* environment.getEnvironmentId;
          const existing = yield* sql<LeaseRow>`
          SELECT * FROM codex_live_voice_leases
          WHERE environment_id = ${environmentId}
            AND principal_session_id = ${session.sessionId}
            AND client_request_id = ${input.clientRequestId}
        `.pipe(Effect.map((rows) => rows[0]));
          if (existing !== undefined) {
            if (existing.thread_id !== input.threadId) {
              return yield* liveError("dispatch_conflict");
            }
            yield* recoverPendingIntents(existing.lease_id, existing.generation);
            const key = leaseKey(existing.lease_id, existing.generation);
            if (
              !active.has(key) &&
              ["preparing", "prepared", "starting", "active", "stopping"].includes(existing.status)
            ) {
              const reconciled = yield* updateStatus(existing, "unknown");
              return reconciled.session;
            }
            return sessionFromRow(existing);
          }

          const projection = yield* threads
            .getThreadProjection(input.threadId)
            .pipe(Effect.mapError(() => liveError("session_not_found")));
          if (projection.thread.archivedAt !== null) return yield* liveError("session_not_found");
          const providerInstance = yield* providerInstances.getInstance(
            projection.thread.providerInstanceId,
          );
          if (providerInstance?.driverKind !== "codex") {
            return yield* liveError("unsupported_provider");
          }
          const runtimePolicy = yield* runtimePolicies
            .resolve({
              thread: projection.thread,
              modelSelection: projection.thread.modelSelection,
            })
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          const previousLease = yield* sql<LeaseRow>`
          SELECT * FROM codex_live_voice_leases
          WHERE thread_id = ${input.threadId}
            AND status IN ('preparing', 'prepared', 'starting', 'active', 'stopping', 'unknown')
          ORDER BY updated_at DESC LIMIT 1
        `.pipe(Effect.map((rows) => rows[0]));
          if (previousLease !== undefined) return yield* liveError("dispatch_conflict");

          const leaseId = NodeCrypto.randomUUID();
          const generation = 1;
          const now = new Date().toISOString();
          yield* sql`
          INSERT INTO codex_live_voice_leases (
            lease_id, generation, environment_id, thread_id, provider_instance_id,
            model_selection_json, runtime_policy_json,
            provider_session_id, planner_native_thread_id, principal_session_id, principal_subject,
            client_request_id, status, updated_at
          ) VALUES (
            ${leaseId}, ${generation}, ${environmentId}, ${input.threadId},
            ${projection.thread.providerInstanceId}, ${JSON.stringify(projection.thread.modelSelection)},
            ${JSON.stringify(runtimePolicy)}, NULL, NULL, ${session.sessionId}, ${session.subject},
            ${input.clientRequestId}, 'preparing', ${now}
          )
        `.pipe(Effect.catch(() => Effect.fail(liveError("dispatch_conflict"))));
          const initial: LiveVoiceSession = {
            leaseId,
            generation,
            environmentId,
            threadId: input.threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            providerSessionId: null,
            plannerNativeThreadId: null,
            status: "preparing",
          };
          yield* eventHub.register(initial);

          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === projection.thread.activeProviderThreadId,
          );
          const providerSession = projection.providerSessions.find(
            (candidate) => candidate.providerInstanceId === projection.thread.providerInstanceId,
          );
          const providerSessionId =
            providerSession?.id ??
            ProviderSessionId.make(`provider-session-live-${NodeCrypto.randomUUID()}`);
          const runtimeOption = yield* providerSessions
            .get(providerSessionId)
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          const runtime = Option.isSome(runtimeOption)
            ? runtimeOption.value
            : yield* providerSessions
                .open({
                  threadId: input.threadId,
                  providerSessionId,
                  modelSelection: projection.thread.modelSelection,
                  runtimePolicy,
                  ...(providerSession === undefined ? {} : { resumeFromSession: providerSession }),
                  ...(providerThread?.nativeThreadRef?.nativeId === undefined
                    ? {}
                    : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
                })
                .pipe(
                  Effect.mapError(() => liveError("runtime_unavailable")),
                  Effect.catch((error) =>
                    markUnknown(leaseId, generation).pipe(Effect.andThen(Effect.fail(error))),
                  ),
                );
          yield* sql`
          UPDATE codex_live_voice_leases SET provider_session_id = ${providerSessionId},
            updated_at = ${new Date().toISOString()}
          WHERE lease_id = ${leaseId} AND generation = ${generation}
        `;
          if (
            runtime.instanceId !== projection.thread.providerInstanceId ||
            runtime.providerSessionId !== providerSessionId ||
            runtime.driver !== "codex"
          ) {
            const lease = yield* getLease(leaseId, generation);
            if (lease !== undefined) yield* updateStatus(lease, "failed");
            return yield* liveError("unsupported_provider");
          }
          if (runtime.liveVoice === undefined) {
            const lease = yield* getLease(leaseId, generation);
            if (lease !== undefined) yield* updateStatus(lease, "failed");
            return yield* liveError("unsupported_provider");
          }

          const prepared = yield* runtime.liveVoice
            .preparePlanner({
              modelSelection: projection.thread.modelSelection,
              ...(getCodexServiceTierOptionValue(projection.thread.modelSelection) === undefined
                ? {}
                : {
                    serviceTier: getCodexServiceTierOptionValue(projection.thread.modelSelection),
                  }),
              ...(getModelSelectionStringOptionValue(
                projection.thread.modelSelection,
                "reasoningEffort",
              ) === undefined
                ? {}
                : {
                    reasoningEffort: getModelSelectionStringOptionValue(
                      projection.thread.modelSelection,
                      "reasoningEffort",
                    ),
                  }),
              onSubmitWork: ({ plannerNativeThreadId, plannerTurnId, callId, message }) =>
                submitWork({
                  principalSessionId: session.sessionId,
                  leaseId,
                  generation,
                  plannerNativeThreadId,
                  plannerTurnId,
                  callId,
                  message,
                }),
            })
            .pipe(
              Effect.mapError((error) =>
                error instanceof ProviderAdapter.ProviderAdapterProtocolError &&
                error.detail === "Managed ChatGPT account is required for Codex Live."
                  ? liveError("managed_account_required")
                  : liveError("planner_restriction_failed"),
              ),
              Effect.catch((error) =>
                markUnknown(leaseId, generation).pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
          const row = yield* getLease(leaseId, generation);
          if (row === undefined) return yield* liveError("session_not_found");
          yield* sql`
          UPDATE codex_live_voice_leases SET provider_session_id = ${providerSessionId},
            planner_native_thread_id = ${prepared.plannerNativeThreadId}, status = 'prepared',
            updated_at = ${new Date().toISOString()}
          WHERE lease_id = ${leaseId} AND generation = ${generation}
        `;
          const ready = yield* getLease(leaseId, generation);
          if (ready === undefined) return yield* liveError("session_not_found");
          active.set(leaseKey(leaseId, generation), {
            runtime,
            plannerNativeThreadId: prepared.plannerNativeThreadId,
          });
          yield* eventHub.publish({ type: "status", session: sessionFromRow(ready) });
          yield* Effect.forkScoped(
            runtime.liveVoice.events.pipe(
              Stream.runForEach((event) => handleNativeEvent(leaseId, generation, event)),
            ),
          );
          return sessionFromRow(ready);
        }),
      );

    const start: CodexLiveSessionService["Service"]["start"] = (session, input) =>
      leaseLocks.withLock(
        leaseKey(input.leaseId, input.generation),
        Effect.gen(function* () {
          yield* ensurePrincipal(session);
          let row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
          if (row.start_client_request_id === input.clientRequestId) return sessionFromRow(row);
          if (row.status !== "prepared" || row.planner_native_thread_id === null) {
            return yield* liveError("invalid_state");
          }
          const projection = yield* threads
            .getThreadProjection(row.thread_id as LiveVoiceSession["threadId"])
            .pipe(Effect.mapError(() => liveError("session_not_found")));
          const providerInstance = yield* providerInstances.getInstance(
            projection.thread.providerInstanceId,
          );
          const runtimePolicy = yield* runtimePolicies
            .resolve({
              thread: projection.thread,
              modelSelection: projection.thread.modelSelection,
            })
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          if (
            projection.thread.archivedAt !== null ||
            projection.thread.providerInstanceId !== row.provider_instance_id ||
            providerInstance?.driverKind !== "codex" ||
            JSON.stringify(projection.thread.modelSelection) !== row.model_selection_json ||
            JSON.stringify(runtimePolicy) !== row.runtime_policy_json
          ) {
            yield* updateStatus(row, "failed");
            return yield* liveError("stale_lease");
          }
          const next = yield* updateStatus(
            row,
            "starting",
            (now) =>
              sql`
            UPDATE codex_live_voice_leases SET start_client_request_id = ${input.clientRequestId},
              native_started = 0, native_sdp_received = 0, updated_at = ${now}
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
          `,
          );
          row = next.row;
          const lease = active.get(leaseKey(input.leaseId, input.generation));
          if (lease === undefined) {
            yield* updateStatus(row, "unknown");
            return sessionFromRow(yield* getLease(input.leaseId, input.generation) ?? row);
          }
          yield* lease.runtime
            .liveVoice!.start({
              plannerNativeThreadId: row.planner_native_thread_id,
              realtimeSessionId: `${input.leaseId}:${input.generation}`,
              offerSdp: input.offerSdp,
            })
            .pipe(
              Effect.mapError(() => liveError("runtime_unavailable")),
              Effect.catch((error) =>
                updateStatus(row, "unknown").pipe(Effect.andThen(Effect.fail(error))),
              ),
            );
          return sessionFromRow((yield* getLease(input.leaseId, input.generation)) ?? row);
        }),
      );

    const stop: CodexLiveSessionService["Service"]["stop"] = (session, input) =>
      leaseLocks.withLock(
        leaseKey(input.leaseId, input.generation),
        Effect.gen(function* () {
          yield* ensurePrincipal(session);
          const row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
          if (
            row.stop_client_request_id === input.clientRequestId ||
            row.status === "closed" ||
            row.status === "stopping"
          ) {
            return sessionFromRow(row);
          }
          if (row.status === "failed") return sessionFromRow(row);
          if (row.planner_native_thread_id === null || row.provider_session_id === null) {
            if (row.status === "unknown") return sessionFromRow(row);
            return yield* liveError("invalid_state");
          }
          const next = yield* updateStatus(
            row,
            "stopping",
            (now) =>
              sql`
            UPDATE codex_live_voice_leases SET stop_client_request_id = ${input.clientRequestId},
              updated_at = ${now}
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
          `,
          );
          const lease = active.get(leaseKey(input.leaseId, input.generation));
          const runtime =
            lease?.runtime ??
            Option.getOrUndefined(
              yield* providerSessions.get(ProviderSessionId.make(row.provider_session_id)),
            );
          if (runtime?.liveVoice === undefined) {
            yield* updateStatus(next.row, "unknown");
            return sessionFromRow((yield* getLease(input.leaseId, input.generation)) ?? next.row);
          }
          yield* runtime.liveVoice.stop(row.planner_native_thread_id).pipe(
            Effect.mapError(() => liveError("runtime_unavailable")),
            Effect.catch((error) =>
              updateStatus(next.row, "unknown").pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
          return sessionFromRow((yield* getLease(input.leaseId, input.generation)) ?? next.row);
        }),
      );

    const status: CodexLiveSessionService["Service"]["status"] = (session, input) =>
      Effect.gen(function* () {
        yield* ensurePrincipal(session);
        let row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
        yield* recoverPendingIntents(input.leaseId, input.generation);
        row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
        if (
          !active.has(leaseKey(input.leaseId, input.generation)) &&
          ["preparing", "prepared", "starting", "active", "stopping"].includes(row.status)
        ) {
          return (yield* updateStatus(row, "unknown")).session;
        }
        return sessionFromRow(row);
      });

    const subscribe: CodexLiveSessionService["Service"]["subscribe"] = (session, input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* ensurePrincipal(session);
          let row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
          yield* recoverPendingIntents(input.leaseId, input.generation);
          row = yield* getOwnedLease(session.sessionId, input.leaseId, input.generation);
          yield* eventHub.register(sessionFromRow(row));
          return eventHub.subscribe(input);
        }),
      );

    function submitWork(input: {
      readonly principalSessionId: string;
      readonly leaseId: string;
      readonly generation: number;
      readonly plannerNativeThreadId: string;
      readonly plannerTurnId: string;
      readonly callId: string;
      readonly message: string;
    }) {
      return leaseLocks.withLock(
        leaseKey(input.leaseId, input.generation),
        Effect.gen(function* () {
          const sessions = yield* authSessions
            .listActive()
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          const principal = sessions.find(
            (candidate) => candidate.sessionId === input.principalSessionId,
          );
          const currentRow = yield* getOwnedLease(
            input.principalSessionId,
            input.leaseId,
            input.generation,
          );
          if (
            principal === undefined ||
            principal.subject !== currentRow.principal_subject ||
            !principal.scopes.includes(AuthOrchestrationOperateScope)
          ) {
            return yield* liveError("session_not_found");
          }
          if (currentRow.planner_native_thread_id !== input.plannerNativeThreadId) {
            return yield* liveError("stale_lease");
          }
          const commandId = CommandId.make(
            `command:live-voice:${encodeURIComponent(input.leaseId)}:${input.generation}:${encodeURIComponent(input.plannerTurnId)}:submit-0`,
          );
          const messageId = MessageId.make(
            `message:live-voice:${encodeURIComponent(input.leaseId)}:${input.generation}:${encodeURIComponent(input.plannerTurnId)}:submit-0`,
          );
          const now = new Date().toISOString();
          const priorIntents = yield* sql<{
            dispatch_state: "reserved" | "admitted" | "conflict";
          }>`
            SELECT dispatch_state FROM codex_live_voice_intents
            WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
              AND planner_native_thread_id = ${input.plannerNativeThreadId}
              AND planner_turn_id = ${input.plannerTurnId} AND submit_slot = 0
          `;
          if (
            priorIntents.length === 0 &&
            currentRow.status !== "starting" &&
            currentRow.status !== "active"
          ) {
            return yield* liveError("stale_lease");
          }
          yield* sql`
          INSERT OR IGNORE INTO codex_live_voice_intents (
            lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot,
            call_id, message, command_id, message_id, dispatch_state, updated_at
          ) VALUES (
            ${input.leaseId}, ${input.generation}, ${input.plannerNativeThreadId},
            ${input.plannerTurnId}, 0, ${input.callId}, ${input.message.trim()},
            ${commandId}, ${messageId}, 'reserved', ${now}
          )
        `;
          const intents = yield* sql<{
            message: string;
            command_id: string;
            message_id: string;
            dispatch_state: "reserved" | "admitted" | "conflict";
            receipt_json: string | null;
          }>`
          SELECT message, command_id, message_id, dispatch_state, receipt_json
          FROM codex_live_voice_intents
          WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
            AND planner_native_thread_id = ${input.plannerNativeThreadId}
            AND planner_turn_id = ${input.plannerTurnId} AND submit_slot = 0
        `;
          const intent = intents[0];
          if (intent === undefined) return yield* liveError("runtime_unavailable");
          if (intent.message !== input.message.trim()) {
            return yield* liveError("dispatch_conflict");
          }
          if (intent.dispatch_state === "conflict") {
            return yield* liveError("dispatch_conflict");
          }
          if (intent.dispatch_state === "admitted" && intent.receipt_json !== null) {
            return intent.receipt_json;
          }
          const projection = yield* threads
            .getProjectThread({
              projectId: (yield* threads.getThreadProjection(
                currentRow.thread_id as LiveVoiceSession["threadId"],
              )).thread.projectId,
              threadId: currentRow.thread_id as LiveVoiceSession["threadId"],
            })
            .pipe(Effect.mapError(() => liveError("session_not_found")));
          const providerInstance = yield* providerInstances.getInstance(
            projection.thread.providerInstanceId,
          );
          const currentRuntimePolicy = yield* runtimePolicies
            .resolve({
              thread: projection.thread,
              modelSelection: projection.thread.modelSelection,
            })
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          if (
            projection.thread.providerInstanceId !== currentRow.provider_instance_id ||
            providerInstance?.driverKind !== "codex" ||
            projection.thread.archivedAt !== null ||
            JSON.stringify(projection.thread.modelSelection) !== currentRow.model_selection_json ||
            JSON.stringify(currentRuntimePolicy) !== currentRow.runtime_policy_json
          ) {
            yield* sql`
              UPDATE codex_live_voice_intents SET dispatch_state = 'conflict',
                updated_at = ${new Date().toISOString()}
              WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
                AND planner_native_thread_id = ${input.plannerNativeThreadId}
                AND planner_turn_id = ${input.plannerTurnId} AND submit_slot = 0
                AND dispatch_state = 'reserved'
            `;
            return yield* liveError("stale_lease");
          }
          const result = yield* threads
            .sendToThread({
              projectId: projection.thread.projectId,
              threadId: projection.thread.id,
              commandId: CommandId.make(intent.command_id),
              messageId: MessageId.make(intent.message_id),
              text: input.message.trim(),
              attachments: [],
              mode: "queue",
              createdBy: "user",
              creationSource: "voice",
            })
            .pipe(Effect.mapError(() => liveError("runtime_unavailable")));
          const receipt = JSON.stringify({
            accepted: true,
            delivery: result.delivery,
            runId: result.run.id,
          });
          yield* sql`
          UPDATE codex_live_voice_intents SET dispatch_state = 'admitted', receipt_json = ${receipt},
            updated_at = ${new Date().toISOString()}
          WHERE lease_id = ${input.leaseId} AND generation = ${input.generation}
            AND planner_native_thread_id = ${input.plannerNativeThreadId}
            AND planner_turn_id = ${input.plannerTurnId} AND submit_slot = 0
        `;
          return receipt;
        }),
      );
    }

    function handleNativeEvent(
      leaseId: string,
      generation: number,
      event: ProviderAdapter.ProviderAdapterV2LiveVoiceEvent,
    ): Effect.Effect<void> {
      return Effect.gen(function* () {
        const row = yield* getLease(leaseId, generation);
        if (
          row === undefined ||
          row.planner_native_thread_id === null ||
          row.planner_native_thread_id !== event.plannerNativeThreadId
        )
          return;
        switch (event.type) {
          case "started": {
            if (
              event.realtimeSessionId != null &&
              event.realtimeSessionId !== `${leaseId}:${generation}`
            ) {
              yield* updateStatus(row, "unknown");
              return;
            }
            yield* updateStatus(
              row,
              row.native_sdp_received === 1 ? "active" : "starting",
              (now) => sql`
                UPDATE codex_live_voice_leases SET native_started = 1, updated_at = ${now}
                WHERE lease_id = ${leaseId} AND generation = ${generation}
              `,
            );
            return;
          }
          case "sdp": {
            yield* updateStatus(
              row,
              row.native_started === 1 ? "active" : "starting",
              (now) => sql`
                UPDATE codex_live_voice_leases SET native_sdp_received = 1, updated_at = ${now}
                WHERE lease_id = ${leaseId} AND generation = ${generation}
              `,
            );
            yield* eventHub.publish({
              type: "answer",
              leaseId,
              generation,
              sdp: event.sdp.slice(0, 256_000),
            });
            return;
          }
          case "error":
            yield* eventHub.publish({
              type: "error",
              leaseId,
              generation,
              code: "runtime_unavailable",
            });
            yield* updateStatus(row, "failed");
            return;
          case "closed":
            yield* updateStatus(row, "closed");
            active.delete(leaseKey(leaseId, generation));
            return;
          case "transcript":
            yield* eventHub.publish({
              type: "transcript",
              leaseId,
              generation,
              role: event.role,
              text: event.text.slice(0, 16_384),
            });
            return;
        }
      }).pipe(Effect.catchCause(() => markUnknown(leaseId, generation).pipe(Effect.orDie)));
    }

    function recoverPendingIntents(leaseId: string, generation: number) {
      return Effect.gen(function* () {
        const pendingIntents = yield* sql<{
          planner_native_thread_id: string;
          planner_turn_id: string;
          call_id: string;
          message: string;
          principal_session_id: string;
        }>`
          SELECT i.planner_native_thread_id, i.planner_turn_id, i.call_id, i.message,
            l.principal_session_id
          FROM codex_live_voice_intents i
          JOIN codex_live_voice_leases l USING (lease_id, generation)
          WHERE i.lease_id = ${leaseId} AND i.generation = ${generation}
            AND i.dispatch_state = 'reserved'
          ORDER BY i.updated_at, i.planner_turn_id
        `;
        yield* Effect.forEach(
          pendingIntents,
          (intent) =>
            submitWork({
              principalSessionId: intent.principal_session_id,
              leaseId,
              generation,
              plannerNativeThreadId: intent.planner_native_thread_id,
              plannerTurnId: intent.planner_turn_id,
              callId: intent.call_id,
              message: intent.message,
            }).pipe(Effect.ignore),
          { concurrency: 1, discard: true },
        );
      });
    }

    return CodexLiveSessionService.of({ prepare, start, stop, status, subscribe });
  }),
).pipe(Layer.provideMerge(CodexLiveEventHub.layer));
