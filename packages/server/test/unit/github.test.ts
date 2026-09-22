import { describe, expect, it } from 'vitest';

import {
  type FetchFn,
  GitHubError,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUser,
  isLoginAllowed,
} from '../../src/lib/github.js';

const config = {
  githubClientId: 'Iv1.client',
  githubClientSecret: 'client-secret',
  githubOAuthUrl: 'https://github.test',
  githubApiUrl: 'https://api.github.test',
  publicBaseUrl: 'https://appreciator.test',
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that records its calls and answers with a fixed status and body. */
function fakeFetch(status: number, body: unknown): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as FetchFn;
  return { fetchFn, calls };
}

describe('buildAuthorizeUrl', () => {
  it("points at GitHub's authorize endpoint with the client, callback, scope and state", () => {
    const url = new URL(buildAuthorizeUrl(config, 'the-state'));

    expect(`${url.origin}${url.pathname}`).toBe('https://github.test/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'Iv1.client',
      redirect_uri: 'https://appreciator.test/auth/github/callback',
      scope: 'read:user',
      state: 'the-state',
    });
  });
});

describe('exchangeCode', () => {
  it('posts the code with the app credentials and returns the token', async () => {
    const { fetchFn, calls } = fakeFetch(200, { access_token: 'gho_token', token_type: 'bearer' });

    const token = await exchangeCode(config, 'the-code', fetchFn);

    expect(token).toBe('gho_token');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://github.test/login/oauth/access_token');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('accept')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      client_id: 'Iv1.client',
      client_secret: 'client-secret',
      code: 'the-code',
      redirect_uri: 'https://appreciator.test/auth/github/callback',
    });
  });

  it('fails on a non-200', async () => {
    const { fetchFn } = fakeFetch(502, 'bad gateway');

    await expect(exchangeCode(config, 'c', fetchFn)).rejects.toThrow(/status 502/);
  });

  it('fails on an error reported in a 200 body, naming the error', async () => {
    const { fetchFn } = fakeFetch(200, {
      error: 'bad_verification_code',
      error_description: 'The code passed is incorrect or expired.',
    });

    await expect(exchangeCode(config, 'c', fetchFn)).rejects.toThrow(
      new GitHubError('token exchange: bad_verification_code'),
    );
  });

  it('fails when there is no token', async () => {
    for (const body of [{}, { access_token: '' }, { access_token: 42 }]) {
      const { fetchFn } = fakeFetch(200, body);

      await expect(exchangeCode(config, 'c', fetchFn)).rejects.toThrow(/no access token/);
    }
  });

  it('fails on a body that is not JSON', async () => {
    const { fetchFn } = fakeFetch(200, '<html>');

    await expect(exchangeCode(config, 'c', fetchFn)).rejects.toThrow(/not JSON/);
  });
});

describe('fetchUser', () => {
  const USER = {
    id: 583231,
    login: 'octocat',
    avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
    email: 'octocat@github.test',
  };

  it('reads the user with the token and keeps only id, login and avatar', async () => {
    const { fetchFn, calls } = fakeFetch(200, USER);

    const user = await fetchUser(config, 'gho_token', fetchFn);

    expect(user).toEqual({ id: USER.id, login: USER.login, avatar_url: USER.avatar_url });
    expect(calls[0]?.url).toBe('https://api.github.test/user');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer gho_token');
    expect(headers.get('user-agent')).toBeTruthy();
  });

  it('fails on a non-200', async () => {
    const { fetchFn } = fakeFetch(401, { message: 'Bad credentials' });

    await expect(fetchUser(config, 't', fetchFn)).rejects.toThrow(/status 401/);
  });

  it('fails on a user without a usable id or login', async () => {
    for (const body of [
      { ...USER, id: undefined },
      { ...USER, id: '583231' },
      { ...USER, id: -1 },
      { ...USER, login: '' },
      { ...USER, login: 'x'.repeat(256) },
    ]) {
      const { fetchFn } = fakeFetch(200, body);

      await expect(fetchUser(config, 't', fetchFn)).rejects.toThrow(GitHubError);
    }
  });

  it('drops an avatar that is not an https URL', async () => {
    for (const avatar of [null, 'javascript:alert(1)', 'http://avatars.test/a', 42]) {
      const { fetchFn } = fakeFetch(200, { ...USER, avatar_url: avatar });

      expect((await fetchUser(config, 't', fetchFn)).avatar_url).toBeNull();
    }
  });
});

describe('isLoginAllowed', () => {
  it('accepts a listed login, whatever the casing', () => {
    expect(isLoginAllowed('octocat', ['octocat'])).toBe(true);
    expect(isLoginAllowed('OctoCat', ['octocat'])).toBe(true);
    expect(isLoginAllowed('octocat', ['OCTOCAT'])).toBe(true);
  });

  it('refuses an unlisted login, including near misses', () => {
    expect(isLoginAllowed('octocat2', ['octocat'])).toBe(false);
    expect(isLoginAllowed('octo', ['octocat'])).toBe(false);
  });

  it('refuses everyone when the allowlist is empty', () => {
    expect(isLoginAllowed('octocat', [])).toBe(false);
  });
});
