import knex from 'knex'
import Big from 'big.js'
import type { Transaction as AkahuTransaction } from 'akahu'
import { compareTwoStrings } from 'string-similarity'
import { production } from '../knexfile'
import { Account, AccountPair, Accounts, AccountType } from './accounts'
import { Transaction, Transactions, TransactionType } from './transactions'
import { Util } from './util'

const transactionMapping = {
  [AccountType.Asset]: {
    [AccountType.Asset]: TransactionType.Transfer,
    [AccountType.Liability]: TransactionType.Withdrawal,
    [AccountType.Expense]: TransactionType.Withdrawal,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Liability]: {
    [AccountType.Asset]: TransactionType.Deposit,
    [AccountType.Liability]: TransactionType.Transfer,
    [AccountType.Expense]: TransactionType.Withdrawal,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Expense]: {
    [AccountType.Asset]: undefined,
    [AccountType.Liability]: undefined,
    [AccountType.Expense]: undefined,
    [AccountType.Revenue]: undefined
  },
  [AccountType.Revenue]: {
    [AccountType.Asset]: TransactionType.Deposit,
    [AccountType.Liability]: TransactionType.Deposit,
    [AccountType.Expense]: undefined,
    [AccountType.Revenue]: undefined
  }
}

interface CurrencyConversion {
  currency: string
  amount: number
  rate: number
  fee?: number
}

interface Row<T> {
  id: string
  data: T
}

type IncompleteTransaction = Omit<Transaction, 'id'> & {
  _id: string
  _account: string
}

function findAccountPair (accounts: Accounts, transaction: AkahuTransaction): AccountPair {
  let account: AccountPair | undefined

  // Interest is a special case - match any account that contains the word interest
  if (transaction.description.toLowerCase().includes('interest')) {
    account ??= accounts.getByName('Interest')
  }

  // Match account using the Akahu merchant ID
  if ('merchant' in transaction) {
    account ??= accounts.getByAkahuId(transaction.merchant._id)
  }

  // Match account using the bank account number
  if ('meta' in transaction) {
    account ??= accounts.getByBankNumber(transaction.meta.other_account ?? '')
  }

  // If all else fails match account using fuzzy name matching
  // Match the description with and without the reference - pick the best result
  if (account === undefined) {
    let name = transaction.description
    let match = accounts.getByNameFuzzy(name)
    if ('meta' in transaction) {
      name = name.replace(transaction.meta.reference ?? '', '')
      const newMatch = accounts.getByNameFuzzy(name)
      if (newMatch[1] > match[1]) match = newMatch
    }
    account ??= match[0]
  }

  return account
}

function transformTransaction (accounts: Accounts, transaction: AkahuTransaction): IncompleteTransaction {
  // TODO:
  // transaction.meta.reference
  // transaction.meta.particulars
  // transaction.meta.code
  // transaction.type

  // Look up Akahu Account ID (acc_xxxxx)
  const pair = accounts.getByAkahuId(transaction._account)
  if (pair === undefined) throw Error(`Akahu account ${transaction._account} not set up`)
  const account = pair.source ?? pair.destination
  if (account === undefined) throw Error('Found invalid AccountPair')
  if (account.type !== AccountType.Asset && account.type !== AccountType.Liability) throw Error(`User's account ${transaction._account} not configured as an asset or liability`)

  const findAccount = findAccountPair(accounts, transaction)

  let source: Account, destination: Account
  if (transaction.amount < 0) {
    if (findAccount.destination === undefined) {
      const other = findAccount.source
      if (other === undefined) throw Error('Found invalid AccountPair')

      // TODO: Enhance with data from this transaction
      destination = accounts.create({
        fireflyId: other.fireflyId,
        akahuId: other.akahuId,
        name: other.name,
        type: AccountType.Expense,
        bankNumbers: other.bankNumbers,
        alternateNames: other.alternateNames
      })
    } else {
      destination = findAccount.destination
    }

    source = account
  } else {
    if (findAccount.source === undefined) {
      const other = findAccount.destination
      if (other === undefined) throw Error('Found invalid AccountPair')

      // TODO: Enhance with data from this transaction
      source = accounts.create({
        fireflyId: other.fireflyId,
        akahuId: other.akahuId,
        name: other.name,
        type: AccountType.Revenue,
        bankNumbers: other.bankNumbers,
        alternateNames: other.alternateNames
      })
    } else {
      source = findAccount.source
    }

    destination = account
  }

  const type = transactionMapping[source.type][destination.type]
  if (type === undefined) throw Error(`Invalid transaction type ${source.type} -> ${destination.type}`)

  const newTrans: IncompleteTransaction = {
    fireflyId: undefined,
    akahuIds: new Set([transaction._id]),
    type,
    source,
    destination,
    date: new Date(transaction.date),
    amount: Big(transaction.amount).abs(),
    description: transaction.description,
    _id: transaction._id,
    _account: transaction._account
  }

  // Add foreign currency details if any available
  if ('meta' in transaction) {
    const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
    if (conversion !== undefined) {
      newTrans.foreignAmount = Big(conversion.amount).abs()
      newTrans.foreignCurrencyCode = conversion.currency
      // TODO: Store fee/rate
    }
  }

  // Use personal finance group as category
  if ('category' in transaction) {
    const categoryName = transaction.category.groups?.['personal_finance']?.name
    if (categoryName !== undefined) newTrans.categoryName = categoryName
    // TODO: Store other categories
  }

  return newTrans
}

