CREATE TABLE IF NOT EXISTS orthros_save_snapshots (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    container_id text NOT NULL,
    sha256 char(64) NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    object_key text NOT NULL UNIQUE,
    device_id varchar(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, container_id, sha256)
);

CREATE INDEX IF NOT EXISTS orthros_save_snapshots_history_idx
    ON orthros_save_snapshots (user_id, container_id, created_at DESC);

CREATE TABLE IF NOT EXISTS orthros_save_heads (
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    container_id text NOT NULL,
    snapshot_id uuid NOT NULL REFERENCES orthros_save_snapshots(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, container_id)
);

