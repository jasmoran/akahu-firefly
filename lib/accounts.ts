import { compareTwoStrings } from 'string-similarity'
import { Util } from './util'

// List account types
export enum AccountType {
  Asset = 'asset',
  Liability = 'liability',
  Expense = 'expense',
  Revenue = 'revenue'
}

export interface AccountPair {
  source: Account | undefined
  destination: Account | undefined
}

export interface Account {
  id: number
  fireflyId: number | undefined
  akahuId: string | undefined
  name: string
  type: AccountType
  bankNumbers: Set<string>
  alternateNames: Set<string>
}

export class Accounts {
  private counter = 0
  private accounts: Map<number, Account> = new Map()
  private fireflyIdIndex: Map<number, AccountPair> = new Map()
  private akahuIdIndex: Map<string, AccountPair> = new Map()
  private bankNumberIndex: Map<string, AccountPair> = new Map()
  private nameIndex: Map<string, AccountPair> = new Map()

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

  // Find all accounts that match any of the provided identifiers
  private findMatches (account: Account): AccountPair[] {
    const matches: Map<string, AccountPair> = new Map()

    // Uniquely identify AccountPairs using the combination of the source and destination IDs
    const addPair = (pair: AccountPair | undefined): void => {
      if (pair !== undefined) {
        matches.set(`${pair.source?.id ?? ''}~${pair.destination?.id ?? ''}`, pair)
      }
    }

    // Match on account name
    account.alternateNames.forEach(name => {
      addPair(this.nameIndex.get(this.normalizeName(name)))
    })

    // Match on bank numbers
    account.bankNumbers.forEach(bankNumber => {
      addPair(this.bankNumberIndex.get(bankNumber))
    })

    // Match on Akahu ID
    addPair(this.akahuIdIndex.get(account.akahuId ?? ''))

    // Match on Firefly ID
    addPair(this.fireflyIdIndex.get(account.fireflyId ?? 0))

    return [...matches.values()]
  }

  private findPair (account: Account): AccountPair {
    const matches = this.findMatches(account)

    // We must match one account at most
    if (matches.length < 2) {
      let pair = matches[0]

      if (account.type === AccountType.Expense) {
        if (pair === undefined) {
          // Create a new pair if one doesn't exist
          pair = { source: undefined, destination: account }
          return pair
        } else if (pair.destination === undefined) {
          pair.destination = account
          return pair
        }
      } else if (account.type === AccountType.Revenue) {
        if (pair === undefined) {
          // Create a new pair if one doesn't exist
          pair = { source: account, destination: undefined }
          return pair
        } else if (pair.source === undefined) {
          pair.source = account
          return pair
        }
      } else {
        if (pair === undefined) {
          // Create a new pair if one doesn't exist
          pair = { source: account, destination: account }
          return pair
        }
      }
    }

    throw Error(`Account (${Util.stringify(account)}) conflicts with accounts:\n${Util.stringify(matches)}`)
  }

  private index (account: Account): void {
    this.accounts.set(account.id, account)

    // Find a single AccountPair that matches this account
    const pair = this.findPair(account)

    // Add account to fireflyIdIndex
    if (account.fireflyId !== undefined) {
      this.fireflyIdIndex.set(account.fireflyId, pair)
    }

    // Add account to akahuIdIndex
    if (account.akahuId !== undefined) {
      this.akahuIdIndex.set(account.akahuId, pair)
    }

    // Add account to nameIndex (both main and alternate names)
    account.alternateNames.forEach(name => {
      name = this.normalizeName(name)
      this.nameIndex.set(name, pair)
    })

    // Add account to bankNumberIndex
    account.bankNumbers.forEach(bankNumber => {
      this.bankNumberIndex.set(bankNumber, pair)
    })
  }

  private deindex (account: Account): void {
    // Remove account from fireflyIdIndex
    if (account.fireflyId !== undefined) {
      this.fireflyIdIndex.delete(account.fireflyId)
    }

    // Remove account from akahuIdIndex
    if (account.akahuId !== undefined) {
      this.akahuIdIndex.delete(account.akahuId)
    }

    // Remove account from nameIndex
    account.alternateNames.forEach(name => {
      this.nameIndex.delete(this.normalizeName(name))
    })

    // Remove account from bankNumberIndex
    account.bankNumbers.forEach(bankNumber => {
      this.bankNumberIndex.delete(bankNumber)
    })
  }

  private clone (account: Account | undefined): Account | undefined {
    if (account === undefined) {
      return undefined
    } else {
      return { ...account }
    }
  }

  private clonePair (pair: AccountPair | undefined): AccountPair | undefined {
    if (pair === undefined) {
      return undefined
    } else {
      return {
        source: this.clone(pair.source),
        destination: this.clone(pair.destination)
      }
    }
  }

  public get (id: number): Account | undefined {
    return this.clone(this.accounts.get(id))
  }

  public getByAkahuId (akahuId: string): AccountPair | undefined {
    return this.clonePair(this.akahuIdIndex.get(akahuId))
  }

  public getByFireflyId (fireflyId: number): AccountPair | undefined {
    return this.clonePair(this.fireflyIdIndex.get(fireflyId))
  }

  public getByBankNumber (bankNumber: string): AccountPair | undefined {
    const formatted = Accounts.formatBankNumber(bankNumber)
    return this.clonePair(this.bankNumberIndex.get(formatted))
  }

  private normalizeName (name: string): string {
    return name.normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim()
  }

  public getByName (name: string): AccountPair | undefined {
    return this.clonePair(this.nameIndex.get(this.normalizeName(name)))
  }

  public getByNameFuzzy (source: string): [AccountPair, number] {
    let bestMatch
    let bestRating = 0

    // Do a case-insensitive compare by lowering case
    source = this.normalizeName(source)

    // Loop through all name-account pairs and find the best match
    for (const [name, pair] of this.nameIndex.entries()) {
      const rating = compareTwoStrings(source, name)
      if (rating > bestRating) {
        bestMatch = pair
        bestRating = rating
      }
    }

    bestMatch = this.clonePair(bestMatch)

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

    // De-index account
    this.deindex(existing)

    // Re-index account
    this.index(account)
  }

  public create (inputAccount: Omit<Account, 'id'>): Account {
    const account = inputAccount as Account
    this.counter++
    account.id = this.counter
    this.index(account)
    return account
  }

  public duplicate (): Accounts {
    const newAccounts = new Accounts()
    newAccounts.counter = this.counter
    newAccounts.accounts = this.accounts
    newAccounts.fireflyIdIndex = this.fireflyIdIndex
    newAccounts.akahuIdIndex = this.akahuIdIndex
    newAccounts.bankNumberIndex = this.bankNumberIndex
    newAccounts.nameIndex = this.nameIndex
    return newAccounts
  }

  public changes (other: Accounts): void {
    this.accounts.forEach((b, id) => {
      const diff = this.compare(other.get(id), b)
      if (diff !== null) console.log(diff)
    })
  }

  private compare (a: Account | undefined, b: Account): Partial<Account> | null {
    // Return whole account if it is newly created
    if (a === undefined) {
      return b
    }

    const result: any = {}
    let different = false

    // Loop through all properties and compare them
    let key: keyof Account
    for (key in b) {
      const aValue = a[key]
      const bValue = b[key]
      if (aValue !== bValue) {
        result[key] = bValue
        different = true
      }
    }

    // Return changed properties or null
    if (different) {
      result.fireflyId = b.fireflyId
      return result as Partial<Account>
    } else {
      return null
    }
  }
}