function findBestTransaction (transaction: IncompleteTransaction, transactions: IncompleteTransaction[]): IncompleteTransaction | undefined {
  // Find transactions with the same source, destination and amount
  const matches: Array<[number, number, IncompleteTransaction]> = transactions.filter(other => {
    return transaction._account !== other._account &&
      transaction.source.id === other.source.id &&
      transaction.destination.id === other.destination.id &&
      transaction.amount.eq(other.amount)
  }).map(other => [
    Math.abs(transaction.date.getTime() - other.date.getTime()), // Distance from target time
    compareTwoStrings(transaction.description, other.description), // Distance from target description
    other
  ])

  // Sort by date and then description
  matches.sort((a, b) => {
    const dateCompare = a[0] - b[0]
    if (dateCompare !== 0) {
      return dateCompare
    } else {
      return a[1] - b[1]
    }
  })

  // Return best match
  return matches[0]?.[2]
}

function mergeTransactions (a: Omit<Transaction, 'id'>, b: Omit<Transaction, 'id'>): void {
  // Check essential details match
  if (a.type !== b.type || a.source.id !== b.source.id || a.destination.id !== b.destination.id || !a.amount.eq(b.amount)) {
    throw Error(`Can't merge - essential details of transactions don't match\n${Util.stringify(a)}\n${Util.stringify(b)}`)
  }

  // Check firefly IDs match
  if ('fireflyId' in a && 'fireflyId' in b && a.fireflyId !== b.fireflyId) {
    throw Error(`Can't merge - firefly IDs don't match\n${Util.stringify(a)}\n${Util.stringify(b)}`)
  }

  // Check foreign amount details match
  if ('foreignAmount' in a && 'foreignAmount' in b && !a.foreignAmount.eq(b.foreignAmount)) {
    throw Error(`Can't merge - foreign amounts don't match\n${Util.stringify(a)}\n${Util.stringify(b)}`)
  }
  if ('foreignCurrencyCode' in a && 'foreignCurrencyCode' in b && a.foreignCurrencyCode !== b.foreignCurrencyCode) {
    throw Error(`Can't merge - foreign currency codes don't match\n${Util.stringify(a)}\n${Util.stringify(b)}`)
  }

  // Update transaction a from transaction b
  a.fireflyId ??= b.fireflyId
  a.akahuIds = new Set([...a.akahuIds, ...b.akahuIds])
  a.description = `${a.description} - ${b.description}`
  a.date ??= b.date
  if ('foreignAmount' in b) a.foreignAmount ??= b.foreignAmount
  if ('foreignCurrencyCode' in b) a.foreignCurrencyCode ??= b.foreignCurrencyCode
  if ('categoryName' in b) a.categoryName ??= b.categoryName

  // Use transaction B's date if it has the transactio time set
  if (b.date.getMinutes() !== 0 || b.date.getHours() !== 0) {
    a.date = b.date
  }
}

export async function importTransactions (accounts: Accounts, transactions: Transactions): Promise<void> {
  const db = knex(production)
  const transactionsTable = db<Row<AkahuTransaction>, any>('akahu_transactions')
  const akahuTransactions = await transactionsTable.pluck('data')

  const internalTransactions: Map<string, IncompleteTransaction> = new Map()

  akahuTransactions.forEach(akahuTransaction => {
    const transaction = transformTransaction(accounts, akahuTransaction)

    // Detect if this is an internal transfer of funds
    if (transaction.source.akahuId !== undefined && transaction.destination.akahuId !== undefined &&
      transaction.source.akahuId.startsWith('acc_') && transaction.destination.akahuId.startsWith('acc_')) {
      internalTransactions.set(transaction._id, transaction)
    } else {
      transactions.create(transaction)
    }
  })

  // Transfers between our accounts will result in two transactions,
  // one form the source account and one from the destination account.
  // Find these pairs and merge the two transactions together.
  internalTransactions.forEach(transaction => {
    // Find the best matching transaction
    const match = findBestTransaction(transaction, [...internalTransactions.values()])

    // Error if search failed
    if (match === undefined) {
      throw Error(`Could not find matching transaction for ${Util.stringify(transaction)}`)
    }

    // Remove paired transactions from internalTransactions
    internalTransactions.delete(match._id)
    internalTransactions.delete(transaction._id)

    mergeTransactions(transaction, match)

    // Add merged transaction to transaction store
    transactions.create(transaction)
  })
}
