import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createWorkspaceSearchCorpus,
  createWorkspaceSearchDocument,
  searchWorkspaceCorpus,
  searchWorkspaceDocuments,
  updateWorkspaceSearchCorpus,
} from './workspace-search.ts';

function page(path: string, title: string, content: string) {
  return createWorkspaceSearchDocument({
    kind: 'page',
    path,
    title,
    content,
    modifiedTs: 0,
  });
}

describe('non-Latin workspace search', () => {
  const documents = [
    page('zh', '中文笔记', '量子计算研究方法'),
    page('ja', '日本語ノート', '機械学習の研究計画'),
    page('th', 'บันทึกภาษาไทย', 'การค้นคว้าด้านดาราศาสตร์'),
    page('ar', 'ملاحظات عربية', 'مناهج البحث العلمي'),
    page('he', 'הערות בעברית', 'שיטות מחקר מדעי'),
  ];

  test.each([
    ['Chinese', '量子计算', 'zh'],
    ['Japanese', '機械学習', 'ja'],
    ['Thai', 'ดาราศาสตร์', 'th'],
    ['Arabic', 'البحث', 'ar'],
    ['Hebrew', 'מחקר', 'he'],
  ])('finds %s body text', (_script, query, expectedPath) => {
    const results = searchWorkspaceDocuments(documents, query, { intent: 'full_text' });

    expect(results[0]?.document.path).toBe(expectedPath);
    expect(results[0]?.signals.fullText).toBeGreaterThan(0);
  });

  test('finds a document matching a mixed-script query', () => {
    const mixed = [
      page('latin-only', 'Roadmap', 'project roadmap milestones'),
      page('cjk-only', '東京', '東京の旅行記録'),
      page('both', 'Project Tokyo', 'project roadmap for 東京 research'),
    ];

    const results = searchWorkspaceDocuments(mixed, 'project 東京', { intent: 'full_text' });

    const hit = results.find((result) => result.document.path === 'both');
    expect(hit).toBeDefined();
    expect(hit?.signals.fullText).toBeGreaterThan(0);
  });

  test('keeps exact dense-script matches above one-character variants', () => {
    const dense = [
      page('variant', 'Variant', '東京都の研究計画'),
      page('exact', 'Exact', '東京の研究計画'),
    ];

    const results = searchWorkspaceDocuments(dense, '東京の研究計画', { intent: 'full_text' });

    expect(results[0]?.document.path).toBe('exact');
  });

  test('incremental updates use the same tokenizer as a fresh corpus', () => {
    const initial = [page('existing', 'Existing', 'ordinary Latin text')];
    const corpus = createWorkspaceSearchCorpus(initial);
    const next = [...initial, page('inserted', '新しい文書', '共同研究の計画')];

    const update = updateWorkspaceSearchCorpus(corpus, next);
    const incremental = searchWorkspaceCorpus(update.corpus, '共同研究', { intent: 'full_text' });
    const fresh = searchWorkspaceDocuments(next, '共同研究', { intent: 'full_text' });

    expect(update.rebuilt).toBe(false);
    expect(incremental.map((result) => result.document.path)).toEqual(
      fresh.map((result) => result.document.path),
    );
    expect(incremental[0]?.document.path).toBe('inserted');
  });
});

describe('without Intl.Segmenter', () => {
  afterEach(() => {
    vi.resetModules();
  });

  test('loads safely and retains the base Latin tokenizer', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    vi.resetModules();
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });

    try {
      const fallbackModule = await import('./workspace-search.ts');
      const fallbackDocuments = [
        fallbackModule.createWorkspaceSearchDocument({
          kind: 'page',
          path: 'fallback',
          title: 'Fallback',
          content: 'ordinary Latin search remains available',
        }),
      ];

      expect(
        fallbackModule
          .searchWorkspaceDocuments(fallbackDocuments, 'ordinary', { intent: 'full_text' })
          .map((result) => result.document.path),
      ).toEqual(['fallback']);
    } finally {
      if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
      else Reflect.deleteProperty(Intl, 'Segmenter');
    }
  });
});
