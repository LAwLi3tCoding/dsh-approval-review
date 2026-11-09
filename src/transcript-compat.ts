/** Read both legacy nested results and DSH 0.2.2's flat tool messages. */

/** Only the fields this reader consumes, independent of the installed host types. */
interface ReadableBlock {
  readonly type: string
  readonly text?: string
  readonly toolCallId?: string
  readonly content?: readonly ReadableBlock[]
}

interface ReadableMessage {
  readonly source?: { readonly kind: string; readonly callId?: string }
  readonly toolCallId?: string
  readonly content: readonly ReadableBlock[]
}

/** Extract model-visible text, retaining the old nested tool-result representation. */
export function contentTexts(blocks: readonly ReadableBlock[]): string[] {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'tool-result' && Array.isArray(block.content)) texts.push(...contentTexts(block.content))
  }
  return texts
}

/**
 * Current messages identify results in source.callId (and toolCallId); old
 * hosts store the identity on a nested result block. Never correlate conflicting
 * current metadata or reinterpret non-tool provenance as a legacy result.
 */
export function toolResultCallId(message: ReadableMessage): string | undefined {
  if (message.source !== undefined) {
    if (message.source.kind !== 'tool') return undefined
    const callId = message.source.callId
    if (typeof callId !== 'string' || callId.length === 0) return undefined
    if (message.toolCallId !== undefined && message.toolCallId !== callId) return undefined
    return callId
  }
  return message.content.find(block => block.type === 'tool-result'
    && typeof block.toolCallId === 'string' && block.toolCallId.length > 0)?.toolCallId
}
