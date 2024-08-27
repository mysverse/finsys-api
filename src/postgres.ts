import pkg from "pg";
const { Pool, types } = pkg;

const pool = new Pool();

export async function startDB() {
  try {
    console.log("Attempting to connect...");
    // Parsing bigint to integer (consider the limitations of JavaScript number type)
    types.setTypeParser(types.builtins.INT8, BigInt);
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
  rejection_reason?: string
) {
  if (status === "rejected" && rejection_reason) {
    await pool.query(
      `UPDATE ${table_payouts} SET status = $1, rejection_reason = $2 WHERE id = $3`,
      [status, rejection_reason, requestId]
    );
  } else {
    await pool.query(`UPDATE ${table_payouts} SET status = $1 WHERE id = $2`, [
      status,
      requestId,
    ]);
  }
}

// Function to fetch payout request details if it's not already approved
export async function fetchPayoutRequestDetails(requestId: number) {
  const response = await pool.query<PayoutRequestData>(
    `SELECT status, user_id, amount FROM payout_requests WHERE id = $1`,
    [requestId]
  );
  console.dir(response, { depth: null });
  const request = response.rows[0];
  if (!request || request.status === "approved") {
    throw new Error("Request is either non-existent or already approved");
  }
  return request;
}

// Function to get all pending payout requests
export async function getAllRequests(): Promise<PayoutRequestData[]> {
  const response = await pool.query<PayoutRequestData>(
    `SELECT * FROM ${table_payouts} ORDER BY created_at DESC`
  );
  return response.rows;
}

// Function to get all pending payout requests for a specific user
export async function getPayoutRequestsByUser(userId: number) {
  const response = await pool.query<PayoutRequestData>(
    `SELECT * FROM payout_requests WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return response.rows;
}
