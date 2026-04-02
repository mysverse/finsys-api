// Modules
import { config as config_env } from "dotenv-safe";
config_env();

import fastify, { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import noblox from "noblox.js";
import { Type, TypeBoxTypeProvider } from "@fastify/type-provider-typebox";

// Classes
import config from "./config.js";

import {
  createPayoutRequest,
  getPayoutRequestByUser,
  updatePayoutRequestStatus,
  getPayoutRequestsByUser,
  fetchPayoutRequestDetails,
  getAllRequests,
  setLogger,
} from "./postgres.js";
import { generateSync } from "otplib";
import got from "got";
import { payout_requests } from "@prisma/client";
import {
  RobloxSession,
  RobloxError,
  RobloxErrorType,
  classifyHttpError,
} from "./roblox.js";

// Variables

const server = fastify({
  trustProxy: true,
  logger: {
    level: process.env.LOG_LEVEL || "info",
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          hostname: request.hostname,
          remoteAddress: request.ip,
        };
      },
    },
    ...(process.env.NODE_ENV === "development" && {
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
      },
    }),
  },
}).withTypeProvider<TypeBoxTypeProvider>();

setLogger(server.log);

const port: number = config.port;

const origins = ["localhost", "127.0.0.1"].concat(config.settings.cors);

await server.register(fastifyCors, {
  origin: origins,
});

await server.register(fastifySwagger, {
  openapi: {
    info: {
      title: "MYSverse FinSys API",
      description: "Financial system API for managing Roblox group payouts",
      version: "1.0.0",
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          name: "x-api-key",
          in: "header",
        },
      },
    },
    tags: [
      {
        name: "Payouts",
        description: "Create, approve/reject, and list payout requests",
      },
      {
        name: "Permissions",
        description: "Check user permissions for the financial system",
      },
      {
        name: "System",
        description: "Health checks and administrative operations",
      },
    ],
    security: [{ apiKey: [] }],
  },
});

await server.register(fastifySwaggerUi, {
  routePrefix: "/docs",
  indexPrefix: config.settings.proxyPrefix,
});

const maxRobux = config.settings.maxRobux;
const groupId = config.settings.groupId;

let robloxSession!: RobloxSession;

function isBlacklisted(userId: number | BigInt) {
  return config.blacklistedIds.includes(Number(userId));
}

