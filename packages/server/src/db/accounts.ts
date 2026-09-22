import { randomUUID } from 'node:crypto';

import type { Account } from '@appreciator/shared';

import type { Executor } from './pool.js';
import { execute, queryOne } from './pool.js';

/** Row shape of the `accounts` table, as created by 007_accounts.sql. */
export interface AccountRow {
  id: string;
  github_id: number;
  login: string;
  avatar_url: string | null;
}

const ACCOUNT_COLUMNS = 'id, github_id, login, avatar_url';

/** Maps a row to the `Account` contract. The GitHub id stays server-side. */
export function toAccount(row: AccountRow): Account {
  return { id: row.id, login: row.login, avatarUrl: row.avatar_url };
}

export function findAccountById(executor: Executor, id: string): Promise<AccountRow | undefined> {
  return queryOne<AccountRow>(executor, `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`, [
    id,
  ]);
}

export interface GitHubIdentity {
  githubId: number;
  login: string;
  avatarUrl: string | null;
}

/**
 * Finds or creates the account for a GitHub user, refreshing the login and
 * avatar, which the user can change on GitHub at any time.
 *
 * Keyed on the numeric GitHub id, which is stable, rather than the login,
 * which can be renamed and later claimed by someone else. One upsert
 * statement, so two concurrent first sign-ins converge on one row.
 */
export async function upsertAccount(
  executor: Executor,
  identity: GitHubIdentity,
): Promise<AccountRow> {
  await execute(
    executor,
    `INSERT INTO accounts (id, github_id, login, avatar_url) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE login = VALUES(login), avatar_url = VALUES(avatar_url)`,
    [randomUUID(), identity.githubId, identity.login, identity.avatarUrl],
  );

  const row = await queryOne<AccountRow>(
    executor,
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE github_id = ?`,
    [identity.githubId],
  );
  if (row === undefined) {
    throw new Error('account row missing after upsert');
  }
  return row;
}
