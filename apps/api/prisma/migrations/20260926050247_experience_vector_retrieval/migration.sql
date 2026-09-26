-- AlterTable
ALTER TABLE "action_records" ADD COLUMN     "experience_retrieval" JSONB;

-- AlterTable
ALTER TABLE "agent_experiences" ADD COLUMN     "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "embedding_key" VARCHAR(64);

-- CreateIndex
CREATE INDEX "agent_experiences_board_id_role_enabled_embedding_key_idx" ON "agent_experiences"("board_id", "role", "enabled", "embedding_key");
