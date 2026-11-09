import { evaluate, helperRequest } from './transport.ts';
import { office } from './expressions.ts';
import type { Config } from './config.ts';

export const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Render the taskpane-bound slide through Office.js, or opt into the COM transport. */
export async function renderSlide(config: Config, slide: number, options: { signal?: AbortSignal; target?: string; expectSlides?: number } = {}) {
  if (!Number.isSafeInteger(slide) || slide < 1) throw new Error('slide must be a positive integer');
  if (config.renderBackend === 'officejs') {
    const expression = office('const items=await slides(ctx);const slide=at(items,' + JSON.stringify(slide) + ');'
      + 'if(typeof slide.getImageAsBase64!=="function") throw new Error("This Office runtime does not support slide images; select renderBackend: com.");'
      + 'const image=slide.getImageAsBase64({width:' + config.renderWidth + '});await ctx.sync();return image.value;');
    const encoded = await evaluate(config, expression, options.signal, options.target);
    const bytes = Buffer.from(encoded as string, 'base64');
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('Office.js did not return a PNG');
    return bytes;
  }
  const expected = Number(options.expectSlides ?? 0);
  const bytes = await helperRequest(config, '/render',
    {
      slide, width: config.renderWidth, height: config.renderHeight, expectSlides: expected,
      ...(options.target === undefined ? {} : { target: options.target })
    }, options.signal, true);
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('dsh-powerpoint helper did not return a PNG');
  return bytes;
}
