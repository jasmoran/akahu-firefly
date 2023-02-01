import knex from 'knex'
import { firefly } from '../knexfile'

export interface AccountWithNumber {
  id: number
  account_type_id: number
  account_number: string
}

export interface AccountWithExternalId {
  id: number
  account_type_id: number
  external_id: string
}

function accountMeta<T> (name: string) {
  return async function (): Promise<T[]> {
    const db = knex(firefly)
    const accounts = await db('accounts')
      .select('accounts.id', 'accounts.account_type_id', 'account_meta.data')
      .innerJoin('account_meta', 'accounts.id', 'account_meta.account_id')
      .whereNull('accounts.deleted_at')
      .andWhere('account_meta.name', name)

    accounts.forEach(account => {
      account[name] = JSON.parse(account.data)
      delete account.data
    })

    return accounts
  }
}

// Fetch all accounts that have an account_number loaded
export const accountsWithNumber = accountMeta<AccountWithNumber>('account_number')

// Fetch all accounts that have an external_id loaded
export const accountsWithExternalId = accountMeta<AccountWithExternalId>('external_id')
