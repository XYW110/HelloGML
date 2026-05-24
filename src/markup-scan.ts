/**
 * DSML 工具标记扫描基础设施
 * 用于解析 DSML/XML 格式的工具调用标记
 *
 * 设计原则：
 * - 使用 while 循环而非递归，避免栈溢出
 * - 所有函数为纯函数，无副作用
 * - 不引入任何第三方 XML 解析库
 */

/**
 * DSML 工具标记接口
 */
export interface ToolMarkupTag {
  name: string; // 规范名称: "tool_calls" | "invoke" | "parameter"
  start: number; // 在原始文本中的起始位置（包含）
  end: number; // 在原始文本中的结束位置（不包含）
  closing: boolean; // 是否为闭合标签
  rawName: string; // 原始标签名（规范化前）
}

/**
 * 全角字符到半角字符的映射表
 * 包含：＜→<, ＞→>, ／→/, ＝→=, 引号, 感叹号, 顿号
 */
const FULLWIDTH_MAP: Record<string, string> = {
  "\uff1c": "<", // ＜
  "\uff1e": ">", // ＞
  "\uff0f": "/", // ／
  "\uff1d": "=", // ＝
  "\uff02": '"', // ＂
  "\uff07": "'", // ＇
  "\uff01": "|", // ！
  "\u3001": "|", // 、
};

/**
 * 全角字符折叠函数
 * 将全角字符转换为半角字符
 * @param text 输入文本
 * @returns 折叠后的文本
 */
export function foldFullwidth(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    result += FULLWIDTH_MAP[char] ?? char;
  }
  return result;
}

/**
 * 在指定位置跳过 markdown 代码块和 CDATA 区块
 * @param text 原始文本（已折叠全角）
 * @param pos 当前位置
 * @returns 跳过后的位置
 */
function skipIgnoredRegions(text: string, pos: number): number {
  const remaining = text.slice(pos);

  // 跳过 markdown 代码块 ```...```
  // 匹配 ``` 开始到下一个 ``` 之间的内容
  if (remaining.startsWith("```")) {
    let endPos = pos + 3;
    // 找到下一个 ```
    while (endPos < text.length) {
      const nextTripleBacktick = text.indexOf("```", endPos);
      if (nextTripleBacktick === -1) {
        // 没有闭合标签，剩余全部是代码块
        return text.length;
      }
      endPos = nextTripleBacktick + 3;
      // 检查是否在代码块内（简单处理：假设找到的就是闭合标签）
      return endPos;
    }
  }

  // 跳过 CDATA 区块 <![CDATA[...]]>
  if (remaining.startsWith("<![CDATA[")) {
    const cdataEnd = text.indexOf("]]>", pos);
    if (cdataEnd !== -1) {
      return cdataEnd + 3;
    }
  }

  return pos;
}

/**
 * 尝试匹配 DSML 格式标签 <|DSML|tagname ...>
 * @param text 文本（已折叠全角）
 * @param pos 当前位置
 * @returns 匹配结果或 null
 */
function tryMatchDSMLTag(text: string, pos: number): ToolMarkupTag | null {
  const remaining = text.slice(pos);

  // DSML 格式: <|DSML|tagname> 或 </|DSML|tagname> 或 <|DSML|tagname attr="value">
  const dsmlRegex = /^<\/?\|DSML\|(\w+)(?:\s+[^>]*)?>/;
  const match = remaining.match(dsmlRegex);

  if (match) {
    const fullMatch = match[0];
    const rawName = match[1];
    const isClosing = fullMatch.startsWith("</");

    return {
      name: rawName,
      start: pos,
      end: pos + fullMatch.length,
      closing: isClosing,
      rawName: rawName,
    };
  }

  return null;
}

/**
 * 尝试匹配纯 XML 格式标签 <tagname ...>
 * @param text 文本（已折叠全角）
 * @param pos 当前位置
 * @returns 匹配结果或 null
 */
