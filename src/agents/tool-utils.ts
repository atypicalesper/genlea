import type { StructuredToolInterface } from '@langchain/core/tools';

// Wraps a LangChain tool so its serialized output is capped at maxChars before
// being written into the message history. The full result still executes — only
// the copy the LLM reads on subsequent iterations is trimmed.
export function capOutput<T extends StructuredToolInterface>(t: T, maxChars: number): T {
  const orig = t.invoke.bind(t);
  (t as StructuredToolInterface).invoke = async (
    input: Parameters<typeof orig>[0],
    opts?: Parameters<typeof orig>[1],
  ) => {
    const result = await orig(input, opts);
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars) + ` …[+${str.length - maxChars} chars]`;
  };
  return t;
}
