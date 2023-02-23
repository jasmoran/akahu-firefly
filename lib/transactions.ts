import Big from 'big.js'
import { compareTwoStrings } from 'string-similarity'
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
  akahuIds: Set<string>
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
  private static counter = 0
  private transactions: Map<number, Transaction> = new Map()
  private fireflyIdIndex: Map<number, Transaction> = new Map()
  private akahuIdIndex: Map<string, Transaction> = new Map()

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
    transaction.akahuIds.forEach(akahuId => {
      const existing = this.akahuIdIndex.get(akahuId)
      if (existing === undefined) {
        this.akahuIdIndex.set(akahuId, transaction)
      } else {
        console.error(`Akahu transaction ID ${akahuId} duplicated in ${Util.stringify(existing)} and ${Util.stringify(transaction)}`)
      }
    })
  }

  private deindex (transaction: Transaction): void {
    // Remove transaction from fireflyIdIndex
    if (transaction.fireflyId !== undefined) {
      this.fireflyIdIndex.delete(transaction.fireflyId)
    }

    // Remove transaction from akahuIdIndex
    transaction.akahuIds.forEach(akahuId => {
      this.akahuIdIndex.delete(akahuId)
    })
  }

  private clone (transaction: Transaction): Transaction {
    const clone = { ...transaction }
    clone.akahuIds = new Set(clone.akahuIds)
    clone.date = new Date(clone.date)
    clone.amount = new Big(clone.amount)
    if ('foreignAmount' in clone) clone.foreignAmount = new Big(clone.foreignAmount)
    return clone
  }

  public get (id: number): Transaction | undefined {
    const res = this.transactions.get(id)
    return res === undefined ? undefined : this.clone(res)
  }

  public getByAkahuId (akahuId: string): Transaction | undefined {
    const res = this.akahuIdIndex.get(akahuId)
    return res === undefined ? undefined : this.clone(res)
  }

  public getByFireflyId (fireflyId: number): Transaction | undefined {
    const res = this.fireflyIdIndex.get(fireflyId)
    return res === undefined ? undefined : this.clone(res)
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
    if (transaction.id === undefined) {
      Transactions.counter++
      transaction.id = Transactions.counter
    }
    this.index(transaction)
    return transaction
  }

  public duplicate (): Transactions {
    const newTransactions = new Transactions()

    // Clone all transactions
    newTransactions.transactions = new Map([...this.transactions].map(([id, trans]) => [id, this.clone(trans)]))

    // Rebuild indexes using cloned transactions
    newTransactions.fireflyIdIndex = new Map(
      [...this.fireflyIdIndex].map(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ([id, trans]) => [id, newTransactions.transactions.get(trans.id)!]
      )
    )
    newTransactions.akahuIdIndex = new Map(
      [...this.akahuIdIndex].map(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ([id, trans]) => [id, newTransactions.transactions.get(trans.id)!]
      )
    )

    return newTransactions
  }

  public changes (other: Transactions): void {
    this.transactions.forEach((b, id) => {
      const diff = this.compare(other.get(id), b)
      if (diff !== null) console.log(diff)
    })
  }

  private compare (a: Transaction | undefined, b: Transaction): [Partial<Transaction>, Partial<Transaction>] | null {
    // Return whole transaction if it is newly created
    if (a === undefined) {
      return [{}, b]
    }

    const left: Partial<Transaction> = {}
    const right: Partial<Transaction> = {}
    let different = false

    if (a.type !== b.type) {
      left.type = a.type
      right.type = b.type
      different = true
    }
    if (a.fireflyId !== b.fireflyId) {
      left.fireflyId = a.fireflyId
      right.fireflyId = b.fireflyId
      different = true
    }
    if ([...a.akahuIds].sort().join(',') !== [...b.akahuIds].sort().join(',')) {
      left.akahuIds = a.akahuIds
      right.akahuIds = b.akahuIds
      different = true
    }
    if (a.description !== b.description) {
      left.description = a.description
      right.description = b.description
      different = true
    }
    if (a.date.getTime() !== b.date.getTime()) {
      left.date = a.date
      right.date = b.date
      different = true
    }
    if (!a.amount.eq(b.amount)) {
      left.amount = a.amount
      right.amount = b.amount
      different = true
    }
    if (a.source.id !== b.source.id) {
      left.source = a.source
      right.source = b.source
      different = true
    }
    if (a.destination.id !== b.destination.id) {
      left.destination = a.destination
      right.destination = b.destination
      different = true
    }
    if ((a.foreignAmount === undefined && b.foreignAmount !== undefined) ||
      (a.foreignAmount !== undefined && b.foreignAmount === undefined) ||
      (a.foreignAmount !== undefined && b.foreignAmount !== undefined && !a.foreignAmount.eq(b.foreignAmount))) {
      if ('foreignAmount' in a) left.foreignAmount = a.foreignAmount
      if ('foreignAmount' in b) right.foreignAmount = b.foreignAmount
      different = true
    }
    if (a.foreignCurrencyCode !== b.foreignCurrencyCode) {
      if ('foreignCurrencyCode' in a) left.foreignCurrencyCode = a.foreignCurrencyCode
      if ('foreignCurrencyCode' in b) right.foreignCurrencyCode = b.foreignCurrencyCode
      different = true
    }
    if (a.categoryName !== b.categoryName) {
      if ('categoryName' in a) left.categoryName = a.categoryName
      if ('categoryName' in b) right.categoryName = b.categoryName
      different = true
    }

    // Return changed properties or null
    if (different) {
      left.id = a.id
      right.id = b.id
      return [left, right]
    } else {
      return null
    }
  }

  private findBestTransaction (transaction: Transaction, transactions: Transaction[]): Transaction | undefined {
    // Find transactions with the same source, destination and amount
    const matches = transactions.filter(other => {
      // Check firefly IDs match
      if (transaction.fireflyId !== undefined && other.fireflyId !== undefined && transaction.fireflyId !== other.fireflyId) {
        return false
      }

      // Check foreign amount details match
      if ('foreignAmount' in transaction && 'foreignAmount' in other && !transaction.foreignAmount.eq(other.foreignAmount)) {
        return false
      }
      if ('foreignCurrencyCode' in transaction && 'foreignCurrencyCode' in other && transaction.foreignCurrencyCode !== other.foreignCurrencyCode) {
        return false
      }

      return transaction.type === other.type &&
        transaction.source.id === other.source.id &&
        transaction.destination.id === other.destination.id &&
        transaction.amount.eq(other.amount)
    })

    type Similarities = Array<{
      date: number
      description: number
      transaction: Transaction
    }>

    // Calculate similarity of date and description for each match
    const similarities: Similarities = matches.map(other => ({
      date: Math.abs(transaction.date.getTime() - other.date.getTime()), // Similarity to target date
      description: compareTwoStrings(transaction.description, other.description), // Similarity to target description
      transaction: other
    }))

    // Sort by date and then description
    similarities.sort((a, b) => {
      const dateCompare = a.date - b.date
      if (dateCompare !== 0) {
        return dateCompare
      } else {
        return a.description - b.description
      }
    })

    // Return best match
    return similarities[0]?.transaction
  }

  /**
   * Populate missing details in transaction a with details from transaction
   */
  private mergeTransactions (a: Transaction, b: Transaction): void {
    // Update transaction a from transaction b
    a.fireflyId ??= b.fireflyId
    a.akahuIds = new Set([...a.akahuIds, ...b.akahuIds])
    a.description = `${a.description} - ${b.description}`
    a.date ??= b.date
    if ('foreignAmount' in b) a.foreignAmount ??= b.foreignAmount
    if ('foreignCurrencyCode' in b) a.foreignCurrencyCode ??= b.foreignCurrencyCode
    if ('categoryName' in b) a.categoryName ??= b.categoryName

    // Use transaction B's date if it has the transaction time set
    if (b.date.getMinutes() !== 0 || b.date.getHours() !== 0) {
      a.date = b.date
    }
  }

  /**
   * Merges transactions from `other` into this Transactions instance
   *
   * De-duplicates transactions
   *
   * @param other Other set of transactions
   * @returns {Object} Lists of transactions that are unique to the left and right hand sides of the merge
   */
  public merge (other: Transactions): { left: Map<number, Transaction>, right: Map<number, Transaction> } {
    // Clone transaction maps
    const left: Map<number, Transaction> = new Map(this.transactions)
    const right: Map<number, Transaction> = new Map(other.transactions)

    // Look for transactions in left that match transactions in `other`
    left.forEach(transaction => {
      // Find the best matching transaction
      const match = this.findBestTransaction(transaction, [...right.values()])

      // Merge the two transactions if a match was found
      if (match !== undefined) {
        // Remove matched transactions
        left.delete(transaction.id)
        right.delete(match.id)

        // Merged transactions
        this.mergeTransactions(transaction, match)
        this.save(transaction)
      }
    })

    // Look for transactions in `other` that match transactions in left
    right.forEach(transaction => {
      // Find the best matching transaction
      const match = this.findBestTransaction(transaction, [...left.values()])

      if (match === undefined) {
        // Add transactions that are only in `other`
        this.create(transaction)
      } else {
        // Remove matched transactions
        left.delete(match.id)
        right.delete(transaction.id)

        // Merged transactions
        this.mergeTransactions(match, transaction)
        this.save(match)
      }
    })

    return { left, right }
  }
}
