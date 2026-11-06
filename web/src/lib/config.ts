/** Public runtime config, inlined at build time from web/.env.local (see infra/scripts/write-web-env.ts). */
export const config = {
  region: process.env.NEXT_PUBLIC_AWS_REGION ?? '',
  userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID ?? '',
  userPoolClientId: process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID ?? '',
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, ''),
};

export const isConfigured = Boolean(config.userPoolId && config.userPoolClientId && config.apiUrl);
