/**
 * 内置测试书源
 *
 * 说明：用于开发/验收流程，生产环境应通过书源管理导入。
 */

import type { Source } from '../types'

export const TEST_SOURCES: Source[] = [
  {
    id: 'test-novel-api',
    name: '测试小说源 (API)',
    host: 'https://api.example.com',
    type: 'novel',
    enabled: true,
    search: {
      request: { url: '{{host}}/search?q={{keyword}}', action: 'fetch' },
      parse: {
        list: '@js:JSON.parse(result).data.list',
        fields: {
          name: '@js:result.title',
          author: '@js:result.author',
          url: "@js:host + '/book/' + result.id"
        }
      }
    },
    chapter: {
      request: { url: '{{url}}/chapters', action: 'fetch' },
      parse: {
        list: '@js:JSON.parse(result).chapters',
        fields: {
          name: '@js:result.title',
          url: "@js:host + '/chapter/' + result.id"
        }
      }
    },
    content: {
      request: { url: '{{url}}', action: 'fetch' },
      parse: { content: '@js:JSON.parse(result).content' }
    }
  },
  {
    id: 'test-novel-html',
    name: '测试小说源 (HTML)',
    host: 'https://www.example-novel.com',
    type: 'novel',
    enabled: true,
    search: {
      request: { url: '{{host}}/search?q={{keyword}}', action: 'loadUrl' },
      parse: {
        list: '.search-result .book-item',
        fields: {
          name: '.book-title@text',
          author: '.book-author@text',
          cover: '.book-cover img@src',
          intro: '.book-desc@text',
          latestChapter: '.latest-chapter@text',
          url: 'a.book-link@href'
        }
      }
    },
    chapter: {
      request: { url: '{{url}}', action: 'loadUrl' },
      parse: {
        list: '.chapter-list li',
        fields: {
          name: 'a@text',
          url: 'a@href'
        }
      }
    },
    content: {
      request: { url: '{{url}}', action: 'loadUrl' },
      parse: {
        title: 'h1.chapter-title@text',
        content: '#content@text'
      }
    }
  }
]
