import type { AddTool, Execution, Properties } from '../../shared/types.ts';
import type { Config } from './config.ts';
import { objectSchema } from './schemas.ts';
import { requestHelper } from './transport.ts';

export function registerZoteroTools(
  add: AddTool,
  config: Config,
  evaluateNow: (code: string, exec: Execution) => Promise<unknown>,
  targetBody: (exec: Execution) => { target?: string },
) {
  const zoteroPosition = {
    anchor_text: { type: 'string', description: 'Unique document text used as the insertion anchor.' },
    position: {
      type: 'string',
      enum: ['before', 'after', 'replace', 'end', 'selection'],
      description: 'Placement relative to anchor_text, document end, or the current selection.',
    },
  } as const;
  const zoteroRefresh = {
    type: 'boolean',
    description: 'Refresh with Zotero after the change; defaults to true.',
  } as const;
  const zoteroStyle = {
    type: 'string',
    description:
      'Zotero CSL style ID. Required for a citation in a document without Zotero preferences; existing preferences are preserved.',
  } as const;
  const zoteroStatus =
    ' Returns document, compact fields (kind/text/start, citationID/uris for citations), preferences, refreshTriggered and pendingFormatting. refreshTriggered means the official macro was dispatched, not that formatting finished. pendingFormatting detects blank or placeholder results, not style-update completion. Call word_zotero_inspect to read back the expected formatted text. After a timeout inspect before retrying; writes are never automatically replayed.';
  const zotero = (action: string, properties: Properties, required: string[], description: string) =>
    add(
      'word_zotero_' + action,
      description + zoteroStatus,
      properties,
      required,
      objectSchema,
      async (args, exec) => {
        const documentUrl = await evaluateNow('(Office.context.document.url || "")', exec);
        const payload: Record<string, unknown> = { ...args, action, documentUrl, ...targetBody(exec) };
        if (action === 'insert_citation' || action === 'insert_bibliography' || action === 'set_style')
          payload.refresh = args.refresh ?? true;
        return requestHelper(config, '/word/zotero', payload, exec.signal);
      },
    );
  zotero(
    'insert_citation',
    {
      items: {
        type: 'array',
        description:
          'Real Zotero item URIs and CSL-JSON read from the existing Zotero MCP; never invent metadata or guess local itemID/libraryID.',
        items: {
          type: 'object',
          properties: {
            uri: { type: 'string' },
            itemData: { type: 'object', additionalProperties: true },
            locator: { type: 'string' },
            label: { type: 'string' },
            prefix: { type: 'string' },
            suffix: { type: 'string' },
            suppressAuthor: { type: 'boolean' },
          },
          required: ['uri', 'itemData'],
          additionalProperties: false,
        },
      },
      ...zoteroPosition,
      style_id: zoteroStyle,
      refresh: zoteroRefresh,
    },
    ['items'],
    'Insert a native Zotero citation into the taskpane-bound Word document. Supply real item data from Zotero MCP. The helper requires style_id when the document has no Zotero preferences and preserves existing preferences. Does not automate the Add/Edit Citation picker.',
  );
  zotero(
    'insert_bibliography',
    { ...zoteroPosition, refresh: zoteroRefresh },
    [],
    'Insert a native Zotero bibliography into the taskpane-bound Word document.',
  );
  zotero(
    'refresh',
    {},
    [],
    'Refresh native Zotero citations and bibliography in the taskpane-bound Word document.',
  );
  zotero(
    'inspect',
    {},
    [],
    'Inspect native Zotero fields and document preferences in the taskpane-bound Word document without inserting fields. Use this after uncertain or timed-out writes.',
  );
  zotero(
    'set_style',
    { style_id: zoteroStyle, refresh: zoteroRefresh },
    ['style_id'],
    'Set the native Zotero CSL style for the taskpane-bound Word document.',
  );
}
