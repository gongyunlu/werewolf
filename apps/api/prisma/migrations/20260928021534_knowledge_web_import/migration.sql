-- AlterTable
ALTER TABLE "asked_prompts" ADD COLUMN     "knowledge_capture_id" UUID;

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" UUID NOT NULL,
    "url" VARCHAR(600) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_captures" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sources_url_key" ON "knowledge_sources"("url");

-- CreateIndex
CREATE INDEX "knowledge_captures_source_id_created_at_idx" ON "knowledge_captures"("source_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_captures_batch_id_source_id_key" ON "knowledge_captures"("batch_id", "source_id");

-- CreateIndex
CREATE INDEX "asked_prompts_knowledge_capture_id_idx" ON "asked_prompts"("knowledge_capture_id");

-- AddForeignKey
ALTER TABLE "knowledge_captures" ADD CONSTRAINT "knowledge_captures_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asked_prompts" ADD CONSTRAINT "asked_prompts_knowledge_capture_id_fkey" FOREIGN KEY ("knowledge_capture_id") REFERENCES "knowledge_captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;
