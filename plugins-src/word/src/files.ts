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
