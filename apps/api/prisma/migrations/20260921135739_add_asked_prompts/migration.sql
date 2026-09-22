-- CreateTable
CREATE TABLE "asked_prompts" (
    "id" SERIAL NOT NULL,
    "game_id" VARCHAR(64) NOT NULL,
    "action_key" VARCHAR(200),
    "model" VARCHAR(64) NOT NULL,
    "system" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "tool" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asked_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asked_prompts_action_key_idx" ON "asked_prompts"("action_key");

-- CreateIndex
CREATE INDEX "asked_prompts_game_id_id_idx" ON "asked_prompts"("game_id", "id");

-- AddForeignKey
ALTER TABLE "asked_prompts" ADD CONSTRAINT "asked_prompts_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
