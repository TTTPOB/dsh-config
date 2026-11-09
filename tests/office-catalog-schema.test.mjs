import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchema, qualifyDescriptions } from '../plugins-src/shared/catalog-schema.ts';

test('normalization preserves supported constraints, maps scalar nullable unions, and never mutates the catalog',()=>{
  const input={type:'object',$schema:'synthetic',properties:{
    minimum:{type:'number',minimum:3,maximum:9,default:5},
    label:{type:'string',minLength:2,pattern:'synthetic',enum:['one','two'],description:'Call native_tool, not prefix_native_tool.'},
    values:{type:'array',minItems:1,items:{anyOf:[{type:'number'},{type:'null'}]}},
    mode:{type:'string',const:'fixed'},
    nested:{oneOf:[{type:'string'},{type:'boolean'}]},
  },required:['mode'],additionalProperties:false};
  const before=structuredClone(input),describe=qualifyDescriptions('prefix_',['native_tool']);
  const result=normalizeSchema(input,describe);
  assert.deepEqual(input,before);
  assert.equal(result.properties.minimum.default,input.properties.minimum.default);
  assert.ok(!('minimum' in result.properties.minimum));assert.ok(!('$schema' in result));
  assert.deepEqual(result.properties.label.enum,input.properties.label.enum);
  assert.equal(result.properties.mode.const,input.properties.mode.const);
  assert.deepEqual(result.properties.nested,input.properties.nested);
  assert.deepEqual(result.properties.values.items,{oneOf:input.properties.values.items.anyOf});
  assert.equal(result.properties.label.description,'Call prefix_native_tool, not prefix_native_tool.');
  assert.deepEqual(result.required,input.required);assert.equal(result.additionalProperties,false);
  assert.notEqual(result.properties.label,input.properties.label);
});

test('normalization refuses overlapping anyOf rather than silently changing union semantics',()=>{
  for(const branches of [[{type:'number'},{type:'number'}],[{type:'integer'},{type:'number'}],[{type:'object'},{type:'object'}]])
    assert.throws(()=>normalizeSchema({anyOf:branches},x=>x),/disjoint/);
});
