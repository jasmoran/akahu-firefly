export const Util = {
  stringify (data: any): string {
    return JSON.stringify(
      data,
      (_key, value) => (value instanceof Set ? [...value] : value)
    )
  }
}
