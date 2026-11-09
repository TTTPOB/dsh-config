import { readFile } from 'node:fs/promises';
import { imageExpression } from './files.ts';
import { imageSchema, objectSchema } from './schemas.ts';
import { requestHelper } from './transport.ts';

import type { AddTool, Context, Execution } from '../../shared/types.ts';
import type { Config } from './config.ts';

export function registerImageTools(
  add: AddTool,
  ctx: Context,
  config: Config,
  hideOnce: (exec: Execution) => Promise<void>,
  targetBody: (exec: Execution) => { target?: string },
  evaluateNow: (code: string, exec: Execution) => Promise<unknown>,
) {
  add(
    'word_render_page',
    'Render one page of the current Word document and return PNG directly for visual inspection. page is one-based. The Windows helper exports and rasterizes the selected document; no PDF renderer is needed on the DSH machine. Returns pageCount with the image; does not call a reviewer model.',
    { page: { type: 'integer', description: 'One-based page number in the paginated Word document.' } },
    ['page'],
    {
      type: 'object',
      properties: { page: { type: 'integer' }, pageCount: { type: 'integer' }, image: imageSchema },
      required: ['page', 'pageCount', 'image'],
      additionalProperties: false,
    },
    async (args, exec) => {
      if (!Number.isSafeInteger(args.page) || args.page < 1)
        throw new Error('page must be a positive one-based integer');
      await hideOnce(exec);
      const rendered = await requestHelper<{ base64: string; mimeType: string; pageCount: number }>(
        config,
        '/word/render',
        { page: args.page, longEdge: config.renderLongEdge, ...targetBody(exec) },
        exec.signal,
      );
      const data = Buffer.from(rendered.base64, 'base64');
      const image = await ctx.attachments.saveImage({
        data,
        mediaType: rendered.mimeType,
        name: 'word-page-' + args.page + '.png',
      });
      return {
        page: args.page,
        pageCount: rendered.pageCount,
        image: { ...image, attachmentId: String(image.attachmentId) },
      };
    },
    (_args, value) => [
      {
        type: 'text',
        text: JSON.stringify({
          page: value.page,
          pageCount: value.pageCount,
          width: value.image.width,
          height: value.image.height,
        }),
      },
      { type: 'image', attachment: value.image },
    ],
  );
  add(
    'word_insert_image',
    'Insert an inline image into Word from required filePath on the DSH machine; no Windows path is required. where defaults to documentEnd; selection replaces the selected range. Sizes are points.',
    {
      filePath: { type: 'string' },
      where: { type: 'string', enum: ['documentStart', 'documentEnd', 'selection'] },
      width: { type: 'number' },
      height: { type: 'number' },
    },
    ['filePath'],
    objectSchema,
    async (args, exec) => {
      if (typeof args.filePath !== 'string' || !args.filePath)
        throw new Error('filePath is required on the DSH machine');
      const base64 = (await readFile(args.filePath, { signal: exec.signal })).toString('base64');
      for (const key of ['width', 'height'] as const)
        if (args[key] !== undefined && (!Number.isFinite(args[key]) || args[key] <= 0))
          throw new Error(key + ' must be positive');
      return evaluateNow(
        imageExpression(base64, args.where ?? 'documentEnd', { width: args.width, height: args.height }),
        exec,
      );
    },
  );
}
