import type { EnrichedTransaction } from 'akahu'
import Big from 'big.js'
import { Accounts } from './accounts'
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
    await Promise.all([
      processor.accounts.importFromFirefly(),
      processor.transactions.importFromFirefly()
    ])
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
    const account = this.accounts.getByAkahuId(transaction._account)

    let type, sourceId, destinationId
    if (transaction.amount < 0) {
      type = TransactionType.Withdrawal
      sourceId = account?.asset?.fireflyId ?? 0
      destinationId = 0 // TODO - expense account
    } else {
      type = TransactionType.Deposit
      sourceId = 0 // TODO - revenue account
      destinationId = account?.asset?.fireflyId ?? 0
    }

    if (type === TransactionType.Transfer) throw Error('Impossible')

    const fireflyTrans: Transaction = {
      fireflyId: 0,
      akahuId: transaction._id,
      type,
      sourceId,
      destinationId,
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
