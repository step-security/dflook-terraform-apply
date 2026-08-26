export const find = (_tool: string, _version: string, _arch?: string): string => ''
export const downloadTool = async (_url: string): Promise<string> => ''
export const extractZip = async (_file: string, _dest?: string): Promise<string> => ''
export const cacheDir = async (
  _dir: string,
  _tool: string,
  _version: string,
  _arch?: string
): Promise<string> => ''
