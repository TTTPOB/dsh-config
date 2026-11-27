import { array, boolean, integer, nullable, number, openRecord, record, string, success, trueValue } from '../../shared/catalog-output-schema.ts';
import type { Schema } from '../../shared/types.ts';

const paragraphFormatting = openRecord({}, {
  style: string, styleBuiltIn: string, font: { type: 'object', additionalProperties: true },
});

/** Successful envelopes emitted by the Word client runtime. */
export const catalogOutputSchemas: Readonly<Partial<Record<string, Schema>>> = {
  verify_doc: success(record({
    styles: { type: 'object', additionalProperties: true, description: 'Maps paragraph style names to paragraph counts.' },
    lists: array(record({ paraIndex: integer, level: integer, listString: string })),
    tables: array(record({ tableIndex: integer, rowCount: integer, cellsPerRow: array(integer), uniform: boolean })),
  })),
  read_doc_section: success(record({ paragraphStart: integer, paragraphEnd: integer, paragraphCount: integer, text: string }, {
    formatting: array(paragraphFormatting), truncated: string,
  })),
  search_doc_text: success(record({
    matches: array(record({ snippet: string }, { paragraph_index: integer })), total_matches: integer,
  }, { message: string, truncated: string })),
  collapse_blank_paragraphs: success(record({ deleted: integer, scanned: integer, skipped_with_content: integer }, {
    tracked: trueValue, not_removed: integer, note: string,
  })),
  edit_doc_text: success(record({ replaced: trueValue }, {
    paragraph: record({ text: string }, { styleBuiltIn: nullable(string) }),
  }), { tracked_change_warning: string }),
  edit_doc_list: success(record({ items: array(record({ text: string, isListItem: trueValue, listString: string, level: integer })) })),
};
