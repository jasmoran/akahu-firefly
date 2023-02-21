import Big from 'big.js'
import type { Account } from './accounts'
import { Util } from './util'

// List transaction types
export enum TransactionType {
  Withdrawal = 'Withdrawal',
  Deposit = 'Deposit',
  OpeningBalance = 'Opening balance',
  Reconciliation = 'Reconciliation',
  Invalid = 'Invalid',
  LiabilityCredit = 'Liability credit',
  Transfer = 'Transfer'
}

// Export Transaction type
// Transfer transactions must have a second akahuId
export interface Transaction {
  id: number
  type: TransactionType
  fireflyId: number | undefined
  akahuId: string | undefined
  otherAkahuId: string | undefined
  description: string
  date: Date
  amount: Big
  source: Account
  destination: Account
  foreignAmount?: Big
  foreignCurrencyCode?: string
  categoryName?: string
}

export class Transactions {
  private counter = 0
  private readonly transactions: Map<number, Transaction> = new Map()
  private readonly transactionsByFireflyId: Map<number, Transaction> = new Map()
  private readonly transactionsByAkahuId: Map<string, Transaction> = new Map()

  // Track modifications
  private readonly originalTransactions: Map<number, Transaction> = new Map()

  private add (transaction: Transaction): void {
    this.transactions.set(transaction.id, transaction)

    // Add transaction to transactionsByFireflyId
    if (transaction.fireflyId !== undefined) {
      const existing = this.transactionsByFireflyId.get(transaction.fireflyId)
      if (existing === undefined) {
        this.transactionsByFireflyId.set(transaction.fireflyId, transaction)
      } else {
        console.error(`Firefly transaction ID ${transaction.fireflyId} duplicated in ${Util.stringify(existing)} and ${Util.stringify(transaction)}`)
      }
    }

    // Add transaction to transactionsByAkahuId
    if (transaction.akahuId !== undefined) {
      this.addAkahuId(transaction.akahuId, transaction)
    }
    if (transaction.otherAkahuId !== undefined) {
      this.addAkahuId(transaction.otherAkahuId, transaction)
    }
  }

  private addAkahuId (akahuId: string, transaction: Transaction): void {
    const existing = this.transactionsByAkahuId.get(akahuId)
    if (existing === undefined) {
      this.transactionsByAkahuId.set(akahuId, transaction)
    } else {
      console.error(`Akahu transaction ID ${akahuId} duplicated in ${Util.stringify(existing)} and ${Util.stringify(transaction)}`)
    }
  }

  private clone (transaction: Transaction | undefined): Transaction | undefined {
    if (transaction === undefined) {
      return undefined
    } else {
      return { ...transaction }
    }
  }

  public get (id: number): Transaction | undefined {
    return this.clone(this.transactions.get(id))
  }

  public getByAkahuId (akahuId: string): Transaction | undefined {
    return this.clone(this.transactionsByAkahuId.get(akahuId))
  }

  public getByFireflyId (fireflyId: number): Transaction | undefined {
    return this.clone(this.transactionsByFireflyId.get(fireflyId))
  }

  // TODO: Implement this properly using the Firefly API
  public save (transaction: Transaction): void {
    // Check if the ID exists
    const existing = this.transactions.get(transaction.id)
    if (existing === undefined) {
      console.error(`Transaction ID ${transaction.id} doesn't exist`)
      return
    }

    // Remove transaction from transactionsByFireflyId
    if (existing.fireflyId !== undefined) {
      this.transactionsByFireflyId.delete(existing.fireflyId)
    }

    // Remove transaction from transactionsByAkahuId
    if (existing.akahuId !== undefined) {
      this.transactionsByAkahuId.delete(existing.akahuId)
    }
    if (existing.otherAkahuId !== undefined) {
      this.transactionsByAkahuId.delete(existing.otherAkahuId)
    }

    // Re-add transaction
    this.add(transaction)
  }

  // TODO: Implement this properly using the Firefly API
  public create (inputTransaction: Omit<Transaction, 'id'>): Transaction {
    const transaction = inputTransaction as Transaction
    this.counter++
    transaction.id = this.counter
    this.add(transaction)
    return transaction
  }

  public changes (): void {
    this.transactions.forEach((b, id) => {
      const diff = this.compare(this.originalTransactions.get(id), b)
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
      } else if (aValue instanceof Object && bValue instanceof Object && 'id' in aValue && 'id' in bValue) {
        equal = aValue.id === bValue.id
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
      result.id = b.id
      return result as Partial<Transaction>
    } else {
      return null
    }
  }
}