function tryMatchXMLTag(text: string, pos: number): ToolMarkupTag | null {
  const remaining = text.slice(pos);

  // 纯 XML 格式: <tagname> 或 </tagname> 或 <tagname attr="value">
  // 注意：不能匹配以 <? 开头的处理指令
  const xmlRegex = /^<(\w+)(?:\s+[^>]*)?>/;
  const closeRegex = /^<\/(\w+)(?:\s+[^>]*)?>/;

  // 先尝试闭合标签
  const closeMatch = remaining.match(closeRegex);
  if (closeMatch) {
    const fullMatch = closeMatch[0];
    const rawName = closeMatch[1];

    return {
      name: rawName,
      start: pos,
      end: pos + fullMatch.length,
      closing: true,
      rawName: rawName,
    };
  }

  // 再尝试开标签
  const openMatch = remaining.match(xmlRegex);
  if (openMatch) {
    const fullMatch = openMatch[0];
    const rawName = openMatch[1];

    return {
      name: rawName,
      start: pos,
      end: pos + fullMatch.length,
      closing: false,
      rawName: rawName,
    };
  }

  return null;
}

/**
 * 在指定位置查找工具标记，跳过 markdown 代码块和 CDATA 区块
 * @param text 原始文本
 * @param pos 搜索起始位置
 * @returns 找到的标签或 null
 */
export function findToolMarkupTagOutsideIgnored(
  text: string,
  pos: number
): ToolMarkupTag | null {
  // 1. 先对搜索区域调用 foldFullwidth() 折叠全角字符
  const foldedText = foldFullwidth(text);

  // 2. 从 pos 开始扫描
  let currentPos = pos;

  while (currentPos < foldedText.length) {
    // 3. 跳过 markdown 代码块和 CDATA 区块
    const skippedPos = skipIgnoredRegions(foldedText, currentPos);

    if (skippedPos !== currentPos) {
      // 跳过了代码块或 CDATA，更新位置
      currentPos = skippedPos;
      continue;
    }

    // 4. 匹配 DSML 格式标签 <|DSML|tagname> 或 </|DSML|tagname>
    let tag = tryMatchDSMLTag(foldedText, currentPos);

    if (tag) {
      // 映射回原始文本的位置（因为全角折叠不改变 ASCII 字符位置）
      return {
        ...tag,
        start: currentPos,
        end: currentPos + (tag.end - tag.start),
      };
    }

    // 5. 兼容纯 XML 格式 <tagname ...> 和 </tagname>
    tag = tryMatchXMLTag(foldedText, currentPos);

    if (tag) {
      return {
        ...tag,
        start: currentPos,
        end: currentPos + (tag.end - tag.start),
      };
    }

    // 没有匹配到标签，移动到下一个字符继续搜索
    currentPos++;
  }

  return null;
}

/**
 * 查找匹配的闭合标签
 * 从 openTag.end 开始扫描，找到同名的第一个闭合标签
 * 处理嵌套：遇到同名开标签时递增深度计数器
 * @param text 原始文本
 * @param openTag 开口标签
 * @returns 匹配的闭合标签或 null
 */
export function findMatchingCloseTag(
  text: string,
  openTag: ToolMarkupTag
): ToolMarkupTag | null {
  let depth = 1;
  let pos = openTag.end;

  while (pos < text.length) {
    const tag = findToolMarkupTagOutsideIgnored(text, pos);

    if (!tag) {
      break;
    }

    if (tag.name === openTag.name) {
      if (tag.closing) {
        depth--;
        if (depth === 0) {
          return tag;
        }
      } else {
        depth++;
      }
    }

    pos = tag.end;
  }

  return null;
}

/**
 * 查找所有指定标签名的完整块
 * @param text 原始文本
 * @param tagName 标签名称
 * @returns 所有匹配的块数组
 */
export function findBlocks(
  text: string,
  tagName: string
): Array<{ open: ToolMarkupTag; close: ToolMarkupTag; body: string }> {
  const blocks: Array<{
    open: ToolMarkupTag;
    close: ToolMarkupTag;
    body: string;
  }> = [];
  let pos = 0;

  while (pos < text.length) {
    const tag = findToolMarkupTagOutsideIgnored(text, pos);

    if (!tag) {
      break;
    }

    // 找到开口标签
    if (!tag.closing && tag.name === tagName) {
      const closeTag = findMatchingCloseTag(text, tag);

      if (closeTag) {
        blocks.push({
          open: tag,
          close: closeTag,
          body: text.slice(tag.end, closeTag.start),
        });

        pos = closeTag.end;
        continue;
      }
    }

    pos = tag.end;
  }

  return blocks;
}
