import { compareTwoStrings } from 'string-similarity'
import { Util } from './util'

// List account types
export enum AccountType {
  Asset = 'asset',
  Liability = 'liability',
  Expense = 'expense',
  Revenue = 'revenue'
}

export interface Account {
  id: number
  source?: {
    fireflyId?: number
    type: AccountType
    notes?: string | undefined
  } | undefined
  destination?: {
    fireflyId?: number
    type: AccountType
    notes?: string | undefined
  } | undefined
  akahuId: string | undefined
  name: string
  bankNumbers: Set<string>
  alternateNames: Map<string, string>
}

type AccountChanges = {
  [P in keyof Account]?: Account[P]
} & {
  id: number
}

export class Accounts implements Iterable<Account> {
  private static counter = 0
  private readonly accounts: Map<number, Account> = new Map()
  private readonly fireflyIdIndex: Map<number, Account> = new Map()
  private readonly akahuIdIndex: Map<string, Account> = new Map()
  private readonly bankNumberIndex: Map<string, Account> = new Map()
  private readonly nameIndex: Map<string, Account> = new Map()

  // Formats a bank account string:
  // 2 digit Bank Number
  // 4 digit Branch Number
  // 7 digit Account Body
  // 3 digit Account Suffix
  public static formatBankNumber (bankNumber: string): string {
    const lengths = [2, 4, 7, 3]
    return bankNumber
      .split('-')
      .map((part, ix) => parseInt(part).toString().padStart(lengths[ix] ?? 0, '0'))
      .join('-')
  }

  private index (account: Account): void {
    this.accounts.set(account.id, account)

    // Add account to fireflyIdIndex
    if (account.source?.fireflyId !== undefined) {
      const existing = this.fireflyIdIndex.get(account.source?.fireflyId)
      if (existing === undefined) {
        this.fireflyIdIndex.set(account.source?.fireflyId, account)
      } else {
        console.error(`Firefly account ID ${account.source?.fireflyId} duplicated in ${Util.stringify(existing)} and ${Util.stringify(account)}`)
      }
    }
    if (account.source?.fireflyId !== account.destination?.fireflyId && account.destination?.fireflyId !== undefined) {
      const existing = this.fireflyIdIndex.get(account.destination?.fireflyId)
      if (existing === undefined) {
        this.fireflyIdIndex.set(account.destination?.fireflyId, account)
      } else {
        console.error(`Firefly account ID ${account.destination?.fireflyId} duplicated in ${Util.stringify(existing)} and ${Util.stringify(account)}`)
      }
    }

    // Add account to akahuIdIndex
    if (account.akahuId !== undefined) {
      const existing = this.akahuIdIndex.get(account.akahuId)
      if (existing === undefined) {
        this.akahuIdIndex.set(account.akahuId, account)
      } else {
        console.error(`Akahu transaction ID ${account.akahuId} duplicated in ${Util.stringify(existing)} and ${Util.stringify(account)}`)
      }
    }

    // Add account to nameIndex (both main and alternate names)
    account.alternateNames.forEach((name, normName) => {
      const existing = this.nameIndex.get(normName)
      if (existing === undefined) {
        this.nameIndex.set(normName, account)
      } else {
        console.error(`Transaction name ${name} duplicated in ${Util.stringify(existing)} and ${Util.stringify(account)}`)
      }
    })

    // Add account to bankNumberIndex
    account.bankNumbers.forEach(bankNumber => {
      const existing = this.bankNumberIndex.get(bankNumber)
      if (existing === undefined) {
        this.bankNumberIndex.set(bankNumber, account)
      } else {
        console.error(`Bank account number ${bankNumber} duplicated in ${Util.stringify(existing)} and ${Util.stringify(account)}`)
      }
    })
  }

  private deindex (account: Account): void {
    // Remove account from fireflyIdIndex
    if (account.source?.fireflyId !== undefined) {
      this.fireflyIdIndex.delete(account.source?.fireflyId)
    }
    if (account.destination?.fireflyId !== undefined) {
      this.fireflyIdIndex.delete(account.destination?.fireflyId)
    }

    // Remove account from akahuIdIndex
    if (account.akahuId !== undefined) {
      this.akahuIdIndex.delete(account.akahuId)
    }

    // Remove account from nameIndex
    for (const normName of account.alternateNames.keys()) {
      this.nameIndex.delete(normName)
    }

    // Remove account from bankNumberIndex
    account.bankNumbers.forEach(bankNumber => {
      this.bankNumberIndex.delete(bankNumber)
    })
  }

  private clone (account: Account): Account {
    const clone = { ...account }
    clone.bankNumbers = new Set(clone.bankNumbers)
    clone.alternateNames = new Map(clone.alternateNames)
    return clone
  }

  public get (id: number): Account | undefined {
    const res = this.accounts.get(id)
    return res === undefined ? undefined : this.clone(res)
  }

