import { array, boolean, integer, nullable, number, record, string, success, trueValue } from '../../shared/catalog-output-schema.ts';
import type { Schema } from '../../shared/types.ts';

const slideIdUpdate = {
  type: 'object', additionalProperties: true,
  description: 'Maps old slide IDs to new slide ID strings after writeback; look up the old ID as a key.',
} as const;
const writeback = { slide_id_update: slideIdUpdate };
const callbackOutput = {
  ...writeback,
  no_changes_warning: string,
  result: { description: 'JSON returned by the callback; omitted if it returns undefined.' },
};

const placement = { ref: string, id: string, left: integer, top: integer, width: integer, height: integer };
const box = record({ id: string, name: string, left: number, top: number, w: number, h: number }, {
  isTable: trueValue, sizeEstimated: trueValue,
});
const verifiedSlide = record({
  slideId: string,
  shapes: array(box),
  overflows: array(record({ shape: box, overflowBy: number }, {
    bottom: number, slideH: number, right: number, slideW: number,
  })),
  overlaps: array(record({ shapeA: box, shapeB: box, overlapX: number, overlapY: number }, {
    bothHaveText: trueValue, isContainment: trueValue,
  })),
  coverage: nullable(record({
    bbox_width: number, bbox_height: number, coverage_ratio: nullable(number), top_start: number, bottom_gap: number,
  }, { low_coverage: trueValue, top_heavy: trueValue })),
}, {
  inherited_overlaps: array(record({
    shape_id: string, shape_name: string, inherited_id: string, inherited_name: string,
    inherited_kind: { type: 'string', enum: ['text', 'image'] }, layer: { type: 'string', enum: ['layout', 'master'] },
    inherited_box: record({ left: number, top: number, width: number, height: number }), msg: string,
  })),
  contrast_warnings: array(record({
    shape_id: string, shape_name: string, font_color: string, bg_color: string, ratio: number, msg: string,
  }, { bg_shape_id: string, bg_shape_name: string, bg_source: string })),
  text_overflow_warnings: array(record({
    shape: string, estTextHeight: number, boxHeight: number, innerHeight: number, estLines: integer, overflowBy: number, message: string,
  }, { runsInto: string })),
  small_shape_warnings: array(record({ shape: string, width: number, height: number, message: string })),
});

const chartStyle = record({
  form: string, series_count: integer, fonts: array(string), font_inherits_theme: boolean, fills: array(string),
  series_fills: array(string), scheme_colors: array(string), legend: string, value_axis: string, gridlines: boolean,
  has_native_title: boolean, data_label_position: nullable(string), series_color_pattern: string, gap_width: nullable(number),
  unsupported: array(string),
});
const replacementReport = record({
  dry_run: boolean, total_replacements: integer, slides_modified: integer,
  pairs: array(record({ find: string, replace: string, replacements: integer })),
  slides: array(record({
    slide_id: string, position: integer, replacements: integer,
    locations: array(record({ container: { type: 'string', enum: ['body', 'table', 'notes'] }, replacements: integer }, {
      shapeId: string, shapeName: string, cell: string,
    })),
  })),
}, { skipped: array(record({ reason: string, detail: string })), warnings: array(string) });

/** Successful envelopes emitted by the PowerPoint client runtime. */
export const catalogOutputSchemas: Readonly<Partial<Record<string, Schema>>> = {
  list_slide_shapes: success(array(record({ ...placement, name: string, type: string }))),
  create_slide_chart: success(record({ inserted: string }), writeback),
  read_chart_style: success(record({ chart_count: integer, charts: array(record({ chart_part: string, style: chartStyle })) })),
  edit_built_chart: success(record({ chart_part: string, dropped: array(string) }), writeback),
  edit_slide_chart: record({ success: trueValue }, callbackOutput),
  edit_slide_master: record({ success: trueValue }, {
    ...callbackOutput,
    slide_master_id_update: {
      type: 'object', additionalProperties: true,
      description: 'Maps old slide master IDs to new slide master ID strings.',
    },
    slide_master_layouts: array(record({ id: string, name: string })),
  }),
  edit_slide_xml: record({ success: trueValue }, callbackOutput),
  duplicate_slide: record({ success: trueValue }),
  verify_slides: success(record({
    slides: array(verifiedSlide), total_slides: integer, from_slide: integer, to_slide: integer,
  }, { dimensions_assumed_warning: string })),
  read_slide_text: success(string),
  edit_slide_text: record({ success: trueValue }, writeback),
  find_and_replace: success(replacementReport, writeback),
  search_icons: success(array(record({}, {
    id: { description: 'Icon ID copied from the remote search response; insert_icon accepts string IDs.' },
    description: { description: 'Description copied from the remote search response.' },
    isMono: { description: 'Monochrome metadata copied from the remote search response.' },
    contentTier: { description: 'Content tier copied from the remote search response.' },
    searchScore: { description: 'Search score copied from the remote search response.' },
  }))),
  insert_icon: success(record({ inserted: trueValue, icon_id: string }, { placed_shape: record(placement) }), writeback),
  copy_image_between_slides: success(record({ shape_id: string }), writeback),
};
