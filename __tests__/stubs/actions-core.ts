export const info = (_message: string): void => undefined
export const debug = (_message: string): void => undefined
export const warning = (_message: string): void => undefined
export const error = (_message: string, _properties?: unknown): void => undefined
export const startGroup = (_title: string): void => undefined
export const endGroup = (): void => undefined
export const setOutput = (_name: string, _value: string): void => undefined
export const setFailed = (_message: string): void => undefined
export const setSecret = (_value: string): void => undefined
export const getInput = (_name: string): string => ''