async function payoutRobux(userId: number, amount: number, log: FastifyBaseLogger) {
  // Pre-flight: abort early if session is known to be unhealthy
  if (!robloxSession.isHealthy()) {
    throw new RobloxError(
      RobloxErrorType.AUTH_EXPIRED,
      "Roblox session is not healthy. Payout aborted. Replace the cookie and retry.",
      undefined,
      false,
    );
  }

  const cookie = robloxSession.getCookie();

  // Step 1: Fetch X-CSRF Token via noblox.js (cached internally)
  log.trace({ userId, amount }, "Payout step 1: fetching CSRF token");
  const xCsrfToken = await robloxSession.getCsrfToken();

  // Step 2: Initial Payout Request
  log.trace({ userId, amount }, "Payout step 2: sending initial payout request");
  const payoutResponse = await got.post(
    `https://groups.roblox.com/v1/groups/${groupId}/payouts`,
    {
      headers: {
        Cookie: `.ROBLOSECURITY=${cookie}`,
        "X-CSRF-TOKEN": xCsrfToken,
      },
      retry: {
        methods: ["POST"],
        limit: 3,
      },
      timeout: {
        request: 10000,
      },
      json: {
        PayoutType: 1,
        Recipients: [
          {
            recipientId: userId,
            recipientType: 0,
            amount: amount,
          },
        ],
      },
      throwHttpErrors: false,
    },
  );

  if (payoutResponse.statusCode === 200) {
    log.debug({ userId, amount }, "Payout completed without 2FA challenge");
    return payoutResponse;
  }

  // Classify non-200 responses
  const initialError = classifyHttpError(
    payoutResponse.statusCode,
    payoutResponse.headers,
    payoutResponse.body,
    "Initial payout request",
  );

  // If classifyHttpError returns null, it's a 2FA challenge — proceed with the flow
  if (initialError !== null) {
    if (initialError.type === RobloxErrorType.AUTH_EXPIRED) {
      robloxSession.markUnhealthy();
    }
    log.error({ statusCode: payoutResponse.statusCode, body: payoutResponse.body }, "Initial payout request failed");
    throw initialError;
  }

  // Step 3: 2FA challenge detected — extract metadata
  log.trace("Payout step 3: extracting 2FA challenge metadata");
  const challengeMetadataEncodedHeader =
    payoutResponse.headers["rblx-challenge-metadata"];

  const challengeMetadataEncoded = challengeMetadataEncodedHeader
    ? Array.isArray(challengeMetadataEncodedHeader)
      ? challengeMetadataEncodedHeader[0]
      : challengeMetadataEncodedHeader
    : "";

  const challengeMetadata = JSON.parse(
    Buffer.from(challengeMetadataEncoded, "base64").toString("utf-8"),
  );

  const challengeMetadataId: string = challengeMetadata["challengeId"];

  const twoFaCode = generateSync({
    secret: robloxSession.getTotpSecret(),
  });

  // Step 4: Submit 2FA Verification
  log.trace("Payout step 4: submitting 2FA verification");
  const challengeHeaderId = payoutResponse.headers["rblx-challenge-id"];

  const twoFaVerificationResponse = await got.post<any>(
    `https://twostepverification.roblox.com/v1/users/${robloxSession.getUserId()}/challenges/authenticator/verify`,
    {
      headers: {
        Cookie: `.ROBLOSECURITY=${cookie}`,
        "X-CSRF-TOKEN": xCsrfToken,
      },
      retry: {
        methods: ["POST"],
        limit: 3,
      },
      json: {
        challengeId: challengeMetadataId,
        actionType: "Generic",
        code: twoFaCode,
      },
      throwHttpErrors: false,
      responseType: "json",
    },
  );

  if (twoFaVerificationResponse.statusCode !== 200) {
    log.error(
      { statusCode: twoFaVerificationResponse.statusCode },
      "Two-step verification failed",
    );
    throw new RobloxError(
      RobloxErrorType.TWO_FA_FAILED,
      `Two-step verification failed: ${JSON.stringify(twoFaVerificationResponse.body)}`,
      twoFaVerificationResponse.statusCode,
    );
  }

  const verificationToken =
    twoFaVerificationResponse.body?.verificationToken;

  if (!verificationToken) {
    throw new RobloxError(
      RobloxErrorType.TWO_FA_FAILED,
      "Missing verification token in 2FA response",
    );
  }

  // Step 5: Send Challenge Continue Request
  log.trace("Payout step 5: sending challenge continue request");
  const continueMetadata = {
    verificationToken: verificationToken,
    rememberDevice: true,
    challengeId: challengeMetadataId,
    actionType: "Generic",
  };

  const continueResponse = await got.post(
    "https://apis.roblox.com/challenge/v1/continue",
    {
      headers: {
        Accept: "*/*",
        Cookie: `.ROBLOSECURITY=${cookie}`,
        "X-CSRF-TOKEN": xCsrfToken,
      },
      retry: {
        methods: ["POST"],
        limit: 3,
      },
      json: {
        challengeId: challengeHeaderId,
        challengeType: "twostepverification",
        challengeMetadata: JSON.stringify(continueMetadata),
      },
      throwHttpErrors: false,
    },
  );

  if (continueResponse.statusCode !== 200) {
    log.error({ statusCode: continueResponse.statusCode, body: continueResponse.body }, "Challenge continuation failed");
    const continueError = classifyHttpError(
      continueResponse.statusCode,
      continueResponse.headers,
      continueResponse.body,
      "Challenge continuation",
    );
    throw continueError ?? new RobloxError(
      RobloxErrorType.TWO_FA_FAILED,
      "Challenge continuation failed.",
      continueResponse.statusCode,
    );
  }

  // Step 6: Retry Payout Request with 2FA Verification
  log.trace("Payout step 6: retrying payout with 2FA verification");
  const encodedMetadata = Buffer.from(
    JSON.stringify(continueMetadata),
  ).toString("base64");

  const finalResponse = await got.post(
    `https://groups.roblox.com/v1/groups/${groupId}/payouts`,
    {
      headers: {
        Cookie: `.ROBLOSECURITY=${cookie}`,
        "X-CSRF-TOKEN": xCsrfToken,
        "rblx-challenge-id": challengeHeaderId,
        "rblx-challenge-metadata": encodedMetadata,
        "rblx-challenge-type": "twostepverification",
      },
      retry: {
        methods: ["POST"],
        limit: 5,
      },
      timeout: {
        request: 5000,
      },
      json: {
        PayoutType: 1,
        Recipients: [
          {
            recipientId: userId,
            recipientType: 0,
            amount: amount,
          },
        ],
      },
      throwHttpErrors: false,
    },
  );

  if (finalResponse.statusCode === 200) {
    return finalResponse;
  }

  log.error({ statusCode: finalResponse.statusCode, body: finalResponse.body }, "Final payout request failed");
  const finalError = classifyHttpError(
    finalResponse.statusCode,
    finalResponse.headers,
    finalResponse.body,
    "Final payout request",
  );
  if (finalError?.type === RobloxErrorType.AUTH_EXPIRED) {
    robloxSession.markUnhealthy();
  }
  throw finalError ?? new RobloxError(
    RobloxErrorType.ROBLOX_API_ERROR,
    "Error with final payout request.",
    finalResponse.statusCode,
  );
}

