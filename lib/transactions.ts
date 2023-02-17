import Big from 'big.js'
import * as firefly from './firefly'

// List transaction types
enum TransactionType {
  Withdrawal = 'Withdrawal',
  Deposit = 'Deposit',
  OpeningBalance = 'Opening balance',
  Reconciliation = 'Reconciliation',
  Invalid = 'Invalid',
  LiabilityCredit = 'Liability credit',
  Transfer = 'Transfer'
}

interface TransactionCommon {
  fireflyId: number
  akahuId: string | undefined
  description: string
  date: Date
  amount: Big
  sourceId: number
  destinationId: number
  foreignAmount?: Big
  foreignCurrencyCode?: string
  categoryName?: string
}

// Export Transaction type
// Transfer transactions must have a second akahuId
export type Transaction = TransactionCommon & { type: TransactionType.Transfer, otherAkahuId: string | undefined }
| TransactionCommon & { type: TransactionType.Withdrawal | TransactionType.Deposit | TransactionType.OpeningBalance | TransactionType.Reconciliation | TransactionType.Invalid | TransactionType.LiabilityCredit }

export class Transactions {
  private readonly transactionsByFireflyId: Map<number, Transaction> = new Map()
  private readonly transactionsByAkahuId: Map<string, Transaction> = new Map()

  // Track modifications
  private readonly originalTransactions: Map<number, Transaction> = new Map()

  public async importFromFirefly (): Promise<void> {
    const fireflyTransactions = await firefly.transactions()

    // Process each Firefly transaction
    fireflyTransactions.forEach(fireflyTransaction => {
      // Fetch transaction type
      const transactionType: TransactionType = TransactionType[fireflyTransaction.type as keyof typeof TransactionType]

      // Split comma seperated external IDs into an array
      // Array should be empty if external ID is empty or null
      const externalId = fireflyTransaction.external_id ?? ''
      const externalIds = externalId.length === 0 ? [] : externalId.split(',')
      const akahuIds = externalIds.filter(id => id.startsWith('trans_'))

      const common: TransactionCommon = {
        fireflyId: fireflyTransaction.id,
        description: fireflyTransaction.description,
        date: fireflyTransaction.date,
        amount: Big(fireflyTransaction.amount),
        sourceId: fireflyTransaction.source_id,
        destinationId: fireflyTransaction.destination_id,
        akahuId: akahuIds[0]
      }

      // Create Transaction from Firefly data
      let transaction: Transaction
      if (transactionType === TransactionType.Transfer) {
        transaction = {
          ...common,
          type: transactionType,
          otherAkahuId: akahuIds[1]
        }
      } else {
        transaction = {
          ...common,
          type: transactionType
        }
      }

      // Add optional values
      if (fireflyTransaction.foreign_amount !== null) transaction.foreignAmount = Big(fireflyTransaction.foreign_amount)
      if (fireflyTransaction.foreign_currency_code !== null) transaction.foreignCurrencyCode = fireflyTransaction.foreign_currency_code
      if (fireflyTransaction.category_name !== null) transaction.categoryName = fireflyTransaction.category_name

      this.add(transaction)
      this.originalTransactions.set(transaction.fireflyId, { ...transaction })
    })
  }

  private add (transaction: Transaction): void {
    // Add transaction to transactionsByFireflyId
    const existing = this.transactionsByFireflyId.get(transaction.fireflyId)
    if (existing === undefined) {
      this.transactionsByFireflyId.set(transaction.fireflyId, transaction)
    } else {
      console.error(`Firefly transaction ID ${transaction.fireflyId} duplicated in ${JSON.stringify(existing)} and ${JSON.stringify(transaction)}`)
    }

    // Add transaction to transactionsByAkahuId
    if (transaction.akahuId !== undefined) {
      this.addAkahuId(transaction.akahuId, transaction)
    }
    if (transaction.type === TransactionType.Transfer && transaction.otherAkahuId !== undefined) {
      this.addAkahuId(transaction.otherAkahuId, transaction)
    }
  }

  private addAkahuId (akahuId: string, transaction: Transaction): void {
    const existing = this.transactionsByAkahuId.get(akahuId)
    if (existing === undefined) {
      this.transactionsByAkahuId.set(akahuId, transaction)
    } else {
      console.error(`Akahu transaction ID ${akahuId} duplicated in ${JSON.stringify(existing)} and ${JSON.stringify(transaction)}`)
    }
  }

  private clone (transaction: Transaction | undefined): Transaction | undefined {
    if (transaction === undefined) {
      return undefined
    } else {
      return { ...transaction }
    }
  }

  public getByAkahuId (akahuId: string): Transaction | undefined {
    return this.clone(this.transactionsByAkahuId.get(akahuId))
  }

  public getByFireflyId (fireflyId: number): Transaction | undefined {
    return this.clone(this.transactionsByFireflyId.get(fireflyId))
  }

  // TODO: Implement this properly using the Firefly API
  public save (transaction: Transaction): void {
    // Check if the Firefly ID exists
    const existing = this.transactionsByFireflyId.get(transaction.fireflyId)
    if (existing === undefined) {
      console.error(`Firefly transaction ID ${transaction.fireflyId} doesn't exist`)
      return
    }

    // Remove transaction from transactionsByFireflyId
    this.transactionsByFireflyId.delete(existing.fireflyId)

    // Remove transaction from transactionsByAkahuId
    if (existing.akahuId !== undefined) {
      this.transactionsByAkahuId.delete(existing.akahuId)
    }
    if (existing.type === TransactionType.Transfer && existing.otherAkahuId !== undefined) {
      this.transactionsByAkahuId.delete(existing.otherAkahuId)
    }

    // Re-add transaction
    this.add(transaction)
  }

  // TODO: Implement this properly using the Firefly API
  public create (inputTransaction: Omit<Transaction, 'fireflyId'>): Transaction {
    const fireflyId = Math.max(...this.transactionsByFireflyId.keys()) + 1
    const transaction = inputTransaction as Transaction
    transaction.fireflyId = fireflyId
    this.add(transaction)
    return transaction
  }

  public changes (): void {
    this.transactionsByFireflyId.forEach((b, fireflyId) => {
      const diff = this.compare(this.originalTransactions.get(fireflyId), b)
      if (diff !== null) console.log(diff)
    })
  }

  private compare (a: Transaction | undefined, b: Transaction): Partial<Transaction> | null {
    // Return whole transaction if it is newly created
    if (a === undefined) {
      return b
    }

    const result: any = {}
    let different = false

    // Loop through all properties and compare them
    let key: keyof Transaction
    for (key in b) {
      const aValue = a[key]
      const bValue = b[key]
      let equal: boolean
      if (aValue instanceof Big && bValue instanceof Big) {
        equal = aValue.eq(bValue)
      } else if (aValue instanceof Date && bValue instanceof Date) {
        equal = aValue.getTime() === bValue.getTime()
      } else {
        equal = aValue === bValue
      }
      if (!equal) {
        result[key] = bValue
        different = true
      }
    }

    // Return changed properties or null
    if (different) {
      result.fireflyId = b.fireflyId
      return result as Partial<Transaction>
    } else {
      return null
    }
  }
}
