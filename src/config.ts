import { config as config_env } from "dotenv-safe";
config_env();

interface FinsysJsonConfigurationGroup {
  id: number;
  minRank: number;
}

interface FinsysJsonConfiguration {
  requesterGroups: FinsysJsonConfigurationGroup[];
  approverGroups: FinsysJsonConfigurationGroup[];
  cors: string[];
  blacklistedIds?: number[];
}

// import jsonConfigFile from "../config.json" with { type: "json" };;
const { default: jsonConfigFile } = await import("../config.json", {
  assert: { type: "json" },
});

const jsonConfig: FinsysJsonConfiguration = jsonConfigFile;

console.log(`Blacklisted user IDs: ${jsonConfig.blacklistedIds?.join(", ")}`);

export default {
  testMode: false,
  seriesIdentifier: process.env.IDENTIFIER,
  port:
    typeof process.env.API_PORT !== "undefined"
      ? parseInt(process.env.API_PORT)
      : 3000,
  notifierUrl: process.env.NOTIFIER_URL as string,
  settings: {
    permissionGroups: {
      requesters: jsonConfig.requesterGroups,
      approvers: jsonConfig.approverGroups,
    },
    cors: jsonConfig.cors,
    maxRobux:
      typeof process.env.MAX_TRANSACTION_LIMIT !== "undefined"
        ? parseInt(process.env.MAX_TRANSACTION_LIMIT)
        : 100,
    groupId:
      typeof process.env.ROBLOX_GROUP_ID !== "undefined"
        ? parseInt(process.env.ROBLOX_GROUP_ID)
        : 123456,
  },
  blacklistedIds: jsonConfig.blacklistedIds || [],
  credentials: {
    api: process.env.AUTHENTICATION_KEY as string,
    roblox: process.env.ROBLOSECURITY as string,
    roblox_totp: process.env.ROBLOX_TOTP_SECRET as string,
  },
};
