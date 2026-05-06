import crypto from "crypto";
import { logger, createRequestLogger } from "../middlewares/logger";
import "dotenv/config";

import type { Request } from "express";

const HIBP_URL = process.env.HIBP_URL;
const USER_AGENT = process.env.USER_AGENT;

export const isPasswordPwned = async (
  password: string,
  req?: Request,
): Promise<boolean> => {
  const log = req ? createRequestLogger(req) : logger;

  try {
    const hash = crypto
      .createHash("sha1")
      .update(password)
      .digest("hex")
      .toUpperCase();

    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    const response = await fetch(`${HIBP_URL}/${prefix}`, {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      log.error("HIBP API check failed", {
        status: response.status,
      });
      return false;
    }

    const text = await response.text();

    const pwned = text.split("\r\n").some((line) => {
      const [hashSuffix] = line.split(":");
      return hashSuffix === suffix;
    });

    return pwned;
  } catch (error) {
    log.error("HIBP check error", {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return false;
  }
};
