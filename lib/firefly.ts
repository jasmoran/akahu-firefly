import knex from 'knex'
import { firefly } from '../knexfile'

export enum AccountType {
  Default = 'Default account',
  Cash = 'Cash account',
  Asset = 'Asset account',
  Expense = 'Expense account',
  Revenue = 'Revenue account',
  InitialBalance = 'Initial balance account',
  Beneficiary = 'Beneficiary account',
  Import = 'Import account',
  Loan = 'Loan',
  Reconciliation = 'Reconciliation account',
  Debt = 'Debt',
  Mortgage = 'Mortgage',
  LiabilityCredit = 'Liability credit account'
}

export interface Account {
  id: number
  type: AccountType
  name: string
  iban: string | null
  account_number: string | null
  external_id: string | null
  notes: string | null
}

export interface Transaction {
  id: number
  type: string
  description: string
  date: Date
  amount: string | number
  source_id: number
  destination_id: number
  foreign_amount: string | number | null
  foreign_currency_code: string | null
  external_id: string | null
  category_name: string | null
}

export const ALT_NAMES_REGEX = /\*\*Alternate names\*\*(\n-\s*`[^`]+`)+/
// Fetch all accounts
export async function accounts (): Promise<Account[]> {
  const db = knex(firefly)
  const accounts = await db('accounts AS acc')
    .select(
      'acc.id',
      'at.type',
      'acc.name',
      'acc.iban',
      'num.data AS account_number',
      'ext.data AS external_id',
      'notes.text AS notes'
    )
    .leftJoin('account_meta AS num', function () {
      this.on('acc.id', 'num.account_id')
        .andOnVal('num.name', 'account_number')
    })
    .leftJoin('account_meta AS ext', function () {
      this.on('acc.id', 'ext.account_id')
        .andOnVal('ext.name', 'external_id')
    })
    .leftJoin('notes', function () {
      this.on('acc.id', 'notes.noteable_id')
        .andOnVal('notes.noteable_type', 'FireflyIII\\Models\\Account')
        .andOnNull('notes.deleted_at')
    })
    .leftJoin('account_types AS at', 'acc.account_type_id', 'at.id')
    .whereNull('acc.deleted_at')

  accounts.forEach(account => {
    account.account_number = JSON.parse(account.account_number)
    account.external_id = JSON.parse(account.external_id)
  })

  return accounts
}

// Fetch all transactions
export async function transactions (): Promise<Transaction[]> {
  const db = knex(firefly)
  const transactions = await db('transaction_journals AS tj')
    .select(
      'tj.id',
      'tt.type',
      'tj.description',
      'tj.date',
      db.raw('ROUND(dst.amount, 2) AS amount'),
      'src.account_id AS source_id',
      'dst.account_id AS destination_id',
      'dst.foreign_amount',
      'tc.code AS foreign_currency_code',
      'meta.data AS external_id',
      'c.name AS category_name'
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
    .leftJoin('transaction_currencies AS tc', 'dst.foreign_currency_id', 'tc.id')
    .leftJoin('transaction_types AS tt', 'tj.transaction_type_id', 'tt.id')
    .leftJoin('category_transaction_journal AS ctj', 'tj.id', 'ctj.transaction_journal_id')
    .leftJoin('categories AS c', 'ctj.category_id', 'c.id')
    .whereNull('tj.deleted_at')

  transactions.forEach(account => {
    account.external_id = JSON.parse(account.external_id)
  })

  return transactions
}
