/**
 * 规则存储服务
 * 使用 FileManager 持久化存储规则
 */

import type { Rule, RuleResult } from '../types'
import { UniversalContentType } from '../types'
import { logger } from './logger'

const RULES_FILE_NAME = 'reader/rules.json'

/**
 * 获取规则存储路径
 */
function getRulesFilePath(): string {
  const documentsDir = FileManager.documentsDirectory
  return `${documentsDir}/${RULES_FILE_NAME}`
}

/**
 * 加载所有规则
 */
export async function loadRules(): Promise<RuleResult<Rule[]>> {
  try {
    const filePath = getRulesFilePath()
    
    const fileExists = await FileManager.exists(filePath)
    if (!fileExists) {
      return { success: true, data: [] }
    }
    
    const content = await FileManager.readAsString(filePath)
    if (!content) {
      return { success: true, data: [] }
    }
    
    const rules = JSON.parse(content) as Rule[]
    return { success: true, data: rules }
  } catch (error: any) {
    return { success: false, error: error.message || '加载规则失败' }
  }
}

/**
 * 保存所有规则
 */
export async function saveRules(rules: Rule[]): Promise<RuleResult<void>> {
  try {
    const filePath = getRulesFilePath()
    // 确保父目录存在
    const dir = `${FileManager.documentsDirectory}/reader`
    const dirExists = await FileManager.exists(dir)
    if (!dirExists) {
      logger.info(`创建规则存储目录: ${dir}`)
      await FileManager.createDirectory(dir)
    }
    const content = JSON.stringify(rules, null, 2)
    await FileManager.writeAsString(filePath, content)
    logger.debug(`规则已保存，共 ${rules.length} 条`)
    return { success: true }
  } catch (error: any) {
    logger.error(`保存规则失败: ${error.message}`)
    return { success: false, error: error.message || '保存规则失败' }
  }
}

/**
 * 添加规则
 */
export async function addRule(rule: Rule): Promise<RuleResult<void>> {
  try {
    logger.info(`正在添加规则: ${rule.name} (${rule.id})`)
    const result = await loadRules()
    if (!result.success) {
      return { success: false, error: result.error }
    }
    
    const rules = result.data || []
    
    // 检查是否已存在
    const existingIndex = rules.findIndex(r => r.id === rule.id)
    if (existingIndex >= 0) {
      rules[existingIndex] = rule
      logger.info(`规则已更新: ${rule.name}`)
    } else {
      rules.push(rule)
      logger.info(`规则已添加: ${rule.name}`)
    }
    
    return await saveRules(rules)
  } catch (error: any) {
    logger.error(`添加规则失败: ${error.message}`)
    return { success: false, error: error.message || '添加规则失败' }
  }
}

/**
 * 删除规则
 */
export async function deleteRule(ruleId: string): Promise<RuleResult<void>> {
  try {
    logger.info(`正在删除规则: ${ruleId}`)
    const result = await loadRules()
    if (!result.success) {
      return { success: false, error: result.error }
    }
    
    const rules = result.data || []
    const filteredRules = rules.filter(r => r.id !== ruleId)
    
    if (filteredRules.length < rules.length) {
      logger.info(`规则已删除`)
    }
    
    return await saveRules(filteredRules)
  } catch (error: any) {
    logger.error(`删除规则失败: ${error.message}`)
    return { success: false, error: error.message || '删除规则失败' }
  }
}

/**
 * 清空所有规则
 */
export async function clearAllRules(): Promise<RuleResult<void>> {
  try {
    return await saveRules([])
  } catch (error: any) {
    return { success: false, error: error.message || '清空规则失败' }
  }
}

/**
 * 根据 ID 获取规则
 */
export async function getRule(ruleId: string): Promise<RuleResult<Rule | null>> {
  try {
    const result = await loadRules()
    if (!result.success) {
      return { success: false, error: result.error }
    }
    
    const rules = result.data || []
    const rule = rules.find(r => r.id === ruleId) || null
    
    return { success: true, data: rule }
  } catch (error: any) {
    return { success: false, error: error.message || '获取规则失败' }
  }
}

/**
 * 解析 JSON 规则字符串
 */
export function parseRuleJson(json: string): RuleResult<Rule> {
  try {
    const rule = JSON.parse(json) as Rule
    
    // 验证必须字段
    if (!rule.id || !rule.name || !rule.host) {
      return { success: false, error: '规则缺少必要字段 (id, name, host)' }
    }
    
    // 设置默认值
    if (rule.contentType === undefined) {
      rule.contentType = UniversalContentType.NOVEL // 默认小说
    }
    
    return { success: true, data: rule }
  } catch (error: any) {
    return { success: false, error: '无效的 JSON 格式' }
  }
}

