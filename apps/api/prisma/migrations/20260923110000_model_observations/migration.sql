-- AlterTable
ALTER TABLE "asked_prompts" ADD COLUMN     "call_id" UUID,
ADD COLUMN     "checkpoint_id" VARCHAR(120),
ADD COLUMN     "duration_ms" DOUBLE PRECISION,
ADD COLUMN     "endpoint_key" VARCHAR(64),
ADD COLUMN     "execution_id" UUID,
ADD COLUMN     "failure_code" VARCHAR(32),
ADD COLUMN     "finished_at" TIMESTAMPTZ,
ADD COLUMN     "format_attempt" SMALLINT,
ADD COLUMN     "span_id" VARCHAR(16),
ADD COLUMN     "status" VARCHAR(32),
ADD COLUMN     "step" VARCHAR(32),
ADD COLUMN     "summary_key" VARCHAR(200),
ADD COLUMN     "task_id" VARCHAR(120),
ADD COLUMN     "trace_id" VARCHAR(32);

-- CreateTable
CREATE TABLE "model_attempts" (
    "asked_prompt_id" INTEGER NOT NULL,
    "attempt_no" SMALLINT NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'started',
    "dispatched" BOOLEAN,
    "failure_code" VARCHAR(32),
    "duration_ms" DOUBLE PRECISION,
    "thinking_ms" DOUBLE PRECISION,
    "http_status" SMALLINT,
    "request_id" TEXT,
    "usage" JSONB,
    "usage_complete" BOOLEAN,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "trace_id" VARCHAR(32),
    "span_id" VARCHAR(16),

    CONSTRAINT "model_attempts_pkey" PRIMARY KEY ("asked_prompt_id","attempt_no")
);

-- CreateIndex
CREATE UNIQUE INDEX "asked_prompts_call_id_key" ON "asked_prompts"("call_id");

-- AddForeignKey
ALTER TABLE "model_attempts" ADD CONSTRAINT "model_attempts_asked_prompt_id_fkey" FOREIGN KEY ("asked_prompt_id") REFERENCES "asked_prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
