/**
 * 工具调用重试与纠正机制
 * 
 * 功能：
 * - 检测模型输出中的格式错误（如未闭合标签、非法 JSON）
 * - 生成纠正指令注入到下一轮对话中
 * - 限制最大重试次数避免死循环
 */

import { ParsedToolCall, parseDSMLFormat } from "./dsml-parse";

/**
 * 重试指令结构
 */
export interface RetryDirective {
  /** 是否需要重试 */
  shouldRetry: boolean;
  /** 错误类型描述 */
  errorType?: string;
  /** 生成的纠正提示文本 */
  correctionPrompt?: string;
  /** 当前重试次数 */
  retryCount: number;
}

/**
 * 检测并评估是否需要重试
 * 
 * @param fullContent 模型完整输出内容
 * @param allowedNames 允许的工具名称集合
 * @param currentRetryCount 当前已重试次数
 * @param maxRetries 最大重试次数（默认 2）
 * @returns 重试指令
 */
export function evaluateRetryDirective(
  fullContent: string,
  allowedNames: Set<string>,
  currentRetryCount: number = 0,
  maxRetries: number = 2
): RetryDirective {
  // 超过最大重试次数，不再重试
  if (currentRetryCount >= maxRetries) {
    return {
      shouldRetry: false,
      errorType: "max_retries_exceeded",
      retryCount: currentRetryCount,
    };
  }

  const trimmed = fullContent.trim();
  
  // 空内容不需要重试
  if (!trimmed) {
    return {
      shouldRetry: false,
      retryCount: currentRetryCount,
    };
  }

  // 1. 检测未闭合的 DSML/XML 标签
  const unclosedTag = detectUnclosedTags(trimmed);
  if (unclosedTag) {
    return {
      shouldRetry: true,
      errorType: "unclosed_tag",
      correctionPrompt: generateUnclosedTagCorrection(unclosedTag),
      retryCount: currentRetryCount,
    };
  }

  // 2. 检测有标签但解析失败的情况
  const hasToolMarkup = /<\|?DSML\|?tool_calls|<tool_calls/i.test(trimmed);
  if (hasToolMarkup) {
    const parsed = parseDSMLFormat(trimmed, allowedNames);
    
    // 有标签但解析结果为空，说明格式有误
    if (parsed.length === 0) {
      return {
        shouldRetry: true,
        errorType: "parse_failure",
        correctionPrompt: generateParseFailureCorrection(trimmed),
        retryCount: currentRetryCount,
      };
    }
  }

  // 3. 检测半截 JSON（旧格式兼容）
  if (trimmed.startsWith("{") && !trimmed.endsWith("}")) {
    return {
      shouldRetry: true,
      errorType: "incomplete_json",
      correctionPrompt: generateIncompleteJsonCorrection(),
      retryCount: currentRetryCount,
    };
  }

  // 没有检测到错误，不需要重试
  return {
    shouldRetry: false,
    retryCount: currentRetryCount,
  };
}

/**
 * 检测未闭合的标签
 * 
 * @returns 返回未闭合的标签名，如果没有则返回 null
 */
function detectUnclosedTags(text: string): string | null {
  // 检查 tool_calls 标签
  const openToolCalls = (text.match(/<\|?DSML\|?tool_calls[^>]*>/gi) || []).length;
  const closeToolCalls = (text.match(/<\/\|?DSML\|?tool_calls>/gi) || []).length;
  if (openToolCalls > closeToolCalls) {
    return "tool_calls";
  }

  // 检查 invoke 标签
  const openInvokes = (text.match(/<\|?DSML\|?invoke[^>]*>/gi) || []).length;
  const closeInvokes = (text.match(/<\/\|?DSML\|?invoke>/gi) || []).length;
  if (openInvokes > closeInvokes) {
    return "invoke";
  }

  // 检查 parameter 标签
  const openParams = (text.match(/<\|?DSML\|?parameter[^>]*>/gi) || []).length;
  const closeParams = (text.match(/<\/\|?DSML\|?parameter>/gi) || []).length;
  if (openParams > closeParams) {
    return "parameter";
  }

  return null;
}

/**
 * 生成未闭合标签的纠正提示
 */
function generateUnclosedTagCorrection(tagName: string): string {
  return [
    "检测到未闭合的 <" + tagName + "> 标签。",
    "请确保所有打开的标签都有对应的闭合标签。",
    "正确格式示例：",
    "<|DSML|tool_calls>",
    "  <|DSML|invoke name=\"search\">",
    "    <|DSML|parameter name=\"query\"><![CDATA[关键词]]></|DSML|parameter>",
    "  </|DSML|invoke>",
    "</|DSML|tool_calls>",
  ].join("\n");
}

/**
 * 生成解析失败的纠正提示
 */
function generateParseFailureCorrection(content: string): string {
  // 截取前 100 字符作为示例
  const snippet = content.slice(0, 100) + (content.length > 100 ? "..." : "");
  return [
    "无法解析工具调用格式。检测到工具标记但提取失败。",
    "请检查：",
    "1. 标签名称是否正确（tool_calls / invoke / parameter）",
    "2. name 属性是否使用双引号包裹",
    "3. parameter 内容是否放在 CDATA 中或使用纯文本",
    "",
    "你的输出片段：" + snippet,
    "",
    "请重新输出完整的工具调用块。",
  ].join("\n");
}

/**
 * 生成不完整 JSON 的纠正提示
 */
function generateIncompleteJsonCorrection(): string {
  return [
    "检测到不完整的 JSON 格式。",
    "如果你要调用工具，请使用 DSML 格式：",
    "<|DSML|tool_calls>",
    "  <|DSML|invoke name=\"工具名称\">",
    "    <|DSML|parameter name=\"参数名\"><![CDATA[参数值]]></|DSML|parameter>",
    "  </|DSML|invoke>",
    "</|DSML|tool_calls>",
    "",
    "或者补全 JSON 对象的大括号。",
  ].join("\n");
}

/**
 * 构建重试消息内容
 * 
 * @param directive 重试指令
 * @param originalQuery 原始用户问题
 * @returns 注入到历史消息中的纠正提示
 */
export function buildRetryMessage(
  directive: RetryDirective,
  originalQuery: string
): string {
  if (!directive.shouldRetry || !directive.correctionPrompt) {
    return "";
  }

  return [
    "[系统提示] 上一轮响应格式有误（" + directive.errorType + "），请根据以下要求修正：",
    "",
    directive.correctionPrompt,
    "",
    "原始问题：" + originalQuery,
    "",
    "请重新输出正确的响应。",
  ].join("\n");
}