  public getByAkahuId (akahuId: string): Account | undefined {
    const res = this.akahuIdIndex.get(akahuId)
    return res === undefined ? undefined : this.clone(res)
  }

  public getByFireflyId (fireflyId: number): Account | undefined {
    const res = this.fireflyIdIndex.get(fireflyId)
    return res === undefined ? undefined : this.clone(res)
  }

  public getByBankNumber (bankNumber: string): Account | undefined {
    const formatted = Accounts.formatBankNumber(bankNumber)
    const res = this.bankNumberIndex.get(formatted)
    return res === undefined ? undefined : this.clone(res)
  }

  public static normalizeName (name: string): string {
    return name.normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim()
  }

  public getByName (name: string): Account | undefined {
    const res = this.nameIndex.get(Accounts.normalizeName(name))
    return res === undefined ? undefined : this.clone(res)
  }

  public getByNameFuzzy (source: string): [Account, number] {
    let bestMatch
    let bestRating = 0

    // Do a case-insensitive compare by lowering case
    source = Accounts.normalizeName(source)

    // Loop through all name-account pairs and find the best match
    for (const [name, account] of this.nameIndex.entries()) {
      const rating = compareTwoStrings(source, name)
      if (rating > bestRating) {
        bestMatch = account
        bestRating = rating
      }
    }

    bestMatch = bestMatch === undefined ? undefined : this.clone(bestMatch)

    if (bestMatch === undefined) throw Error(`Could not find an account name to match ${source}`)

    return [bestMatch, bestRating]
  }

  public save (account: Account): void {
    // Check if the ID exists
    const existing = this.accounts.get(account.id)
    if (existing === undefined) {
      console.error(`Account ID ${account.id} doesn't exist`)
      return
    }

    // Deny changes to Firefly or Akahu IDs
    if (existing.source?.fireflyId !== undefined && existing.source.fireflyId !== account.source?.fireflyId) {
      throw Error(`Cannot change source Firefly ID once it has been set. ${existing.source.fireflyId} -> ${account.source?.fireflyId ?? 'undefined'}`)
    }
    if (existing.destination?.fireflyId !== undefined && existing.destination.fireflyId !== account.destination?.fireflyId) {
      throw Error(`Cannot change destination Firefly ID once it has been set. ${existing.destination.fireflyId} -> ${account.destination?.fireflyId ?? 'undefined'}`)
    }
    if (existing.akahuId !== undefined && existing.akahuId !== account.akahuId) {
      throw Error(`Cannot change Akahu ID once it has been set. ${existing.akahuId} -> ${account.akahuId ?? 'undefined'}`)
    }

    // De-index account
    this.deindex(existing)

    // Re-index account
    this.index(account)
  }

  public create (inputAccount: Omit<Account, 'id'>): Account {
    const account = inputAccount as Account
    Accounts.counter++
    account.id = Accounts.counter
    this.index(account)
    return account
  }

  public duplicate (): Accounts {
    const newAccounts = new Accounts()
    for (const account of this.accounts.values()) {
      newAccounts.index(this.clone(account))
    }
    return newAccounts
  }

  public changes (other: Accounts): Array<[Partial<Account>, AccountChanges]> {
    const changes: Array<[Partial<Account>, AccountChanges]> = []
    this.accounts.forEach((b, id) => {
      const diff = this.compare(other.get(id), b)
      if (diff !== null) changes.push(diff)
    })
    return changes
  }

  private compare (a: Account | undefined, b: Account): [Partial<Account>, AccountChanges] | null {
    // Return whole account if it is newly created
    if (a === undefined) {
      return [{}, b]
    }

    const left: Partial<Account> = {}
    const right: Partial<Account> = {}
    let different = false

    if (Util.stringify(a.source) !== Util.stringify(b.source)) {
      left.source = a.source
      right.source = b.source
      different = true
    }
    if (Util.stringify(a.destination) !== Util.stringify(b.destination)) {
      left.destination = a.destination
      right.destination = b.destination
      different = true
    }
    if (a.akahuId !== b.akahuId) {
      left.akahuId = a.akahuId
      right.akahuId = b.akahuId
      different = true
    }
    if (a.name !== b.name) {
      left.name = a.name
      right.name = b.name
      different = true
    }
    if ([...a.bankNumbers].sort().join(',') !== [...b.bankNumbers].sort().join(',')) {
      left.bankNumbers = a.bankNumbers
      right.bankNumbers = b.bankNumbers
      different = true
    }
    if ([...a.alternateNames.values()].sort().join(',') !== [...b.alternateNames.values()].sort().join(',')) {
      left.alternateNames = a.alternateNames
      right.alternateNames = b.alternateNames
      different = true
    }

    // Return changed properties or null
    if (different) {
      return [
        { ...left, id: a.id },
        { ...right, id: b.id }
      ]
    } else {
      return null
    }
  }

  public * [Symbol.iterator] (): Iterator<Account> {
    for (const account of this.accounts.values()) {
      yield this.clone(account)
    }
  }
}
