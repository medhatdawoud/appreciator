import type { AppConfig } from '../env.js';

/**
 * The slice of GitHub's OAuth web flow this server uses: send the browser to
 * GitHub, trade the code it comes back with for a token, read who the user
 * is, then drop the token. It is never stored, and `read:user` is the only
 * scope asked for.
 */

type GitHubConfig = Pick<
  AppConfig,
  'githubClientId' | 'githubClientSecret' | 'githubOAuthUrl' | 'githubApiUrl' | 'publicBaseUrl'
>;

export type FetchFn = typeof fetch;

/** How long to wait on GitHub before giving up on a sign-in. */
const GITHUB_TIMEOUT_MS = 10_000;

const MAX_LOGIN_LENGTH = 255;
const MAX_AVATAR_URL_LENGTH = 1024;

/**
 * GitHub answered, but not with what we needed. The message is for the
 * server log: it names the step and GitHub's error code, never a token.
 */
export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string | null;
}

function clientCredentials(config: GitHubConfig): { clientId: string; clientSecret: string } {
  if (config.githubClientId === undefined || config.githubClientSecret === undefined) {
    throw new Error('GitHub sign-in is not configured');
  }
  return { clientId: config.githubClientId, clientSecret: config.githubClientSecret };
}

/** Where GitHub sends the browser back to. Must match the OAuth app's callback URL. */
export function callbackUrl(config: Pick<AppConfig, 'publicBaseUrl'>): string {
  return `${config.publicBaseUrl}/auth/github/callback`;
}

export function buildAuthorizeUrl(config: GitHubConfig, state: string): string {
  const url = new URL(`${config.githubOAuthUrl}/login/oauth/authorize`);
  url.searchParams.set('client_id', clientCredentials(config).clientId);
  url.searchParams.set('redirect_uri', callbackUrl(config));
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', state);
  return url.toString();
}

async function readJson(response: Response, step: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GitHubError(`${step}: response was not JSON`);
  }
  if (typeof body !== 'object' || body === null) {
    throw new GitHubError(`${step}: response was not an object`);
  }
  return body as Record<string, unknown>;
}

/**
 * Trades an authorization code for an access token.
 *
 * GitHub reports a bad or expired code as a 200 with an `error` field, so
 * the body is checked as well as the status.
 */
export async function exchangeCode(
  config: GitHubConfig,
  code: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const { clientId, clientSecret } = clientCredentials(config);
  const response = await fetchFn(`${config.githubOAuthUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl(config),
    }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new GitHubError(`token exchange: status ${response.status}`);
  }

  const body = await readJson(response, 'token exchange');
  if (typeof body.error === 'string') {
    throw new GitHubError(`token exchange: ${body.error}`);
  }
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new GitHubError('token exchange: no access token in response');
  }
  return body.access_token;
}

/** Reads the signed-in GitHub user, checking the shape before anything is stored. */
export async function fetchUser(
  config: GitHubConfig,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<GitHubUser> {
  const response = await fetchFn(`${config.githubApiUrl}/user`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      // GitHub's API refuses requests without a User-Agent.
      'user-agent': 'appreciator',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new GitHubError(`user lookup: status ${response.status}`);
  }

  const body = await readJson(response, 'user lookup');
  const { id, login, avatar_url: avatarUrl } = body;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new GitHubError('user lookup: missing or invalid id');
  }
  if (typeof login !== 'string' || login.length === 0 || login.length > MAX_LOGIN_LENGTH) {
    throw new GitHubError('user lookup: missing or invalid login');
  }
  return {
    id,
    login,
    // Only ever shown as an <img src>, so anything that is not a plausible
    // https URL is dropped rather than stored.
    avatar_url:
      typeof avatarUrl === 'string' &&
      avatarUrl.startsWith('https://') &&
      avatarUrl.length <= MAX_AVATAR_URL_LENGTH
        ? avatarUrl
        : null,
  };
}

/** GitHub logins are case-insensitive, so the comparison is too. */
export function isLoginAllowed(login: string, allowlist: readonly string[]): boolean {
  const candidate = login.toLowerCase();
  return allowlist.some((allowed) => allowed.toLowerCase() === candidate);
}
