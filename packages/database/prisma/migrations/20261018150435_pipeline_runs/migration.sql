-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "requirement" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentStage" TEXT,
    "version" INTEGER NOT NULL,
    "doc" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineAttempt" (
    "seq" BIGSERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineAttempt_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "PipelineRun_ownerId_updatedAt_idx" ON "PipelineRun"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "PipelineRun_updatedAt_idx" ON "PipelineRun"("updatedAt" DESC);

-- CreateIndex
CREATE INDEX "PipelineAttempt_runId_seq_idx" ON "PipelineAttempt"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineAttempt_runId_attemptId_key" ON "PipelineAttempt"("runId", "attemptId");

-- AddForeignKey
ALTER TABLE "PipelineAttempt" ADD CONSTRAINT "PipelineAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
