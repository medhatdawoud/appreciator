import type { Account } from '@appreciator/shared';

import type { Executor } from './pool.js';
import { queryOne } from './pool.js';

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
