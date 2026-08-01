import { renderRecordHtml } from './pdf-html-template';
import { recordShape } from './__fixtures__/record-shapes';

/**
 * Task 7 — golden-file coverage across form shapes (spec risk 2: a real
 * revision, `CE-95-043-00-01`, has 18 items, 10 of them monthly) plus the
 * digest-stability guard: `renderRecordHtml` must print the STORED hex
 * verbatim and never recompute it (this file's own header comment,
 * `pdf-html-template.ts`).
 *
 * Every snapshot below was read end-to-end before being committed — see
 * `task-7-report.md` for the read-through notes.
 */
describe('QA-format record — golden shapes', () => {
  for (const name of ['single-3m', 'monthly-only', 'long-18-item', 'voided']) {
    it(`renders ${name} stably`, () => {
      expect(renderRecordHtml(recordShape(name))).toMatchSnapshot();
    });
  }

  it('prints every one of the 18 rows on a long form', () => {
    const html = renderRecordHtml(recordShape('long-18-item'));
    for (let n = 1; n <= 18; n++) {
      expect(html).toContain(`<td class="p-no">${n}</td>`);
    }
  });

  it('never recomputes the digest — the stored hex is printed verbatim', () => {
    const shape = recordShape('single-3m');
    const html = renderRecordHtml({
      ...shape,
      footer: { ...shape.footer, integrityDigestHex: 'aaaa1111' },
    });
    expect(html).toContain('aaaa1111');
    expect(html).not.toContain('deadbeefcafe');
  });

  it('still marks a voided record while showing intact content', () => {
    const html = renderRecordHtml(recordShape('voided'));
    expect(html).toContain('RECORD VOID');
    expect(html).toContain('Wrong machine');
    expect(html).toContain('<td class="p-no">1</td>');
  });
});
