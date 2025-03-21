// Modules
import { config as config_env } from "dotenv-safe";
config_env();

import fastify, { FastifyReply, FastifyRequest } from "fastify";
import fastifyCors from "@fastify/cors";
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
} from "./postgres.js";
import { authenticator } from "otplib";
import got from "got";
import { payout_requests } from "@prisma/client";

// Variables

const server = fastify({
  trustProxy: true,
}).withTypeProvider<TypeBoxTypeProvider>();

const port: number = config.port;

const origins = ["localhost", "127.0.0.1"].concat(config.settings.cors);

await server.register(fastifyCors, {
  origin: origins,
});

const userCookie = config.credentials.roblox;
const totpSecret = config.credentials.roblox_totp;
const maxRobux = config.settings.maxRobux;

let accountUserId: number | undefined;
const groupId = config.settings.groupId;

// let fph: any;

function extractRobloxErrorReason(body: string) {
  let response: string | undefined = undefined;
  try {
    const content = JSON.parse(body);
    if (content) {
      const errors = content.errors;
      if (errors && Array.isArray(errors)) {
        for (const { code, message, userFacingMessage } of errors) {
          if (message) {
            response = message;
            break;
          }
        }
      }
    }
  } catch (error) {
    console.error(error);
  }
  return response;
}

function isBlacklisted(userId: number | BigInt) {
  return config.blacklistedIds.includes(Number(userId));
}

async function payoutRobux(userId: number, amount: number) {
  // Step 1: Fetch X-CSRF Token

  const csrfResponse = await got.post("https://auth.roblox.com/v2/logout", {
    headers: { Cookie: `.ROBLOSECURITY=${userCookie}` },
    retry: {
      methods: ["POST"],
      limit: 3,
    },
    throwHttpErrors: false,
  });

  const xCsrfToken = csrfResponse.headers["x-csrf-token"];

  if (!xCsrfToken) {
    throw new Error("Unable to get CSRF token!");
  }

  // Step 2: Initial Payout Request
  const payoutResponse = await got.post(
    `https://groups.roblox.com/v1/groups/${groupId}/payouts`,
    {
      headers: {
        Cookie: `.ROBLOSECURITY=${userCookie}`,
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
    }
  );

  if (payoutResponse.statusCode === 403) {
    // Step 3: Generate 2FA Code using TOTP
    const challengeMetadataEncodedHeader =
      payoutResponse.headers["rblx-challenge-metadata"];

    const challengeMetadataEncoded = challengeMetadataEncodedHeader
      ? Array.isArray(challengeMetadataEncodedHeader)
        ? challengeMetadataEncodedHeader[0]
        : challengeMetadataEncodedHeader
      : "";

    const challengeMetadata = JSON.parse(
      Buffer.from(challengeMetadataEncoded, "base64").toString("utf-8")
    );

    const challengeMetadataId: string = challengeMetadata["challengeId"];

    const twoFaCode = authenticator.generate(totpSecret);

    // Step 4: Submit 2FA Verification
    const challengeHeaderId = payoutResponse.headers["rblx-challenge-id"];

    const twoFaVerificationResponse = await got.post<any>(
      `https://twostepverification.roblox.com/v1/users/${accountUserId}/challenges/authenticator/verify`,
      {
        headers: {
          Cookie: `.ROBLOSECURITY=${userCookie}`,
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
      }
    );

    if (twoFaVerificationResponse.statusCode === 200) {
      const verificationToken =
        twoFaVerificationResponse.body?.verificationToken;

      if (!verificationToken) {
        throw new Error("Missing verification token");
      }

      // New Step: Send Challenge Continue Request
      const challengeMetadata = {
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
            Cookie: `.ROBLOSECURITY=${userCookie}`,
            "X-CSRF-TOKEN": xCsrfToken,
          },
          retry: {
            methods: ["POST"],
            limit: 3,
          },
          json: {
            challengeId: challengeHeaderId,
            challengeType: "twostepverification",
            challengeMetadata: JSON.stringify(challengeMetadata),
          },
          throwHttpErrors: false,
        }
      );

      if (continueResponse.statusCode !== 200) {
        console.error("Challenge continuation failed.");
        console.error(continueResponse);
        const errorType = extractRobloxErrorReason(continueResponse.body);
        if (errorType) {
          throw new Error(`Challenge continuation failed: ${errorType}`);
        }
        throw new Error("Challenge continuation failed.");
      }

      // Step 5: Retry Payout Request with 2FA Verification

      const encodedMetadata = Buffer.from(
        JSON.stringify({
          verificationToken: verificationToken,
          rememberDevice: true,
          challengeId: challengeMetadataId,
          actionType: "Generic",
        })
      ).toString("base64");

      const finalPayoutHeaders = {
        Cookie: `.ROBLOSECURITY=${userCookie}`,
        "X-CSRF-TOKEN": xCsrfToken,
        "rblx-challenge-id": challengeHeaderId,
        "rblx-challenge-metadata": encodedMetadata,
        "rblx-challenge-type": "twostepverification",
      };

      // fph = finalPayoutHeaders;

      const finalResponse = await got.post(
        `https://groups.roblox.com/v1/groups/${groupId}/payouts`,
        {
          headers: finalPayoutHeaders,
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
        }
      );
      if (finalResponse.statusCode === 200) {
        // Payout successful with 2FA
        return finalResponse;
      } else {
        // Handle other errors
        console.error("Error with final payout request.");
        console.error(finalResponse.body);
        const errorType = extractRobloxErrorReason(finalResponse.body);
        if (errorType) {
          throw new Error(`Error with final payout request: ${errorType}`);
        }
        throw new Error("Error with final payout request.");
      }
    } else {
      // Handle 2FA verification failure
      console.error("Two-step verification failed.");
      console.error(twoFaVerificationResponse.body);
      throw new Error(JSON.stringify(twoFaVerificationResponse.body));
    }
  } else if (payoutResponse.statusCode === 200) {
    // Payout successful without 2FA
    return payoutResponse;
  } else {
    // Handle other errors
    console.error("Error with initial payout request.");
    console.error(payoutResponse.body);
    const errorType = extractRobloxErrorReason(payoutResponse.body);
    if (errorType) {
      throw new Error(`Error with initial payout request: ${errorType}`);
    }
    throw new Error("Error with initial payout request.");
  }
}