server.addHook(
  "preHandler",
  async (req: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for public endpoints
    if (req.url === "/health" || req.url.startsWith("/docs")) return;

    const { headers } = req;

    // Take user from the header, in a real world scenario this would be a JWT token
    const authHeader = headers["x-api-key"] || "";
    const submittedKey = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    // Check if the user is allowed to perform the action on the resource
    const allowed = config.credentials.api === `${submittedKey}`;

    // If the user is not allowed, return a 403
    if (!allowed) {
      req.log.warn({ ip: req.ip }, "Rejected request: invalid API key");
      return reply.code(403).send({ error: "Forbidden: invalid or missing API key" });
    }
  },
);

interface FinsysPermissions {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
}

async function allowedToAccessApplication(
  userId: number,
): Promise<FinsysPermissions> {
  let canCreate = false;
  let canEdit = false;
  let canView = false;

  const groups = await noblox.getGroups(userId);

  function getRankInGroup(groupId: number) {
    const group = groups.find((g) => g.Id === groupId);
    return group ? group.Rank : 0;
  }

  for (const group of config.settings.permissionGroups.approvers) {
    const rank = getRankInGroup(group.id);
    if (rank >= group.minRank) {
      canView = true;
      canEdit = true;
      break;
    }
  }

  const payoutGroupRank = getRankInGroup(groupId);

  if (payoutGroupRank > 0) {
    for (const group of config.settings.permissionGroups.requesters) {
      const rank = getRankInGroup(group.id);
      if (rank >= group.minRank) {
        canView = true;
        canCreate = true;
        break;
      }
    }
  }

  return {
    canView,
    canCreate,
    canEdit,
  };
}

const ErrorResponse = Type.Object({
  error: Type.String({ description: "Human-readable error message" }),
});

const RobloxErrorResponse = Type.Object({
  error: Type.String({ description: "Human-readable error message" }),
  errorType: Type.String({ description: "Classified error type" }),
  retryable: Type.Boolean({ description: "Whether the operation can be retried" }),
});

