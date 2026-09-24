import { describe, expect, it } from 'vitest';

import { EnvError, loadAppConfig } from '../../src/env.js';

const baseEnv = {
  DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/db',
  VISITOR_HASH_SECRET: '0123456789abcdef0123456789abcdef',
};

describe('MANAGEMENT_SECRET', () => {
  it('is optional', () => {
    expect(loadAppConfig(baseEnv).managementSecret).toBeUndefined();
    expect(
      loadAppConfig({ ...baseEnv, MANAGEMENT_SECRET: '   ' }).managementSecret,
    ).toBeUndefined();
  });

  it('is kept verbatim when long enough', () => {
    const secret = 'apr_sk_0123456789abcdef0123456789abcdef';

    expect(loadAppConfig({ ...baseEnv, MANAGEMENT_SECRET: ` ${secret} ` }).managementSecret).toBe(
      secret,
    );
  });

  it('refuses a short value rather than storing a weak hash', () => {
    expect(() => loadAppConfig({ ...baseEnv, MANAGEMENT_SECRET: 'hunter2' })).toThrow(EnvError);
    expect(() => loadAppConfig({ ...baseEnv, MANAGEMENT_SECRET: 'hunter2' })).toThrow(
      /MANAGEMENT_SECRET must be at least 32 characters/,
    );
  });
});

describe('RATE_LIMIT_READ_MAX', () => {
  it('defaults to 600, apart from RATE_LIMIT_MAX', () => {
    const config = loadAppConfig({ ...baseEnv, RATE_LIMIT_MAX: '5' });

    expect(config.rateLimitReadMax).toBe(600);
    expect(config.rateLimitMax).toBe(5);
  });

  it('can be set', () => {
    expect(loadAppConfig({ ...baseEnv, RATE_LIMIT_READ_MAX: '1200' }).rateLimitReadMax).toBe(1200);
  });

  it('refuses anything but a positive integer', () => {
    for (const value of ['0', '-1', '1.5', 'many']) {
      expect(() => loadAppConfig({ ...baseEnv, RATE_LIMIT_READ_MAX: value })).toThrow(
        /RATE_LIMIT_READ_MAX must be a positive integer/,
      );
    }
  });
});

describe('WIDGET_RATE_LIMIT_MAX', () => {
  it('defaults to 300', () => {
    expect(loadAppConfig(baseEnv).widgetRateLimitMax).toBe(300);
  });

  it('is read independently of RATE_LIMIT_MAX', () => {
    const config = loadAppConfig({ ...baseEnv, RATE_LIMIT_MAX: '5', WIDGET_RATE_LIMIT_MAX: '42' });

    expect(config.rateLimitMax).toBe(5);
    expect(config.widgetRateLimitMax).toBe(42);
  });

  it('refuses a value that is not a positive integer', () => {
    for (const value of ['0', '-1', '1.5', 'lots']) {
      expect(() => loadAppConfig({ ...baseEnv, WIDGET_RATE_LIMIT_MAX: value })).toThrow(
        /WIDGET_RATE_LIMIT_MAX must be a positive integer/,
      );
    }
  });
});

