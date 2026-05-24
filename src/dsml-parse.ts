/**
 * DSML/XML 格式工具调用解析器
 *
 * 设计原则：
 * - 不引入第三方 XML 解析库
 * - 使用 markup-scan.ts 的底层扫描函数
 * - 支持自动修复缺失的包装标签
 * - JSON 作为回退兼容
 */

import {
  findBlocks,
  findToolMarkupTagOutsideIgnored,
  foldFullwidth,
  type ToolMarkupTag,
} from "./markup-scan";

/**
 * 解析后的工具调用结构
 */
export interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * consumeDSMLToolCapture 的返回类型
 */
export interface DSMLCaptureResult {
  /** 工具调用块之前的普通文本 */
  prefix: string;
  /** 解析出的工具调用数组 */
  calls: ParsedToolCall[];
  /** 工具调用块之后的剩余文本 */
  suffix: string;
  /** 是否已找到完整的闭合标签 */
  ready: boolean;
}

/**
 * 从 parameter 标签体中提取值
 * 支持 CDATA 和纯文本，尝试 JSON.parse 推断类型
 */
function extractParameterValue(body: string): unknown {
  const trimmed = body.trim();

  // 尝试提取 CDATA 内容
  const cdataStart = trimmed.indexOf("<![CDATA[");
  if (cdataStart !== -1) {
    const cdataEnd = trimmed.indexOf("]]>", cdataStart);
    if (cdataEnd !== -1) {
      const value = trimmed.slice(cdataStart + 9, cdataEnd);
      return tryParseValue(value);
    }
  }

  // 纯文本内容
  return tryParseValue(trimmed);
}

/**
 * 尝试将字符串解析为数字/布尔/对象/数组，失败则保持字符串
 */
function tryParseValue(value: string): unknown {
  if (!value) return "";

  // 尝试 JSON.parse
  try {
    return JSON.parse(value);
  } catch {
    // 保持字符串
  }

  return value;
}

/**
 * 从标签文本中提取 name 属性值
 */
function extractNameAttr(tagText: string): string | null {
  const nameMatch = tagText.match(/name\s*=\s*["']([^"']+)["']/);
  return nameMatch ? nameMatch[1] : null;
}

/**
 * 自动修复缺失的 <tool_calls> 包装标签
 * 如果检测到 <invoke> 但没有被 <tool_calls> 包裹，自动补全
 */
function repairMissingWrapper(text: string): string {
  const folded = foldFullwidth(text);

  // 检查是否已有 tool_calls 包装
  const hasToolCallsOpen = /<\|?DSML\|?tool_calls|<tool_calls/i.test(folded);
  if (hasToolCallsOpen) {
    return text;
  }

  // 查找第一个 invoke 开标签
  const invokeOpenMatch = folded.match(/<\|?DSML\|?invoke\b|<invoke\b/i);
  if (!invokeOpenMatch || invokeOpenMatch.index === undefined) {
    return text;
  }

  // 查找最后一个 invoke 闭标签
  let lastInvokeCloseIndex = -1;
  const closeRegex = /<\/\|?DSML\|?invoke>|<\/invoke>/gi;
  let match;
  while ((match = closeRegex.exec(folded)) !== null) {
    lastInvokeCloseIndex = match.index + match[0].length;
  }

  if (lastInvokeCloseIndex === -1) {
    return text;
  }

  // 在第一个 invoke 前插入 <tool_calls>，在最后一个 </invoke> 后插入 </tool_calls>
  const insertPos = invokeOpenMatch.index;
  const result =
    text.slice(0, insertPos) +
    "<|DSML|tool_calls>\n" +
    text.slice(insertPos, lastInvokeCloseIndex) +
    "\n</|DSML|tool_calls>" +
    text.slice(lastInvokeCloseIndex);

  return result;
}

/**
 * 解析单个 invoke 块为 ParsedToolCall
 */
