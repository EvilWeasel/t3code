import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";

it.effect("upgrades deployed 61 through main 62 and Voice 63 with one submission slot per planner turn", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    assert.lengthOf(yield* failureIndex, 0);
    assert.deepStrictEqual(yield* runMigrations(), [
      [62, "ThreadFailureLookupIndex"],
      [63, "CodexLiveVoice"],
    ]);
    assert.lengthOf(yield* failureIndex, 1);
    assert.deepStrictEqual(yield* sql`
      SELECT migration_id, name FROM effect_sql_migrations
      WHERE migration_id >= 62 ORDER BY migration_id
    `, [
      { migration_id: 62, name: "ThreadFailureLookupIndex" },
      { migration_id: 63, name: "CodexLiveVoice" },
    ]);
    assert.lengthOf(yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('codex_live_voice_leases', 'codex_live_voice_intents')
    `, 2);
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

// Frozen schema from qualified f1bf0f15 migration 62, independent of the new migration.
const qualifiedVoice62Schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS codex_live_voice_leases (
      lease_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_policy_json TEXT NOT NULL,
      provider_session_id TEXT,
      planner_native_thread_id TEXT,
      principal_session_id TEXT NOT NULL,
      principal_subject TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      start_client_request_id TEXT,
      stop_client_request_id TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'preparing', 'prepared', 'starting', 'active', 'stopping', 'closed', 'failed', 'unknown'
      )),
      native_started INTEGER NOT NULL DEFAULT 0 CHECK (native_started IN (0, 1)),
      native_sdp_received INTEGER NOT NULL DEFAULT 0 CHECK (native_sdp_received IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (lease_id, generation),
      UNIQUE (environment_id, principal_session_id, client_request_id)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS codex_live_voice_one_active_lease_per_thread_idx
    ON codex_live_voice_leases(thread_id)
    WHERE status IN ('preparing', 'prepared', 'starting', 'active', 'stopping', 'unknown')
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS codex_live_voice_one_active_lease_per_provider_session_idx
    ON codex_live_voice_leases(provider_session_id)
    WHERE provider_session_id IS NOT NULL
      AND status IN ('preparing', 'prepared', 'starting', 'active', 'stopping', 'unknown')
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS codex_live_voice_intents (
      lease_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      planner_native_thread_id TEXT NOT NULL,
      planner_turn_id TEXT NOT NULL,
      submit_slot INTEGER NOT NULL CHECK (submit_slot = 0),
      call_id TEXT NOT NULL,
      message TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      dispatch_state TEXT NOT NULL CHECK (dispatch_state IN ('reserved', 'admitted', 'conflict')),
      receipt_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot),
      FOREIGN KEY (lease_id, generation)
        REFERENCES codex_live_voice_leases (lease_id, generation)
        ON DELETE CASCADE
    ) WITHOUT ROWID
  `;
});

const failureIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'index'
      AND name = 'orchestration_v2_projection_turn_items_failed_error_idx'
  `;
});

it.effect("adds Voice 63 to the current main 62 database without replacing main's migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 62 });
    assert.lengthOf(yield* failureIndex, 1);
    assert.lengthOf(yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_live_voice_leases'
    `, 0);
    assert.deepStrictEqual(yield* runMigrations(), [[63, "CodexLiveVoice"]]);
    assert.lengthOf(yield* failureIndex, 1);
    const ledger = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    assert.deepStrictEqual(ledger.map((row) => [row.migration_id, row.name] as const), migrationManifest);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("upgrades the qualified Voice 62 ledger atomically while preserving leases, intents and history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* qualifiedVoice62Schema;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES (62, 'CodexLiveVoice', '2026-10-14 01:52:17')
    `;
    yield* sql`
      INSERT INTO codex_live_voice_leases (
        lease_id, generation, environment_id, thread_id, provider_instance_id,
        model_selection_json, runtime_policy_json, principal_session_id, principal_subject,
        client_request_id, status, updated_at
      ) VALUES ('retained-lease', 1, 'env-a', 'thread-a', 'codex', '{}', '{}',
        'principal-a', 'subject-a', 'request-a', 'closed', '2026-10-14T01:52:17.000Z')
    `;
    yield* sql`
      INSERT INTO codex_live_voice_intents (
        lease_id, generation, planner_native_thread_id, planner_turn_id, submit_slot,
        call_id, message, command_id, message_id, dispatch_state, receipt_json, updated_at
      ) VALUES ('retained-lease', 1, 'planner-a', 'turn-a', 0, 'call-a', '  exact work  ',
        'command-a', 'message-a', 'admitted', '{"runId":"run-a","readback":{"state":"sent"}}',
        '2026-10-14T01:52:17.000Z')
    `;
    const leases = yield* sql`SELECT * FROM codex_live_voice_leases`;
    const intents = yield* sql`SELECT * FROM codex_live_voice_intents`;
    assert.lengthOf(yield* failureIndex, 0);
    assert.deepStrictEqual(yield* runMigrations(), [
      [62, "ThreadFailureLookupIndex"],
      [63, "CodexLiveVoice"],
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM codex_live_voice_leases`, leases);
    assert.deepStrictEqual(yield* sql`SELECT * FROM codex_live_voice_intents`, intents);
    assert.deepStrictEqual(yield* sql`
      SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id = 63
    `, [{ migration_id: 63, name: "CodexLiveVoice", created_at: "2026-10-14 01:52:17" }]);
    const ledger = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    assert.deepStrictEqual(ledger.map((row) => [row.migration_id, row.name] as const), migrationManifest);
    assert.lengthOf(yield* failureIndex, 1);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["OtherForkMigration", "CodexLiveVoice"])(
  "refuses a conflicting or incomplete recorded 62 schema: %s",
  (name) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name) VALUES (62, ${name})
    `;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const result = yield* Effect.exit(runMigrations());
    assert.isTrue(Exit.isFailure(result));
    assert.deepStrictEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, before);
    assert.lengthOf(yield* failureIndex, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
