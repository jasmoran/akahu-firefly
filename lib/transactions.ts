import Big from 'big.js'
import { compareTwoStrings } from 'string-similarity'
import { Util } from './util'

export class Transactions implements Iterable<Transactions.Transaction> {
  private static counter = 0
  private transactions: Map<number, Transactions.Transaction> = new Map()
  private fireflyIdIndex: Map<number, Transactions.Transaction> = new Map()
  private akahuIdIndex: Map<string, Transactions.Transaction> = new Map()

  private index (transaction: Transactions.Transaction): void {
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

  private deindex (transaction: Transactions.Transaction): void {
    // Remove transaction from fireflyIdIndex
    if (transaction.fireflyId !== undefined) {
      this.fireflyIdIndex.delete(transaction.fireflyId)
    }

    // Remove transaction from akahuIdIndex
    transaction.akahuIds.forEach(akahuId => {
      this.akahuIdIndex.delete(akahuId)
    })
  }

  private clone (transaction: Transactions.Transaction): Transactions.Transaction {
    const clone = { ...transaction }
    clone.akahuIds = new Set(clone.akahuIds)
    clone.date = new Date(clone.date)
    clone.amount = new Big(clone.amount)
    if ('foreignAmount' in clone) clone.foreignAmount = new Big(clone.foreignAmount)
    return clone
  }

  public get (id: number): Transactions.Transaction | undefined {
    const res = this.transactions.get(id)
    return res === undefined ? undefined : this.clone(res)
  }

  public getByAkahuId (akahuId: string): Transactions.Transaction | undefined {
    const res = this.akahuIdIndex.get(akahuId)
    return res === undefined ? undefined : this.clone(res)
  }

  public getByFireflyId (fireflyId: number): Transactions.Transaction | undefined {
    const res = this.fireflyIdIndex.get(fireflyId)
    return res === undefined ? undefined : this.clone(res)
  }

  public save (transaction: Transactions.Transaction): void {
    // Check if the ID exists
    const existing = this.transactions.get(transaction.id)
    if (existing === undefined) {
      console.error(`Transaction ID ${transaction.id} doesn't exist`)
      return
    }

    // Deny changes to Firefly or Akahu IDs
    if (existing.fireflyId !== undefined && existing.fireflyId !== transaction.fireflyId) {
      throw Error(`Cannot change Firefly ID once it has been set. ${existing.fireflyId} -> ${transaction.fireflyId ?? 'undefined'}`)
    }
    for (const akahuId of existing.akahuIds) {
      if (!transaction.akahuIds.has(akahuId)) {
        throw Error(`Cannot remove Akahu IDs once they have been added. ${akahuId}`)
      }
    }

    // De-index transaction
    this.deindex(existing)

    // Re-index transaction
    this.index(transaction)
  }

  public create (inputTransaction: Omit<Transactions.Transaction, 'id'>): Transactions.Transaction {
    const transaction = inputTransaction as Transactions.Transaction
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

  private findBestTransaction (
    transaction: Transactions.Transaction,
    transactions: Transactions.Transaction[],
    compare: (a: Transactions.Transaction, b: Transactions.Transaction) => boolean
  ): Transactions.Transaction | undefined {
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

      return transaction.sourceId === other.sourceId &&
        transaction.destinationId === other.destinationId &&
        transaction.amount.eq(other.amount) &&
        compare(transaction, other)
    })

    // Return early if there are 0 or 1 matches
    if (matches.length < 2) return matches[0]

    type Similarities = Array<{
      date: number
      description: number
      transaction: Transactions.Transaction
    }>

    // Calculate similarity of date and description for each match
    const similarities: Similarities = matches.map(other => ({
      date: Math.abs(transaction.date.getTime() - other.date.getTime()), // Similarity to target date
      description: compareTwoStrings(transaction.description, other.description), // Similarity to target description
      transaction: other
    })).filter(x => x.date < 3 * 24 * 60 * 60 * 1000) // Ensure transaction is within 3 days of target

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
  private mergeTransactions (a: Transactions.Transaction, b: Transactions.Transaction): void {
    // Update transaction a from transaction b
    a.fireflyId ??= b.fireflyId
    a.akahuIds = new Set([...a.akahuIds, ...b.akahuIds])
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
  public merge (
    other: Transactions,
    compare: (a: Transactions.Transaction, b: Transactions.Transaction) => boolean = _ => true,
    merge: (a: Transactions.Transaction, b: Transactions.Transaction) => void = _ => _
  ): { left: Map<number, Transactions.Transaction>, right: Map<number, Transactions.Transaction> } {
    // Clone transaction maps
    const left: Map<number, Transactions.Transaction> = new Map(this.transactions)
    const right: Map<number, Transactions.Transaction> = new Map(other.transactions)

    // Look for transactions in left that match transactions in `other`
    left.forEach(transaction => {
      // Find the best matching transaction
      const match = this.findBestTransaction(transaction, [...right.values()], compare)

      // Merge the two transactions if a match was found
      if (match !== undefined) {
        // Remove matched transactions
        left.delete(transaction.id)
        right.delete(match.id)

        // Merged transactions
        this.mergeTransactions(transaction, match)
        merge(transaction, match)
        this.save(transaction)
      }
    })

    // Look for transactions in `other` that match transactions in left
    right.forEach(transaction => {
      // Find the best matching transaction
      const match = this.findBestTransaction(transaction, [...left.values()], compare)

      if (match === undefined) {
        // Add transactions that are only in `other`
        this.create(transaction)
      } else {
        // Remove matched transactions
        left.delete(match.id)
        right.delete(transaction.id)

        // Merged transactions
        this.mergeTransactions(match, transaction)
        merge(match, transaction)
        this.save(match)
      }
    })

    return { left, right }
  }

  public * [Symbol.iterator] (): Iterator<Transactions.Transaction> {
    for (const account of this.transactions.values()) {
      yield this.clone(account)
    }
  }
}

export namespace Transactions {
  // Export Transaction type
  // Transfer transactions must have a second akahuId
  export interface Transaction {
    id: number
    fireflyId: number | undefined
    akahuIds: Set<string>
    description: string
    date: Date
    amount: Big
    sourceId: number
    destinationId: number
    foreignAmount?: Big
    foreignCurrencyCode?: string
    categoryName?: string
  }
}