function parseInvokeBlock(
  body: string,
  openTag: ToolMarkupTag,
  fullText: string,
  allowedNames: Set<string>
): ParsedToolCall | null {
  const tagText = fullText.slice(openTag.start, openTag.end);
  const name = extractNameAttr(tagText);
  if (!name) return null;

  // 检查工具名是否在允许列表中
  if (allowedNames.size > 0 && !allowedNames.has(name)) {
    return null;
  }

  // 提取所有 parameter 子标签
  const paramBlocks = findBlocks(body, "parameter");
  const input: Record<string, unknown> = {};

  for (const block of paramBlocks) {
    const paramTagText = body.slice(block.open.start, block.open.end);
    const paramName = extractNameAttr(paramTagText);
    if (paramName) {
      input[paramName] = extractParameterValue(block.body);
    }
  }

  return { name, input };
}

/**
 * 尝试解析 Hash 标记格式: ##TOOL_CALL## {"name":"...","input":{...}} ##END_CALL##
 */
function parseHashFormat(
  text: string,
  allowedNames: Set<string>
): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const hashRegex = /##TOOL_CALL##\s*({[\s\S]*?})\s*##END_CALL##/g;
  let match;

  while ((match = hashRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const name = parsed.name;
      if (name && (allowedNames.size === 0 || allowedNames.has(name))) {
        results.push({
          name,
          input: (parsed.input || parsed.arguments || {}) as Record<
            string,
            unknown
          >,
        });
      }
    } catch {
      // 忽略解析失败
    }
  }

  return results;
}

/**
 * 尝试解析代码块格式: ```tool_call\n{"name":"...","input":{...}}\n```
 */
function parseCodeBlockFormat(
  text: string,
  allowedNames: Set<string>
): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const codeBlockRegex = /```tool_call\s*\n?({[\s\S]*?})\n?```/g;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const name = parsed.name;
      if (name && (allowedNames.size === 0 || allowedNames.has(name))) {
        results.push({
          name,
          input: (parsed.input || parsed.arguments || {}) as Record<
            string,
            unknown
          >,
        });
      }
    } catch {
      // 忽略解析失败
    }
  }

  return results;
}

/**
 * 解析 DSML/XML 格式的工具调用
 *
 * 支持格式（按优先级）：
 * 1. DSML/XML: <|DSML|tool_calls>...</|DSML|tool_calls>
 * 2. 纯 XML: <tool_calls>...</tool_calls>
 * 3. Hash 标记: ##TOOL_CALL## ... ##END_CALL##
 * 4. 代码块: ```tool_call ... ```
 * 5. JSON（回退，由调用方处理）
 *
 * @param text 模型输出文本
 * @param allowedNames 允许的工具名称集合（空集合表示允许所有）
 * @returns 解析出的工具调用数组
 */
export function parseDSMLFormat(
  text: string,
  allowedNames: Set<string>
): ParsedToolCall[] {
  if (!text || !text.trim()) return [];

  // 1. 自动修复缺失的包装标签
  const repaired = repairMissingWrapper(text);

  // 2. 查找所有 tool_calls 块
  const toolCallBlocks = findBlocks(repaired, "tool_calls");
  const results: ParsedToolCall[] = [];

  for (const block of toolCallBlocks) {
    // 3. 对每个 tool_calls 块，查找 invoke 子块
    const invokeBlocks = findBlocks(block.body, "invoke");

    for (const invokeBlock of invokeBlocks) {
      const call = parseInvokeBlock(
        invokeBlock.body,
        invokeBlock.open,
        block.body,
        allowedNames
      );
      if (call) {
        results.push(call);
      }
    }
  }

  // 如果 DSML/XML 解析成功，直接返回
  if (results.length > 0) {
    return results;
  }

  // 4. 尝试 Hash 标记格式
  const hashResults = parseHashFormat(repaired, allowedNames);
  if (hashResults.length > 0) {
    return hashResults;
  }

  // 5. 尝试代码块格式
  const codeBlockResults = parseCodeBlockFormat(repaired, allowedNames);

  return codeBlockResults;
}

