-- AlterTable
ALTER TABLE "games" ADD COLUMN     "roster" JSONB;

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "model_name" VARCHAR(64) NOT NULL,
    "base_url" VARCHAR(512),
    "api_key_ciphertext" TEXT,
    "api_key_hint" VARCHAR(4),
    "tag" VARCHAR(64),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memories" (
    "agent_id" UUID NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "sort" SMALLINT NOT NULL,
    "title" VARCHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("agent_id","type","sort")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- AddForeignKey
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
