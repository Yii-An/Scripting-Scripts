import { 
  Button, 
  Form, 
  NavigationStack, 
  NavigationLink,
  Section, 
  Text, 
  VStack, 
  HStack,
  Image,
  Spacer,
  useState,
  useEffect
} from 'scripting'
import type { SearchItem, Rule } from '../types'
import { ChapterListScreen } from './ChapterListScreen'
import { RuleListScreen } from './RuleListScreen'
import { getRule } from '../services/ruleStorage'

/**
 * 书架项类型
 */
type BookshelfItem = SearchItem & {
  ruleId: string      // 规则ID
  ruleName: string    // 规则名称
  addedAt: number     // 添加时间
  lastReadAt?: number // 最后阅读时间
  lastChapter?: string // 最后阅读章节
}

/**
 * 书架存储 Key
 */
const BOOKSHELF_KEY = 'any-reader-bookshelf'

/**
 * 加载书架数据
 */
async function loadBookshelf(): Promise<BookshelfItem[]> {
  try {
    const data = await Keychain.get(BOOKSHELF_KEY)
    if (data) {
      return JSON.parse(data)
    }
  } catch (e) {
    console.error('加载书架失败:', e)
  }
  return []
}

/**
 * 保存书架数据
 */
async function saveBookshelf(items: BookshelfItem[]): Promise<void> {
  try {
    await Keychain.set(BOOKSHELF_KEY, JSON.stringify(items))
  } catch (e) {
    console.error('保存书架失败:', e)
  }
}

/**
 * 书籍详情页包装器（加载规则后显示章节）
 */
function BookDetailWrapper({ book }: { book: BookshelfItem }) {
  const [rule, setRule] = useState<Rule | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getRule(book.ruleId).then((result) => {
      if (result.success && result.data) {
        setRule(result.data)
      } else {
        setError('规则不存在或已被删除')
      }
      setLoading(false)
    })
  }, [book.ruleId])

  if (loading) {
    return (
      <Form navigationTitle={book.name}>
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="gray">加载中...</Text>
          </VStack>
        </Section>
      </Form>
    )
  }

  if (error || !rule) {
    return (
      <Form navigationTitle={book.name}>
        <Section>
          <VStack padding={40} alignment="center">
            <Text foregroundStyle="red">{error || '加载失败'}</Text>
          </VStack>
        </Section>
      </Form>
    )
  }

  return <ChapterListScreen rule={rule} item={book} />
}

/**
 * 书架页面（首页）
 */
export const HomeScreen = () => {
  const [books, setBooks] = useState<BookshelfItem[]>([])
  const [loading, setLoading] = useState(true)

  // 加载书架
  useEffect(() => {
    loadBookshelf().then(items => {
      // 按最后阅读时间排序
      items.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt))
      setBooks(items)
      setLoading(false)
    })
  }, [])

  // 删除书籍
  const removeBook = async (url: string) => {
    const confirmed = await Dialog.confirm({
      title: '确认删除',
      message: '确定要从书架中移除这本书吗？'
    })
    
    if (confirmed) {
      const newBooks = books.filter(b => b.url !== url)
      setBooks(newBooks)
      await saveBookshelf(newBooks)
    }
  }

  return (
    <NavigationStack>
      <Form
        navigationTitle="书架"
        toolbar={{
          topBarTrailing: (
            <NavigationLink destination={<RuleListScreen />}>
              <Text>书源</Text>
            </NavigationLink>
          )
        }}
      >
        {loading ? (
          <Section>
            <VStack padding={40} alignment="center">
              <Text foregroundStyle="gray">加载中...</Text>
            </VStack>
          </Section>
        ) : books.length === 0 ? (
          <Section>
            <VStack padding={40} alignment="center" spacing={16} frame={{ maxWidth: "infinity" }}>
              <Text font="title2">📚</Text>
              <Text foregroundStyle="gray">书架空空如也</Text>
              <Text foregroundStyle="gray" font="caption">
                去书源搜索添加书籍吧
              </Text>
            </VStack>
          </Section>
        ) : (
          <Section header={<Text>共 {books.length} 本</Text>}>
            {books.map((book) => (
              <NavigationLink
                key={book.url}
                destination={<BookDetailWrapper book={book} />}
              >
                <HStack spacing={12} padding={{ vertical: 8 }}>
                  {book.cover ? (
                    <Image 
                      imageUrl={book.cover} 
                      frame={{ width: 60, height: 80 }}
                      resizable
                      scaleToFit
                      clipShape="rect"
                    />
                  ) : (
                    <VStack 
                      frame={{ width: 60, height: 80 }} 
                      background="gray"
                      alignment="center"
                    >
                      <Text font="title2">📖</Text>
                    </VStack>
                  )}
                  <VStack alignment="leading" spacing={4}>
                    <Text font="headline" lineLimit={1}>{book.name}</Text>
                    {book.author ? (
                      <Text font="subheadline" foregroundStyle="gray" lineLimit={1}>
                        {book.author}
                      </Text>
                    ) : null}
                    {book.lastChapter ? (
                      <Text font="caption" foregroundStyle="gray" lineLimit={1}>
                        上次: {book.lastChapter}
                      </Text>
                    ) : null}
                    <Text font="caption2" foregroundStyle="gray">
                      {book.ruleName}
                    </Text>
                  </VStack>
                  <Spacer />
                </HStack>
              </NavigationLink>
            ))}
          </Section>
        )}
      </Form>
    </NavigationStack>
  )
}

/**
 * 添加书籍到书架
 */
export async function addToBookshelf(
  item: SearchItem, 
  ruleId: string, 
  ruleName: string
): Promise<boolean> {
  const books = await loadBookshelf()
  
  // 检查是否已存在
  const exists = books.some(b => b.url === item.url)
  if (exists) {
    await Dialog.alert({ title: '提示', message: '书籍已在书架中' })
    return false
  }
  
  // 添加新书
  const newBook: BookshelfItem = {
    ...item,
    ruleId,
    ruleName,
    addedAt: Date.now()
  }
  
  books.unshift(newBook)
  await saveBookshelf(books)
  await Dialog.alert({ title: '成功', message: '已添加到书架' })
  return true
}

/**
 * 更新阅读进度
 */
export async function updateReadProgress(
  url: string, 
  chapterName: string
): Promise<void> {
  const books = await loadBookshelf()
  const book = books.find(b => b.url === url)
  
  if (book) {
    book.lastReadAt = Date.now()
    book.lastChapter = chapterName
    await saveBookshelf(books)
  }
}

/**
 * 检查是否在书架中
 */
export async function isInBookshelf(url: string): Promise<boolean> {
  const books = await loadBookshelf()
  return books.some(b => b.url === url)
}