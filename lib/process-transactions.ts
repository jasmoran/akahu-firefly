import type { Transaction as AkahuTransaction } from 'akahu'
import Big from 'big.js'
import { Account, AccountPair, Accounts, AccountType } from './accounts'
import { importAccounts } from './firefly-import'
import { Transaction, Transactions, TransactionType } from './transactions'

interface CurrencyConversion {
  currency: string
  amount: number
  rate: number
  fee?: number
}

export class ProcessTransactions {
  private readonly transactions: Transactions
  private readonly accounts: Accounts

  private constructor () {
    this.accounts = new Accounts()
    this.transactions = new Transactions()
  }

  public static async build (): Promise<ProcessTransactions> {
    const processor = new ProcessTransactions()
    await importAccounts(processor.accounts)
    await processor.transactions.importFromFirefly(processor.accounts)
    return processor
  }

  private findAccountPair (transaction: AkahuTransaction): AccountPair {
    let account: AccountPair | undefined

    // Interest is a special case - match any account that contains the word interest
    if (transaction.description.toLowerCase().includes('interest')) {
      account ??= this.accounts.getByName('Interest')
    }

    // Match account using the Akahu merchant ID
    if ('merchant' in transaction) {
      account ??= this.accounts.getByAkahuId(transaction.merchant._id)
    }

    // Match account using the bank account number
    if ('meta' in transaction) {
      account ??= this.accounts.getByBankNumber(transaction.meta.other_account ?? '')
    }

    // If all else fails match account using fuzzy name matching
    // Match the description with and without the reference - pick the best result
    if (account === undefined) {
      let name = transaction.description
      let match = this.accounts.getByNameFuzzy(name)
      if ('meta' in transaction) {
        name = name.replace(transaction.meta.reference ?? '', '')
        const newMatch = this.accounts.getByNameFuzzy(name)
        if (newMatch[1] > match[1]) match = newMatch
      }
      account ??= match[0]
    }

    return account
  }

  public akahuToFirefly (transaction: AkahuTransaction): Transaction {
    // TODO:
    // transaction.meta.reference
    // transaction.meta.particulars
    // transaction.meta.code
    // transaction.meta.other_account
    // transaction.type
    // transaction.merchant

    // Look up Akahu Account ID (acc_xxxxx)
    const pair = this.accounts.getByAkahuId(transaction._account)
    if (pair === undefined) throw Error(`Akahu account ${transaction._account} not set up in Firefly`)
    const account = pair.source ?? pair.destination
    if (account === undefined) throw Error('Found invalid AccountPair')
    if (account.type !== AccountType.Asset && account.type !== AccountType.Liability) throw Error(`User's account ${transaction._account} not configured as an asset or liability`)

    const findAccount = this.findAccountPair(transaction)

    let type, source: Account, destination: Account
    if (transaction.amount < 0) {
      if (findAccount.destination === undefined) {
        const other = findAccount.source
        if (other === undefined) throw Error('Found invalid AccountPair')

        // TODO: Enhance with data from this transaction
        destination = this.accounts.create({
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

      type = TransactionType.Withdrawal
      source = account
    } else {
      if (findAccount.source === undefined) {
        const other = findAccount.destination
        if (other === undefined) throw Error('Found invalid AccountPair')

        // TODO: Enhance with data from this transaction
        source = this.accounts.create({
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

      type = TransactionType.Deposit
      destination = account
    }

    const fireflyTrans: Transaction = {
      fireflyId: 0,
      akahuId: transaction._id,
      otherAkahuId: undefined,
      type,
      source,
      destination,
      date: new Date(transaction.date),
      amount: Big(transaction.amount).abs(),
      description: transaction.description
    }

    // Add foreign currency details if any available
    if ('meta' in transaction) {
      const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
      if (conversion !== undefined) {
        fireflyTrans.foreignAmount = Big(conversion.amount).abs()
        fireflyTrans.foreignCurrencyCode = conversion.currency
        // TODO: Store fee/rate
      }
    }

    // Use personal finance group as category
    if ('category' in transaction) {
      const categoryName = transaction.category.groups?.['personal_finance']?.name
      if (categoryName !== undefined) fireflyTrans.categoryName = categoryName
      // TODO: Store other categories
    }

    return fireflyTrans
  }

  public processTransactions (transactions: AkahuTransaction[]): void {
    transactions.forEach(transaction => {
      const existingTransaction = this.transactions.getByAkahuId(transaction._id)
      const convertedTransaction = this.akahuToFirefly(transaction)
      if (existingTransaction !== undefined) {
        // existingTransaction.description = convertedTransaction.description
        existingTransaction.amount = convertedTransaction.amount
        this.transactions.save(existingTransaction)
      }
    })

    this.transactions.changes()
  }
}
