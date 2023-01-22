import knex from 'knex'
import { firefly } from '../knexfile'

export interface AccountWithNumber {
  id: number
  account_type_id: number
  account_number: string
}

// Fetch all accounts that have an account_number loaded
export async function accountsWithNumber (): Promise<AccountWithNumber[]> {
  const db = knex(firefly)
  const accounts = await db('accounts')
    .select('accounts.id', 'accounts.account_type_id', 'account_meta.data')
    .innerJoin('account_meta', 'accounts.id', 'account_meta.account_id')
    .where('account_meta.name', 'account_number')

  accounts.forEach(account => {
    account.account_number = JSON.parse(account.data)
    delete account.data
  })

  return accounts
}
