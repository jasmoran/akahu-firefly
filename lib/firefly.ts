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

export interface Transaction {
  id: number
  transaction_type_id: number
  description: string
  date: Date
  amount: string | number
  source_id: number
  destination_id: number
  foreign_amount: string | number | null
  foreign_currency_id: number | null
  external_id: string | null
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

// Fetch all transactions
export async function transactions (): Promise<Transaction[]> {
  const db = knex(firefly)
  const transactions = await db('transaction_journals AS tj')
    .select(
      'tj.id',
      'tj.transaction_type_id',
      'tj.description',
      'tj.date',
      'dst.amount',
      'src.account_id AS source_id',
      'dst.account_id AS destination_id',
      'src.foreign_amount',
      'src.foreign_currency_id',
      'meta.data AS external_id'
    )
    .leftJoin('transactions AS src', function () {
      this.on('tj.id', 'src.transaction_journal_id')
        .andOnVal('src.amount', '<', 0)
        .andOnNull('src.deleted_at')
    })
    .leftJoin('transactions AS dst', function () {
      this.on('tj.id', 'dst.transaction_journal_id')
        .andOnVal('dst.amount', '>=', 0)
        .andOnNull('dst.deleted_at')
    })
    .leftJoin('journal_meta AS meta', function () {
      this.on('tj.id', 'meta.transaction_journal_id')
        .andOnVal('meta.name', 'external_id')
        .andOnNull('meta.deleted_at')
    })
    .whereNull('tj.deleted_at')

  transactions.forEach(account => {
    account.external_id = JSON.parse(account.external_id)
  })

  return transactions
}
