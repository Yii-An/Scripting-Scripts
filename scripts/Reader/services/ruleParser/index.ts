/**
 * 规则解析器模块导出入口
 *
 * 提供书源规则的解析功能（仅解析，不执行）
 */

// CSS/XPath 选择器解析器
export {
  detectSelectorType,
  isCssSelector,
  isXPathSelector,
  extractSelector,
  parseAttribute,
  parseSlice,
  parseCssSelector,
  parseXPathSelector,
  parseSelector
} from './selectorParser'

// JSONPath 解析器
export { isJsonPath, extractJsonPath, parseJsonPathSlice, parseJsonPath } from './jsonPathParser'

// 正则表达式处理器
export { isRegexExpr, extractRegexPattern, parseRegexReplace, parseRegex, applyRegexReplace, applyRegexMatch, validateRegex } from './regexProcessor'

// 变量替换器
export { replaceVariables, hasVariables, extractVariableNames, validateTemplate, createVariableContext } from './variableReplacer'

// @js 脚本执行器
export { isJsExpr, extractJsCode, injectJsLib, generateWebViewScript, generateNativeScript, parseJsExpr } from './jsExecutor'
export type { JsExecutionContext, JsNode } from './jsExecutor'

// RuleParser 主解析器
export { RuleParser, ruleParser } from './RuleParser'
export type { ExprType, ExprNode, CompositeNode, ParsedExpr } from './RuleParser'