server.post(
  "/create-payout",
  {
    schema: {
      summary: "Create a payout request",
      description:
        "Submit a new payout request for a Roblox user. The user must not be blacklisted, must not have an existing pending request, and the amount must not exceed the configured maximum.",
      tags: ["Payouts"],
      body: Type.Object({
        userId: Type.Number({ description: "Roblox user ID of the recipient" }),
        amount: Type.Number({
          description: "Payout amount in Robux (must be greater than 0)",
        }),
        reason: Type.String({ description: "Reason for the payout request" }),
      }),
      response: {
        200: Type.Object({
          success: Type.Boolean(),
          message: Type.String(),
          id: Type.Integer({ description: "ID of the created payout request" }),
        }),
        400: ErrorResponse,
        500: ErrorResponse,
      },
    },
  },

  async (req, res) => {
    try {
      const { userId, amount, reason } = req.body;

      if (amount <= 0) {
        res.status(400);
        return { error: "Payout amount must be greater than 0." };
      }

      if (isBlacklisted(userId)) {
        res.status(400);
        return {
          error: `User ${userId} is blacklisted and cannot receive payouts.`,
        };
      }

      const existingRequest = await getPayoutRequestByUser(userId);

      if (existingRequest) {
        res.status(400);
        return {
          error: `User ${userId} already has a pending payout request. Please wait for it to be processed.`,
        };
      }

      if (amount > maxRobux) {
        res.status(400);
        return {
          error: `Payout amount (${amount}) exceeds the maximum allowed amount of ${maxRobux} Robux.`,
        };
      }

      const response = await createPayoutRequest(userId, amount, reason);
      return {
        success: true,
        message: "Payout request created successfully.",
        id: Number(response.id),
      };
    } catch (error) {
      res.status(500);
      return {
        error:
          error instanceof Error ? error.message : "An unexpected error occurred while creating the payout request.",
      };
    }
  },
);

server.post(
  "/update-payout-status",
  {
    schema: {
      summary: "Update a payout request status",
      description:
        "Approve, reject, or reset a payout request. When approving, the Robux payout is executed automatically via the Roblox API before the status is updated.",
      tags: ["Payouts"],
      body: Type.Object({
        approverId: Type.Optional(
          Type.Number({ description: "Roblox user ID of the approver" }),
        ),
        requestId: Type.Number({ description: "ID of the payout request" }),
        status: Type.Union(
          [
            Type.Literal("pending"),
            Type.Literal("approved"),
            Type.Literal("rejected"),
          ],
          { description: "New status for the payout request" },
        ),
        rejectionReason: Type.Optional(
          Type.String({
            description: "Required when rejecting a request",
          }),
        ),
      }),
      response: {
        200: Type.Object({
          success: Type.Boolean(),
          message: Type.String(),
        }),
        400: ErrorResponse,
        404: ErrorResponse,
        500: ErrorResponse,
        503: RobloxErrorResponse,
      },
    },
  },
  async (req, res) => {
    try {
      const { requestId, status, rejectionReason, approverId } = req.body;

      let requestDetails;
      try {
        requestDetails = await fetchPayoutRequestDetails(requestId);
      } catch {
        res.status(404);
        return {
          error: `Payout request ${requestId} not found or has already been approved.`,
        };
      }

      if (isBlacklisted(requestDetails.user_id)) {
        res.status(400);
        return {
          error: `Payout recipient (user ${requestDetails.user_id}) is blacklisted and cannot receive payouts.`,
        };
      }

      if (status === "approved") {
        const { user_id, amount } = requestDetails;
        await payoutRobux(Number(user_id), Number(amount), req.log);
        req.log.info({ userId: Number(user_id), amount: Number(amount), requestId }, "Payout completed successfully");
      }

      await updatePayoutRequestStatus(
        requestId,
        status,
        rejectionReason,
        Number(requestDetails.user_id),
        approverId,
      );

      return {
        success: true,
        message: `Payout request ${requestId} status updated to '${status}'.`,
      };
    } catch (error) {
      req.log.error({ err: error instanceof Error ? error : undefined, requestId: req.body.requestId }, "Failed to update payout status");
      if (error instanceof RobloxError) {
        const statusCode = error.type === RobloxErrorType.AUTH_EXPIRED ? 503 : 500;
        res.status(statusCode);
        return {
          error: error.message,
          errorType: error.type,
          retryable: error.retryable,
        };
      }
      res.status(500);
      return {
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred while updating the payout request.",
      };
    }
  },
);

