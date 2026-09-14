/**
 * Runtime configuration.
 *
 * Every secret is read from the environment and never written to the database or the logs.
 * Missing values are reported as a list at boot rather than one at a time, because a
 * half-configured Meta app is the normal state for the first hour of a project and finding
 * out one variable per restart is a waste of that hour.
 */
export type Config = {
  port: number;
  databasePath: string;
  publicUrl: string;

  meta: {
    appSecret: string;
    verifyToken: string;
    graphVersion: string;
    graphBaseUrl: string;
  };

  instagram: {
    accountId: string;
    accessToken: string;
    /** Instagram allows 50 published posts per rolling 24 hours per account. */
    dailyPublishLimit: number;
  };

  whatsapp: {
    phoneNumberId: string;
    accessToken: string;
    /** Fallback template used when the 24 hour service window has closed. */
    reengagementTemplate: string;
    templateLanguage: string;
  };

  /** Shared secret n8n sends as `x-cascade-key` on every call to this service. */
  apiKey: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];

  const required = (name: string): string => {
    const value = env[name];
    if (!value) {
      missing.push(name);
      return "";
    }
    return value;
  };

  const config: Config = {
    port: Number(env.PORT ?? 8080),
    databasePath: env.DATABASE_PATH ?? "./cascade.db",
    publicUrl: env.PUBLIC_URL ?? "http://localhost:8080",

    meta: {
      appSecret: required("META_APP_SECRET"),
      verifyToken: required("META_VERIFY_TOKEN"),
      graphVersion: env.GRAPH_VERSION ?? "v21.0",
      graphBaseUrl: env.GRAPH_BASE_URL ?? "https://graph.facebook.com",
    },

    instagram: {
      accountId: required("IG_ACCOUNT_ID"),
      accessToken: required("IG_ACCESS_TOKEN"),
      dailyPublishLimit: Number(env.IG_DAILY_PUBLISH_LIMIT ?? 50),
    },

    whatsapp: {
      phoneNumberId: required("WA_PHONE_NUMBER_ID"),
      accessToken: required("WA_ACCESS_TOKEN"),
      reengagementTemplate: env.WA_REENGAGEMENT_TEMPLATE ?? "lead_follow_up",
      templateLanguage: env.WA_TEMPLATE_LANGUAGE ?? "en",
    },

    apiKey: required("CASCADE_API_KEY"),
  };

  if (missing.length > 0 && env.NODE_ENV !== "test") {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. See .env.example and docs/SETUP.md.`
    );
  }

  return config;
}
