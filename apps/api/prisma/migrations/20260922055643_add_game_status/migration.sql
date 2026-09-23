-- AlterTable
ALTER TABLE "games" ADD COLUMN     "status" VARCHAR(16) NOT NULL DEFAULT 'queued';

-- 加这一列之前建的档没有状态，默认值会把跑完的和中途散了的都说成「排队中」。
-- 分两拨回填：有胜方的已经跑完；没有的（都是开发期中途放弃的那几局）不会再有人接着跑，
-- 标成 failed，免得列表里挂着一堆永远排队中的局。
UPDATE "games" SET "status" = 'finished' WHERE "winner" IS NOT NULL;
UPDATE "games" SET "status" = 'failed' WHERE "winner" IS NULL;
