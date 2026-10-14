import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
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