server.post(
  "/disburse",
  {
    schema: {
      summary: "Create, approve, and disburse a payout in one step",
      description:
        "Automatically creates a payout request, approves it, and disburses the Robux to the recipient in a single operation. The user must not be blacklisted, must not have an existing pending request, and the amount must not exceed the configured maximum.",
      tags: ["Payouts"],
      body: Type.Object({
        approverId: Type.Optional(
          Type.Number({ description: "Roblox user ID of the approver" }),
        ),
        userId: Type.Number({ description: "Roblox user ID of the recipient" }),
        amount: Type.Number({
          description: "Payout amount in Robux (must be greater than 0)",
        }),
        reason: Type.String({ description: "Reason for the payout" }),
      }),
      response: {
        200: Type.Object({
          success: Type.Boolean(),
          message: Type.String(),
          id: Type.Integer({ description: "ID of the created payout request" }),
        }),
        400: ErrorResponse,
        500: ErrorResponse,
        503: RobloxErrorResponse,
      },
    },
  },
  async (req, res) => {
    try {
      const { userId, amount, reason, approverId } = req.body;

      if (amount <= 0) {
        res.status(400);
        return { error: "Payout amount must be greater than 0." };
      }

      if (isBlacklisted(userId)) {
        res.status(400);
        return {
          error: `User ${userId} is blacklisted and cannot receive payouts.`,
        };
      }

      const existingRequest = await getPayoutRequestByUser(userId);

      if (existingRequest) {
        res.status(400);
        return {
          error: `User ${userId} already has a pending payout request. Please wait for it to be processed.`,
        };
      }

      if (amount > maxRobux) {
        res.status(400);
        return {
          error: `Payout amount (${amount}) exceeds the maximum allowed amount of ${maxRobux} Robux.`,
        };
      }

      // Create the payout request
      const record = await createPayoutRequest(userId, amount, reason);
      const requestId = Number(record.id);

      // Disburse via Roblox
      try {
        await payoutRobux(userId, amount, req.log);
      } catch (error) {
        // Payout failed — reject the request so it doesn't stay pending
        await updatePayoutRequestStatus(
          requestId,
          "rejected",
          error instanceof Error ? error.message : "Payout disbursement failed",
          userId,
          approverId,
        );
        throw error;
      }

      // Mark as approved after successful disbursement
      await updatePayoutRequestStatus(
        requestId,
        "approved",
        undefined,
        userId,
        approverId,
      );

      req.log.info({ userId, amount, requestId }, "Payout disbursed successfully");

      return {
        success: true,
        message: `Payout of ${amount} Robux to user ${userId} disbursed and approved.`,
        id: requestId,
      };
    } catch (error) {
      req.log.error({ err: error instanceof Error ? error : undefined, userId: req.body.userId }, "Failed to disburse payout");
      if (error instanceof RobloxError) {
        const statusCode = error.type === RobloxErrorType.AUTH_EXPIRED ? 503 : 500;
        res.status(statusCode);
        return {
          error: error.message,
          errorType: error.type,
          retryable: error.retryable,
        };
      }
      res.status(500);
      return {
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred while disbursing the payout.",
      };
    }
  },
);

