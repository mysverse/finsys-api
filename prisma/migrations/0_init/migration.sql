-- CreateTable
CREATE TABLE "payout_requests" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" VARCHAR(15) NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "group_id" BIGINT,
    "category" VARCHAR(255),
    "approver_id" BIGINT,
    "rejection_reason" TEXT,

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_payouts_by_user_and_status" ON "payout_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "payout_requests_status" ON "payout_requests"("status");

-- CreateIndex
CREATE INDEX "payout_requests_user_id" ON "payout_requests"("user_id");

