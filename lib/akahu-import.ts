import knex from 'knex'
import Big from 'big.js'
import type { Transaction as AkahuTransaction } from 'akahu'
import { production } from '../knexfile'
import { Account, AccountPair, Accounts, AccountType } from './accounts'
import { Transaction, Transactions } from './transactions'
import { Util } from './util'

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

type IncompleteTransaction = Omit<Transaction, 'id'>

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
        fireflyId: undefined,
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
        fireflyId: undefined,
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

  const newTrans: IncompleteTransaction = {
    fireflyId: undefined,
    akahuIds: new Set([transaction._id]),
    source,
    destination,
    date: new Date(transaction.date),
    amount: Big(transaction.amount).abs(),
    description: transaction.description
  }

  if ('meta' in transaction) {
    // Add foreign currency details if any available
    const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
    if (conversion !== undefined) {
      newTrans.foreignAmount = Big(conversion.amount).abs()
      newTrans.foreignCurrencyCode = conversion.currency
      // TODO: Store fee/rate
    }

    // Strip reference, code and particulars from description
    newTrans.description = newTrans.description.replace(transaction.meta.reference ?? '', '').replace(transaction.meta.code ?? '', '').replace(transaction.meta.particulars ?? '', '').trim()
  }

  // Use personal finance group as category
  if ('category' in transaction) {
    const categoryName = transaction.category.groups?.['personal_finance']?.name
    if (categoryName !== undefined) newTrans.categoryName = categoryName
    // TODO: Store other categories
  }

  return newTrans
}

export async function importTransactions (accounts: Accounts): Promise<Transactions> {
  const db = knex(production)
  const transactionsTable = db<Row<AkahuTransaction>, any>('akahu_transactions')
  const akahuTransactions = await transactionsTable.pluck('data')

  const positive = new Transactions()
  const negative = new Transactions()
  const normalTransactions: IncompleteTransaction[] = []

  akahuTransactions.forEach(akahuTransaction => {
    const transaction = transformTransaction(accounts, akahuTransaction)

    // Detect if this is an internal transfer of funds
    if (transaction.source.akahuId !== undefined && transaction.destination.akahuId !== undefined &&
      transaction.source.akahuId.startsWith('acc_') && transaction.destination.akahuId.startsWith('acc_')) {
      if (akahuTransaction.amount < 0) {
        negative.create(transaction)
      } else {
        positive.create(transaction)
      }
    } else {
      normalTransactions.push(transaction)
    }
  })

  // Transfers between our accounts will result in two transactions,
  // one from the source account and one from the destination account.
  // Find these pairs and merge the two transactions together.
  const remainders = positive.merge(negative, _ => true, (a: Transaction, b: Transaction) => {
    // Combine the two descriptions
    a.description = `${a.description} - ${b.description}`
  })

  // Error if there are any unmatched transactions
  const unmatched = [...remainders.left.values(), ...remainders.right.values()]
  if (unmatched.length !== 0) {
    throw Error(`Could not find matching transactions for ${Util.stringify(unmatched)}`)
  }

  // Add normal transactions to positive
  normalTransactions.forEach(transaction => positive.create(transaction))

  return positive
}
