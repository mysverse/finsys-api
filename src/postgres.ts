import { payout_requests, Prisma, PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import config from "./config.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

let log: FastifyBaseLogger | undefined;

export function setLogger(logger: FastifyBaseLogger) {
  log = logger;
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// TODO: replace this unsafe method of serialisation
BigInt.prototype.toJSON = function () {
  return Number(this);
};

function handleNumeric(num: number) {
  return num;
}

// Create a new payout request
export async function createPayoutRequest(
  userId: number,
  amount: number,
  reason: string
) {
  log?.debug({ userId, amount }, "Creating payout request");
  return prisma.payout_requests.create({
    data: {
      user_id: handleNumeric(userId),
      amount: handleNumeric(amount),
      reason,
      status: "pending",
    },
  });
}

// Get a payout request (first pending) for a user
export async function getPayoutRequestByUser(
  userId: number
): Promise<any | null> {
  return await prisma.payout_requests.findFirst({
    where: {
      user_id: handleNumeric(userId),
      status: "pending",
    },
  });
}

// Update the status of a payout request and notify the user
export async function updatePayoutRequestStatus(
  requestId: number,
  status: "pending" | "approved" | "rejected",
  rejection_reason?: string,
  user_id?: number,
  approver_id?: number
) {
  log?.debug({ requestId, status, approverId: approver_id }, "Updating payout request status");
  if (status === "rejected" && rejection_reason) {
    await prisma.payout_requests.update({
      where: { id: handleNumeric(requestId) },
      data: {
        status,
        rejection_reason,
        approver_id: approver_id ? handleNumeric(approver_id) : null,
      },
    });
  } else {
    await prisma.payout_requests.update({
      where: { id: handleNumeric(requestId) },
      data: {
        status,
        approver_id: approver_id ? handleNumeric(approver_id) : null,
      },
    });
  }

  try {
    if (
      user_id &&
      config.notifierUrl &&
      config.notifierUrl.trim().length > 0 &&
      (status === "approved" || status === "rejected")
    ) {
      const url = new URL(config.notifierUrl);
      url.searchParams.append("userId", user_id.toString());
      url.searchParams.append("template", "sentral");
      await fetch(url.toString());
    }
  } catch (error) {
    log?.error(
      { err: error instanceof Error ? error : undefined, userId: user_id, status },
      "Failed to notify user of payout request status change",
    );
  }
}

// Fetch payout request details if not already approved
export async function fetchPayoutRequestDetails(requestId: number) {
  const request = await prisma.payout_requests.findUnique({
    where: { id: handleNumeric(requestId) },
    select: {
      status: true,
      user_id: true,
      amount: true,
    },
  });

  if (!request || request.status === "approved") {
    throw new Error("Request is either non-existent or already approved");
  }
  return request;
}

// Get all payout requests ordered with pending ones first and then by created_at (using a raw query)
export async function getAllRequests(offset?: number, limit?: number) {
  const results = await prisma.$queryRaw<payout_requests[]>(
    Prisma.sql`
      SELECT *
      FROM payout_requests
      ORDER BY (status = ‘pending’) DESC, created_at DESC
      LIMIT ${limit ?? 100}
      OFFSET ${offset ?? 0}
    `,
  );
  return results;
}

// Get payout requests for a specific user ordered by created_at DESC with optional pagination
export async function getPayoutRequestsByUser(
  userId: number,
  offset?: number,
  limit?: number
) {
  return await prisma.payout_requests.findMany({
    where: {
      user_id: handleNumeric(userId),
    },
    orderBy: {
      created_at: "desc",
    },
    skip: offset,
    take: limit,
  });
}