/**
 * 流式消费函数：检测并解析 DSML/XML 工具调用块
 *
 * 用于流式场景中实时分离普通文本和工具调用块。
 * 当检测到 <|DSML|tool_calls> 或 <tool_calls> 开标签但未找到对应闭合标签时，
 * 返回 ready=false 表示需要继续缓冲。
 *
 * @param captured 当前累积的缓冲文本
 * @param allowedNames 允许的工具名称集合
 * @returns 解析结果
 */
export function consumeDSMLToolCapture(
  captured: string,
  allowedNames: Set<string>
): DSMLCaptureResult {
  const folded = foldFullwidth(captured);

  // 检测是否有 tool_calls 开标签
  const openMatch = folded.match(/<\|?DSML\|?tool_calls[^>]*>/i);
  if (!openMatch || openMatch.index === undefined) {
    // 没有工具调用标签，全部作为普通文本
    return { prefix: captured, calls: [], suffix: "", ready: true };
  }

  const openTagEnd = (openMatch.index + openMatch[0].length) | 0;

  // 查找对应的闭合标签
  const closeMatch = folded
    .slice(openTagEnd)
    .match(/<\/\|?DSML\|?tool_calls>/i);
  if (!closeMatch) {
    // 未找到闭合标签，需要继续缓冲
    return {
      prefix: captured.slice(0, openMatch.index),
      calls: [],
      suffix: "",
      ready: false,
    };
  }

  const closeTagStart = openTagEnd + (closeMatch.index ?? 0);
  const closeTagEnd = closeTagStart + closeMatch[0].length;

  // 提取工具调用块内容
  const toolCallBody = captured.slice(openTagEnd, closeTagStart);
  const prefix = captured.slice(0, openMatch.index);
  const suffix = captured.slice(closeTagEnd);

  // 解析工具调用
  const calls = parseDSMLFormat(toolCallBody, allowedNames);

  return { prefix, calls, suffix, ready: true };
}

/**
 * ToolStreamSieve - 流式工具调用筛
 *
 * 在流式场景中缓冲文本块，检测 DSML/XML 格式的工具调用标签边界，
 * 实时分离普通文本和工具调用。
 *
 * 核心策略：
 * - 检测到不完整的工具调用前缀（如 <|DSML）时暂不发送
 * - 使用 consumeDSMLToolCapture 检测完整的工具调用块
 * - 缓冲最大 200 字符，超过后强制刷新
 * - 无 setTimeout/setInterval（兼容 Workers 环境）
 */
export class ToolStreamSieve {
  private buffer: string = "";
  private allowedNames: Set<string>;

  constructor(allowedNames: Set<string> = new Set()) {
    this.allowedNames = allowedNames;
  }

