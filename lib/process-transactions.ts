import type { EnrichedTransaction } from 'akahu'
import Big from 'big.js'
import { Account, Accounts, AccountType } from './accounts'
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
    await processor.accounts.importFromFirefly()
    await processor.transactions.importFromFirefly(processor.accounts)
    return processor
  }

  public akahuToFirefly (transaction: EnrichedTransaction): Transaction {
    // TODO:
    // transaction.meta.reference
    // transaction.meta.particulars
    // transaction.meta.code
    // transaction.meta.other_account
    // transaction.type
    // transaction.merchant

    // Look up Akahu Account ID (acc_xxxxx)
    const accountSet = this.accounts.getByAkahuId(transaction._account)
    if (accountSet === undefined) throw Error(`Akahu account ${transaction._account} not set up in Firefly`)
    const account = accountSet.asset ?? accountSet.liability
    if (account === undefined) throw Error(`User's account ${transaction._account} not configured as an asset or liability`)

    const dummyAccount: Account = {
      fireflyId: 0,
      akahuId: undefined,
      name: '',
      type: AccountType.Expense,
      bankNumbers: new Set()
    }

    let type, source: Account, destination
    if (transaction.amount < 0) {
      type = TransactionType.Withdrawal
      source = account
      destination = dummyAccount // TODO - expense account
    } else {
      type = TransactionType.Deposit
      source = dummyAccount // TODO - revenue account
      destination = account
    }

    if (type === TransactionType.Transfer) throw Error('Impossible')

    const fireflyTrans: Transaction = {
      fireflyId: 0,
      akahuId: transaction._id,
      type,
      source,
      destination,
      date: new Date(transaction.date),
      amount: Big(transaction.amount).abs(),
      description: transaction.description
    }

    // Add foreign currency details if any available
    const conversion: CurrencyConversion | undefined = (transaction.meta.conversion as unknown) as CurrencyConversion | undefined
    if (conversion !== undefined) {
      fireflyTrans.foreignAmount = Big(conversion.amount).abs()
      fireflyTrans.foreignCurrencyCode = conversion.currency
      // TODO: Store fee/rate
    }

    // Use personal finance group as category
    const categoryName = transaction?.category?.groups?.['personal_finance']?.name
    if (categoryName !== undefined) fireflyTrans.categoryName = categoryName
    // TODO: Store other categories

    return fireflyTrans
  }

  public processTransactions (transactions: EnrichedTransaction[]): void {
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
