/**
 * 规则管理页面
 * 每个规则一个列表项，点击进入详情页选择搜索或发现
 */

import {
  Button,
  Form,
  NavigationStack,
  Section,
  Text,
  TextField,
  VStack,
  HStack,
  Spacer,
  useState,
  useEffect,
  Image,
  NavigationLink
} from 'scripting'
import type { Rule } from '../types'
import { UniversalContentType, UniversalContentTypeLabels } from '../types'
import {
  loadRules,
  deleteRule,
  clearAllRules,
  parseRuleJson,
  addRule,
  importRules,
  updateRulesFromUrl
} from '../services/ruleStorage'
import { SearchScreen } from './SearchScreen'
import { DiscoverScreen } from './DiscoverScreen'
import { logger } from '../services/logger'

/**
 * 获取内容类型标签
 */
function getContentTypeLabel(type: UniversalContentType): string {
  return UniversalContentTypeLabels[type] || '未知'
}

/**
 * 规则详情页 - 选择搜索或发现
 */
function RuleDetailScreen({ rule, onDelete }: { rule: Rule; onDelete: () => Promise<void> }) {
  return (
    <Form navigationTitle={rule.name}>
      {/* 规则信息 */}
      <Section header={<Text>书源信息</Text>}>
        <HStack spacing={12}>
          <Text foregroundStyle="secondaryLabel">类型</Text>
          <Spacer />
          <Text>{getContentTypeLabel(rule.contentType)}</Text>
        </HStack>
        <HStack spacing={12}>
          <Text foregroundStyle="secondaryLabel">域名</Text>
          <Spacer />
          <Text lineLimit={1}>{rule.host}</Text>
        </HStack>
        {rule.author ? (
          <HStack spacing={12}>
            <Text foregroundStyle="secondaryLabel">作者</Text>
            <Spacer />
            <Text>{rule.author}</Text>
          </HStack>
        ) : null}
      </Section>

      {/* 功能入口 */}
      <Section header={<Text>功能</Text>}>
        {rule.search?.enabled ? (
          <NavigationLink destination={<SearchScreen rule={rule} />}>
            <HStack>
              <Text>🔍 搜索</Text>
              <Spacer />
            </HStack>
          </NavigationLink>
        ) : (
          <HStack>
            <Text foregroundStyle="tertiaryLabel">🔍 搜索（未启用）</Text>
          </HStack>
        )}
        
        {rule.discover?.enabled ? (
          <NavigationLink destination={<DiscoverScreen rule={rule} />}>
            <HStack>
              <Text>📚 发现</Text>
              <Spacer />
            </HStack>
          </NavigationLink>
        ) : (
          <HStack>
            <Text foregroundStyle="tertiaryLabel">📚 发现（未启用）</Text>
          </HStack>
        )}
      </Section>

      {/* 操作 */}
      <Section>
        <Button
          title="删除此书源"
          action={onDelete}
          foregroundStyle="red"
        />
      </Section>
    </Form>
  )
}

/**
 * 规则列表页面
 */