  /**
   * 检查字符串末尾是否包含不完整的 DSML/XML 前缀
   * 用于判断是否需要继续缓冲等待更多数据
   */
  private hasIncompletePrefix(s: string): boolean {
    // 检查各种不完整前缀
    const incompletePatterns = [
      /<\|?DSML\|?tool_calls?$/i,
      /<\|?DSML\|?tool_cal$/i,
      /<\|?DSML\|?tool_ca$/i,
      /<\|?DSML\|?tool_c$/i,
      /<\|?DSML\|?tool_$/i,
      /<\|?DSML\|?tool$/i,
      /<\|?DSML\|?too$/i,
      /<\|?DSML\|?to$/i,
      /<\|?DSML\|?t$/i,
      /<\|?DSML\|?$/i,
      /<\|?DSML\|$/i,
      /<\|?DSML\|$/i,
      /<\|?DSML$/i,
      /<\|?DSM$/i,
      /<\|?DS$/i,
      /<\|?D$/i,
      /<\|?$/i,
      /<tool_calls?$/i,
      /<tool_cal$/i,
      /<tool_ca$/i,
      /<tool_c$/i,
      /<tool_$/i,
      /<tool$/i,
      /<too$/i,
      /<to$/i,
      /<t$/i,
      /<\/\|?DSML\|?tool_calls?$/i,
      /<\/\|?DSML\|?tool_cal$/i,
      /<\/\|?DSML\|?tool_ca$/i,
      /<\/\|?DSML\|?tool_c$/i,
      /<\/\|?DSML\|?tool_$/i,
      /<\/\|?DSML\|?tool$/i,
      /<\/\|?DSML\|?too$/i,
      /<\/\|?DSML\|?to$/i,
      /<\/\|?DSML\|?t$/i,
      /<\/\|?DSML\|?$/i,
      /<\/\|?DSML\|$/i,
      /<\/\|?DSML$/i,
      /<\/\|?DSM$/i,
      /<\/\|?DS$/i,
      /<\/\|?D$/i,
      /<\/\|?$/i,
      /<\/tool_calls?$/i,
      /<\/tool_cal$/i,
      /<\/tool_ca$/i,
      /<\/tool_c$/i,
      /<\/tool_$/i,
      /<\/tool$/i,
      /<\/too$/i,
      /<\/to$/i,
      /<\/t$/i,
    ];

    return incompletePatterns.some((pattern) => pattern.test(s));
  }

  /**
   * 喂入新文本块，返回应立即发送的普通文本和解析出的工具调用
   *
   * @param chunk - 新到达的文本块
   * @returns 处理结果
   */
  feed(chunk: string): {
    text: string;
    toolCalls: ParsedToolCall[] | null;
    ready: boolean;
  } {
    // 将新 chunk 追加到 buffer
    this.buffer += chunk;

    // 检查 buffer 末尾是否包含不完整前缀
    if (this.hasIncompletePrefix(this.buffer)) {
      if (this.buffer.length < 200) {
        // 缓冲未满，继续等待
        return { text: "", toolCalls: null, ready: false };
      }
      // 缓冲超过 200 字符，强制刷新
      const text = this.buffer;
      this.buffer = "";
      return { text, toolCalls: null, ready: true };
    }

    // 调用 consumeDSMLToolCapture 检测工具调用块
    const result = consumeDSMLToolCapture(this.buffer, this.allowedNames);

    if (result.ready) {
      if (result.calls.length > 0) {
        // 有工具调用：返回 prefix 作为 text，calls 作为 toolCalls
        const text = result.prefix;
        const toolCalls = result.calls;
        // 保留 suffix 到 buffer 中
        this.buffer = result.suffix;
        return { text, toolCalls, ready: true };
      } else {
        // 无工具调用：全部 buffer 作为普通文本
        const text = this.buffer;
        this.buffer = "";
        return { text, toolCalls: null, ready: true };
      }
    } else {
      // ready=false：继续缓冲，但如果 buffer > 200 字符则强制刷新
      if (this.buffer.length > 200) {
        const text = this.buffer;
        this.buffer = "";
        return { text, toolCalls: null, ready: true };
      }
      return { text: "", toolCalls: null, ready: false };
    }
  }

  /**
   * 流结束时，返回缓冲区中剩余的内容
   */
  flush(): { text: string; toolCalls: ParsedToolCall[] | null } {
    if (!this.buffer) {
      return { text: "", toolCalls: null };
    }

    // 尝试对剩余 buffer 调用 consumeDSMLToolCapture
    const result = consumeDSMLToolCapture(this.buffer, this.allowedNames);
    this.buffer = "";

    if (result.ready && result.calls.length > 0) {
      // 能解析出工具调用，返回 prefix 和 calls
      return {
        text: result.prefix + result.suffix,
        toolCalls: result.calls,
      };
    }

    // 不能解析，全部作为普通文本返回
    return { text: result.prefix + result.suffix, toolCalls: null };
  }

  /** 重置状态 */
  reset(): void {
    this.buffer = "";
  }
}
