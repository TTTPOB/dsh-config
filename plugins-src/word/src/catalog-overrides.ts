import type { CatalogTool } from '../../shared/catalog.ts';
import { normalizeSchema, qualifyDescriptions } from '../../shared/catalog-schema.ts';
import type { Schema } from '../../shared/types.ts';

const descriptions: Record<string, string> = {
  verify_doc: 'Fast structural check of the current Word document: paragraph style distribution, list numbering sequence, and table row/cell structure. Use between edits to locate numbering restarts, table breaks or changed styles. For fonts, spacing and pagination, render affected pages with word_render_page.',
  edit_doc_text: 'Replace one exact text span in place. Only the matched characters change, which keeps word/sentence-level tracked revisions instead of whole-paragraph delete+insert. Read first, match the intended text uniquely, and keep unchanged context verbatim. Use word_execute_office_js for structural edits such as inserting paragraphs, changing styles and tables.',
};
const sentenceReplacements: Record<string, { index: number; text: string }> = {
  read_doc_section: { index: 1, text: 'Locate an unfamiliar section with word_search_doc_text first, then read its heading or returned paragraph range.' },
};

/** Replace app-only state/review instructions with DSH-owned reading and rendering guidance. */
export function catalogDefinitions(tools: CatalogTool[]) {
  const describe = qualifyDescriptions('word_', [...tools.map(tool => tool.clientName), 'execute_office_js']);
  return tools.map(tool => {
    const parameters = normalizeSchema(tool.inputSchema, describe);
    let description = descriptions[tool.clientName] ?? describe(tool.description);
    const replacement = sentenceReplacements[tool.clientName];
    if (replacement) {
      const sentences = description.split(/(?<=\.) /);
      sentences[replacement.index] = replacement.text;
      description = sentences.join(' ');
    }
    if (tool.clientName === 'read_doc_section' && parameters.properties?.heading?.description)
      parameters.properties.heading.description = parameters.properties.heading.description.replace(/\(exact match[^)]*\)/,
        '(exact match against a heading read from the document)');
    if (tool.clientName === 'search_doc_text') description = description.replace(/\(does not search[^)]*\)/,
      '(does not search headers or footers; read those explicitly with Word Office.js)');
    return { ...tool, description, inputSchema: parameters as Schema & { type: 'object' } };
  });
}
