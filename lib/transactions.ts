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
  private readonly fireflyIdIndex: Map<number, Transaction> = new Map()
  private readonly akahuIdIndex: Map<string, Transaction> = new Map()

  // Track modifications
  private readonly originalTransactions: Map<number, Transaction> = new Map()

  private index (transaction: Transaction): void {
    this.transactions.set(transaction.id, transaction)

    // Add transaction to fireflyIdIndex
    if (transaction.fireflyId !== undefined) {
      const existing = this.fireflyIdIndex.get(transaction.fireflyId)
      if (existing === undefined) {
        this.fireflyIdIndex.set(transaction.fireflyId, transaction)
      } else {
        console.error(`Firefly transaction ID ${transaction.fireflyId} duplicated in ${Util.stringify(existing)} and ${Util.stringify(transaction)}`)
      }
    }

    // Add transaction to akahuIdIndex
    if (transaction.akahuId !== undefined) {
      this.addAkahuId(transaction.akahuId, transaction)
    }
    if (transaction.otherAkahuId !== undefined) {
      this.addAkahuId(transaction.otherAkahuId, transaction)
    }
  }

  private deindex (transaction: Transaction): void {
    // Remove transaction from fireflyIdIndex
    if (transaction.fireflyId !== undefined) {
      this.fireflyIdIndex.delete(transaction.fireflyId)
    }

    // Remove transaction from akahuIdIndex
    if (transaction.akahuId !== undefined) {
      this.akahuIdIndex.delete(transaction.akahuId)
    }
    if (transaction.otherAkahuId !== undefined) {
      this.akahuIdIndex.delete(transaction.otherAkahuId)
    }
  }

  private addAkahuId (akahuId: string, transaction: Transaction): void {
    const existing = this.akahuIdIndex.get(akahuId)
    if (existing === undefined) {
      this.akahuIdIndex.set(akahuId, transaction)
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
    return this.clone(this.akahuIdIndex.get(akahuId))
  }

  public getByFireflyId (fireflyId: number): Transaction | undefined {
    return this.clone(this.fireflyIdIndex.get(fireflyId))
  }

  public save (transaction: Transaction): void {
    // Check if the ID exists
    const existing = this.transactions.get(transaction.id)
    if (existing === undefined) {
      console.error(`Transaction ID ${transaction.id} doesn't exist`)
      return
    }

    // De-index transaction
    this.deindex(existing)

    // Re-index transaction
    this.index(transaction)
  }

  public create (inputTransaction: Omit<Transaction, 'id'>): Transaction {
    const transaction = inputTransaction as Transaction
    this.counter++
    transaction.id = this.counter
    this.index(transaction)
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
