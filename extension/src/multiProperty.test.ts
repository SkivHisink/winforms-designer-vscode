import { describe, expect, it } from 'vitest';
import type { ComponentDesc, PropertyDesc } from './engineClient';
import { intersectMultiProperties, normalizeMultiSelection } from './multiProperty';

function prop(name: string, value: string | null, over: Partial<PropertyDesc> = {}): PropertyDesc {
  return {
    name,
    type: 'System.String',
    value,
    isDefault: false,
    sourceExplicit: true,
    readOnly: false,
    isEnum: false,
    category: 'Appearance',
    ...over,
  };
}

function component(id: string, properties: PropertyDesc[], over: Partial<ComponentDesc> = {}): ComponentDesc {
  return {
    id,
    name: id,
    type: id === 'button1' ? 'System.Windows.Forms.Button' : 'System.Windows.Forms.TextBox',
    parent: 'this',
    isRoot: false,
    ownership: 'currentSource',
    editable: true,
    properties,
    events: [],
    ...over,
  };
}

describe('normalizeMultiSelection', () => {
  it('keeps a closed rendered unique set and makes the primary the final member', () => {
    expect(normalizeMultiSelection('button2', ['button2', 'button1'], ['button1', 'button2']))
      .toEqual(['button1', 'button2']);
  });

  it('collapses a malformed, primary-less, or oversized request to the primary', () => {
    expect(normalizeMultiSelection('button1', ['missing'], ['button1'])).toEqual(['button1']);
    expect(normalizeMultiSelection('button2', ['button1'], ['button1', 'button2'])).toEqual(['button2']);
    expect(normalizeMultiSelection('button2', ['button2', 'button1', 'button1'], ['button1', 'button2']))
      .toEqual(['button2']);
    expect(normalizeMultiSelection('button1', Array.from({ length: 129 }, () => 'button1'), ['button1']))
      .toEqual(['button1']);
  });
});

describe('intersectMultiProperties', () => {
  it('V2-FND-001-S038: intersects heterogeneous writable scalar properties and marks unequal values as mixed', () => {
    const result = intersectMultiProperties([
      component('button1', [prop('Text', 'Button'), prop('FlatStyle', 'Standard', { type: 'System.Windows.Forms.FlatStyle', isEnum: true })]),
      component('textBox1', [prop('Text', 'Text box'), prop('Multiline', 'False', { type: 'System.Boolean' })]),
    ], 'textBox1');

    expect(result?.multiCount).toBe(2);
    expect(result?.id).toBe('textBox1');
    expect(result?.properties.map((property) => property.name)).toEqual(['Text']);
    expect(result?.properties[0]).toMatchObject({ value: null, mixed: true, multi: true, multiResettable: true });
  });

  it('V2-FND-001-S038: keeps a common value and intersects closed standard-value sets', () => {
    const first = prop('Enabled', 'True', {
      type: 'System.Boolean', standardValues: ['True', 'False'], standardValuesExclusive: true,
    });
    const second = prop('Enabled', 'True', {
      type: 'System.Boolean', standardValues: ['False', 'True'], standardValuesExclusive: true,
    });
    const result = intersectMultiProperties([
      component('button1', [first]), component('textBox1', [second]),
    ], 'button1');

    expect(result?.properties[0]).toMatchObject({ value: 'True', mixed: false, standardValues: ['True', 'False'] });
  });

  it('keeps built-in Color and Font editor values for a two-control VS-style selection', () => {
    const color = (name: string, value: string) => prop(name, value, {
      type: 'System.Drawing.Color',
      uiTypeEditor: 'System.Drawing.Design.ColorEditor',
    });
    const font = (value: string) => prop('Font', value, {
      type: 'System.Drawing.Font',
      uiTypeEditor: 'System.Drawing.Design.FontEditor',
    });
    const result = intersectMultiProperties([
      component('button1', [
        color('BackColor', 'Red'), color('ForeColor', 'Black'), font('Segoe UI, 9pt'),
      ]),
      component('button2', [
        color('BackColor', 'Blue'), color('ForeColor', 'Black'), font('Arial, 10pt'),
      ]),
    ], 'button2');

    expect(result?.properties.map((property) => property.name)).toEqual(['BackColor', 'ForeColor', 'Font']);
    expect(result?.properties.find((property) => property.name === 'BackColor')).toMatchObject({
      mixed: true, value: null, multi: true, uiTypeEditor: null,
    });
    expect(result?.properties.find((property) => property.name === 'ForeColor')).toMatchObject({
      mixed: false, value: 'Black', multi: true, uiTypeEditor: null,
    });
    expect(result?.properties.find((property) => property.name === 'Font')).toMatchObject({
      mixed: true, value: null, multi: true, uiTypeEditor: null,
    });
  });

  it('V2-FND-001-S038: excludes one-target read-only/type-mismatched and dedicated-editor properties', () => {
    const result = intersectMultiProperties([
      component('button1', [
        prop('Text', 'A'),
        prop('Tag', 'x', { readOnly: true }),
        prop('Items', null, { isCollection: true, collectionItemType: 'System.String' }),
        prop('Image', null, { isImage: true, type: 'System.Drawing.Image' }),
      ]),
      component('textBox1', [
        prop('Text', 'B', { type: 'System.Int32' }),
        prop('Tag', 'y'),
        prop('Items', null, { isCollection: true, collectionItemType: 'System.String' }),
        prop('Image', null, { isImage: true, type: 'System.Drawing.Image' }),
      ]),
    ], 'button1');

    expect(result?.properties).toEqual([]);
  });

  it('fails closed when any selected component is not editable', () => {
    expect(intersectMultiProperties([
      component('button1', [prop('Text', 'A')]),
      component('textBox1', [prop('Text', 'B')], { editable: false, ownership: 'inherited' }),
    ], 'button1')).toBeNull();
  });
});
