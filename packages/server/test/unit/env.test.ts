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
