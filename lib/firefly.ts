import knex from 'knex'
import Big from 'big.js'
import { firefly } from '../knexfile'
import { Account as AccountAccount, Accounts, AccountType as AccountAccountType } from './accounts'
import { Transaction as TransactionTransaction, Transactions } from './transactions'
import { Util } from './util'

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

// Map Firefly account types to Asset, Liability, Expense and Revenue
// Ignore type accounts will be discarded
const TypeMapping: { [K in AccountType]?: AccountAccountType } = {
  [AccountType.Default]: AccountAccountType.Asset,
  [AccountType.Cash]: AccountAccountType.Asset,
  [AccountType.Asset]: AccountAccountType.Asset,
  [AccountType.Expense]: AccountAccountType.Expense,
  [AccountType.Revenue]: AccountAccountType.Revenue,
  [AccountType.Loan]: AccountAccountType.Liability,
  [AccountType.Debt]: AccountAccountType.Liability,
  [AccountType.Mortgage]: AccountAccountType.Liability
}

export const ALT_NAMES_REGEX = /\*\*Alternate names\*\*(\n-\s*`[^`]+`)+/
export const AKAHU_ID_REGEX = /\*\*Akahu ID\*\*\s*`([^`]+)`/

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

// Find all accounts that match any of the provided identifiers
function findMatches (accounts: Accounts, account: Omit<AccountAccount, 'id'>): AccountAccount[] {
  const matches: Map<number, AccountAccount> = new Map()

  const addAccount = (acc: AccountAccount | undefined): void => {
    if (acc !== undefined) {
      matches.set(acc.id, acc)
    }
  }

  // Match on account name
  account.alternateNames.forEach(name => {
    addAccount(accounts.getByName(name))
  })

  // Match on bank numbers
  account.bankNumbers.forEach(bankNumber => {
    addAccount(accounts.getByBankNumber(bankNumber))
  })

  // Match on Akahu ID
  addAccount(accounts.getByAkahuId(account.akahuId ?? ''))

  // Match on Firefly ID
  addAccount(accounts.getByFireflyId(account.source?.fireflyId ?? 0))
  addAccount(accounts.getByFireflyId(account.destination?.fireflyId ?? 0))

  return [...matches.values()]
}

function mergeAccounts (a: AccountAccount, b: Omit<AccountAccount, 'id'>): AccountAccount {
  // Ensure only one account has source set
  if (a.source !== undefined && b.source !== undefined) {
    throw Error(`Merging two accounts with Source Firefly IDs ${Util.stringify([a, b])}`)
  }

  // Ensure only one account has destination set
  if (a.destination !== undefined && b.destination !== undefined) {
    throw Error(`Merging two accounts with Destination Firefly IDs ${Util.stringify([a, b])}`)
  }

  // Compare Akahu IDs
  if (a.akahuId !== undefined && b.akahuId !== undefined && a.akahuId !== b.akahuId) {
    throw Error(`Merging mismatched Akahu IDs ${Util.stringify([a, b])}`)
  }

  // Compare names
  if (a.name !== b.name) throw Error(`Merging mismatched names ${Util.stringify([a, b])}`)

  return {
    id: a.id,
    source: a.source ?? b.source,
    destination: a.destination ?? b.destination,
    akahuId: a.akahuId ?? b.akahuId,
    name: a.name,
    bankNumbers: new Set([...a.bankNumbers, ...b.bankNumbers]),
    alternateNames: new Map([...a.alternateNames, ...b.alternateNames])
  }
}

export async function importAccounts (): Promise<Accounts> {
  const fireflyAccounts = await accounts()
  const accs = new Accounts()

  // Process each Firefly account
  fireflyAccounts.forEach(fireflyAccount => {
    // Fetch account type
    const type = TypeMapping[fireflyAccount.type]
    if (type === undefined) return

    // Fetch Akahu ID
    let akahuId: string | undefined
    if (fireflyAccount.notes !== null && AKAHU_ID_REGEX.test(fireflyAccount.notes)) {
      akahuId = fireflyAccount.notes.match(AKAHU_ID_REGEX)?.[1]
    }

    const notes = fireflyAccount.notes ?? undefined

    // Set source & destination Firefly IDs
    const source = type === AccountAccountType.Expense ? undefined : { fireflyId: fireflyAccount.id, type, notes }
    const destination = type === AccountAccountType.Revenue ? undefined : { fireflyId: fireflyAccount.id, type, notes }

    // Create Account from Firefly data
    const name = fireflyAccount.name.trim()
    const account: Omit<AccountAccount, 'id'> = {
      source,
      destination,
      akahuId,
      name,
      bankNumbers: new Set<string>(),
      alternateNames: new Map()
    }

    account.alternateNames.set(Accounts.normalizeName(name), name)

    // Add bank account numbers
    if (fireflyAccount.account_number !== null) {
      const numbers = fireflyAccount.account_number.split(',')
      numbers.forEach(number => {
        if (/^\d+-\d+-\d+-\d+$/.test(number)) {
          account.bankNumbers.add(Accounts.formatBankNumber(number))
        }
      })
    }

    // Add alternate names
    if (fireflyAccount.notes !== null) {
      fireflyAccount
        .notes
        .match(ALT_NAMES_REGEX)
        ?.[0]
        ?.split('\n')
        ?.forEach(line => {
          const name = line.match(/`([^`]+)`/)?.[1]
          if (name !== undefined) account.alternateNames.set(Accounts.normalizeName(name), name)
        })
    }

    // Find any accounts that have matching values
    const matches = findMatches(accs, account)
    const [match, others] = matches

    if (match === undefined) {
      // Create a new account if there are no existing accounts
      accs.create(account)
    } else if (others === undefined && (type === AccountAccountType.Revenue || type === AccountAccountType.Expense)) {
      // Merge expense / revenue accounts
      accs.save(mergeAccounts(match, account))
    } else {
      throw Error(`Account (${Util.stringify(account)}) conflicts with accounts:\n${Util.stringify(matches)}`)
    }
  })

  return accs
}

export async function importTransactions (accounts: Accounts): Promise<Transactions> {
  const fireflyTransactions = await transactions()
  const trans = new Transactions()

  // Process each Firefly transaction
  fireflyTransactions.forEach(fireflyTransaction => {
    // Split comma seperated external IDs into an array
    // Array should be empty if external ID is empty or null
    const externalId = fireflyTransaction.external_id ?? ''
    const externalIds = externalId.length === 0 ? [] : externalId.split(',')
    const akahuIds = externalIds.filter(id => id.startsWith('trans_'))

    const source = accounts.getByFireflyId(fireflyTransaction.source_id)
    const destination = accounts.getByFireflyId(fireflyTransaction.destination_id)

    // Confirm source and destination account exist
    // This should be enforced by a foreign key in the database
    if (source === undefined || destination === undefined) throw Error("Source or desination account doesn't exist")

    // Create Transaction from Firefly data
    const transaction: Omit<TransactionTransaction, 'id'> = {
      fireflyId: fireflyTransaction.id,
      description: fireflyTransaction.description,
      date: fireflyTransaction.date,
      amount: Big(fireflyTransaction.amount),
      sourceId: source.id,
      destinationId: destination.id,
      akahuIds: new Set(akahuIds)
    }

    // Add optional values
    if (fireflyTransaction.foreign_amount !== null) transaction.foreignAmount = Big(fireflyTransaction.foreign_amount)
    if (fireflyTransaction.foreign_currency_code !== null) transaction.foreignCurrencyCode = fireflyTransaction.foreign_currency_code
    if (fireflyTransaction.category_name !== null) transaction.categoryName = fireflyTransaction.category_name

    trans.create(transaction)
  })

  return trans
}
