import { describe, expect, test } from 'bun:test';
import { planDocumentWork } from '../../../src/plugins/falco/commands';

const plan = (haveXml: boolean, havePdf: boolean, extractPdf: boolean, force: boolean) =>
  planDocumentWork({ haveXml, havePdf, extractPdf, force });

describe('peppol sync work plan', () => {
  test('a document already fully on disk is skipped', () => {
    expect(plan(true, true, true, false)).toEqual({ skip: true, reuseXml: false, writePdf: false });
    expect(plan(true, false, false, false)).toEqual({ skip: true, reuseXml: false, writePdf: false });
  });

  test('a missing document is downloaded', () => {
    expect(plan(false, false, false, false)).toEqual({ skip: false, reuseXml: false, writePdf: false });
    expect(plan(false, false, true, false)).toEqual({ skip: false, reuseXml: false, writePdf: true });
  });

  test('an existing XML is reused to produce only the missing PDF', () => {
    expect(plan(true, false, true, false)).toEqual({ skip: false, reuseXml: true, writePdf: true });
  });

  test('a freshly downloaded XML re-renders its PDF even when one exists', () => {
    // Otherwise a stale rendition sits beside newly downloaded source.
    expect(plan(false, true, true, false)).toEqual({ skip: false, reuseXml: false, writePdf: true });
  });

  test('--force re-downloads and re-renders regardless of what is on disk', () => {
    expect(plan(true, true, true, true)).toEqual({ skip: false, reuseXml: false, writePdf: true });
    expect(plan(true, true, false, true)).toEqual({ skip: false, reuseXml: false, writePdf: false });
  });

  test('without --extract-pdf no PDF is ever written', () => {
    for (const haveXml of [true, false]) {
      for (const havePdf of [true, false]) {
        for (const force of [true, false]) {
          expect(plan(haveXml, havePdf, false, force).writePdf).toBe(false);
        }
      }
    }
  });

  test('a skipped document is never also asked to do work', () => {
    for (const haveXml of [true, false]) {
      for (const havePdf of [true, false]) {
        for (const extractPdf of [true, false]) {
          for (const force of [true, false]) {
            const result = plan(haveXml, havePdf, extractPdf, force);
            if (result.skip) {
              expect(result.reuseXml).toBe(false);
              expect(result.writePdf).toBe(false);
            }
          }
        }
      }
    }
  });

  test('nothing is skipped when --force is set', () => {
    for (const haveXml of [true, false]) {
      for (const havePdf of [true, false]) {
        for (const extractPdf of [true, false]) {
          expect(plan(haveXml, havePdf, extractPdf, true).skip).toBe(false);
        }
      }
    }
  });

  test('every combination lands in exactly one tally bucket', () => {
    // The tally bug this guards: a document that was neither skipped nor
    // downloaded was counted in nothing, so the summary read
    // "0 downloaded, 0 already on disk" while real work happened.
    const buckets = new Map<string, string>();
    for (const haveXml of [true, false]) {
      for (const havePdf of [true, false]) {
        for (const extractPdf of [true, false]) {
          for (const force of [true, false]) {
            const result = plan(haveXml, havePdf, extractPdf, force);
            // Mirrors how runPeppolSync counts: skip and reuse both report the
            // document as already on disk, a fetch reports it as downloaded.
            const bucket = result.skip || result.reuseXml ? 'skipped' : 'wrote';
            buckets.set(`${haveXml}/${havePdf}/${extractPdf}/${force}`, bucket);
          }
        }
      }
    }

    expect(buckets.size).toBe(16);
    expect([...buckets.values()].every((bucket) => bucket === 'skipped' || bucket === 'wrote')).toBe(true);
    // A forced run must re-download every document, never report one as present.
    const forced = [...buckets.entries()].filter(([key]) => key.endsWith('/true'));
    expect(forced.map(([, bucket]) => bucket)).toEqual(Array(8).fill('wrote'));
  });
});
