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
}

import jsonConfigFile from "../config.json";

const jsonConfig: FinsysJsonConfiguration = jsonConfigFile;

export default {
  testMode: false,
  seriesIdentifier: process.env.IDENTIFIER,
  port:
    typeof process.env.API_PORT !== "undefined"
      ? parseInt(process.env.API_PORT)
      : 3000,
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
  credentials: {
    api: process.env.AUTHENTICATION_KEY as string,
    roblox: process.env.ROBLOSECURITY as string,
    roblox_totp: process.env.ROBLOX_TOTP_SECRET as string,
  },
};
