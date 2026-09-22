-- AlterTable
ALTER TABLE "game_events" ADD COLUMN     "audience" TEXT[] DEFAULT ARRAY[]::TEXT[];