/**
 * 生成规则 ID
 */
export function generateRuleId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

/**
 * 导出规则为 JSON 字符串
 */
export function exportRule(rule: Rule): string {
  return JSON.stringify(rule, null, 2)
}

/**
 * 导出所有规则为 JSON 字符串
 */
export async function exportAllRules(): Promise<RuleResult<string>> {
  try {
    const result = await loadRules()
    if (!result.success) {
      return { success: false, error: result.error }
    }
    
    const json = JSON.stringify(result.data, null, 2)
    return { success: true, data: json }
  } catch (error: any) {
    return { success: false, error: error.message || '导出失败' }
  }
}

/**
 * 从 URL 更新规则
 */
export async function updateRulesFromUrl(url: string): Promise<RuleResult<{ added: number; updated: number }>> {
  try {
    // 获取远程数据
    const response = await fetch(url)
    if (!response.ok) {
      return { success: false, error: `HTTP 错误: ${response.status}` }
    }
    const responseText = await response.text()

    if (!responseText) {
      return { success: false, error: '无法获取远程数据' }
    }

    // 解析 JSON
    let remoteRules: Rule[]
    try {
      const parsed = JSON.parse(responseText)
      if (Array.isArray(parsed)) {
        remoteRules = parsed
      } else if (typeof parsed === 'object' && parsed.id) {
        remoteRules = [parsed]
      } else {
        return { success: false, error: '无效的规则格式' }
      }
    } catch {
      return { success: false, error: '无效的 JSON 格式' }
    }

    // 加载现有规则
    const existingResult = await loadRules()
    const existingRules = existingResult.success ? (existingResult.data || []) : []
    const existingMap = new Map(existingRules.map(r => [r.id, r]))

    // 统计
    let added = 0
    let updated = 0

    // 合并规则
    for (const rule of remoteRules) {
      if (!rule.id || !rule.name || !rule.host) {
        continue // 跳过无效规则
      }

      if (existingMap.has(rule.id)) {
        existingMap.set(rule.id, rule)
        updated++
      } else {
        existingMap.set(rule.id, rule)
        added++
      }
    }

    // 保存合并后的规则
    const mergedRules = Array.from(existingMap.values())
    const saveResult = await saveRules(mergedRules)

    if (!saveResult.success) {
      return { success: false, error: saveResult.error }
    }

    return { success: true, data: { added, updated } }
  } catch (error: any) {
    return { success: false, error: error.message || '更新失败' }
  }
}

/**
 * 导入规则（支持单个规则或规则数组）
 */
export async function importRules(json: string): Promise<RuleResult<number>> {
  try {
    logger.info(`开始导入规则，JSON 长度: ${json.length}`)
    logger.debug(`导入内容预览: ${json.substring(0, 200)}...`)
    
    const parsed = JSON.parse(json)
    logger.debug(`JSON 解析成功，类型: ${typeof parsed}, 是否数组: ${Array.isArray(parsed)}`)
    
    let rulesToImport: Rule[] = []
    
    if (Array.isArray(parsed)) {
      rulesToImport = parsed
      logger.info(`解析到规则数组，共 ${parsed.length} 条`)
    } else if (typeof parsed === 'object' && parsed.id) {
      rulesToImport = [parsed]
      logger.info(`解析到单个规则: ${parsed.name || parsed.id}`)
    } else {
      logger.warn(`无效的规则格式: ${JSON.stringify(parsed).substring(0, 100)}`)
      return { success: false, error: '无效的规则格式' }
    }
    
    // 验证并添加每个规则
    let importedCount = 0
    for (const rule of rulesToImport) {
      if (rule.id && rule.name && rule.host) {
        logger.debug(`导入规则: ${rule.name} (id=${rule.id}, host=${rule.host})`)
        const addResult = await addRule(rule)
        if (addResult.success) {
          importedCount++
        } else {
          logger.warn(`规则 ${rule.name} 导入失败: ${addResult.error}`)
        }
      } else {
        logger.warn(`跳过无效规则: id=${rule.id}, name=${rule.name}, host=${rule.host}`)
      }
    }
    
    logger.info(`规则导入完成: ${importedCount}/${rulesToImport.length} 条成功`)
    return { success: true, data: importedCount }
  } catch (error: any) {
    logger.error(`导入规则失败: ${error.message}`)
    return { success: false, error: error.message || '导入失败' }
  }
}
