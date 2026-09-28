import { Editor, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The extension picks the scroll-driven path at import time, so the timeline
// must exist before the module loads.
const timelines = vi.hoisted(() => {
  class ScrollTimelineStub {
    constructor(readonly options: unknown) {}
  }
  Object.defineProperty(globalThis, 'ScrollTimeline', {
    configurable: true,
    value: ScrollTimelineStub,
  });
  return { ScrollTimelineStub };
});

const { FrozenTableHeaders } = await import('@ok-app/editor/extensions/frozen-table-headers');

type TrackedAnimation = Animation & { target: Element; cancelled: boolean };

// A leaf node rendering the DOM shape the extension measures: a header row in
// a `.tableWrapper`. Replacing the document re-renders it with fresh cells,
// exactly like a file switch in the visual editor.
const FixtureTable = Node.create({
  name: 'fixtureTable',
  group: 'block',
  atom: true,
  addAttributes() {
    return { label: { default: 'A' } };
  },
  parseHTML() {
    return [{ tag: 'div.tableWrapper' }];
  },
  renderHTML({ node }) {
    return [
      'div',
      { class: 'tableWrapper' },
      [
        'table',
        [
          'tbody',
          ['tr', ['th', `${node.attrs.label as string} 1`], ['th', `${node.attrs.label as string} 2`]],
          ['tr', ['td', '1'], ['td', '2']],
        ],
      ],
    ];
  },
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function doc(...labels: string[]) {
  return {
    type: 'doc',
    content: labels.map((label) => ({ type: 'fixtureTable', attrs: { label } })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, 'animate');
  document.body.replaceChildren();
});

describe('frozen table headers across document replacement', () => {
  it('cancels the scroll-driven animations of cells the editor dropped', async () => {
    expect(timelines.ScrollTimelineStub).toBeDefined();
    const animations: TrackedAnimation[] = [];
    // jsdom has no Web Animations.
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value(this: Element) {
        const animation = {
          target: this,
          cancelled: false,
          startTime: null,
          cancel() {
            animation.cancelled = true;
          },
        } as unknown as TrackedAnimation;
        animations.push(animation);
        return animation;
      },
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const height = this.tagName === 'TABLE' ? 300 : this.tagName === 'TR' ? 40 : 0;
      return DOMRect.fromRect({ x: 0, y: 100, width: 400, height });
    });

    const scroller = document.createElement('div');
    scroller.dataset.testid = 'editor-scroll-container';
    Object.defineProperty(scroller, 'scrollHeight', { value: 4000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 600 });
    const host = document.createElement('div');
    scroller.append(host);
    document.body.append(scroller);

    const editor = new Editor({
      element: host,
      extensions: [
        Document,
        Paragraph,
        Text,
        FixtureTable,
        FrozenTableHeaders.configure({ topOffset: 0, occludeTop: false }),
      ],
      content: doc('first', 'second'),
    });
    await vi.waitFor(() => expect(animations).toHaveLength(8));
    const firstDocument = [...animations];
    const firstWrappers = [...editor.view.dom.querySelectorAll<HTMLElement>('.tableWrapper')];
    const unhooked = firstWrappers.map((wrapper) => vi.spyOn(wrapper, 'removeEventListener'));

    // A file switch: every cell of the first document leaves the editor.
    editor.commands.setContent(doc('third'));
    await vi.waitFor(() => expect(animations).toHaveLength(12));
    // The trailing full pass releases what the switch dropped.
    await vi.waitFor(() => {
      expect(firstDocument.every((animation) => animation.cancelled)).toBe(true);
    }, { timeout: 2_000 });
    for (const animation of firstDocument) expect(animation.target.isConnected).toBe(false);
    for (const spy of unhooked) {
      expect(spy).toHaveBeenCalledWith('contentvisibilityautostatechange', expect.any(Function));
    }
    const current = animations.slice(8);
    expect(current.some((animation) => animation.cancelled)).toBe(false);

    // Cells replaced after the last full pass still do not outlive the editor.
    editor.commands.setContent(doc('fourth'));
    await settle(0);
    editor.destroy();
    expect(animations.every((animation) => animation.cancelled)).toBe(true);
  });
});