server.get(
  "/pending-requests",
  {
    schema: {
      summary: "List payout requests",
      description:
        "Retrieve payout requests, ordered with pending requests first. When a userId is provided, only that user's requests are returned (requires view permission). Without a userId, all requests are returned.",
      tags: ["Payouts"],
      querystring: Type.Object({
        userId: Type.Optional(
          Type.Number({
            description:
              "Filter by Roblox user ID. When provided, permission checks are enforced.",
          }),
        ),
        offset: Type.Optional(
          Type.Number({ description: "Number of records to skip (pagination)" }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Maximum number of records to return" }),
        ),
      }),
      response: {
        200: Type.Object({
          requests: Type.Array(
            Type.Object({
              id: Type.Integer(),
              user_id: Type.Integer(),
              amount: Type.Integer(),
              reason: Type.String(),
              status: Type.String(),
              created_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              updated_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              group_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
              category: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              approver_id: Type.Optional(
                Type.Union([Type.Integer(), Type.Null()]),
              ),
              rejection_reason: Type.Optional(
                Type.Union([Type.String(), Type.Null()]),
              ),
            }),
          ),
        }),
        403: ErrorResponse,
        500: ErrorResponse,
      },
    },
  },
  async (req, res) => {
    try {
      const userId = req.query.userId;
      let requests: payout_requests[];
      if (userId) {
        const allowed = await allowedToAccessApplication(userId);
        if (!allowed.canView) {
          res.status(403);
          return {
            error:
              "You must be a member of an approved group to access payout requests.",
          };
        }
        requests = await getPayoutRequestsByUser(
          userId,
          req.query.offset,
          req.query.limit,
        );
      } else {
        requests = await getAllRequests(req.query.offset, req.query.limit);
      }

      return { requests: JSON.parse(JSON.stringify(requests)) };
    } catch (error) {
      res.status(500);
      return {
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred while fetching payout requests.",
      };
    }
  },
);

server.get(
  "/permissions",
  {
    schema: {
      summary: "Check user permissions",
      description:
        "Check what financial system actions a user is allowed to perform based on their Roblox group memberships.",
      tags: ["Permissions"],
      querystring: Type.Object({
        userId: Type.Number({ description: "Roblox user ID to check permissions for" }),
      }),
      response: {
        200: Type.Object({
          canView: Type.Boolean({ description: "Whether the user can view payout requests" }),
          canCreate: Type.Boolean({ description: "Whether the user can create payout requests" }),
          canEdit: Type.Boolean({ description: "Whether the user can approve or reject payout requests" }),
        }),
        500: ErrorResponse,
      },
    },
  },
  async (req, res) => {
    try {
      const userId = req.query.userId;
      const permissions = await allowedToAccessApplication(userId);
      return permissions;
    } catch (error) {
      res.status(500);
      return {
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred while checking permissions.",
      };
    }
  },
);

server.get(
  "/health",
  {
    schema: {
      summary: "Service health check",
      description:
        "Returns the health status of the service including Roblox session validity. This endpoint does not require authentication.",
      tags: ["System"],
      response: {
        200: Type.Object({
          authenticated: Type.Boolean({
            description: "Whether the Roblox session is currently valid",
          }),
          userId: Type.Union([Type.Number(), Type.Null()]),
          userName: Type.Union([Type.String(), Type.Null()]),
          lastHealthCheck: Type.Union([Type.String(), Type.Null()]),
          healthy: Type.Boolean({
            description: "Overall health status of the service",
          }),
          uptime: Type.Number({ description: "Server uptime in seconds" }),
        }),
      },
    },
  },
  async () => {
    return robloxSession.getHealthStatus();
  },
);

server.post(
  "/admin/refresh-cookie",
  {
    schema: {
      summary: "Replace the Roblox session cookie",
      description:
        "Hot-swap the Roblox cookie without restarting the server. Validates the new cookie and verifies group membership before accepting it. Does not update the .env file.",
      tags: ["System"],
      body: Type.Object({
        cookie: Type.String({ description: "New ROBLOSECURITY cookie value" }),
      }),
      response: {
        200: Type.Object({
          success: Type.Boolean(),
          message: Type.String(),
          userId: Type.Number(),
          userName: Type.String(),
        }),
        400: ErrorResponse,
        500: ErrorResponse,
      },
    },
  },
  async (req, res) => {
    try {
      await robloxSession.reinitialize(req.body.cookie, groupId);
      return {
        success: true,
        message: "Cookie replaced and validated successfully.",
        userId: robloxSession.getUserId(),
        userName: robloxSession.getHealthStatus().userName!,
      };
    } catch (error) {
      res.status(error instanceof RobloxError ? 400 : 500);
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reinitialize session with the provided cookie.",
      };
    }
  },
);

async function bootstrap() {
  robloxSession = new RobloxSession(
    config.credentials.roblox,
    config.credentials.roblox_totp,
    server.log,
  );
  await robloxSession.init(groupId);
  robloxSession.startHealthCheck();

  const address = await server.listen({ port: port });
  await server.ready();
  server.log.info({ address, port }, "Server listening");
  server.log.info({ blacklistedIds: config.blacklistedIds, groupId, maxRobux }, "Configuration loaded");
}

await bootstrap();
