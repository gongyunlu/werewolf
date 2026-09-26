-- AlterTable
ALTER TABLE "asked_prompts" ADD COLUMN     "knowledge" JSONB,
ADD COLUMN     "knowledge_version_id" UUID,
ALTER COLUMN "game_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "knowledge_items" (
    "id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "active_version_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_versions" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "board_ids" TEXT[],
    "roles" TEXT[],
    "action_types" TEXT[],
    "first_day_only" BOOLEAN NOT NULL,
    "state" JSONB NOT NULL,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embedding_key" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_items_active_version_id_key" ON "knowledge_items"("active_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_versions_item_id_version_key" ON "knowledge_versions"("item_id", "version");

-- CreateIndex
CREATE INDEX "asked_prompts_knowledge_version_id_idx" ON "asked_prompts"("knowledge_version_id");

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "knowledge_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "knowledge_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asked_prompts" ADD CONSTRAINT "asked_prompts_knowledge_version_id_fkey" FOREIGN KEY ("knowledge_version_id") REFERENCES "knowledge_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
