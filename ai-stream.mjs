// Provider-neutral text streaming. No SDK, CDN, or provider credentials here.
export function responseText(result, protocol) {
  let value = protocol === 'anthropic' ? (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')
    : protocol === 'responses' ? result.output_text || (result.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n')
    : result.choices?.[0]?.message?.content;
  return Array.isArray(value) ? value.map(x => x.text || '').join('') : value;
}

export async function readAIStream(response, protocol, onDelta, signal) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const result = await response.json(); const text = responseText(result, protocol);
    if (typeof text !== 'string' || !text.trim()) throw Error('API 没有返回可用文本。');
    onDelta(text); return { text, usage: result.usage || null, mode: 'standard' };
  }
  let buffer = ''; let text = ''; let usage = null; let ended = false;
  const decoder = new TextDecoder();
  const add = delta => {
    if (typeof delta !== 'string' || !delta) return;
    if (text.length + delta.length > 1_000_000) throw Error('AI 回复超过 1 MB，已停止接收。');
    text += delta; onDelta(delta);
  };
  function event(frame) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { ended = true; return; }
    let item; try { item = JSON.parse(data); } catch { throw Error('API 流式数据格式不正确。'); }
    if (item.error || item.type === 'error' || item.type === 'response.failed') throw Error(item.error?.message || item.response?.error?.message || item.message || 'API 流式请求失败。');
    if (protocol === 'anthropic') {
      if (item.type === 'content_block_delta' && item.delta?.type === 'text_delta') add(item.delta.text);
      if (item.type === 'message_start') usage = item.message?.usage || null;
      if (item.type === 'message_delta') usage = { ...usage, ...item.usage };
      if (item.type === 'message_stop') ended = true;
    } else if (protocol === 'responses') {
      if (item.type === 'response.output_text.delta') add(item.delta);
      if (item.type === 'response.completed') { usage = item.response?.usage || null; ended = true; }
      if (item.type === 'response.incomplete') throw Error('AI 回复未完成，请检查输出长度限制或重试。');
    } else {
      add(item.choices?.[0]?.delta?.content);
      if (item.usage) usage = item.usage;
      // Usage may arrive after finish_reason, so keep reading until [DONE]/EOF.
      if (item.choices?.[0]?.finish_reason) ended = true;
    }
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      signal?.throwIfAborted(); const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, '\n');
      // A CR can be split across chunks; normalize once both bytes arrive.
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 1_000_000) throw Error('API 流式事件过大。');
      let separator;
      while ((separator = buffer.indexOf('\n\n')) >= 0) { event(buffer.slice(0, separator)); buffer = buffer.slice(separator + 2); }
      if (chunk.done) break;
    }
    if (buffer.trim()) event(buffer);
    if (!ended) throw Error('AI 连接提前结束，回复可能不完整。');
    if (!text.trim()) throw Error('API 没有返回可用文本。');
    return { text, usage, mode: 'stream' };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
