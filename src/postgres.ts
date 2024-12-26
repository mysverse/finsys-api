import pkg from "pg";
import config from "./config.js";
const { Pool, types } = pkg;

const pool = new Pool();

export async function startDB() {
  try {
    console.log("Attempting to connect...");
    // Parsing bigint to integer (consider the limitations of JavaScript number type)
    types.setTypeParser(types.builtins.INT8, parseInt);
    types.setTypeParser(types.builtins.FLOAT8, parseFloat);
    // amount is numeric so...
    types.setTypeParser(types.builtins.NUMERIC, parseFloat);
    await pool.connect();
    console.log("Connected");
  } catch (error) {
    console.error(error);
    throw new Error("Unable to connect to Postgres database!");
  }
}

const table_payouts = "payout_requests";

type PayoutStatus = "pending" | "approved" | "rejected";

interface PayoutRequestData {
  id: number;
  user_id: number;
  amount: number;
  reason: string;
  status: PayoutStatus;
  roblox_group_id: number | null;
  category: string | null;
  approved_by_roblox_user_id: number | null;
  rejection_reason: string | null;
  created_at: Date; // Assuming TIMESTAMP maps to JavaScript Date
  updated_at: Date; // Assuming TIMESTAMP maps to JavaScript Date
}

// Function to create a new payout request
export async function createPayoutRequest(
  userId: number,
  amount: number,
  reason: string
) {
  await pool.query(
    `INSERT INTO ${table_payouts} (user_id, amount, reason, status) VALUES ($1, $2, $3, $4)`,
    [userId, amount, reason, "pending"]
  );
}

// Function to get a payout request by user ID
export async function getPayoutRequestByUser(
  userId: number
): Promise<PayoutRequestData | undefined> {
  const response = await pool.query<PayoutRequestData>(
    `SELECT * FROM ${table_payouts} WHERE user_id = $1 AND status = 'pending'`,
    [userId]
  );
  return response.rows[0];
}

// Function to update the status of a payout request
export async function updatePayoutRequestStatus(
  requestId: number,
  status: PayoutStatus,
  rejection_reason?: string,
  user_id?: number,
  approver_id?: number
) {
  if (status === "rejected" && rejection_reason) {
    await pool.query(
      `UPDATE ${table_payouts} SET status = $1, rejection_reason = $2, approver_id = $3 WHERE id = $4`,
      [status, rejection_reason, approver_id, requestId]
    );
  } else {
    await pool.query(
      `UPDATE ${table_payouts} SET status = $1, approver_id = $2 WHERE id = $3`,
      [status, approver_id, requestId]
    );
  }
  try {
    if (user_id && config.notifierUrl && config.notifierUrl.trim().length > 0) {
      if (status === "approved" || status === "rejected") {
        const url = new URL(config.notifierUrl);
        url.searchParams.append("userId", user_id.toString());
        url.searchParams.append("template", "sentral");
        await fetch(url);
      }
    }
  } catch (error) {
    console.error("Failed to notify user of payout request status change");
    console.error(error);
  }
}

// Function to fetch payout request details if it's not already approved
export async function fetchPayoutRequestDetails(requestId: number) {
  const response = await pool.query<PayoutRequestData>(
    `SELECT status, user_id, amount FROM ${table_payouts} WHERE id = $1`,
    [requestId]
  );
  const request = response.rows[0];
  if (!request || request.status === "approved") {
    throw new Error("Request is either non-existent or already approved");
  }
  return request;
}

// Function to get all pending payout requests
export async function getAllRequests(
  offset?: number,
  limit?: number
): Promise<PayoutRequestData[]> {
  let sql: string = `SELECT * FROM ${table_payouts} ORDER BY status = 'pending' DESC, created_at DESC`;
  const params: number[] = [];

  if (limit) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset) {
    sql += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const response = await pool.query<PayoutRequestData>(sql, params);
  return response.rows;
}

// Function to get all pending payout requests for a specific user
export async function getPayoutRequestsByUser(
  userId: number,
  offset?: number,
  limit?: number
): Promise<PayoutRequestData[]> {
  let sql: string = `SELECT * FROM ${table_payouts} WHERE user_id = $1 ORDER BY created_at DESC`;
  let params: any[] = [userId];

  if (limit) {
    sql += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset) {
    sql += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const response = await pool.query<PayoutRequestData>(sql, params);
  return response.rows;
}