export function RuleListScreen() {
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddSheet, setShowAddSheet] = useState(false)
  const [showUpdateSheet, setShowUpdateSheet] = useState(false)
  const [ruleJson, setRuleJson] = useState('')
  const [updateUrl, setUpdateUrl] = useState('')
  const [updating, setUpdating] = useState(false)

  // 加载规则
  const fetchRules = async () => {
    logger.info('[RuleListScreen] 加载规则列表')
    setLoading(true)
    setError(null)
    const result = await loadRules()
    if (result.success) {
      setRules(result.data || [])
      logger.info(`[RuleListScreen] 加载完成，共 ${result.data?.length || 0} 条规则`)
    } else {
      logger.error(`[RuleListScreen] 加载失败: ${result.error}`)
      setError(result.error || '加载失败')
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchRules()
  }, [])

  // 删除规则
  const handleDelete = async (ruleId: string) => {
    const confirm = await Dialog.confirm({
      title: '确认删除',
      message: '确定要删除这个规则吗？'
    })
    if (confirm) {
      logger.info(`[RuleListScreen] 删除规则: ${ruleId}`)
      const result = await deleteRule(ruleId)
      if (result.success) {
        fetchRules()
      } else {
        logger.error(`[RuleListScreen] 删除失败: ${result.error}`)
        await Dialog.alert({ title: '错误', message: result.error || '删除失败' })
      }
    }
  }

  // 添加规则
  const handleAddRule = async () => {
    if (!ruleJson.trim()) {
      await Dialog.alert({ title: '错误', message: '请输入规则 JSON' })
      return
    }

    const parseResult = parseRuleJson(ruleJson)
    if (!parseResult.success) {
      await Dialog.alert({ title: '解析失败', message: parseResult.error || '无效的 JSON' })
      return
    }

    const addResult = await addRule(parseResult.data!)
    if (addResult.success) {
      setRuleJson('')
      setShowAddSheet(false)
      fetchRules()
      await Dialog.alert({ title: '成功', message: '规则添加成功' })
    } else {
      await Dialog.alert({ title: '错误', message: addResult.error || '添加失败' })
    }
  }

  // 从剪贴板导入
  const handleImportFromClipboard = async () => {
    logger.info('[RuleListScreen] 从剪贴板导入规则')
    const content = await Pasteboard.getString()
    if (!content) {
      logger.warn('[RuleListScreen] 剪贴板为空')
      await Dialog.alert({ title: '错误', message: '剪贴板为空' })
      return
    }

    const result = await importRules(content)
    if (result.success) {
      fetchRules()
      await Dialog.alert({ title: '成功', message: `成功导入 ${result.data} 条规则` })
    } else {
      await Dialog.alert({ title: '导入失败', message: result.error || '导入失败' })
    }
  }

  // 从 URL 更新书源
  const handleUpdateFromUrl = async () => {
    if (!updateUrl.trim()) {
      await Dialog.alert({ title: '错误', message: '请输入书源 URL' })
      return
    }

    setUpdating(true)
    const result = await updateRulesFromUrl(updateUrl.trim())
    setUpdating(false)

    if (result.success) {
      const { added, updated } = result.data!
      setUpdateUrl('')
      setShowUpdateSheet(false)
      fetchRules()
      await Dialog.alert({
        title: '更新成功',
        message: `新增 ${added} 个书源，更新 ${updated} 个书源`
      })
    } else {
      await Dialog.alert({ title: '更新失败', message: result.error || '更新失败' })
    }
  }

  // 清空所有书源
  const handleClearAll = async () => {
    if (rules.length === 0) {
      await Dialog.alert({ title: '提示', message: '当前没有书源可清空' })
      return
    }

    const confirm = await Dialog.confirm({
      title: '确认清空',
      message: `确定要删除全部 ${rules.length} 个书源吗？此操作不可撤销！`
    })
    if (confirm) {
      const result = await clearAllRules()
      if (result.success) {
        fetchRules()
        await Dialog.alert({ title: '成功', message: '已清空所有书源' })
      } else {
        await Dialog.alert({ title: '错误', message: result.error || '清空失败' })
      }
    }
  }

  return (
    <NavigationStack>
      <Form
        navigationTitle="书源管理"
        toolbar={{
          topBarLeading: (
            <Button
              title="刷新"
              action={fetchRules}
              disabled={loading}
            />
          ),
          topBarTrailing: (
            <HStack spacing={16}>
              <Button
                title="添加"
                action={() => setShowAddSheet(true)}
              />
              <Button
                title="更多"
                action={async () => {
                  const result = await Dialog.actionSheet({
                    title: '更多操作',
                    actions: [
                      { label: '从剪贴板导入' },
                      { label: '从 URL 更新' },
                      { label: '清空全部书源', destructive: true }
                    ]
                  })
                  if (result === 0) {
                    handleImportFromClipboard()
                  } else if (result === 1) {
                    setShowUpdateSheet(true)
                  } else if (result === 2) {
                    handleClearAll()
                  }
                }}
              />
            </HStack>
          )
        }}
      >
        {/* 加载状态 */}
        {loading ? (
          <Section>
            <VStack padding={60} alignment="center" frame={{ maxWidth: "infinity" }}>
              <Text foregroundStyle="secondaryLabel">加载中...</Text>
            </VStack>
          </Section>
        ) : null}

        {/* 错误信息 */}
        {error ? (
          <Section>
            <VStack padding={60} alignment="center" frame={{ maxWidth: "infinity" }}>
              <Text foregroundStyle="red">{error}</Text>
            </VStack>
          </Section>
        ) : null}

        {/* 规则列表 - 每个规则一行，点击进入详情页 */}
        {rules.length > 0 ? (
          <Section header={<Text>已导入 {rules.length} 个书源</Text>}>
            {rules.map((rule) => (
              <NavigationLink
                key={rule.id}
                destination={
                  <RuleDetailScreen
                    rule={rule}
                    onDelete={async () => handleDelete(rule.id)}
                  />
                }
              >
                <HStack spacing={12} padding={{ vertical: 4 }}>
                  {rule.icon ? (
                    <Image
                      imageUrl={rule.icon}
                      resizable
                      frame={{ width: 44, height: 44 }}
                      clipShape={{ type: 'rect', cornerRadius: 8 }}
                    />
                  ) : (
                    <VStack
                      frame={{ width: 44, height: 44 }}
                      background="systemBlue"
                      alignment="center"
                      clipShape={{ type: 'rect', cornerRadius: 8 }}
                    >
                      <Text foregroundStyle="white">{rule.name.charAt(0)}</Text>
                    </VStack>
                  )}
                  <VStack alignment="leading" spacing={2}>
                    <Text font="body">{rule.name}</Text>
                    <HStack spacing={6}>
                      <Text font="caption" foregroundStyle="secondaryLabel">
                        {getContentTypeLabel(rule.contentType)}
                      </Text>
                      <Text font="caption" foregroundStyle="tertiaryLabel">
                        {rule.host}
                      </Text>
                    </HStack>
                  </VStack>
                  <Spacer />
                </HStack>
              </NavigationLink>
            ))}
          </Section>
        ) : !loading ? (
          <Section>
            <VStack padding={60} alignment="center" spacing={20} frame={{ maxWidth: "infinity" }}>
              <Text font={80}>📚</Text>
              <VStack spacing={8}>
                <Text font="title2" fontWeight="semibold">暂无书源</Text>
                <Text font="subheadline" foregroundStyle="secondaryLabel">
                  快来添加你喜欢的阅读源吧
                </Text>
              </VStack>
              <Button
                title="从剪贴板导入"
                action={handleImportFromClipboard}
                buttonStyle="borderedProminent"
                controlSize="large"
              />
            </VStack>
          </Section>
        ) : null}

        {/* 添加规则 Sheet */}
        {showAddSheet ? (
          <Section header={<Text>添加书源</Text>}>
            <TextField
              title="规则 JSON"
              value={ruleJson}
              onChanged={setRuleJson}
              prompt="粘贴规则 JSON..."
              axis="vertical"
              lineLimit={{ min: 5, max: 10 }}
            />
            <HStack spacing={12}>
              <Button
                title="取消"
                action={() => {
                  setShowAddSheet(false)
                  setRuleJson('')
                }}
                foregroundStyle="red"
              />
              <Spacer />
              <Button
                title="粘贴"
                action={async () => {
                  const content = await Pasteboard.getString()
                  if (content) setRuleJson(content)
                }}
              />
              <Button
                title="添加"
                action={handleAddRule}
              />
            </HStack>
          </Section>
        ) : null}

        {/* 更新书源 Sheet */}
        {showUpdateSheet ? (
          <Section header={<Text>从 URL 更新书源</Text>}>
            <TextField
              title="书源 URL"
              value={updateUrl}
              onChanged={setUpdateUrl}
              prompt="输入书源 JSON 的 URL..."
            />
            <HStack spacing={12}>
              <Button
                title="取消"
                action={() => {
                  setShowUpdateSheet(false)
                  setUpdateUrl('')
                }}
                foregroundStyle="red"
              />
              <Spacer />
              <Button
                title="粘贴"
                action={async () => {
                  const content = await Pasteboard.getString()
                  if (content) setUpdateUrl(content)
                }}
              />
              <Button
                title={updating ? '更新中...' : '更新'}
                action={handleUpdateFromUrl}
                disabled={updating}
              />
            </HStack>
          </Section>
        ) : null}
      </Form>
    </NavigationStack>
  )
}