server.addHook("onSend", async (request, reply, payload: any) => {
  try {
    // Parse the JSON string back into an object
    const jsonPayload = JSON.parse(payload);
    // Re-stringify it with the BigInt conversion
    return JSON.stringify(jsonPayload, (key, value) =>
      typeof value === "bigint" ? Number(value) : value
    );
  } catch (error) {
    // If parsing fails, return the payload as-is
    return payload;
  }
});

server.addHook(
  "preHandler",
  async (req: FastifyRequest, reply: FastifyReply) => {
    const { headers } = req;

    // Take user from the header, in a real world scenario this would be a JWT token
    const authHeader = headers["x-api-key"] || "";
    const submittedKey = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    // Check if the user is allowed to perform the action on the resource
    const allowed = config.credentials.api === `${submittedKey}`;

    // If the user is not allowed, return a 403
    if (!allowed) {
      reply.code(403).send({ error: "Forbidden" });
    }
  }
);

interface FinsysPermissions {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
}

async function allowedToAccessApplication(
  userId: number
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

server.post(
  "/create-payout",
  {
    schema: {
      body: Type.Object({
        userId: Type.Number(),
        amount: Type.Number(),
        reason: Type.String(),
      }),
    },
  },

  async (req, res) => {
    try {
      const { userId, amount, reason } = req.body;

      if (isBlacklisted(userId)) {
        res.status(400);
        return { error: "User is blacklisted." };
      }

      const existingRequest = await getPayoutRequestByUser(userId);

      if (existingRequest) {
        res.status(400);
        return { error: "Existing pending request found for this user." };
      }

      if (amount > maxRobux) {
        res.status(400);
        return {
          error: `Unable to submit a amount higher than ${maxRobux} Robux.`,
        };
      }

      const response = await createPayoutRequest(userId, amount, reason);
      return {
        success: true,
        message: "Payout request created successfully.",
        id: response.id,
      };
    } catch (error) {
      res.status(500);
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }
);

server.post(
  "/update-payout-status",
  {
    schema: {
      body: Type.Object({
        approverId: Type.Optional(Type.Number()),
        requestId: Type.Number(),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("approved"),
          Type.Literal("rejected"),
        ]),
        rejectionReason: Type.Optional(Type.String()),
      }),
    },
  },
  async (req, res) => {
    try {
      const { requestId, status, rejectionReason, approverId } = req.body;

      // Fetch request details
      const requestDetails = await fetchPayoutRequestDetails(requestId);

      if (isBlacklisted(requestDetails.user_id)) {
        res.status(400);
        return { error: "Payout recipient is blacklisted." };
      }

      if (status === "approved") {
        const { user_id, amount } = requestDetails;

        // Perform the payout
        await payoutRobux(Number(user_id), Number(amount));

        console.log(`Payout of ${amount} Robux to user ${user_id} completed.`);
      }

      // Update the request status in the database
      await updatePayoutRequestStatus(
        requestId,
        status,
        rejectionReason,
        Number(requestDetails.user_id),
        approverId
      );

      return {
        success: true,
        message: `Payout request status updated to ${status}.`,
      };
    } catch (error) {
      console.error(error);
      res.status(500);
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }
);

server.get(
  "/pending-requests",
  {
    schema: {
      querystring: Type.Object({
        userId: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
    },
  },
  async (req, res) => {
    try {
      const userId = req.query.userId;
      let requests: payout_requests[];
      if (userId) {
        const allowed = await allowedToAccessApplication(userId);
        if (!allowed.canView) {
          throw new Error(
            "FINSYS_NOT_ALLOWED: You must be a member of approved groups to access this feature."
          );
        }
        requests = await getPayoutRequestsByUser(
          userId,
          req.query.offset,
          req.query.limit
        );
      } else {
        requests = await getAllRequests(req.query.offset, req.query.limit);
      }

      return { requests: JSON.parse(JSON.stringify(requests)) };
    } catch (error) {
      res.status(500);
      return {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }
);

server.get(
  "/permissions",
  {
    schema: {
      querystring: Type.Object({
        userId: Type.Number(),
      }),
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
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }
);

async function bootstrap() {
  const currentUser = await noblox.setCookie(config.credentials.roblox);
  accountUserId = currentUser.id;
  console.log(`Logged in as ${currentUser.name} [${currentUser.id}]`);
  const address = await server.listen({ port: port });
  await server.ready();
  console.log(`Server listening at ${address}`);
}

await bootstrap();
