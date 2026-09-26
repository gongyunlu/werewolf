-- AlterTable
ALTER TABLE "asked_prompts" ADD COLUMN     "experiences" JSONB;

-- CreateTable
CREATE TABLE "experience_generations" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "game_id" VARCHAR(64) NOT NULL,
    "player_id" VARCHAR(64) NOT NULL,
    "review_version" VARCHAR(64) NOT NULL,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experience_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_experiences" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "board_id" VARCHAR(64) NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "content" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_experiences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "experience_generations_game_id_player_id_review_version_key" ON "experience_generations"("game_id", "player_id", "review_version");

-- CreateIndex
CREATE INDEX "agent_experiences_agent_id_board_id_enabled_idx" ON "agent_experiences"("agent_id", "board_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "agent_experiences_generation_id_ordinal_key" ON "agent_experiences"("generation_id", "ordinal");

-- AddForeignKey
ALTER TABLE "experience_generations" ADD CONSTRAINT "experience_generations_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_experiences" ADD CONSTRAINT "agent_experiences_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_experiences" ADD CONSTRAINT "agent_experiences_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "experience_generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
