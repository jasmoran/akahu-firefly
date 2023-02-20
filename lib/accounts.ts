import { compareTwoStrings } from 'string-similarity'

// List account types
export enum AccountType {
  Asset = 'asset',
  Liability = 'liability',
  Expense = 'expense',
  Revenue = 'revenue'
}

type AccountSet = { [K in AccountType]?: Account | undefined }

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
  private fireflyIdIndex: Map<number, Account> = new Map()
  private akahuIdIndex: Map<string, AccountSet> = new Map()
  private bankNumberIndex: Map<string, AccountSet> = new Map()
  private nameIndex: Map<string, AccountSet> = new Map()

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

    // Add account to accountsByFireflyId
    if (account.fireflyId !== undefined) {
      const existing = this.fireflyIdIndex.get(account.fireflyId)
      if (existing === undefined) {
        this.fireflyIdIndex.set(account.fireflyId, account)
      } else {
        console.error(`Firefly account ID ${account.fireflyId} duplicated in ${JSON.stringify(existing)} and ${JSON.stringify(account)}`)
      }
    }

    // Add account to accountsByAkahuId
    if (account.akahuId !== undefined) {
      const set = this.akahuIdIndex.get(account.akahuId) ?? {}
      if (set[account.type] === undefined) {
        set[account.type] = account
        this.akahuIdIndex.set(account.akahuId, set)
      } else {
        console.error(`Akahu account ID ${account.akahuId} duplicated in ${JSON.stringify(set)} and ${JSON.stringify(account)}`)
      }
    }

    // Add account to accountsByName (both main and alternate names)
    account.alternateNames.forEach(name => {
      name = this.normalizeName(name)
      const set = this.nameIndex.get(name) ?? {}
      if (set[account.type] === undefined) {
        set[account.type] = account
        this.nameIndex.set(name, set)
      } else {
        console.error(`Account name ${name} duplicated in ${JSON.stringify(set)} and ${JSON.stringify(account)}`)
      }
    })

    // Add account to accountsByBankNumber
    account.bankNumbers.forEach(bankNumber => {
      const set = this.bankNumberIndex.get(bankNumber) ?? {}
      if (set[account.type] === undefined) {
        set[account.type] = account
        this.bankNumberIndex.set(bankNumber, set)
      } else {
        console.error(`Bank account number ${bankNumber} duplicated in ${JSON.stringify(set)} and ${JSON.stringify(account)}`)
      }
    })
  }

  private deindex (account: Account): void {
    // Remove account from accountsByFireflyId
    if (account.fireflyId !== undefined) {
      this.fireflyIdIndex.delete(account.fireflyId)
    }

    // Remove account from accountsByAkahuId
    if (account.akahuId !== undefined) {
      this.akahuIdIndex.delete(account.akahuId)
    }

    // Remove account from accountsByName
    account.alternateNames.forEach(name => {
      this.nameIndex.delete(this.normalizeName(name))
    })

    // Remove account from accountsByBankNumber
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

  private cloneSet (set: AccountSet | undefined): AccountSet | undefined {
    if (set === undefined) {
      return undefined
    } else {
      return {
        [AccountType.Asset]: this.clone(set[AccountType.Asset]),
        [AccountType.Liability]: this.clone(set[AccountType.Liability]),
        [AccountType.Expense]: this.clone(set[AccountType.Expense]),
        [AccountType.Revenue]: this.clone(set[AccountType.Revenue])
      }
    }
  }

  public get (id: number): Account | undefined {
    return this.clone(this.accounts.get(id))
  }

  public getByAkahuId (akahuId: string): AccountSet | undefined {
    return this.cloneSet(this.akahuIdIndex.get(akahuId))
  }

  public getByFireflyId (fireflyId: number): Account | undefined {
    return this.clone(this.fireflyIdIndex.get(fireflyId))
  }

  public getByBankNumber (bankNumber: string): AccountSet | undefined {
    const formatted = Accounts.formatBankNumber(bankNumber)
    return this.cloneSet(this.bankNumberIndex.get(formatted))
  }

  private normalizeName (name: string): string {
    return name.normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim()
  }

  public getByName (name: string): AccountSet | undefined {
    return this.cloneSet(this.nameIndex.get(this.normalizeName(name)))
  }

  public getByNameFuzzy (source: string): [AccountSet | undefined, number] {
    let bestMatch
    let bestRating = 0

    // Do a case-insensitive compare by lowering case
    source = this.normalizeName(source)

    // Loop through all name-account pairs and find the best match
    for (const [name, set] of this.nameIndex.entries()) {
      const rating = compareTwoStrings(source, name)
      if (rating > bestRating) {
        bestMatch = set
        bestRating = rating
      }
    }

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
    account.id = this.counter
    this.counter++
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
