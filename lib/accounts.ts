import * as firefly from './firefly'

// List account types
export enum AccountType {
  Asset = 'asset',
  Liability = 'liability',
  Expense = 'expense',
  Revenue = 'revenue'
}

type AccountSet = { [K in AccountType]?: Account | undefined }

// Map Firefly account types to Asset, Liability, Expense and Revenue
// Ignore type accounts will be discarded
const TypeMapping: { [K in firefly.AccountType]?: AccountType } = {
  [firefly.AccountType.Default]: AccountType.Asset,
  [firefly.AccountType.Cash]: AccountType.Asset,
  [firefly.AccountType.Asset]: AccountType.Asset,
  [firefly.AccountType.Expense]: AccountType.Expense,
  [firefly.AccountType.Revenue]: AccountType.Revenue,
  [firefly.AccountType.Loan]: AccountType.Liability,
  [firefly.AccountType.Debt]: AccountType.Liability,
  [firefly.AccountType.Mortgage]: AccountType.Liability,
  [firefly.AccountType.LiabilityCredit]: AccountType.Liability
}

export interface Account {
  fireflyId: number
  akahuId: string | undefined
  name: string
  type: AccountType
  bankNumbers: Set<string>
}

export class Accounts {
  private readonly accountsByFireflyId: Map<number, Account> = new Map()
  private readonly accountsByAkahuId: Map<string, AccountSet> = new Map()
  private readonly accountsByBankNumber: Map<string, AccountSet> = new Map()

  // Track modifications
  private readonly originalAccounts: Map<number, Account> = new Map()

  // Formats a bank account string:
  // 2 digit Bank Number
  // 4 digit Branch Number
  // 7 digit Account Body
  // 3 digit Account Suffix
  private formatBankNumber (bankNumber: string): string {
    const lengths = [2, 4, 7, 3]
    return bankNumber
      .split('-')
      .map((part, ix) => parseInt(part).toString().padStart(lengths[ix] ?? 0, '0'))
      .join('-')
  }

  public async importFromFirefly (): Promise<void> {
    const fireflyAccounts = await firefly.accounts()

    // Process each Firefly account
    fireflyAccounts.forEach(fireflyAccount => {
      // Fetch account type
      const accountType = TypeMapping[fireflyAccount.type]
      if (accountType === undefined) return

      // Fetch Akahu ID
      let akahuId
      const externalId = fireflyAccount.external_id ?? fireflyAccount.iban
      if (externalId !== null && /^(acc|merchant)_/.test(externalId)) {
        akahuId = externalId
      }

      // Create Account from Firefly data
      const account: Account = {
        fireflyId: fireflyAccount.id,
        akahuId,
        name: fireflyAccount.name,
        type: accountType,
        bankNumbers: new Set()
      }

      // Add bank account numbers
      if (fireflyAccount.account_number !== null) {
        const numbers = fireflyAccount.account_number.split(',')
        numbers.forEach(number => {
          if (/^\d+-\d+-\d+-\d+$/.test(number)) {
            account.bankNumbers.add(this.formatBankNumber(number))
          }
        })
      }

      this.add(account)
      this.originalAccounts.set(account.fireflyId, { ...account })
    })
  }

  private add (account: Account): void {
    // Add account to accountsByFireflyId
    const existing = this.accountsByFireflyId.get(account.fireflyId)
    if (existing === undefined) {
      this.accountsByFireflyId.set(account.fireflyId, account)
    } else {
      console.error(`Firefly account ID ${account.fireflyId} duplicated in ${JSON.stringify(existing)} and ${JSON.stringify(account)}`)
    }

    // Add account to accountsByAkahuId
    if (account.akahuId !== undefined) {
      const set = this.accountsByAkahuId.get(account.akahuId) ?? {}
      if (set[account.type] === undefined) {
        set[account.type] = account
        this.accountsByAkahuId.set(account.akahuId, set)
      } else {
        console.error(`Akahu account ID ${account.akahuId} duplicated in ${JSON.stringify(set)} and ${JSON.stringify(account)}`)
      }
    }

    // Add account to accountsByBankNumber
    account.bankNumbers.forEach(bankNumber => {
      const set = this.accountsByBankNumber.get(bankNumber) ?? {}
      if (set[account.type] === undefined) {
        set[account.type] = account
        this.accountsByBankNumber.set(bankNumber, set)
      } else {
        console.error(`Bank account number ${bankNumber} duplicated in ${JSON.stringify(set)} and ${JSON.stringify(account)}`)
      }
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

  public getByAkahuId (akahuId: string): AccountSet | undefined {
    return this.cloneSet(this.accountsByAkahuId.get(akahuId))
  }

  public getByFireflyId (fireflyId: number): Account | undefined {
    return this.clone(this.accountsByFireflyId.get(fireflyId))
  }

  public getByBankNumber (bankNumber: string): AccountSet | undefined {
    return this.cloneSet(this.accountsByBankNumber.get(bankNumber))
  }

  // TODO: Implement this properly using the Firefly API
  public save (account: Account): void {
    // Check if the Firefly ID exists
    const existing = this.accountsByFireflyId.get(account.fireflyId)
    if (existing === undefined) {
      console.error(`Firefly account ID ${account.fireflyId} doesn't exist`)
      return
    }

    // Remove account from accountsByFireflyId
    this.accountsByFireflyId.delete(existing.fireflyId)

    // Remove account from accountsByAkahuId
    if (existing.akahuId !== undefined) {
      this.accountsByAkahuId.delete(existing.akahuId)
    }

    // Remove account from accountsByBankNumber
    account.bankNumbers.forEach(bankNumber => {
      this.accountsByBankNumber.delete(bankNumber)
    })

    // Re-add account
    this.add(account)
  }

  // TODO: Implement this properly using the Firefly API
  public create (inputAccount: Omit<Account, 'fireflyId'>): Account {
    const fireflyId = Math.max(...this.accountsByFireflyId.keys()) + 1
    const account = inputAccount as Account
    account.fireflyId = fireflyId
    this.add(account)
    return account
  }

  public changes (): void {
    this.accountsByFireflyId.forEach((b, fireflyId) => {
      const diff = this.compare(this.originalAccounts.get(fireflyId), b)
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
