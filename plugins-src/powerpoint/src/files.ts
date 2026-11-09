import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Read binary inputs privately and expose only base64 inside the taskpane code. */
export async function officeArgs(args: { files?: unknown; code?: unknown }, signal?: AbortSignal) {
  const files: Record<string, string> = Object.create(null);
  if (args.files !== undefined && (!args.files || typeof args.files !== 'object' || Array.isArray(args.files)))
    throw new Error('files must map identifiers to absolute file paths on the DSH machine');
  for (const [key, filePath] of Object.entries(args.files ?? {})) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) throw new Error('Invalid files identifier: ' + key);
    if (typeof filePath !== 'string' || !isAbsolute(filePath))
      throw new Error('files.' + key + ' must be an absolute file path on the DSH machine');
    try {
      files[key] = (await readFile(filePath, { signal })).toString('base64');
    } catch (error) {
      throw new Error('Cannot read files.' + key + ' (' + filePath + '): ' + (error as Error).message, { cause: error });
    }
  }
  return { code: 'const files = JSON.parse(' + JSON.stringify(JSON.stringify(files)) + ');\n' + args.code };
}
