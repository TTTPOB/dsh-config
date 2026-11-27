import { readFile } from 'node:fs/promises';

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function assertPng(bytes: Buffer, message: string) {
  if (!bytes.subarray(0, pngMagic.length).equals(pngMagic)) throw new Error(message);
}

/** Reject invalid paths or sizes before reading local image bytes. */
export async function readImageBase64(args: { filePath: string; width?: number; height?: number }, signal?: AbortSignal) {
  if (typeof args.filePath !== 'string' || !args.filePath)
    throw new Error('filePath is required on the DSH machine');
  for (const key of ['width', 'height'] as const)
    if (args[key] !== undefined && (!Number.isFinite(args[key]) || args[key] <= 0))
      throw new Error(key + ' must be positive');
  return (await readFile(args.filePath, { signal })).toString('base64');
}
