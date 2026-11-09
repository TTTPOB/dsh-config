import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
export interface OfficeArgs { code: string; files?: unknown }

/** Insert bytes into Word without exposing a Windows-local file path. */
export function imageExpression(base64: string, where: string, size: { width?: number; height?: number }) {
  return (
    '(async()=>{return await Word.run(async ctx=>{' +
    'const target=' +
    (where === 'selection' ? 'ctx.document.getSelection()' : 'ctx.document.body') +
    ';' +
    'const image=target.insertInlinePictureFromBase64(' +
    JSON.stringify(base64) +
    ',' +
    JSON.stringify(where === 'documentStart' ? 'Start' : where === 'selection' ? 'Replace' : 'End') +
    ');' +
    'const size=' +
    JSON.stringify(size) +
    ';image.lockAspectRatio=!(size.width!==undefined && size.height!==undefined);' +
    'if(size.width!==undefined)image.width=size.width;if(size.height!==undefined)image.height=size.height;' +
    'await ctx.sync();image.load("width,height");await ctx.sync();return {inserted:true,width:image.width,height:image.height};});})()'
  );
}

/** Load binary inputs privately; caller arguments retain only DSH file paths. */
export async function officeCode(args: OfficeArgs, signal?: AbortSignal) {
  if (args.files === undefined) return args.code;
  if (args.files === null || typeof args.files !== 'object' || Array.isArray(args.files))
    throw new Error('files must map JavaScript identifiers to absolute file paths on the DSH machine');
  const entries = [];
  for (const [identifier, filePath] of Object.entries(args.files)) {
    if (!/^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(identifier))
      throw new Error('Invalid files identifier: ' + identifier + '; expected JavaScript identifier syntax');
    if (typeof filePath !== 'string' || !isAbsolute(filePath))
      throw new Error('files.' + identifier + ' must be an absolute file path on the DSH machine');
    let data;
    try {
      data = await readFile(filePath, { signal });
    } catch (error) {
      throw new Error(
        'Cannot read files.' + identifier + ' at ' + filePath + ': ' + (error as Error).message,
        { cause: error },
      );
    }
    entries.push([identifier, data.toString('base64')]);
  }
  return 'const files = Object.fromEntries(' + JSON.stringify(entries) + ');\n' + args.code;
}
