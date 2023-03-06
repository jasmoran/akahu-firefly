import * as firefly from './firefly'
import { Account, Accounts, AccountType } from './accounts'
import { Transaction, Transactions } from './transactions'
import Big from 'big.js'
import { Util } from './util'

// Map Firefly account types to Asset, Liability, Expense and Revenue
// Ignore type accounts will be discarded
const TypeMapping: { [K in firefly.AccountType]?: AccountType } = {
  [firefly.AccountType.Default]: AccountType.Asset,
  [firefly.AccountType.Cash]: AccountType.Asset,
  [firefly.AccountType.Asset]: AccountType.Asset,
  [firefly.AccountType.Expense]: AccountType.Expense,
  [firefly.AccountType.Revenue]: AccountType.Revenue,
  [firefly.AccountType.Loan]: AccountType.Liability,
  [firefly.AccountType.Debt]: AccountType.Liability,
  [firefly.AccountType.Mortgage]: AccountType.Liability
}

// Find all accounts that match any of the provided identifiers
function findMatches (accounts: Accounts, account: Omit<Account, 'id'>): Account[] {
  const matches: Map<number, Account> = new Map()

  const addAccount = (acc: Account | undefined): void => {
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

function mergeAccounts (a: Account, b: Omit<Account, 'id'>): Account {
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
  const fireflyAccounts = await firefly.accounts()
  const accounts = new Accounts()

  // Process each Firefly account
  fireflyAccounts.forEach(fireflyAccount => {
    // Fetch account type
    const type = TypeMapping[fireflyAccount.type]
    if (type === undefined) return

    // Fetch Akahu ID
    let akahuId
    const externalId = fireflyAccount.external_id ?? fireflyAccount.iban
    if (externalId !== null && /^(acc|merchant)_/.test(externalId)) {
      akahuId = externalId
    }

    const notes = fireflyAccount.notes ?? undefined

    // Set source & destination Firefly IDs
    const source = type === AccountType.Expense ? undefined : { fireflyId: fireflyAccount.id, type, notes }
    const destination = type === AccountType.Revenue ? undefined : { fireflyId: fireflyAccount.id, type, notes }

    // Create Account from Firefly data
    const name = fireflyAccount.name.trim()
    const account: Omit<Account, 'id'> = {
      source,
      destination,
      akahuId,
      name,
      bankNumbers: new Set<string>(),
      alternateNames: new Map()
    }

    account.alternateNames.set(accounts.normalizeName(name), name)

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
        .match(firefly.ALT_NAMES_REGEX)
        ?.[0]
        ?.split('\n')
        ?.forEach(line => {
          const name = line.match(/`([^`]+)`/)?.[1]
          if (name !== undefined) account.alternateNames.set(accounts.normalizeName(name), name)
        })
    }

    // Find any accounts that have matching values
    const matches = findMatches(accounts, account)
    const [match, others] = matches

    if (match === undefined) {
      // Create a new account if there are no existing accounts
      accounts.create(account)
    } else if (others === undefined && (type === AccountType.Revenue || type === AccountType.Expense)) {
      // Merge expense / revenue accounts
      accounts.save(mergeAccounts(match, account))
    } else {
      throw Error(`Account (${Util.stringify(account)}) conflicts with accounts:\n${Util.stringify(matches)}`)
    }
  })

  return accounts
}

export async function importTransactions (accounts: Accounts): Promise<Transactions> {
  const fireflyTransactions = await firefly.transactions()
  const transactions = new Transactions()

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
    const transaction: Omit<Transaction, 'id'> = {
      fireflyId: fireflyTransaction.id,
      description: fireflyTransaction.description,
      date: fireflyTransaction.date,
      amount: Big(fireflyTransaction.amount),
      source,
      destination,
      akahuIds: new Set(akahuIds)
    }

    // Add optional values
    if (fireflyTransaction.foreign_amount !== null) transaction.foreignAmount = Big(fireflyTransaction.foreign_amount)
    if (fireflyTransaction.foreign_currency_code !== null) transaction.foreignCurrencyCode = fireflyTransaction.foreign_currency_code
    if (fireflyTransaction.category_name !== null) transaction.categoryName = fireflyTransaction.category_name

    transactions.create(transaction)
  })

  return transactions
}
