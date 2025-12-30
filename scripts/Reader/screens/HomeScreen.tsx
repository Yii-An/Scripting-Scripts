/**
 * HomeScreen 首页（书架）
 */

import { Button, Group, HStack, Image, List, NavigationLink, Section, Text, VStack, useCallback, useEffect, useMemo, useRef, useState } from 'scripting'

import { EmptyBookshelfView, EmptyView } from '../components'
import { checkAllUpdates, getBookshelf, getRecentlyRead, removeBookFromBookshelf } from '../services/bookshelfService'
import { getStoredSources } from '../services/sourceStore'
import type { BookshelfItem, Source } from '../types'
import { DiscoverScreen } from './DiscoverScreen'
import { SearchScreen } from './SearchScreen'
import { SettingsScreen } from './SettingsScreen'
import { BookDetailScreen } from './BookDetailScreen'

function keyOf(item: Pick<BookshelfItem, 'sourceId' | 'id'>): string {
  return `${item.sourceId}::${item.id}`
}

export function HomeScreen() {
  const [bookshelf, setBookshelf] = useState<BookshelfItem[]>([])
  const [recentlyRead, setRecentlyRead] = useState<BookshelfItem[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [updatedKeys, setUpdatedKeys] = useState<Set<string>>(new Set())
  const refreshSeqRef = useRef(0)

  const sourcesById = useMemo(() => new Map(sources.map(s => [s.id, s])), [sources])

  useEffect(() => {
    return () => {
      // 使未完成刷新失效，避免卸载后更新状态
      refreshSeqRef.current++
    }
  }, [])

  const refreshLocal = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    setSources(getStoredSources())
    setBookshelf(getBookshelf())
    try {
      const recent = await getRecentlyRead(10)
      if (seq !== refreshSeqRef.current) return
      setRecentlyRead(recent)
    } catch {
      if (seq !== refreshSeqRef.current) return
      setRecentlyRead([])
    }
  }, [])

  const refreshAndCheckUpdates = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    try {
      const updated = await checkAllUpdates()
      if (seq !== refreshSeqRef.current) return
      setUpdatedKeys(new Set(updated.map(keyOf)))
    } catch {
      if (seq !== refreshSeqRef.current) return
      setUpdatedKeys(new Set())
    } finally {
      await refreshLocal()
    }
  }, [refreshLocal])

  const onRemove = useCallback(
    (item: BookshelfItem) => {
      removeBookFromBookshelf(item)
      setUpdatedKeys(keys => {
        const next = new Set(keys)
        next.delete(keyOf(item))
        return next
      })
      void refreshLocal()
    },
    [refreshLocal]
  )

  return (
    <List
      navigationTitle="阅读"
      onAppear={() => void refreshLocal()}
      refreshable={refreshAndCheckUpdates}
      toolbar={{
        topBarTrailing: (
          <HStack>
            <NavigationLink destination={<DiscoverScreen />}>
              <Image systemName="sparkles" />
            </NavigationLink>
            <NavigationLink destination={<SearchScreen />}>
              <Image systemName="magnifyingglass" />
            </NavigationLink>
            <NavigationLink destination={<SettingsScreen />}>
              <Image systemName="gearshape" />
            </NavigationLink>
          </HStack>
        )
      }}
    >
      <Section header={<Text>最近阅读</Text>}>
        {recentlyRead.length ? (
          recentlyRead.map(item => {
            const source = sourcesById.get(item.sourceId)
            if (!source) {
              return (
                <VStack key={`${item.sourceId}::${item.id}`} alignment="leading" spacing={4}>
                  <Text font="headline">{item.name}</Text>
                  <Text font="caption" foregroundStyle="#8E8E93">
                    书源缺失：{item.sourceId}
                  </Text>
                </VStack>
              )
            }

            return (
              <NavigationLink key={`${item.sourceId}::${item.id}`} destination={<BookDetailScreen source={source} book={item} />}>
                <VStack alignment="leading" spacing={4}>
                  <Text font="headline">{item.name}</Text>
                  {item.author ? (
                    <Text font="caption" foregroundStyle="#8E8E93">
                      {item.author}
                    </Text>
                  ) : null}
                </VStack>
              </NavigationLink>
            )
          })
        ) : (
          <EmptyView icon="clock" title="暂无最近阅读" description="打开任意书籍开始阅读" />
        )}
      </Section>

      <Section header={<Text>书架</Text>}>
        {bookshelf.length ? (
          bookshelf.map(item => {
            const source = sourcesById.get(item.sourceId)
            const hasUpdate = updatedKeys.has(keyOf(item))

            const row = (
              <VStack alignment="leading" spacing={4}>
                <HStack spacing={8}>
                  <Text font="headline">{item.name}</Text>
                  {hasUpdate ? (
                    <Text font="caption" foregroundStyle="#FF3B30">
                      更新
                    </Text>
                  ) : null}
                </HStack>
                <HStack spacing={8}>
                  {item.author ? (
                    <Text font="caption" foregroundStyle="#8E8E93">
                      {item.author}
                    </Text>
                  ) : null}
                  {source ? (
                    <Text font="caption" foregroundStyle="#8E8E93">
                      {source.name}
                    </Text>
                  ) : (
                    <Text font="caption" foregroundStyle="#8E8E93">
                      书源缺失：{item.sourceId}
                    </Text>
                  )}
                </HStack>
              </VStack>
            )

            const commonActions = {
              trailingSwipeActions: {
                allowsFullSwipe: true,
                actions: [<Button key="delete" title="删除" role="destructive" action={() => onRemove(item)} />]
              },
              contextMenu: {
                menuItems: (
                  <Group>
                    <Button title="删除" role="destructive" action={() => onRemove(item)} />
                  </Group>
                )
              }
            }

            if (source) {
              return (
                <NavigationLink key={keyOf(item)} destination={<BookDetailScreen source={source} book={item} />} {...commonActions}>
                  {row}
                </NavigationLink>
              )
            }

            return (
              <VStack key={keyOf(item)} {...commonActions}>
                {row}
              </VStack>
            )
          })
        ) : (
          <>
            <EmptyBookshelfView />
            <NavigationLink destination={<SearchScreen />}>
              <Text>去搜索添加书籍</Text>
            </NavigationLink>
          </>
        )}
      </Section>
    </List>
  )
}
