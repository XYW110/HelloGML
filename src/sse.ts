/**
 * 轻量 SSE 解析器（替代 eventsource-parser）
 */

export interface SSEEvent {
  type: string;
  data: string;
}

export function createParser(onEvent: (event: SSEEvent) => void) {
  let buffer = "";
  let eventType = "";
  let eventData = "";

  function dispatch() {
    if (eventData !== "" || eventType !== "") {
      onEvent({
        type: eventType || "message",
        data: eventData,
      });
      eventType = "";
      eventData = "";
    }
  }

  return {
    feed(chunk: string) {
      buffer += chunk;
      // 同时支持 LF (\n) 和 CRLF (\r\n) 作为行分隔符
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        // 过滤空行，避免多余换行触发空事件
        if (line === "") {
          dispatch();
        } else if (line.startsWith("data: ")) {
          eventData += (eventData ? "\n" : "") + line.slice(6);
        } else if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("id: ")) {
          // ignore id
        } else if (line.startsWith("retry: ")) {
          // ignore retry
        } else if (line.startsWith(":")) {
          // comment, ignore
        }
      }
    },
  };
}

/**
 * 读取 ReadableStream 并逐块喂给 SSE 解析器，最后 resolve
 */
export async function parseSSEStream<T>(
  readableStream: ReadableStream,
  onEvent: (event: SSEEvent) => void
): Promise<void> {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  const parser = createParser(onEvent);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}
