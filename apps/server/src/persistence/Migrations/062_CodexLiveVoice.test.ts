import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("persists one voice lease and one submission slot per planner turn", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`
      INSERT INTO codex_live_voice_leases (
        lease_id, generation, environment_id, thread_id, provider_instance_id,
        model_selection_json, runtime_policy_json, principal_session_id, principal_subject,
        client_request_id, status, updated_at
      ) VALUES ('lease-a', 1, 'env-a', 'thread-a', 'codex', '{}', '{}',
        'principal-a', 'subject-a', 'request-a', 'preparing', '2026-10-14T00:00:00.000Z')
    `;
    const duplicateRequest = yield* Effect.exit(sql`
      INSERT INTO codex_live_voice_leases (
        lease_id, generation, environment_id, thread_id, provider_instance_id,
        model_selection_json, runtime_policy_json, principal_session_id, principal_subject,
        client_request_id, status, updated_at
      ) VALUES ('lease-b', 1, 'env-a', 'thread-b', 'codex', '{}', '{}',
        'principal-a', 'subject-a', 'request-a', 'preparing', '2026-10-14T00:00:01.000Z')
    `);
    assert.isTrue(Exit.isFailure(duplicateRequest));

    yield* sql`
      INSERT INTO codex_live_voice_intents (
        lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot,
        call_id, message, command_id, message_id, dispatch_state, updated_at
      ) VALUES ('lease-a', 1, 'planner-a', 'turn-a', 0, 'call-a', 'do the work',
        'command-a', 'message-a', 'reserved', '2026-10-14T00:00:00.000Z')
    `;
    yield* sql`
      INSERT OR IGNORE INTO codex_live_voice_intents (
        lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot,
        call_id, message, command_id, message_id, dispatch_state, updated_at
      ) VALUES ('lease-a', 1, 'planner-a', 'turn-a', 0, 'call-b', 'a different utterance',
        'command-b', 'message-b', 'reserved', '2026-10-14T00:00:02.000Z')
    `;
    const intents = yield* sql<{
      call_id: string;
      message: string;
      command_id: string;
    }>`
      SELECT call_id, message, command_id FROM codex_live_voice_intents
      WHERE lease_id = 'lease-a' AND generation = 1 AND planner_native_thread_id = 'planner-a'
        AND planner_turn_id = 'turn-a' AND submit_slot = 0
    `;
    assert.deepStrictEqual(intents, [
      { call_id: "call-a", message: "do the work", command_id: "command-a" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
