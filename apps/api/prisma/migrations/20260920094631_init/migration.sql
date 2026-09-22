-- CreateTable
CREATE TABLE "games" (
    "id" VARCHAR(64) NOT NULL,
    "board_id" VARCHAR(64) NOT NULL,
    "prompts" JSONB NOT NULL,
    "winner" VARCHAR(16),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_steps" (
    "game_id" VARCHAR(64) NOT NULL,
    "phase_instance_id" VARCHAR(64) NOT NULL,
    "state" JSONB NOT NULL,
    "input" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_steps_pkey" PRIMARY KEY ("game_id","phase_instance_id")
);

-- CreateTable
CREATE TABLE "game_events" (
    "game_id" VARCHAR(64) NOT NULL,
    "seq" SMALLINT NOT NULL,
    "event_key" VARCHAR(200) NOT NULL,
    "day" SMALLINT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_events_pkey" PRIMARY KEY ("game_id","seq")
);

-- CreateTable
CREATE TABLE "action_records" (
    "action_key" VARCHAR(200) NOT NULL,
    "game_id" VARCHAR(64) NOT NULL,
    "phase_instance_id" VARCHAR(64) NOT NULL,
    "action_type" VARCHAR(32) NOT NULL,
    "actor_id" VARCHAR(64) NOT NULL,
    "action_ordinal" SMALLINT NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'running',
    "outcome" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "done_at" TIMESTAMPTZ,

    CONSTRAINT "action_records_pkey" PRIMARY KEY ("action_key")
);

-- CreateTable
CREATE TABLE "graph_checkpoints" (
    "game_id" VARCHAR(64) NOT NULL,
    "checkpoint_ns" VARCHAR(200) NOT NULL DEFAULT '',
    "checkpoint_id" VARCHAR(120) NOT NULL,
    "parent_checkpoint_id" VARCHAR(120),
    "checkpoint" JSONB NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_checkpoints_pkey" PRIMARY KEY ("game_id","checkpoint_ns","checkpoint_id")
);

-- CreateTable
CREATE TABLE "graph_checkpoint_writes" (
    "game_id" VARCHAR(64) NOT NULL,
    "checkpoint_ns" VARCHAR(200) NOT NULL DEFAULT '',
    "checkpoint_id" VARCHAR(120) NOT NULL,
    "task_id" VARCHAR(120) NOT NULL,
    "idx" INTEGER NOT NULL,
    "channel" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "graph_checkpoint_writes_pkey" PRIMARY KEY ("game_id","checkpoint_ns","checkpoint_id","task_id","idx")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_events_game_id_event_key_key" ON "game_events"("game_id", "event_key");

-- CreateIndex
CREATE INDEX "action_records_game_id_phase_instance_id_idx" ON "action_records"("game_id", "phase_instance_id");

-- AddForeignKey
ALTER TABLE "game_steps" ADD CONSTRAINT "game_steps_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_records" ADD CONSTRAINT "action_records_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_checkpoints" ADD CONSTRAINT "graph_checkpoints_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_checkpoint_writes" ADD CONSTRAINT "graph_checkpoint_writes_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