describe('sign-in configuration', () => {
  const SESSION_SECRET = 'session-secret-0123456789abcdef0123';
  const github = {
    GITHUB_CLIENT_ID: 'Iv1.client',
    GITHUB_CLIENT_SECRET: 'client-secret',
    SESSION_SECRET,
  };

  it('is disabled when nothing is configured', () => {
    const config = loadAppConfig(baseEnv);

    expect(config.signInEnabled).toBe(false);
    expect(config.githubClientId).toBeUndefined();
    expect(config.sessionSecret).toBeUndefined();
    expect(config.githubAllowedLogins).toEqual([]);
  });

  it('is enabled with a client id, client secret and session secret', () => {
    const config = loadAppConfig({ ...baseEnv, ...github });

    expect(config.signInEnabled).toBe(true);
    expect(config.githubClientId).toBe('Iv1.client');
    expect(config.githubClientSecret).toBe('client-secret');
    expect(config.sessionSecret).toBe(SESSION_SECRET);
  });

  it('refuses GitHub credentials without a session secret', () => {
    const { SESSION_SECRET: _unused, ...withoutSession } = github;
    void _unused;

    expect(() => loadAppConfig({ ...baseEnv, ...withoutSession })).toThrow(
      /SESSION_SECRET is required/,
    );
  });

  it('refuses a short session secret', () => {
    expect(() => loadAppConfig({ ...baseEnv, ...github, SESSION_SECRET: 'short' })).toThrow(
      /SESSION_SECRET must be at least 32 characters/,
    );
    expect(() => loadAppConfig({ ...baseEnv, SESSION_SECRET: 'short' })).toThrow(EnvError);
  });

  it('refuses half an OAuth app', () => {
    expect(() =>
      loadAppConfig({ ...baseEnv, GITHUB_CLIENT_ID: 'Iv1.client', SESSION_SECRET }),
    ).toThrow(/must be set together/);
    expect(() =>
      loadAppConfig({ ...baseEnv, GITHUB_CLIENT_SECRET: 'client-secret', SESSION_SECRET }),
    ).toThrow(/must be set together/);
  });

  it('reads the allowlist trimmed and lower-cased, dropping empty entries', () => {
    const config = loadAppConfig({
      ...baseEnv,
      ...github,
      GITHUB_ALLOWED_LOGINS: ' MedhatDawoud , ,octocat,',
    });

    expect(config.githubAllowedLogins).toEqual(['medhatdawoud', 'octocat']);
  });

  it('defaults the GitHub endpoints and accepts overrides without a trailing slash', () => {
    expect(loadAppConfig(baseEnv)).toMatchObject({
      githubOAuthUrl: 'https://github.com',
      githubApiUrl: 'https://api.github.com',
    });
    expect(
      loadAppConfig({
        ...baseEnv,
        GITHUB_OAUTH_URL: 'https://ghe.example.com/',
        GITHUB_API_URL: 'https://ghe.example.com/api/v3/',
      }),
    ).toMatchObject({
      githubOAuthUrl: 'https://ghe.example.com',
      githubApiUrl: 'https://ghe.example.com/api/v3',
    });
  });

  it('refuses a GitHub endpoint that is not an http(s) URL', () => {
    expect(() => loadAppConfig({ ...baseEnv, GITHUB_API_URL: 'not a url' })).toThrow(EnvError);
    expect(() => loadAppConfig({ ...baseEnv, GITHUB_OAUTH_URL: 'ftp://github.com' })).toThrow(
      EnvError,
    );
  });
});

describe('demo button and web settings', () => {
  it('enables the demo button for the public base URL origin by default', () => {
    const config = loadAppConfig({ ...baseEnv, PUBLIC_BASE_URL: 'https://appreciator.dev/' });

    expect(config.demoButton).toBe(true);
    expect(config.demoAllowedOrigins).toEqual(['https://appreciator.dev']);
  });

  it('can be turned off', () => {
    expect(loadAppConfig({ ...baseEnv, DEMO_BUTTON: 'false' }).demoButton).toBe(false);
  });

  it('reads DEMO_ALLOWED_ORIGINS as a trimmed list', () => {
    const config = loadAppConfig({
      ...baseEnv,
      DEMO_ALLOWED_ORIGINS: ' https://a.test , https://*.b.test ',
    });

    expect(config.demoAllowedOrigins).toEqual(['https://a.test', 'https://*.b.test']);
  });

  it('refuses a demo origin the management API would refuse', () => {
    expect(() =>
      loadAppConfig({ ...baseEnv, DEMO_ALLOWED_ORIGINS: 'https://a.test/path' }),
    ).toThrow(/DEMO_ALLOWED_ORIGINS entry "https:\/\/a.test\/path" is not an origin/);
  });

  it('refuses a PUBLIC_BASE_URL that is not an http(s) URL', () => {
    expect(() => loadAppConfig({ ...baseEnv, PUBLIC_BASE_URL: 'appreciator.dev' })).toThrow(
      EnvError,
    );
  });

  it('serves the leaderboard unless LEADERBOARD is false', () => {
    expect(loadAppConfig(baseEnv).leaderboardEnabled).toBe(true);
    expect(loadAppConfig({ ...baseEnv, LEADERBOARD: 'false' }).leaderboardEnabled).toBe(false);
  });

  it('defaults REPO_URL to the project repository', () => {
    expect(loadAppConfig(baseEnv).repoUrl).toBe('https://github.com/medhatdawoud/appreciator');
    expect(loadAppConfig({ ...baseEnv, REPO_URL: 'https://example.com/fork' }).repoUrl).toBe(
      'https://example.com/fork',
    );
  });
});
